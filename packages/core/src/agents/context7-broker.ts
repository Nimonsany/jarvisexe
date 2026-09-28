import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export interface Context7Request {
  /** 'resolve' (library id) or 'docs' (library docs) */
  kind: 'resolve' | 'docs';
  libraryName?: string;   // for resolve
  libraryId?: string;     // for docs (e.g. /org/project)
  query?: string;
  version?: string;
  language?: string;
  priority: 'blocking' | 'test' | 'research';
}

export interface Context7Result {
  ok: boolean;
  cacheHit: 'L1' | 'L2' | 'miss';
  data?: unknown;
  error?: string;
  queuedMs?: number;
}

interface CacheEntry { data: unknown; at: number }

/**
 * Context7 Broker — ONE shared instance between ALL agent bots:
 *
 *   Agents → Context7Broker → cache → rate limiter → Context7 (single MCP client)
 *                       ↘ singleflight/dedupe
 *
 * - ONE shared credential/connection — no per-agent credentials.
 * - Cache key: SHA256(kind + library + version + normalizedQuery + language)
 * - L1 RAM cache 30 min · L2 disk cache 24 h (runtime dir)
 * - singleflight: identical in-flight requests share one upstream call
 * - Token bucket: 5 concurrent upstream calls, configurable req/min
 * - Priority: blocking > test > research (the queue drains by priority)
 * - 429 → obey Retry-After, exponential backoff + jitter
 * - Audit: every query (agent → key → cache-hit)
 */
export class Context7Broker {
  private l1 = new Map<string, CacheEntry>();
  private inflight = new Map<string, Promise<Context7Result>>();
  private queue: { req: Context7Request; key: string; resolve: (r: Context7Result) => void; enqueuedAt: number }[] = [];
  private activeUpstream = 0;
  private child: ChildProcess | null = null;
  private pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private rpcId = 0;
  private lastRequestAt = 0;
  private audit: (e: Record<string, unknown>) => void;

  constructor(
    private l2Dir: string,
    private opts: { maxConcurrent?: number; minIntervalMs?: number; l1TtlMs?: number; l2TtlMs?: number } = {},
    audit?: (e: Record<string, unknown>) => void,
  ) {
    mkdirSync(l2Dir, { recursive: true });
    this.audit = audit ?? (() => {});
  }

  private key(req: Context7Request): string {
    const q = (req.query ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    return createHash('sha256').update(
      `${req.kind}|${req.libraryName ?? req.libraryId ?? ''}|${req.version ?? ''}|${q}|${req.language ?? ''}`,
    ).digest('hex').slice(0, 24);
  }

  async request(req: Context7Request, agent = 'unknown'): Promise<Context7Result> {
    const key = this.key(req);

    // L1 RAM cache (30 min)
    const hit1 = this.l1.get(key);
    if (hit1 && Date.now() - hit1.at < (this.opts.l1TtlMs ?? 30 * 60_000)) {
      this.audit({ agent, key, kind: req.kind, cacheHit: 'L1' });
      return { ok: true, cacheHit: 'L1', data: hit1.data };
    }

    // singleflight: identical in-flight requests share one upstream call
    const inflight = this.inflight.get(key);
    if (inflight) return inflight;

    // L2 disk cache (24 h)
    const call = this.upstreamViaCache(key, req, agent);
    this.inflight.set(key, call);
    const result = await call;
    this.inflight.delete(key);
    return result;
  }

  private async upstreamViaCache(key: string, req: Context7Request, agent: string): Promise<Context7Result> {
    const l2File = path.join(this.l2Dir, `${key}.json`);
    if (existsSync(l2File)) {
      try {
        const entry = JSON.parse(readFileSync(l2File, 'utf8')) as CacheEntry;
        if (Date.now() - entry.at < (this.opts.l2TtlMs ?? 24 * 3600_000)) {
          this.l1.set(key, entry);
          this.audit({ agent, key, kind: req.kind, cacheHit: 'L2' });
          return { ok: true, cacheHit: 'L2', data: entry.data };
        }
      } catch { /* corrupt L2 entry — refetch */ }
    }

    // priority queue → rate-limited upstream
    const enqueuedAt = Date.now();
    const result = await new Promise<Context7Result>((resolve) => {
      this.queue.push({ req, key, resolve, enqueuedAt });
      this.drain();
    });
    result.queuedMs = Date.now() - enqueuedAt;
    return result;
  }

  private async drain(): Promise<void> {
    if (this.activeUpstream >= (this.opts.maxConcurrent ?? 5) || this.queue.length === 0) return;
    // priority: blocking > test > research (FIFO within a priority)
    const rank = { blocking: 0, test: 1, research: 2 } as const;
    this.queue.sort((a, b) => rank[a.req.priority] - rank[b.req.priority]);
    const next = this.queue.shift()!;
    const minInterval = this.opts.minIntervalMs ?? 1200;
    const wait = Math.max(0, this.lastRequestAt + minInterval - Date.now());
    this.activeUpstream++;
    setTimeout(async () => {
      this.lastRequestAt = Date.now();
      try {
        const r = await this.callUpstream(next.req);
        if (r.ok) {
          const entry: CacheEntry = { data: r.data, at: Date.now() };
          this.l1.set(next.key, entry);
          try { writeFileSync(path.join(this.l2Dir, `${next.key}.json`), JSON.stringify(entry)); } catch { /* disk full */ }
          this.audit({ agent: 'upstream', key: next.key, kind: next.req.kind, cacheHit: 'miss', priority: next.req.priority });
        }
        next.resolve(r);
      } finally {
        this.activeUpstream--;
        void this.drain();
      }
    }, wait);
  }

  /** 429-aware upstream call with exponential backoff + jitter (max 4 attempts). */
  private async callUpstream(req: Context7Request): Promise<Context7Result> {
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const data = await this.rpc(req) as RpcResult;
        if (data && data.isError) return { ok: false, cacheHit: 'miss', error: extractRpcError(data) };
        return { ok: true, cacheHit: 'miss', data };
      } catch (e) {
        const msg = String(e instanceof Error ? e.message : e);
        if (msg.includes('429') || msg.toLowerCase().includes('rate limit')) {
          const retryAfter = Number(msg.match(/retry-after[:\s]*(\d+)/i)?.[1] ?? 0);
          const backoff = retryAfter * 1000 || Math.min(30_000, 2000 * 2 ** (attempt - 1));
          await new Promise((r) => setTimeout(r, backoff + Math.random() * 500)); // + jitter
          continue;
        }
        return { ok: false, cacheHit: 'miss', error: msg.slice(0, 200) };
      }
    }
    return { ok: false, cacheHit: 'miss', error: 'rate-limited after 4 attempts with backoff' };
  }

  /** Minimal MCP stdio client: one persistent Context7 MCP child (ONE credential). */
  private async rpc(req: Context7Request): Promise<unknown> {
    if (!this.child || this.child.killed) await this.startChild();
    const id = ++this.rpcId;
    const tool = req.kind === 'resolve' ? 'resolve-library-id' : 'get-library-docs';
    // 2026 Context7 schema: resolve-library-id requires query; get-library-docs takes the library id + query
    const args = req.kind === 'resolve'
      ? { libraryName: req.libraryName ?? '', query: req.query ?? req.libraryName ?? 'usage docs' }
      : { context7CompatibleLibraryID: req.libraryId ?? '', ...(req.query ? { query: req.query } : {}) };
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: tool, arguments: args } });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRpc.delete(id);
        reject(new Error('context7 rpc timeout (30s)'));
      }, 30_000);
      this.pendingRpc.set(id, {
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });
      this.child!.stdin!.write(payload + '\n');
    });
  }

  private startChild(): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('npx', ['-y', '@upstash/context7-mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
      let buffer = '';
      proc.stdout!.on('data', (c) => {
        buffer += c.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id && this.pendingRpc.has(msg.id)) {
              const p = this.pendingRpc.get(msg.id)!;
              this.pendingRpc.delete(msg.id);
              if (msg.error) p.reject(new Error(String(msg.error.message ?? msg.error)));
              else p.resolve(msg.result);
            }
          } catch { /* non-JSON line */ }
        }
      });
      proc.on('exit', () => { this.child = null; });
      proc.on('error', (e) => { this.child = null; reject(e); });
      // MCP initialize handshake
      proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'jarvis-context7-broker', version: '0.1.0' } } }) + '\n');
      setTimeout(() => { this.child = proc; resolve(); }, 3000);
    });
  }

  stats(): { l1: number; inflight: number; queued: number; activeUpstream: number } {
    return { l1: this.l1.size, inflight: this.inflight.size, queued: this.queue.length, activeUpstream: this.activeUpstream };
  }

  close(): void {
    try { this.child?.kill(); } catch { /* gone */ }
    this.child = null;
  }
}

interface RpcResult { isError?: boolean; content?: { type: string; text?: string }[] }

function extractRpcError(data: RpcResult): string {
  const text = (data.content ?? []).map((c) => c.text ?? '').join(' ');
  return text.slice(0, 200) || 'tool error';
}
