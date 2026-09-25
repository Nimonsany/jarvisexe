import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ProcessRegistry } from './registry.js';
import type { ActionResult } from './types.js';

/** macOS adapter for Milestone 3 (Windows/Linux adapters: same interface, later). */
export class ApplicationController {
  constructor(private registry: ProcessRegistry) {}

  private runTool(cmd: string, args: string[], timeoutMs = 15000): { ok: boolean; out: string } {
    try {
      const out = execFileSync(cmd, args, { timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, out };
    } catch (e) {
      const err = e as { stdout?: string; message?: string };
      return { ok: false, out: err.stdout ?? err.message ?? '' };
    }
  }

  detect(args: { name: string }): ActionResult & { data?: boolean } {
    const t0 = Date.now();
    const name = args.name.replace(/\.app$/, '');
    const dirs = ['/Applications', '/System/Applications', `${process.env.HOME}/Applications`];
    const found = dirs.some((d) => existsSync(d) && readdirSync(d).some((f) => f.replace(/\.app$/, '').toLowerCase() === name.toLowerCase()));
    return { success: true, tool: 'applications', action: 'detect', durationMs: Date.now() - t0, data: found, metadata: { name } };
  }

  launch(args: { name: string }, dryRun = false): ActionResult {
    const t0 = Date.now();
    const name = args.name.replace(/\.app$/, '');
    if (dryRun) return { success: true, tool: 'applications', action: 'launch', durationMs: 0, metadata: { name, dryRun: true } };
    const r = this.runTool('open', ['-a', name]);
    return { success: r.ok, tool: 'applications', action: 'launch', durationMs: Date.now() - t0, metadata: { name }, ...(r.ok ? {} : { error: r.out.slice(0, 200) }) };
  }

  open(args: { path: string }, dryRun = false): ActionResult {
    const t0 = Date.now();
    if (dryRun) return { success: true, tool: 'applications', action: 'open', durationMs: 0, metadata: { path: args.path, dryRun: true } };
    const r = this.runTool('open', [args.path]);
    return { success: r.ok, tool: 'applications', action: 'open', durationMs: Date.now() - t0, metadata: { path: args.path }, ...(r.ok ? {} : { error: r.out.slice(0, 200) }) };
  }

  'open-url'(args: { url: string }, dryRun = false): ActionResult {
    const t0 = Date.now();
    if (dryRun) return { success: true, tool: 'applications', action: 'open-url', durationMs: 0, metadata: { url: args.url, dryRun: true } };
    const r = this.runTool('open', [args.url]);
    return { success: r.ok, tool: 'applications', action: 'open-url', durationMs: Date.now() - t0, metadata: { url: args.url }, ...(r.ok ? {} : { error: r.out.slice(0, 200) }) };
  }

  /** Running-state check (verification only — JARVIS never kills by fuzzy name). */
  'running-state'(args: { processName: string }): ActionResult & { data?: boolean } {
    const t0 = Date.now();
    const r = this.runTool('pgrep', ['-x', args.processName]);
    return { success: true, tool: 'applications', action: 'running-state', durationMs: Date.now() - t0, data: r.ok, metadata: { processName: args.processName } };
  }

  /** Graceful close — only for applications JARVIS launched (tracked ownership). */
  close(args: { name: string }): ActionResult {
    const t0 = Date.now();
    const name = args.name.replace(/\.app$/, '');
    const r = this.runTool('osascript', ['-e', `tell application "${name}" to quit`]);
    return { success: r.ok, tool: 'applications', action: 'close', durationMs: Date.now() - t0, metadata: { name }, ...(r.ok ? {} : { error: r.out.slice(0, 200) }) };
  }

  activate(args: { name: string }): ActionResult {
    const t0 = Date.now();
    const name = args.name.replace(/\.app$/, '');
    const r = this.runTool('open', ['-a', name]);
    return { success: r.ok, tool: 'applications', action: 'activate', durationMs: Date.now() - t0, metadata: { name }, ...(r.ok ? {} : { error: r.out.slice(0, 200) }) };
  }
}

// keep spawn import used for registry typing
void spawn;
