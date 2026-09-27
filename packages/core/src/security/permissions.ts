import { randomUUID } from 'node:crypto';
import type { TaskStore } from '../task/store.js';
import type { PermissionCategory } from '../computer/types.js';
import { emitComputerEvent } from '../computer/types.js';

/** Permission levels (master mission Phase 10):
 *  0 READ · 1 SAFE EXECUTION · 2 SYSTEM MODIFICATION · 3 ADMIN PRIVILEGE ·
 *  4 CONSEQUENTIAL ACTION (always explicit owner confirmation). */
export type PermissionLevel = 0 | 1 | 2 | 3 | 4;

export const CATEGORY_LEVEL: Record<PermissionCategory, PermissionLevel> = {
  READ: 0,
  SAFE_WRITE: 1,
  EXECUTE: 1,
  UI_AUTOMATION: 1,
  DESTRUCTIVE: 4,
};

export interface PendingApproval {
  id: string;
  taskId: string | null;
  capability: string;
  operation: string;
  argumentsSummary: string;
  riskLevel: PermissionCategory;
  level: PermissionLevel;
  reason: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: string;
}

/**
 * Owner-confirmation flow: approval-required actions become PendingApprovals;
 * they execute ONLY after an explicit owner decision. Nothing here is automatic.
 */
export class ApprovalQueue {
  private pending = new Map<string, PendingApproval>();
  private waiters = new Map<string, (approved: boolean) => void>();

  constructor(private store: TaskStore) {}

  /** Create an approval request and wait for the owner's decision. */
  request(input: {
    taskId: string | null;
    capability: string;
    operation: string;
    argumentsSummary: string;
    riskLevel: PermissionCategory;
    reason: string;
  }): Promise<boolean> {
    const level = CATEGORY_LEVEL[input.riskLevel] ?? 4;
    const approval: PendingApproval = {
      id: randomUUID().slice(0, 8),
      ...input,
      level,
      requestedAt: new Date().toISOString(),
      status: 'pending',
    };
    this.pending.set(approval.id, approval);
    emitComputerEvent(this.store.bus, input.taskId, 'approval.requested', 'warning', {
      approvalId: approval.id, capability: approval.capability, operation: approval.operation, level,
    });
    return new Promise((resolve) => {
      this.waiters.set(approval.id, resolve);
      // auto-reject after 10 minutes so nothing hangs forever
      setTimeout(() => {
        if (this.pending.get(approval.id)?.status === 'pending') {
          this.decide(approval.id, false);
        }
      }, 600_000).unref?.();
    });
  }

  /** Owner decision. */
  decide(id: string, approved: boolean): PendingApproval | null {
    const a = this.pending.get(id);
    if (!a || a.status !== 'pending') return null;
    a.status = approved ? 'approved' : 'rejected';
    a.decidedAt = new Date().toISOString();
    emitComputerEvent(this.store.bus, a.taskId, approved ? 'approval.granted' : 'approval.rejected', approved ? 'info' : 'warning', { approvalId: id, operation: a.operation });
    const resolve = this.waiters.get(id);
    this.waiters.delete(id);
    resolve?.(approved);
    return a;
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
  }

  pendingCount(): number {
    return [...this.pending.values()].filter((a) => a.status === 'pending').length;
  }
}
