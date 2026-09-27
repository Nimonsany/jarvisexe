import http from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { TaskStore } from './task/store.js';
import type { Task, TaskEvent } from './task/types.js';
import { sanitize } from './security/sanitize.js';
import { ChatGPTBrowser, defaultProfileDir } from './browser/chatgpt.js';
import type { Orchestrator } from './orchestrator.js';
import { ComputerController } from './computer/index.js';
import { ApprovalQueue } from './security/permissions.js';
import { PrivilegeBroker } from './security/privilege.js';
import { AuditLog } from './security/audit.js';

export interface JarvisSettings {
  defaultProjectDir: string;
  opencodeBin: string;
  browserChannel: string;      // 'chrome' | 'chromium'
  headless: boolean;           // visible browser mode by default
  autoConsultThreshold: number;
  maxRetries: number;
  finalReview: boolean;        // not wired yet (later milestone)
  startMinimized: boolean;     // not wired yet (later milestone)
  theme: 'dark' | 'light';
  logVerbosity: 'quiet' | 'normal' | 'verbose';
}

const DEFAULT_SETTINGS: JarvisSettings = {
  defaultProjectDir: '',
  opencodeBin: 'opencode',
  browserChannel: 'chrome',
  headless: false,
  autoConsultThreshold: 2,
  maxRetries: 3,
  finalReview: false,
  startMinimized: false,
  theme: 'dark',
  logVerbosity: 'normal',
};

export interface Health {
  core: 'online';
  opencode: 'ready' | 'missing';
  chatgptProfile: 'ready' | 'missing';
  chatgptLogin: 'ok' | 'required' | 'unknown' | 'checking';
  storage: 'ready' | 'error';
}

export class JarvisServer {
  private store: TaskStore;
  private settings: JarvisSettings;
  private loginWatcher: ChatGPTBrowser | null = null;
  private loginState: Health['chatgptLogin'] = 'unknown';
  private busy = false;
  /** Per-install random token; state-changing requests must present it. */
  private token: string;
  /** Strict origin allowlist — the JARVIS UI only. Enforced server-side, not just via CORS headers. */
  private allowedOrigins = new Set(['http://localhost:5173', 'http://127.0.0.1:5173', 'tauri://localhost', 'http://tauri.localhost']);
  private healthCache: { data: Health; at: number } | null = null;
  readonly computer!: ComputerController;
  readonly approvals: ApprovalQueue;
  readonly privilege: PrivilegeBroker;
  readonly audit: AuditLog;
  /** Emergency stop: when true, no new tasks/actions start until cleared by the owner. */
  private emergencyStopped = false;
  private voice: import('./voice/voice.js').VoiceLayer | null = null;

  constructor(private runtimeDir: string, private orchestrator: Orchestrator, settings?: Partial<JarvisSettings>) {
    this.store = orchestrator.taskStore;
    mkdirSync(runtimeDir, { recursive: true });
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    // apply operational settings the core uses
    process.env.OPENCODE_BIN = this.settings.opencodeBin;
    process.env.JARVIS_BROWSER_CHANNEL = this.settings.browserChannel;
    // per-install auth token (persisted, never logged)
    const tokenFile = path.join(runtimeDir, 'auth-token');
    if (existsSync(tokenFile)) {
      this.token = '';
      void readFile(tokenFile, 'utf8').then((t) => { this.token = t.trim(); });
    } else {
      this.token = randomUUID() + randomUUID().slice(0, 8);
      writeFileSync(tokenFile, this.token, { mode: 0o600 });
    }
    this.computer = new ComputerController(this.store, runtimeDir);
    this.approvals = new ApprovalQueue(this.store);
    this.computer.approvalQueue = this.approvals;
    this.privilege = new PrivilegeBroker(this.store, this.approvals);
    this.audit = new AuditLog(path.join(runtimeDir, 'security-audit.jsonl'));
    this.audit.append({ timestamp: new Date().toISOString(), kind: 'security', taskId: null, summary: 'JARVIS core started; security subsystem initialized' });
  }

  private settingsPath() { return path.join(this.runtimeDir, 'settings.json'); }

  async getSettings(): Promise<JarvisSettings> {
    try {
      const raw = await readFile(this.settingsPath(), 'utf8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch { return this.settings; }
  }

  async updateSettings(patch: Partial<JarvisSettings>): Promise<JarvisSettings> {
    const current = await this.getSettings();
    const next = { ...current, ...patch };
    // validate paths that must exist if provided
    if (next.defaultProjectDir && !existsSync(next.defaultProjectDir)) {
      throw new Error(`defaultProjectDir does not exist: ${next.defaultProjectDir}`);
    }
    await writeFile(this.settingsPath(), JSON.stringify(next, null, 2));
    this.settings = next;
    process.env.OPENCODE_BIN = next.opencodeBin;
    process.env.JARVIS_BROWSER_CHANNEL = next.browserChannel;
    return next;
  }

  /** Lightweight health: cached component states, never blocks. Expensive probes
   *  (opencode spawn etc.) refresh the cache in the background. */
  async health(): Promise<Health> {
    const cached = this.healthCache;
    if (cached && Date.now() - cached.at < 10_000) return cached.data;
    if (cached) {
      // stale — return it now, refresh in background (non-blocking)
      void this.refreshHealth();
      return cached.data;
    }
    const data = await this.refreshHealth();
    return data;
  }

  private async refreshHealth(): Promise<Health> {
    const data: Health = {
      core: 'online',
      opencode: await this.checkOpencode(),
      chatgptProfile: existsSync(defaultProfileDir(this.runtimeDir)) ? 'ready' : 'missing',
      chatgptLogin: this.loginState,
      storage: existsSync(this.runtimeDir) ? 'ready' : 'error',
    };
    this.healthCache = { data, at: Date.now() };
    return data;
  }

  private checkOpencode(): Promise<Health['opencode']> {
    return new Promise((resolve) => {
      const p = spawn(this.settings.opencodeBin, ['--version'], { stdio: 'ignore' });
      p.on('error', () => resolve('missing'));
      p.on('exit', (code) => resolve(code === 0 ? 'ready' : 'missing'));
    });
  }

  async createTask(request: string, project?: string): Promise<Task> {
    if (this.emergencyStopped) throw new Error('JARVIS is in EMERGENCY STOP — clear it before new tasks');
    if (this.busy) throw new Error('A task is already running');
    this.busy = true;
    const dir = project || this.settings.defaultProjectDir || path.join(this.runtimeDir, '..', 'projects', `task-project-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const startedAt = Date.now();
    // run in background; UI follows via SSE
    this.orchestrator.run(request, dir)
      .catch(() => {})
      .finally(() => { this.busy = false; });
    // wait for the task id (opencode detect can take several seconds)
    for (let i = 0; i < 120; i++) {
      const tasks = await this.store.listAll();
      const match = tasks.find((t) => t.owner_request === request && new Date(t.created_at).getTime() >= startedAt - 1000);
      if (match) return match;
      await new Promise((r) => setTimeout(r, 150));
    }
    // poll expired — cancel the orphan run so it doesn't execute unattended
    const orphans = await this.store.listAll();
    const orphan = orphans.find((t) => t.owner_request === request && new Date(t.created_at).getTime() >= startedAt - 1000);
    if (orphan && !['COMPLETED', 'CANCELLED', 'FAILED'].includes(orphan.status)) {
      await this.orchestrator.cancel(orphan.id).catch(() => {});
    }
    throw new Error('task did not start within 20s');
  }

  /** Opens the dedicated browser for manual ChatGPT sign-in; updates loginState. */
  async openChatGPTLogin(): Promise<void> {
    if (this.loginWatcher) return;
    this.loginState = 'checking';
    this.loginWatcher = new ChatGPTBrowser(defaultProfileDir(this.runtimeDir), false, this.settings.browserChannel);
    const watcher = this.loginWatcher;
    (async () => {
      try {
        await watcher.launch();
        await watcher.ensureLoggedIn(() => { if (this.loginState !== 'ok') this.loginState = 'required'; });
        this.loginState = 'ok';
      } catch {
        this.loginState = 'unknown';
      } finally {
        await watcher.close().catch(() => {});
        this.loginWatcher = null;
      }
    })();
  }

  async listProjects(): Promise<{ path: string; latestTask?: string; status?: string }[]> {
    const tasks = await this.store.listAll();
    const map = new Map<string, { path: string; latestTask?: string; status?: string }>();
    for (const t of tasks) {
      if (!map.has(t.project_directory)) map.set(t.project_directory, { path: t.project_directory, latestTask: t.id, status: t.status });
    }
    return [...map.values()];
  }

  openProject(dir: string): void {
    if (!existsSync(dir)) throw new Error(`not found: ${dir}`);
    spawn('open', [dir], { stdio: 'ignore' }); // macOS
  }

  private sanitizeEvent(e: TaskEvent): TaskEvent {
    return JSON.parse(sanitize(JSON.stringify(e)));
  }

  handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    void this.handleAsync(req, res);
  }

  private async handleAsync(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const origin = req.headers.origin ?? '';
    const allowed = origin === '' || this.allowedOrigins.has(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : '',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Jarvis-Token',
      Vary: 'Origin',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const p = url.pathname;
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...cors });
      res.end(JSON.stringify(data));
    };

    // SECURITY: foreign origins (e.g. a random website in Chrome) are rejected outright.
    if (!allowed) return void json({ error: 'origin not allowed' }, 403);

    // SECURITY: bootstrap is the ONLY way an allowed origin obtains the token.
    // State-changing requests (POST, SSE) must then present it.
    const isSSE = req.method === 'GET' && p === '/api/events';
    const isPost = req.method === 'POST';
    const needsToken = isSSE || isPost;
    const presented = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? String(req.headers['x-jarvis-token'] ?? '') ?? '';
    const sseToken = isSSE ? (url.searchParams.get('token') ?? '') : '';
    const tokenOk = presented === this.token || (isSSE && sseToken === this.token && sseToken !== '');
    if (needsToken && !tokenOk) return void json({ error: 'unauthenticated' }, 401);

    let body: Record<string, unknown> = {};
    try {
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      }

      if (req.method === 'GET' && p === '/api/bootstrap') return void json({ token: this.token });
      if (req.method === 'GET' && p === '/api/health') return void json(await this.health());
      if (req.method === 'GET' && p === '/api/tasks') return void json(await this.store.listAll());
      if (req.method === 'GET' && p === '/api/settings') return void json(await this.getSettings());
      if (req.method === 'POST' && p === '/api/settings') return void json(await this.updateSettings(body as Partial<JarvisSettings>));
      if (req.method === 'GET' && p === '/api/projects') return void json(await this.listProjects());
      if (req.method === 'POST' && p === '/api/task') {
        return void json(await this.createTask(String(body.request ?? ''), body.project ? String(body.project) : undefined));
      }
      if (req.method === 'POST' && p === '/api/project/open') { this.openProject(String(body.path ?? '')); return void json({ ok: true }); }
      if (req.method === 'POST' && p === '/api/chatgpt/login') { await this.openChatGPTLogin(); return void json({ ok: true }); }

      const taskMatch = p.match(/^\/api\/task\/([^/]+)(\/(pause|resume|cancel))?$/);
      if (taskMatch) {
        const id = taskMatch[1];
        const action = taskMatch[3];
        if (req.method === 'GET' && !action) {
          const task = JSON.parse(sanitize(JSON.stringify(await this.store.load(id))));
          const events = (await this.store.events(id)).map((e) => this.sanitizeEvent(e));
          return void json({ task, events });
        }
        if (req.method === 'POST' && action === 'pause') return void json(await this.orchestrator.pause(id));
        if (req.method === 'POST' && action === 'resume') return void json(await this.orchestrator.resume(id));
        if (req.method === 'POST' && action === 'cancel') {
          const t = await this.orchestrator.cancel(id);
          const killed = this.computer.stopAll(); // STOP kills controlled child processes too
          if (killed > 0) await this.store.emit(t, 'core', 'computer_processes_killed', 'warning', { killed });
          return void json(t);
        }
      }

      if (req.method === 'GET' && p === '/api/events') {
        // SSE: live task events. Auth via ?token= (EventSource cannot send headers —
        // documented practical exception; the token never appears in logs).
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...cors });
        res.flushHeaders(); // send headers immediately so fetch()/EventSource resolve
        const onEvent = (e: TaskEvent) => { try { res.write(`data: ${JSON.stringify(this.sanitizeEvent(e))}\n\n`); } catch { /* client gone */ } };
        this.store.bus.on('event', onEvent);
        req.on('close', () => this.store.bus.off('event', onEvent));
        return;
      }

      // Computer control: policy-gated actions (task-scoped or owner-direct)
      const compMatch = p.match(/^\/api\/(?:task\/([^/]+)\/)?computer$/);
      if (compMatch && req.method === 'POST') {
        const taskId = compMatch[1];
        try {
          const result = await this.computer.execute(body as unknown as import('./computer/types.js').ComputerActionInput, taskId);
          this.audit.append({ timestamp: new Date().toISOString(), kind: 'computer', taskId, summary: `${(body as { capability?: string }).capability}.${(body as { operation?: string }).operation} ${result.success ? 'SUCCESS' : 'DENIED/FAILED'}`, detail: { durationMs: result.durationMs } });
          return void json(result);
        } catch (e) {
          return void json({ success: false, error: String(e instanceof Error ? e.message : e) }, 400);
        }
      }
      if (compMatch && req.method === 'GET') {
        const taskId = compMatch[1];
        return void json(this.computer.history(taskId));
      }

      // Privileged helper (LEVEL 3): broker with explicit owner approval
      if (req.method === 'POST' && p === '/api/privileged') {
        const r = (body as { command?: string; reason?: string; taskId?: string; ownerConfirmed?: boolean });
        if (!r.command) return void json({ success: false, error: 'command required' }, 400);
        const result = await this.privilege.execute({ command: r.command, reason: r.reason ?? '', taskId: r.taskId ?? null }, r.ownerConfirmed);
        return void json(result);
      }

      // Owner approvals (LEVEL 3/4 confirmation flow)
      if (p === '/api/approvals') {
        if (req.method === 'GET') return void json(this.approvals.list());
        const approveMatch = p.match(/^\/api\/approvals\/([^/]+)\/(approve|reject)$/);
        if (req.method === 'POST' && approveMatch) {
          const decided = this.approvals.decide(approveMatch[1], approveMatch[2] === 'approve');
          if (!decided) return void json({ error: 'not found or already decided' }, 404);
          this.audit.append({ timestamp: new Date().toISOString(), kind: 'approval', taskId: decided.taskId, summary: `${decided.operation} ${decided.status.toUpperCase()} by owner`, detail: { approvalId: decided.id, level: decided.level } });
          return void json(decided);
        }
      }

      // EMERGENCY STOP (kill switch)
      if (req.method === 'POST' && p === '/api/emergency-stop') {
        this.emergencyStopped = true;
        const killedProcesses = this.computer.stopAll();
        // cancel all active tasks (kills their opencode children + aborts browser automation)
        const active = await this.store.listIncomplete();
        for (const t of active) await this.orchestrator.cancel(t.id).catch(() => {});
        this.audit.append({ timestamp: new Date().toISOString(), kind: 'security', taskId: null, summary: `EMERGENCY STOP activated: ${killedProcesses} processes killed, ${active.length} tasks cancelled` });
        return void json({ stopped: true, killedProcesses, cancelledTasks: active.map((t) => t.id) });
      }
      if (req.method === 'POST' && p === '/api/emergency-stop/clear') {
        this.emergencyStopped = false;
        this.audit.append({ timestamp: new Date().toISOString(), kind: 'security', taskId: null, summary: 'EMERGENCY STOP cleared by owner' });
        return void json({ stopped: false });
      }
      if (req.method === 'GET' && p === '/api/emergency-stop') return void json({ stopped: this.emergencyStopped });

      // Security audit integrity
      if (req.method === 'GET' && p === '/api/security-audit') return void json({ chain: this.audit.verifyChain(), entries: this.audit.entries().slice(-100) });

      // Voice (Milestone 5): push-to-talk + TTS + status
      if (p.startsWith('/api/voice')) {
        const { VoiceLayer } = await import('./voice/voice.js');
        this.voice ??= new VoiceLayer();
        if (req.method === 'GET' && p === '/api/voice/status') {
          return void json({ whisper: this.voice.whisperReady(), model: this.voice.modelReady(), mics: this.voice.listMicDevices() });
        }
        if (req.method === 'POST' && p === '/api/voice/push-to-talk') {
          // records from the mic (OS prompts for permission on first use) → STT → command
          const duration = Number((body as { durationMs?: number }).durationMs ?? 8000);
          const device = (body as { deviceIndex?: number }).deviceIndex;
          try {
            const r = this.voice.pushToTalk(duration, device);
            this.audit.append({ timestamp: new Date().toISOString(), kind: 'voice', taskId: null, summary: `push-to-talk transcribed (${r.language}, ${r.text.length} chars)` });
            return void json(r);
          } catch (e) {
            return void json({ error: String(e instanceof Error ? e.message : e) }, 400);
          }
        }
        if (req.method === 'POST' && p === '/api/voice/speak') {
          const text = String((body as { text?: string }).text ?? '');
          if (!text) return void json({ error: 'text required' }, 400);
          const r = this.voice.speak(sanitize(text));
          return void json(r);
        }
        if (req.method === 'POST' && p === '/api/voice/listen-start') {
          const device = (body as { deviceIndex?: number }).deviceIndex;
          this.voice.startListenLoop(async (command) => {
            // wake word detected → submit to the orchestrator (busy-checked) + speak the result
            this.audit.append({ timestamp: new Date().toISOString(), kind: 'voice', taskId: null, summary: `wake word command: ${command.slice(0, 80)}` });
            try {
              const task = await this.createTask(command);
              this.voice?.speak('Working on it.');
              void task;
            } catch {
              this.voice?.speak('Cannot start. A task may be running.');
            }
          }, device, (msg) => this.store.bus.emit('event', { timestamp: new Date().toISOString(), task_id: 'TASK-NONE', component: 'voice', event: msg, severity: 'info' }));
          return void json({ listening: true });
        }
        if (req.method === 'POST' && p === '/api/voice/listen-stop') {
          this.voice.stopListenLoop();
          return void json({ listening: false });
        }
      }

      json({ error: 'not found' }, 404);
    } catch (e) {
      if (!res.headersSent) json({ error: String(e) }, 500);
      else { try { res.end(JSON.stringify({ error: String(e) })); } catch { /* already closed */ } }
    }
  }

  private httpServer: http.Server | null = null;

  listen(port = 7788, host = '127.0.0.1'): Promise<void> {
    const srv = http.createServer((req, res) => this.handle(req, res));
    this.httpServer = srv;
    return new Promise((resolve) => srv.listen(port, host, resolve));
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer?.close(() => resolve());
      this.httpServer?.closeAllConnections(); // SSE/keep-alive connections must not block shutdown
    });
  }
}
