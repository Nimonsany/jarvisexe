export type TaskStatus =
  | 'NEW' | 'PLANNING' | 'WAITING_FOR_CHATGPT' | 'PLAN_RECEIVED' | 'PREPARING_EXECUTION'
  | 'EXECUTING' | 'MONITORING' | 'TESTING' | 'VERIFYING' | 'DEBUGGING'
  | 'WAITING_FOR_OWNER' | 'PAUSED' | 'FAILED' | 'COMPLETED' | 'CANCELLED';

export interface Task {
  id: string;
  owner_request: string;
  created_at: string;
  updated_at: string;
  status: TaskStatus;
  current_phase: string;
  project_directory: string;
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

export interface Health {
  core: 'online';
  opencode: 'ready' | 'missing';
  chatgptProfile: 'ready' | 'missing';
  chatgptLogin: 'ok' | 'required' | 'unknown' | 'checking';
  storage: 'ready' | 'error';
}

export interface Settings {
  defaultProjectDir: string;
  opencodeBin: string;
  browserChannel: string;
  headless: boolean;
  autoConsultThreshold: number;
  maxRetries: number;
  finalReview: boolean;
  startMinimized: boolean;
  theme: 'dark' | 'light';
  logVerbosity: 'quiet' | 'normal' | 'verbose';
}

export interface ProjectInfo {
  path: string;
  latestTask?: string;
  status?: string;
}

export interface PendingApproval {
  id: string;
  taskId: string | null;
  capability: string;
  operation: string;
  argumentsSummary: string;
  riskLevel: string;
  level: number;
  reason: string;
  requestedAt: string;
  status: 'pending' | 'approved' | 'rejected';
  decidedAt?: string;
}

// Authoritative backend states → display form. No frontend state machine.
export const STATUS_DISPLAY: Record<TaskStatus, { label: string; mark: 'done' | 'active' | 'pending' | 'bad' }> = {
  NEW: { label: 'New', mark: 'pending' },
  PLANNING: { label: 'Planning with ChatGPT', mark: 'active' },
  WAITING_FOR_CHATGPT: { label: 'Waiting for ChatGPT', mark: 'active' },
  PLAN_RECEIVED: { label: 'Plan received', mark: 'done' },
  PREPARING_EXECUTION: { label: 'Preparing execution', mark: 'active' },
  EXECUTING: { label: 'OpenCode execution', mark: 'active' },
  MONITORING: { label: 'Monitoring', mark: 'active' },
  TESTING: { label: 'Testing', mark: 'active' },
  VERIFYING: { label: 'Verification', mark: 'active' },
  DEBUGGING: { label: 'Debugging', mark: 'active' },
  WAITING_FOR_OWNER: { label: 'Waiting for you', mark: 'active' },
  PAUSED: { label: 'Paused', mark: 'pending' },
  FAILED: { label: 'Failed', mark: 'bad' },
  COMPLETED: { label: 'Completed', mark: 'done' },
  CANCELLED: { label: 'Cancelled', mark: 'bad' },
};

// Pipeline steps shown on the dashboard
export const PIPELINE: TaskStatus[] = ['PLANNING', 'EXECUTING', 'TESTING', 'VERIFYING'];

export function pipelineMark(task: Task | null, step: TaskStatus): 'done' | 'active' | 'pending' | 'bad' {
  if (!task) return 'pending';
  if (task.status === 'FAILED' || task.status === 'CANCELLED') return 'bad';
  const order: TaskStatus[] = ['PLANNING', 'WAITING_FOR_CHATGPT', 'PLAN_RECEIVED', 'PREPARING_EXECUTION', 'EXECUTING', 'MONITORING', 'TESTING', 'VERIFYING', 'COMPLETED'];
  const cur = order.indexOf(task.status === 'DEBUGGING' ? 'EXECUTING' : task.status);
  const idx = order.indexOf(step);
  if (cur > idx) return 'done';
  if (cur === idx) return 'active';
  return 'pending';
}
