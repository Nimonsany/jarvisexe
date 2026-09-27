import { spawn } from 'node:child_process';
import type { TaskStore } from '../task/store.js';
import type { ApprovalQueue } from './permissions.js';
import { emitComputerEvent } from '../computer/types.js';
import { DESTRUCTIVE_PATTERNS } from '../computer/policy.js';

export interface PrivilegedRequest {
  command: string;
  reason: string;
  taskId: string | null;
  timeoutMs?: number;
}

export interface PrivilegedResult {
  success: boolean;
  broker: 'privilege';
  action: string;
  durationMs: number;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * Privilege Broker: JARVIS → Security Policy → THIS BROKER → OS privileged
 * helper → one specific approved action. NEVER an unrestricted root shell.
 *
 * macOS helper: `osascript … with administrator privileges` — the OS shows the
 * password dialog to the OWNER directly; JARVIS never sees or stores it.
 * No persistent sudo rules are ever created.
 *
 * Every privileged action requires:
 *   1. an approved privileged pattern (brew/launchctl only),
 *   2. explicit owner approval via the ApprovalQueue,
 *   3. an audit entry with the policy decision and result.
 */
export class PrivilegeBroker {
  constructor(private store: TaskStore, private approvals: ApprovalQueue) {}

  private static ALLOWED_ADMIN_PATTERNS: RegExp[] = [
    /^brew\s+(install|uninstall|upgrade)\s+[\w@./-]+$/,     // package management
    /^launchctl\s+(load|unload|start|stop)\s+[\w/.-]+$/,    // service control
    /^brew\s+services\s+(start|stop|restart)\s+[\w@./-]+$/,
  ];

  async execute(req: PrivilegedRequest, ownerConfirmed = false): Promise<PrivilegedResult> {
    const t0 = Date.now();
    const command = req.command.trim();

    // policy checks: approved patterns only, never destructive, never sudoers
    const allowed = PrivilegeBroker.ALLOWED_ADMIN_PATTERNS.some((re) => re.test(command));
    if (!allowed) {
      return this.record(req, { success: false, broker: 'privilege', action: command, durationMs: 0, error: 'command is not an approved privileged pattern (brew/launchctl only)' }, 'denied');
    }
    if (DESTRUCTIVE_PATTERNS.test(command)) {
      return this.record(req, { success: false, broker: 'privilege', action: command, durationMs: 0, error: 'destructive pattern refused' }, 'denied');
    }
    if (/\bsudoers\b|visudo|NOPASSWD/.test(command)) {
      return this.record(req, { success: false, broker: 'privilege', action: command, durationMs: 0, error: 'sudoers modification is never permitted' }, 'denied');
    }

    // explicit owner confirmation through the approval queue (level-3 gate)
    if (!ownerConfirmed) {
      const approved = await this.approvals.request({
        taskId: req.taskId,
        capability: 'privileged',
        operation: command,
        argumentsSummary: command.slice(0, 200),
        riskLevel: 'DESTRUCTIVE',
        reason: req.reason,
      });
      if (!approved) {
        return this.record(req, { success: false, broker: 'privilege', action: command, durationMs: 0, error: 'owner did not approve the privileged action' }, 'rejected');
      }
    }

    emitComputerEvent(this.store.bus, req.taskId, 'computer.privilege.started', 'warning', { command: command.slice(0, 120) });
    const result = await new Promise<PrivilegedResult>((resolve) => {
      // macOS: the OS prompts the owner for the password — never stored, never logged
      const proc = spawn('osascript', ['-e', `do shell script ${JSON.stringify(command)} with administrator privileges`], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: req.timeoutMs ?? 300_000,
      });
      let stdout = '', stderr = '';
      const MAX = 500_000;
      proc.stdout?.on('data', (c) => { if (stdout.length < MAX) stdout += c; });
      proc.stderr?.on('data', (c) => { if (stderr.length < MAX) stderr += c; });
      proc.on('exit', (code) => resolve({
        success: code === 0,
        broker: 'privilege',
        action: command,
        durationMs: Date.now() - t0,
        exitCode: code ?? -1,
        stdout: stdout.slice(-2000),
        stderr: stderr.slice(-2000),
        ...(code !== 0 ? { error: stderr.slice(-300) || `exit ${code}` } : {}),
      }));
      proc.on('error', (e) => resolve({ success: false, broker: 'privilege', action: command, durationMs: Date.now() - t0, error: String(e) }));
    });
    return this.record(req, result, result.success ? 'executed' : 'failed');
  }

  private record(req: PrivilegedRequest, result: PrivilegedResult, status: string): PrivilegedResult {
    emitComputerEvent(this.store.bus, req.taskId, `computer.privilege.${status}`, status === 'executed' ? 'info' : 'error', {
      command: req.command.slice(0, 120), reason: req.reason, exitCode: result.exitCode,
    });
    return result;
  }
}
