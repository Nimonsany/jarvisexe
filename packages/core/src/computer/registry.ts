import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { TaskStore } from '../task/store.js';

export interface OwnedProcess {
  id: string;
  pid: number | null;
  command: string;
  startedAt: number;
  proc: ChildProcess;
}

/**
 * Tracks processes JARVIS launched. STOP terminates ONLY these —
 * never arbitrary system processes by fuzzy name matching.
 */
export class ProcessRegistry {
  private processes = new Map<string, OwnedProcess>();

  register(command: string, proc: ChildProcess): OwnedProcess {
    const p: OwnedProcess = { id: randomUUID(), pid: proc.pid ?? null, command, startedAt: Date.now(), proc };
    this.processes.set(p.id, p);
    proc.on('exit', () => this.processes.delete(p.id));
    return p;
  }

  /** Kill all controlled child processes (STOP JARVIS). */
  stopAll(): number {
    let killed = 0;
    for (const p of this.processes.values()) {
      try {
        if (p.pid && !p.proc.killed) { p.proc.kill('SIGTERM'); killed++; }
        const pid = p.pid;
        setTimeout(() => { try { if (pid && !p.proc.killed) p.proc.kill('SIGKILL'); } catch { /* gone */ } }, 4000);
      } catch { /* already gone */ }
    }
    return killed;
  }

  activeCount(): number { return this.processes.size; }

  list(): { id: string; pid: number | null; command: string; startedAt: number }[] {
    return [...this.processes.values()].map(({ id, pid, command, startedAt }) => ({ id, pid, command, startedAt }));
  }

  emitOwnership(bus: TaskStore['bus'], taskId: string | null): void {
    void bus; void taskId; // ownership is exposed via list(); events emitted by callers
  }
}
