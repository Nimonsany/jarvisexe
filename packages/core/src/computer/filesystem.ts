import { existsSync, statSync, mkdirSync, readFileSync, appendFileSync, writeFileSync, createReadStream, readdirSync, unlinkSync, renameSync, copyFileSync, rmdirSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { canonicalize } from './policy.js';
import type { ActionResult } from './types.js';

export class FilesystemController {
  private safe<T>(tool: 'filesystem', action: string, t0: number, fn: () => T, meta: Record<string, unknown> = {}, dryRun = false): ActionResult & { data?: T } {
    if (dryRun) {
      return { success: true, tool, action, durationMs: 0, metadata: { ...meta, dryRun: true } };
    }
    try {
      const data = fn();
      return { success: true, tool, action, durationMs: Date.now() - t0, metadata: meta, data };
    } catch (e) {
      return { success: false, tool, action, durationMs: Date.now() - t0, metadata: meta, error: String(e instanceof Error ? e.message : e) };
    }
  }

  exists(args: { path: string }): ActionResult {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    return this.safe('filesystem', 'exists', t0, () => existsSync(p), { path: p });
  }

  read(args: { path: string; maxBytes?: number }): ActionResult & { data?: string } {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    // reject directory reads
    if (existsSync(p) && statSync(p).isDirectory()) {
      return { success: false, tool: 'filesystem', action: 'read', durationMs: Date.now() - t0, error: 'path is a directory', metadata: { path: p } };
    }
    return this.safe('filesystem', 'read', t0, () => {
      const fd = openSync(p, 'r');
      try {
        const max = args.maxBytes ?? 1_000_000;
        const buf = Buffer.alloc(max);
        const bytes = readSync(fd, buf, 0, max, 0);
        return buf.subarray(0, bytes).toString('utf8');
      } finally { closeSync(fd); }
    }, { path: p });
  }

  write(args: { path: string; content: string; backup?: boolean }): ActionResult {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    mkdirSync(path.dirname(p), { recursive: true });
    // backup existing valuable files when requested
    if (args.backup && existsSync(p)) {
      copyFileSync(p, p + '.jarvis-backup-' + Date.now());
    }
    return this.safe('filesystem', 'write', t0, () => {
      writeFileSync(p, args.content);
      // verify resulting content
      const written = readFileSync(p, 'utf8');
      if (written !== args.content) throw new Error('write verification failed: content mismatch');
      return undefined;
    }, { path: p, bytes: args.content.length, verified: true });
  }

  append(args: { path: string; content: string }): ActionResult {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    mkdirSync(path.dirname(p), { recursive: true });
    return this.safe('filesystem', 'append', t0, () => { appendFileSync(p, args.content); }, { path: p, bytes: args.content.length });
  }

  mkdir(args: { path: string }): ActionResult {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    return this.safe('filesystem', 'mkdir', t0, () => { mkdirSync(p, { recursive: true }); }, { path: p });
  }

  list(args: { path: string }): ActionResult & { data?: string[] } {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    return this.safe('filesystem', 'list', t0, () => readdirSync(p), { path: p });
  }

  stat(args: { path: string }): ActionResult & { data?: Record<string, unknown> } {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    return this.safe('filesystem', 'stat', t0, () => {
      const s = statSync(p);
      return { size: s.size, isDirectory: s.isDirectory(), isFile: s.isFile(), isSymlink: s.isSymbolicLink(), modified: s.mtime.toISOString() };
    }, { path: p });
  }

  hash(args: { path: string }): ActionResult & { data?: string } {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    return this.safe('filesystem', 'hash', t0, () => {
      const h = createHash('sha256');
      createReadStream(p).on('data', (c) => h.update(c)).on('end', () => {});
      // simple sync hash for files
      return createHash('sha256').update(readFileSync(p)).digest('hex');
    }, { path: p });
  }

  copy(args: { source: string; destination: string }): ActionResult {
    const t0 = Date.now();
    const s = canonicalize(args.source), d = canonicalize(args.destination);
    mkdirSync(path.dirname(d), { recursive: true });
    return this.safe('filesystem', 'copy', t0, () => { copyFileSync(s, d); if (!existsSync(d)) throw new Error('copy verification failed'); }, { source: s, destination: d, verified: true });
  }

  move(args: { source: string; destination: string }): ActionResult {
    const t0 = Date.now();
    const s = canonicalize(args.source), d = canonicalize(args.destination);
    mkdirSync(path.dirname(d), { recursive: true });
    return this.safe('filesystem', 'move', t0, () => {
      renameSync(s, d);
      if (!existsSync(d)) throw new Error('move verification failed: destination missing');
      if (existsSync(s)) throw new Error('move verification failed: source still present');
    }, { source: s, destination: d, verified: true });
  }

  rename(args: { path: string; name: string }): ActionResult {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    const d = path.join(path.dirname(p), args.name);
    return this.safe('filesystem', 'rename', t0, () => { renameSync(p, d); if (!existsSync(d)) throw new Error('rename verification failed'); }, { path: p, destination: d, verified: true });
  }

  /** Default delete = move to Trash (macOS ~/.Trash). Never rm -rf. */
  'delete-to-trash'(args: { path: string }): ActionResult {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    const trash = path.join(os.homedir(), '.Trash', path.basename(p) + '-' + Date.now());
    return this.safe('filesystem', 'delete-to-trash', t0, () => {
      renameSync(p, trash);
      if (existsSync(p)) throw new Error('trash verification failed: source still present');
      return trash;
    }, { path: p, trash, verified: true });
  }

  /** PERMANENT delete — DESTRUCTIVE, requires ownerConfirmed (policy gate). */
  'delete-permanent'(args: { path: string; ownerConfirmed?: boolean }): ActionResult {
    const t0 = Date.now();
    const p = canonicalize(args.path);
    return this.safe('filesystem', 'delete-permanent', t0, () => {
      const s = statSync(p);
      if (s.isDirectory()) { rmdirSync(p, { recursive: true }); } else { unlinkSync(p); }
      if (existsSync(p)) throw new Error('delete verification failed: still present');
      return undefined;
    }, { path: p, permanent: true, verified: true });
  }
}