export type TaskStatus =
  | 'NEW'
  | 'PLANNING'
  | 'WAITING_FOR_CHATGPT'
  | 'PLAN_RECEIVED'
  | 'PREPARING_EXECUTION'
  | 'EXECUTING'
  | 'MONITORING'
  | 'TESTING'
  | 'VERIFYING'
  | 'DEBUGGING'
  | 'WAITING_FOR_OWNER'
  | 'PAUSED'
  | 'FAILED'
  | 'COMPLETED'
  | 'CANCELLED';

export interface Task {
  id: string;
  owner_request: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  current_phase: string;
  project_directory: string;
  chatgpt_session: string | null;
  opencode_session: string | null;
  retry_count: number;
  chatgpt_cycle_count: number;
  last_error: string | null;
  result: string | null;
  verification_status: 'UNVERIFIED' | 'PASSED' | 'FAILED';
}

export interface TaskEvent {
  timestamp: string;
  task_id: string;
  component: string;
  event: string;
  severity: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}

// Allowed transitions — everything else throws.
// (Every active state may go PAUSED: boot recovery marks interrupted tasks PAUSED
//  — FR-12 — and the user resumes from there.)
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  NEW: ['PLANNING', 'PAUSED', 'CANCELLED'],
  PLANNING: ['WAITING_FOR_CHATGPT', 'PAUSED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_CHATGPT: ['PLAN_RECEIVED', 'WAITING_FOR_OWNER', 'PAUSED', 'FAILED', 'CANCELLED'],
  PLAN_RECEIVED: ['PREPARING_EXECUTION', 'PAUSED', 'FAILED', 'CANCELLED'],
  PREPARING_EXECUTION: ['EXECUTING', 'PAUSED', 'FAILED', 'CANCELLED'],
  EXECUTING: ['MONITORING', 'TESTING', 'DEBUGGING', 'FAILED', 'CANCELLED', 'PAUSED'],
  MONITORING: ['TESTING', 'DEBUGGING', 'FAILED', 'CANCELLED', 'PAUSED'],
  TESTING: ['VERIFYING', 'DEBUGGING', 'PAUSED', 'FAILED', 'CANCELLED'],
  VERIFYING: ['COMPLETED', 'DEBUGGING', 'PAUSED', 'FAILED', 'CANCELLED'],
  DEBUGGING: ['WAITING_FOR_CHATGPT', 'EXECUTING', 'WAITING_FOR_OWNER', 'PAUSED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_OWNER: ['PLANNING', 'EXECUTING', 'CANCELLED', 'FAILED'],
  PAUSED: ['EXECUTING', 'MONITORING', 'CANCELLED'],
  FAILED: ['PLANNING', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal task transition ${from} -> ${to}`);
  }
}
