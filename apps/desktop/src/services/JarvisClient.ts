import type { Task, TaskEvent, Health, Settings, ProjectInfo } from '../types';

const BASE = 'http://127.0.0.1:7788';

async function req<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ error: r.statusText }));
    throw new Error((err as { error: string }).error);
  }
  return r.json() as Promise<T>;
}

/** The only bridge between the UI and JARVIS Core. The UI never knows
 *  about Playwright, ChatGPT DOM selectors, OpenCode CLI or subprocesses. */
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

  /** Subscribe to live task events (SSE). Returns unsubscribe. */
  subscribeToEvents(onEvent: (e: TaskEvent) => void): () => void {
    const es = new EventSource(`${BASE}/api/events`);
    es.onmessage = (m) => {
      try { onEvent(JSON.parse(m.data) as TaskEvent); } catch { /* malformed event */ }
    };
    return () => es.close();
  },
};
