import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { ProcessRegistry } from './registry.js';
import type { ActionResult } from './types.js';

export class TerminalController {
  constructor(private registry: ProcessRegistry) {}

  /** Run a command as the current user. Verifies exit status — running is not success. */
  run(args: { command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }, dryRun = false): ActionResult & { exitCode?: number; stdout?: string; stderr?: string; pid?: string | null } {
    const command = args.command;
    const cwd = args.cwd && existsSync(args.cwd) ? args.cwd : undefined;
    const t0 = Date.now();
    if (dryRun) {
      return { success: true, tool: 'terminal', action: 'run', durationMs: 0, metadata: { dryRun: true, command, cwd: cwd ?? process.cwd(), timeoutMs: args.timeoutMs ?? 120_000 } };
    }
    return new Promise((resolve) => {
      const proc = spawn('sh', ['-c', command], {
        cwd,
        env: { ...process.env, ...args.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: args.timeoutMs ?? 120_000,
      });
      const owned = this.registry.register(command, proc);
      let stdout = '', stderr = '';
      const MAX = 1_000_000; // output cap
      proc.stdout?.on('data', (c) => { if (stdout.length < MAX) stdout += c; });
      proc.stderr?.on('data', (c) => { if (stderr.length < MAX) stderr += c; });
      proc.on('exit', (code, signal) => {
        resolve({
          success: code === 0,
          tool: 'terminal',
          action: 'run',
          durationMs: Date.now() - t0,
          exitCode: code ?? -1,
          stdout: stdout.slice(-4000),
          stderr: stderr.slice(-4000),
          pid: owned.id,
          metadata: { cwd: cwd ?? process.cwd(), signal: signal ?? undefined },
          ...(signal ? { error: `terminated by signal ${signal}` } : {}),
        });
      });
      proc.on('error', (e) => resolve({ success: false, tool: 'terminal', action: 'run', durationMs: Date.now() - t0, error: String(e), pid: owned.id }));
    }) as never;
  }
}
