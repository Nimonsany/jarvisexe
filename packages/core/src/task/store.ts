import { mkdirSync} from 'node:fs';
import { readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Task, TaskEvent, TaskStatus } from './types.js';
import { assertTransition } from './types.js';

export class TaskStore {
  constructor(private runtimeDir: string) {
    mkdirSync(path.join(runtimeDir, 'tasks'), { recursive: true });
  }

  private dir(taskId: string) {
    return path.join(this.runtimeDir, 'tasks', taskId);
  }

  async create(ownerRequest: string, projectDir: string): Promise<Task> {
    const existing = existsSync(path.join(this.runtimeDir, 'tasks'))
      ? await readdir(path.join(this.runtimeDir, 'tasks'))
      : [];
    const seq = existing.length + 1;
    const id = `TASK-${String(seq).padStart(6, '0')}`;
    const now = new Date().toISOString();
    const task: Task = {
      id,
      owner_request: ownerRequest,
      created_at: now,
      updated_at: now,
      status: 'NEW',
      current_phase: 'created',
      project_directory: projectDir,
      chatgpt_session: null,
      opencode_session: null,
      retry_count: 0,
      chatgpt_cycle_count: 0,
      last_error: null,
      result: null,
      verification_status: 'UNVERIFIED',
    };
    mkdirSync(this.dir(id), { recursive: true });
    await this.save(task);
    await writeFile(path.join(this.dir(id), 'owner-request.md'), ownerRequest);
    await this.emit(task, 'core', 'task_created', 'info', { request: ownerRequest });
    return task;
  }

  async save(task: Task): Promise<void> {
    task.updated_at = new Date().toISOString();
    // atomic-ish: write tmp then rename
    const file = path.join(this.dir(task.id), 'status.json');
    await writeFile(file + '.tmp', JSON.stringify(task, null, 2));
    await writeFile(file, JSON.stringify(task, null, 2));
  }

  async transition(task: Task, to: TaskStatus, component = 'core'): Promise<void> {
    assertTransition(task.status, to);
    const from = task.status;
    task.status = to;
    await this.save(task);
    await this.emit(task, component, `state_${from.toLowerCase()}_to_${to.toLowerCase()}`, 'info');
  }

  async emit(task: Task, component: string, event: string, severity: TaskEvent['severity'], data?: Record<string, unknown>): Promise<void> {
    const e: TaskEvent = { timestamp: new Date().toISOString(), task_id: task.id, component, event, severity, ...(data ? { data } : {}) };
    await appendFile(path.join(this.dir(task.id), 'events.jsonl'), JSON.stringify(e) + '\n');
    const line = `[${e.timestamp.slice(11, 19)}] [${component}] ${event}`;
    console.log(severity === 'error' ? `\x1b[31m${line}\x1b[0m` : line);
  }

  async load(taskId: string): Promise<Task> {
    const raw = await readFile(path.join(this.dir(taskId), 'status.json'), 'utf8');
    return JSON.parse(raw) as Task;
  }

  async listIncomplete(): Promise<Task[]> {
    const dir = path.join(this.runtimeDir, 'tasks');
    if (!existsSync(dir)) return [];
    const out: Task[] = [];
    for (const name of await readdir(dir)) {
      try {
        const t = await this.load(name);
        if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(t.status)) out.push(t);
      } catch { /* skip corrupt entries */ }
    }
    return out;
  }

  taskDir(taskId: string) {
    return this.dir(taskId);
  }
}
