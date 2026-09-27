import type { Task, TaskEvent, Health, Settings, ProjectInfo } from '../types';

const BASE = 'http://127.0.0.1:7788';
let authToken: string | null = null;

/** Fetch the per-install token from the bootstrap endpoint (allowed origins only).
 *  The token is never logged and never placed in URLs (except SSE, see below). */
async function ensureToken(): Promise<string> {
  if (authToken) return authToken;
  const r = await fetch(`${BASE}/api/bootstrap`);
  if (!r.ok) throw new Error('bootstrap failed');
  authToken = ((await r.json()) as { token: string }).token;
  return authToken;
}

async function req<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const token = await ensureToken();
  const r = await fetch(`${BASE}${path}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  });
  if (!r.ok) {
    if (r.status === 401) authToken = null; // token rotated — refetch next call
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error((err as { error: string }).error);
  }
  return r.json() as Promise<T>;
}

/** The only bridge between the UI and JARVIS Core. The UI never knows
 *  about Playwright, ChatGPT DOM selectors, OpenCode CLI, subprocesses,
 *  or computer-controller internals. */
export const JarvisClient = {
  createTask: (request: string, project?: string) => req<Task>('/api/task', 'POST', { request, project }),
  getTask: (id: string) => req<{ task: Task; events: TaskEvent[] }>(`/api/task/${id}`),
  listTasks: () => req<Task[]>('/api/tasks'),
  pauseTask: (id: string) => req<Task>(`/api/task/${id}/pause`, 'POST'),
  resumeTask: (id: string) => req<Task>(`/api/task/${id}/resume`, 'POST'),
  cancelTask: (id: string) => req<Task>(`/api/task/${id}/cancel`, 'POST'),
  getSettings: () => req<Settings>('/api/settings'),
  updateSettings: (s: Partial<Settings>) => req<Settings>('/api/settings', 'POST', s),
  listProjects: () => req<ProjectInfo[]>('/api/projects'),
  openProject: (path: string) => req<{ ok: boolean }>('/api/project/open', 'POST', { path }),
  openChatGPTLogin: () => req<{ ok: boolean }>('/api/chatgpt/login', 'POST'),
  health: () => req<Health>('/api/health'),
  listApprovals: () => req<import('../types').PendingApproval[]>('/api/approvals'),
  decideApproval: (id: string, approved: boolean) => req<import('../types').PendingApproval>(`/api/approvals/${id}/${approved ? 'approve' : 'reject'}`, 'POST'),
  emergencyStop: () => req<{ stopped: boolean; killedProcesses: number; cancelledTasks: string[] }>('/api/emergency-stop', 'POST'),
  getEmergencyStop: () => req<{ stopped: boolean }>('/api/emergency-stop'),
  clearEmergencyStop: () => req<{ stopped: boolean }>('/api/emergency-stop/clear', 'POST'),
  securityAudit: () => req<{ chain: { ok: boolean; entries: number }; entries: unknown[] }>('/api/security-audit'),
  voiceStatus: () => req<{ whisper: boolean; model: boolean; mics: { index: number; name: string }[] }>('/api/voice/status'),
  pushToTalk: (durationMs = 8000, deviceIndex?: number) => req<{ text: string; language: string; command: string | null }>('/api/voice/push-to-talk', 'POST', { durationMs, deviceIndex }),
  speak: (text: string) => req<{ ok: boolean; voice: string }>('/api/voice/speak', 'POST', { text }),

  /** Subscribe to live task events (SSE). Auth via ?token= — EventSource cannot
   *  send headers; documented practical exception, token never logged. */
  subscribeToEvents(onEvent: (e: TaskEvent) => void): () => void {
    let es: EventSource | null = null;
    let closed = false;
    void ensureToken().then((token) => {
      if (closed) return;
      es = new EventSource(`${BASE}/api/events?token=${token}`);
      es.onmessage = (m) => {
        try { onEvent(JSON.parse(m.data) as TaskEvent); } catch { /* malformed event */ }
      };
    });
    return () => { closed = true; es?.close(); };
  },
};
