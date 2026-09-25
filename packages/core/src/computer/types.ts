import type { TaskStore } from '../task/store.js';
import type { TaskEvent } from '../task/types.js';

export type Capability = 'terminal' | 'filesystem' | 'applications' | 'clipboard' | 'screen' | 'keyboard' | 'mouse';
export type PermissionCategory = 'READ' | 'SAFE_WRITE' | 'EXECUTE' | 'UI_AUTOMATION' | 'DESTRUCTIVE';

export interface ComputerActionInput {
  capability: Capability;
  operation: string;
  args?: Record<string, unknown>;
  /** explicit task justification for operations outside the project scope */
  justified?: boolean;
  /** explicit owner confirmation for DESTRUCTIVE ops (permanent delete) */
  ownerConfirmed?: boolean;
  dryRun?: boolean;
}

export interface ActionResult {
  success: boolean;
  tool: Capability;
  action: string;
  durationMs: number;
  metadata?: Record<string, unknown>;
  error?: string;
}

export interface AuditedAction {
  actionId: string;
  taskId: string | null;
  timestamp: string;
  capability: Capability;
  operation: string;
  argumentsSummary: string;   // sanitized, never contains secrets
  riskLevel: PermissionCategory;
  requiresApproval: boolean;
  status: 'allowed' | 'denied' | 'executed' | 'failed' | 'dry-run';
  result?: string;
  durationMs?: number;
  error?: string;
}

export function emitComputerEvent(
  bus: TaskStore['bus'],
  taskId: string | null,
  event: string,
  severity: TaskEvent['severity'],
  data?: Record<string, unknown>,
): void {
  const e: TaskEvent = {
    timestamp: new Date().toISOString(),
    task_id: taskId ?? 'TASK-NONE',
    component: 'computer',
    event,
    severity,
    ...(data ? { data } : {}),
  };
  bus.emit('event', e);
}
