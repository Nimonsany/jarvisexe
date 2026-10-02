import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { discoverOpencode } from './discover.js';
import type { ProcessRegistry } from '../computer/registry.js';

export interface OpenCodeSession {
  session_id: string;
  process: ChildProcess;
  output: string[];
  done: Promise<number>; // exit code
}

/**
 * Controls OpenCode via its CLI (`opencode run`). Sessions are "continued"
 * by sending follow-up prompts in the same project directory — OpenCode CLI
 * is stateless per invocation, so continuity = accumulated conversation file
 * we keep per task and prepend context to follow-up prompts.
 */
export class OpenCodeController {
  /** Ownership registry (M8): set by the orchestrator so every run is tracked
   *  with task id + argv identity and can be group-killed on STOP/cancel. */
  registry: ProcessRegistry | null = null;
  // FR-5: env/configured → bundled → user-local → PATH (absolute path; no cwd binary)
  // Re-discovered at EVERY call: opencode may be installed (or env changed)
  // after the core booted — a construction-time bin freezes the fallback bare
  // name forever (Windows E2E evidence: "task did not start within 20s").
  private bin(): string {
    return discoverOpencode({ configured: process.env.OPENCODE_BIN })?.path ?? 'opencode';
  }

  async detect(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn(this.bin(), ['--version'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    });
  }

  start(projectDir: string, prompt: string, onEvent: (line: string) => void, taskId: string | null = null): OpenCodeSession {
    const session_id = randomUUID();
    // --auto: non-interactive runs auto-reject external_directory permissions otherwise,
    // which breaks tasks in project dirs outside the opencode workspace.
    // detached: own process group → STOP sweeps whatever opencode spawned too.
    const proc = spawn(this.bin(), ['run', '--auto', prompt], {
      cwd: projectDir,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    this.registry?.register(`opencode: ${prompt.slice(0, 120)}`, proc, { role: 'opencode', taskId, detached: true });
    return this.wrap(session_id, proc, onEvent);
  }

  /** Continue the same logical task: new opencode run in same project dir with corrective context. */
  continue(sessionId: string, projectDir: string, correctivePrompt: string, onEvent: (line: string) => void, taskId: string | null = null): OpenCodeSession {
    void sessionId; // continuity is preserved via the shared project directory
    return this.start(projectDir, correctivePrompt, onEvent, taskId);
  }

  stop(session: OpenCodeSession): void {
    const pid = session.process.pid;
    if (!session.process.killed) session.process.kill('SIGTERM');
    // detached run: also sweep the group it leads (its own children)
    if (pid) { try { process.kill(-pid, 'SIGTERM'); } catch { /* not a leader anymore */ } }
    setTimeout(() => {
      try {
        if (!session.process.killed) session.process.kill('SIGKILL');
        if (pid) process.kill(-pid, 'SIGKILL');
      } catch { /* gone */ }
    }, 5000);
  }

  private wrap(session_id: string, proc: ChildProcess, onEvent: (line: string) => void): OpenCodeSession {
    const output: string[] = [];
    const handle = (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        output.push(line);
        if (output.length > 5000) output.shift();
        onEvent(line);
      }
    };
    proc.stdout?.on('data', handle);
    proc.stderr?.on('data', handle);
    const done = new Promise<number>((resolve) => proc.on('exit', (code) => resolve(code ?? -1)));
    return { session_id, process: proc, output, done };
  }
}
