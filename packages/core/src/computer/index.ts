import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { TaskStore } from '../task/store.js';
import { ProcessRegistry } from './registry.js';
import { SecurityPolicy } from './policy.js';
import { TerminalController } from './terminal.js';
import { FilesystemController } from './filesystem.js';
import { ApplicationController } from './applications.js';
import { ClipboardController } from './clipboard.js';
import { ScreenController } from './screen.js';
import { KeyboardMouseController } from './keyboard-mouse.js';
import type { ComputerActionInput, ActionResult, AuditedAction } from './types.js';
import { emitComputerEvent } from './types.js';

/**
 * Computer control: one TOOL PROVIDER with capability adapters.
 * Every action: SecurityPolicy.authorize() → execute → structured result →
 * event on the bus → append-only audit log (sanitized).
 */
export class ComputerController {
  readonly registry: ProcessRegistry;
  readonly policy: SecurityPolicy;
  readonly terminal: TerminalController;
  readonly filesystem: FilesystemController;
  readonly applications: ApplicationController;
  readonly clipboard: ClipboardController;
  readonly screen: ScreenController;
  readonly keyboard: KeyboardMouseController;
  readonly mouse: KeyboardMouseController;
  private historyByTask = new Map<string, AuditedAction[]>();
  private auditFile: string;

  constructor(private store: TaskStore, runtimeDir: string) {
    this.registry = new ProcessRegistry(runtimeDir);
    this.policy = new SecurityPolicy(store);
    this.terminal = new TerminalController(this.registry);
    this.filesystem = new FilesystemController();
    this.applications = new ApplicationController(this.registry);
    this.clipboard = new ClipboardController(this.registry);
    this.screen = new ScreenController(path.join(runtimeDir, 'screenshots'));
    this.keyboard = new KeyboardMouseController();
    this.mouse = this.keyboard;
    this.auditFile = path.join(runtimeDir, 'audit.jsonl');
  }

  /** Approval queue (set by the server after construction). */
  approvalQueue: import('../security/permissions.js').ApprovalQueue | null = null;

  /** STOP JARVIS: kill controlled child processes. */
  stopAll(): number {
    return this.registry.stopAll();
  }

  activeProcesses() { return this.registry.list(); }

  history(taskId?: string): AuditedAction[] {
    if (taskId) return this.historyByTask.get(taskId) ?? [];
    return [...this.historyByTask.values()].flat();
  }

  private audit(entry: AuditedAction): void {
    const list = entry.taskId ? this.historyByTask.get(entry.taskId) ?? [] : [];
    if (entry.taskId) {
      list.push(entry);
      if (list.length > 200) list.shift(); // cap in-memory history
      this.historyByTask.set(entry.taskId, list);
    }
    try { appendFileSync(this.auditFile, JSON.stringify(entry) + '\n'); } catch { /* audit must not break execution */ }
  }

  private summarize(action: ComputerActionInput): string {
    const args = { ...action.args };
    // never store secrets in argumentsSummary: drop content-ish fields
    delete args.content; delete args.text; delete args.env;
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 200) + '…' : s;
  }

  async execute(input: ComputerActionInput, taskId: string | null = null): Promise<ActionResult> {
    const taskProjectDir = taskId ? (await this.store.load(taskId).catch(() => null))?.project_directory ?? null : null;

    const entry: AuditedAction = {
      actionId: randomUUID().slice(0, 8),
      taskId,
      timestamp: new Date().toISOString(),
      capability: input.capability,
      operation: input.operation,
      argumentsSummary: this.summarize(input),
      riskLevel: 'READ',
      requiresApproval: false,
      status: 'allowed',
    };

    const decision = await this.policy.authorize(input, taskId, taskProjectDir);
    entry.riskLevel = decision.category;
    entry.requiresApproval = decision.requiresApproval;

    if (!decision.allowed) {
      // approval-required (DESTRUCTIVE) → route through the owner-confirmation flow
      if (decision.requiresApproval && this.approvalQueue) {
        const approved = await this.approvalQueue.request({
          taskId,
          capability: input.capability,
          operation: input.operation,
          argumentsSummary: this.summarize(input),
          riskLevel: decision.category,
          reason: decision.reason,
        });
        if (approved) {
          emitComputerEvent(this.store.bus, taskId, 'approval.granted', 'info', { operation: input.operation });
          const retryInput = { ...input, ownerConfirmed: true, dryRun: false };
          emitComputerEvent(this.store.bus, taskId, `computer.${input.capability}.${input.operation}.started`, 'info', { operation: input.operation, viaApproval: true });
          const result2 = this.dispatch(retryInput, taskId);
          entry.status = result2.success ? 'executed' : 'failed';
          entry.durationMs = result2.durationMs;
          this.audit(entry);
          emitComputerEvent(this.store.bus, taskId, `computer.${input.capability}.${input.operation}.completed`, result2.success ? 'info' : 'error', { durationMs: result2.durationMs, success: result2.success, viaApproval: true });
          return result2;
        }
        entry.status = 'denied';
        entry.error = 'owner rejected the action';
        this.audit(entry);
        emitComputerEvent(this.store.bus, taskId, 'computer.action.denied', 'warning', { capability: input.capability, operation: input.operation, reason: 'owner rejected' });
        return { success: false, tool: input.capability, action: input.operation, durationMs: 0, error: 'owner rejected the action' };
      }
      entry.status = 'denied';
      entry.error = decision.reason;
      this.audit(entry);
      emitComputerEvent(this.store.bus, taskId, 'computer.action.denied', 'warning', { capability: input.capability, operation: input.operation, reason: decision.reason });
      return { success: false, tool: input.capability, action: input.operation, durationMs: 0, error: decision.reason };
    }

    if (input.dryRun) {
      entry.status = 'dry-run';
      this.audit(entry);
      emitComputerEvent(this.store.bus, taskId, 'computer.action.dry_run', 'info', { capability: input.capability, operation: input.operation });
      const result = this.dispatch(input, taskId);
      return result; // controllers return dry-run results without side effects
    }

    emitComputerEvent(this.store.bus, taskId, `computer.${input.capability}.${input.operation}.started`, 'info', { operation: input.operation });
    const result = this.dispatch(input, taskId);

    entry.status = result.success ? 'executed' : 'failed';
    entry.durationMs = result.durationMs;
    entry.result = result.success ? 'ok' : result.error;
    this.audit(entry);
    emitComputerEvent(this.store.bus, taskId, `computer.${input.capability}.${input.operation}.completed`, result.success ? 'info' : 'error', { durationMs: result.durationMs, success: result.success });
    return result;
  }

  private dispatch(input: ComputerActionInput, taskId: string | null): ActionResult {
    const args = (input.args ?? {}) as never;
    const dry = input.dryRun ?? false;
    switch (input.capability) {
      case 'terminal':
        if (input.operation === 'run') return this.terminal.run({ command: String((args as { command?: string }).command ?? ''), ...(args as object) } as never, dry);
        break;
      case 'filesystem': {
        const fsOp = this.filesystem as unknown as Record<string, (a: never, d?: boolean) => ActionResult>;
        const fn = fsOp[input.operation];
        if (fn) return fn.call(this.filesystem, args, dry);
        break;
      }
      case 'applications': {
        const appOp = this.applications as unknown as Record<string, (a: never, d?: boolean) => ActionResult>;
        const fn = appOp[input.operation];
        if (fn) return fn.call(this.applications, args, dry);
        break;
      }
      case 'clipboard': {
        const cbOp = this.clipboard as unknown as Record<string, (a: never) => ActionResult>;
        const fn = cbOp[input.operation];
        if (fn) return fn.call(this.clipboard, args);
        break;
      }
      case 'screen':
        if (input.operation === 'capture') return this.screen.capture((args as { displayId?: number }) ?? {});
        break;
      case 'keyboard': {
        const kbOp = this.keyboard as unknown as Record<string, (a: never, d?: boolean) => ActionResult>;
        const fn = kbOp[input.operation];
        if (fn) return fn.call(this.keyboard, args, dry);
        break;
      }
      case 'mouse': {
        const mOp = this.mouse as unknown as Record<string, (a: never, d?: boolean) => ActionResult>;
        const fn = mOp[input.operation];
        if (fn) return fn.call(this.mouse, args, dry);
        break;
      }
    }
    return { success: false, tool: input.capability, action: input.operation, durationMs: 0, error: `unknown operation: ${input.capability}.${input.operation}` };
  }
}
