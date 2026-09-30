import { randomUUID } from 'node:crypto';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import type { TaskStore } from '../task/store.js';

export interface OwnedProcess {
  id: string;
  pid: number | null;
  pgid: number | null;        // own process group (detached spawns) → group kill sweeps children
  exe: string | null;         // executable identity (what we spawned)
  argsMarker: string | null;  // full argv as spawned — recovery identity proof
  taskId: string | null;
  role: string;               // 'opencode' | 'terminal' | 'verify' | 'browser' | 'context7' | ...
  command: string;
  startedAt: number;
  proc: ChildProcess | null;  // live handle for our own spawns; null for provenance/external entries
  detached: boolean;
  exited?: boolean;           // child has exited: stays listed for ownership audit, not "active"
}

export interface RegisterOptions {
  role?: string;
  taskId?: string | null;
  detached?: boolean;
}

type PersistedEntry = Omit<OwnedProcess, 'proc'>;

/**
 * Exact process ownership registry (M8 BLOCKER 2).
 *
 * Every process JARVIS creates is recorded with PID, process group, executable
 * identity, full argv marker, task id, role and launch timestamp. Kills are:
 *   - handle-based (strongest proof) for processes we spawned in this run, or
 *   - identity-verified (live `ps` argv must contain the recorded argv marker)
 *     for persisted/recovered or provenance-recorded entries.
 * NEVER a fuzzy name or port match — an unrelated process must survive any
 * STOP/cleanup/recovery driven through this registry.
 */
export class ProcessRegistry {
  private processes = new Map<string, OwnedProcess>();
  private persistPath: string | null;

  constructor(runtimeDir?: string | null) {
    this.persistPath = runtimeDir ? path.join(runtimeDir, 'owned-processes.json') : null;
  }

  /** Track a process we spawned. `detached: true` gives it its own process
   *  group so a group kill also sweeps whatever it spawned underneath. */
  register(command: string, proc: ChildProcess, opts: RegisterOptions = {}): OwnedProcess {
    const pid = proc.pid ?? null;
    const p: OwnedProcess = {
      id: randomUUID(),
      pid,
      pgid: opts.detached && pid ? pid : null,
      exe: proc.spawnfile ?? null,
      argsMarker: proc.spawnargs?.length ? proc.spawnargs.join(' ') : null,
      taskId: opts.taskId ?? null,
      role: opts.role ?? 'owned',
      command,
      startedAt: Date.now(),
      proc,
      detached: opts.detached ?? false,
    };
    // a completed run stays listed (ownership audit) but is pruned when the
    // next process registers, so the map never grows unbounded
    for (const [id, e] of [...this.processes]) if (e.exited) this.processes.delete(id);
    this.processes.set(p.id, p);
    proc.on('exit', () => { p.exited = true; this.persist(); });
    this.persist();
    return p;
  }

  /** Track a process we did not spawn directly but can prove is ours by
   *  parentage (e.g. the browser tree discovered via ppid walk after launch).
   *  argv marker must be captured at discovery time. */
  registerExternal(e: { pid: number; exe: string | null; args: string | null; role: string; taskId?: string | null }): OwnedProcess {
    const p: OwnedProcess = {
      id: randomUUID(),
      pid: e.pid,
      pgid: null, // never group-kill an entry we don't own the group of
      exe: e.exe,
      argsMarker: e.args,
      taskId: e.taskId ?? null,
      role: e.role,
      command: e.args ?? e.exe ?? `pid:${e.pid}`,
      startedAt: Date.now(),
      proc: null,
      detached: false,
    };
    this.processes.set(p.id, p);
    this.persist();
    return p;
  }

  /** Identity proof for entries without a live handle: the live process argv
   *  must still contain the exact argv we recorded at spawn/discovery. */
  private verified(e: OwnedProcess): boolean {
    if (!e.pid) return false;
    let args: string;
    try {
      // -ww: unlimited width so the marker survives the comparison
      args = execFileSync('ps', ['-ww', '-p', String(e.pid), '-o', 'args='], {
        encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch { return false; /* pid gone */ }
    if (!args) return false;
    if (e.argsMarker) return args.includes(e.argsMarker);
    if (e.exe) return args.includes(e.exe);
    return false;
  }

  private killEntry(e: OwnedProcess, signal: NodeJS.Signals): boolean {
    if (e.exited) return false; // nothing to signal — entry kept for audit only
    if (e.proc && e.proc.pid && !e.proc.killed) {
      try {
        if (e.pgid) process.kill(-e.pgid, signal);
        else e.proc.kill(signal);
        return true;
      } catch { /* raced */ }
      return false;
    }
    // no live handle: identity must be re-proven from the OS before any signal
    if (!this.verified(e)) return false;
    try { process.kill(e.pid!, signal); return true; } catch { return false; }
  }

  /** Kill all controlled child processes (STOP JARVIS / emergency stop).
   *  Only registry entries — never arbitrary system processes. */
  stopAll(): number {
    let killed = 0;
    for (const e of [...this.processes.values()]) {
      if (this.killEntry(e, 'SIGTERM')) killed++;
      else if (!e.proc) this.processes.delete(e.id); // identity drifted — never signal
    }
    setTimeout(() => {
      for (const e of [...this.processes.values()]) {
        if (e.exited) { this.processes.delete(e.id); continue; }
        this.killEntry(e, 'SIGKILL');
        this.processes.delete(e.id);
      }
      this.persist();
    }, 4000);
    this.persist();
    return killed;
  }

  /** Boot recovery (previous run's orphans): kill only entries whose live argv
   *  still matches the recorded marker — PID reuse by a foreign process is
   *  detected and dropped without any signal. Returns killed count. */
  recoverStale(): number {
    if (!this.persistPath || !existsSync(this.persistPath)) return 0;
    let killed = 0;
    let stale: PersistedEntry[] = [];
    try { stale = JSON.parse(readFileSync(this.persistPath, 'utf8')) as PersistedEntry[]; } catch { stale = []; }
    for (const raw of stale) {
      const e: OwnedProcess = { ...raw, proc: null };
      if (!e.pid || e.pid === process.pid) continue;
      if (this.verified(e)) {
        try {
          // detached entries are group leaders: sweep the whole group they spawned
          process.kill(e.pgid && e.pgid === e.pid ? -e.pid : e.pid, 'SIGKILL');
          killed++;
        } catch { /* raced */ }
      }
      // verified false → gone or PID reused by something else → drop silently
    }
    writeFileSync(this.persistPath, '[]');
    return killed;
  }

  activeCount(): number { return [...this.processes.values()].filter((e) => !e.exited).length; }

  list(): { id: string; pid: number | null; command: string; startedAt: number; role: string; taskId: string | null; exe: string | null; pgid: number | null }[] {
    return [...this.processes.values()].map(({ id, pid, command, startedAt, role, taskId, exe, pgid }) =>
      ({ id, pid, command, startedAt, role, taskId, exe, pgid }));
  }

  private persist(): void {
    if (!this.persistPath) return;
    const entries: PersistedEntry[] = [...this.processes.values()]
      .filter((e) => e.pid != null && !e.exited) // completed runs are not orphans
      .map(({ proc: _proc, ...rest }) => rest);
    try {
      mkdirSync(path.dirname(this.persistPath), { recursive: true });
      writeFileSync(this.persistPath, JSON.stringify(entries, null, 1));
    } catch { /* persistence is best-effort */ }
  }

  emitOwnership(bus: TaskStore['bus'], taskId: string | null): void {
    void bus; void taskId; // ownership is exposed via list(); events emitted by callers
  }
}
