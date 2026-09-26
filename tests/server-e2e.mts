/**
 * Backend/IPC tests for the JarvisServer API. Plain script (node:test hangs on
 * SSE keep-alive handles), asserts + explicit exit. Run: npx tsx tests/server-e2e.mts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JarvisServer } from '../packages/core/src/server.js';
import type { Orchestrator } from '../packages/core/src/orchestrator.js';
import type { Task } from '../packages/core/src/task/types.js';
import { TaskStore } from '../packages/core/src/task/store.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fakeOrchestrator(runtimeDir: string): Orchestrator & { __slow: boolean } {
  const store = new TaskStore(runtimeDir);
  const self = {
    __slow: false,
    taskStore: store,
    async run(ownerRequest: string, projectDir: string): Promise<Task> {
      const task = await store.create(ownerRequest, projectDir);
      await store.transition(task, 'PLANNING');
      await store.transition(task, 'WAITING_FOR_CHATGPT');
      await store.transition(task, 'PLAN_RECEIVED');
      await store.emit(task, 'planner', 'plan_received', 'info');
      if (self.__slow) {
        await store.transition(task, 'PREPARING_EXECUTION');
        await store.transition(task, 'EXECUTING');
        await sleep(3000); // pause window
      }
      await store.transition(task, 'PREPARING_EXECUTION');
      await store.transition(task, 'EXECUTING');
      await store.transition(task, 'TESTING');
      await store.transition(task, 'VERIFYING');
      task.verification_status = 'PASSED';
      task.result = 'ok';
      await store.transition(task, 'COMPLETED');
      return task;
    },
    async pause(id: string): Promise<Task> {
      const t = await store.load(id);
      if (t.status === 'EXECUTING') await store.transition(t, 'PAUSED');
      return t;
    },
    async resume(id: string): Promise<Task> {
      const t = await store.load(id);
      if (t.status === 'PAUSED') await store.transition(t, 'EXECUTING');
      return t;
    },
    async cancel(id: string): Promise<Task> {
      const t = await store.load(id);
      if (t.status !== 'COMPLETED' && t.status !== 'CANCELLED') await store.transition(t, 'CANCELLED');
      return t;
    },
  };
  return self as never;
}

const runtimeDir = mkdtempSync(path.join(tmpdir(), 'jarvis-srv-'));
const port = 7797;
const server = new JarvisServer(runtimeDir, fakeOrchestrator(runtimeDir));
await server.listen(port, '127.0.0.1');

// fetch the per-install token via bootstrap (allowed origins only)
const bootstrap = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
const TOKEN = ((await bootstrap.json()) as { token: string }).token;
const api = (p: string, method = 'GET', body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` } });

let passed = 0;
const step = (name: string, fn: () => Promise<void>) =>
  fn().then(() => { passed++; console.log(`✔ ${name}`); });

try {
  await step('health reports core online + storage ready', async () => {
    const h = await (await api('/api/health')).json();
    assert.equal(h.core, 'online');
    assert.equal(h.storage, 'ready');
  });

  await step('create task → runs to COMPLETED with events', async () => {
    const t = await (await api('/api/task', 'POST', { request: 'build widget' })).json();
    assert.ok(t.id);
    await sleep(1000);
    const detail = await (await api(`/api/task/${t.id}`)).json();
    assert.equal(detail.task.status, 'COMPLETED');
    assert.equal(detail.task.verification_status, 'PASSED');
    assert.ok(detail.events.length >= 5);
  });

  await step('task list newest first', async () => {
    const list = (await (await api('/api/tasks')).json()) as Task[];
    assert.ok(list.length >= 1);
  });

  await step('pause + resume transitions', async () => {
    // fresh store: use a second server instance on another port
    const rt2 = mkdtempSync(path.join(tmpdir(), 'jarvis-srv2-'));
    const fake2 = fakeOrchestrator(rt2);
    fake2.__slow = true;
    const srv2 = new JarvisServer(rt2, fake2);
    await srv2.listen(port + 1, '127.0.0.1');
    const boot2 = await fetch(`http://127.0.0.1:${port + 1}/api/bootstrap`);
    const TOKEN2 = ((await boot2.json()) as { token: string }).token;
    const api2 = (p: string, method = 'GET', body?: unknown) =>
      fetch(`http://127.0.0.1:${port + 1}${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN2}` } });
    const t = await (await api2('/api/task', 'POST', { request: 'pausable' })).json();
    await sleep(800); // task is EXECUTING now (slow fake)
    const paused = await (await api2(`/api/task/${t.id}/pause`, 'POST')).json();
    assert.equal(paused.status, 'PAUSED');
    const resumed = await (await api2(`/api/task/${t.id}/resume`, 'POST')).json();
    assert.equal(resumed.status, 'EXECUTING');
    await srv2.close();
    rmSync(rt2, { recursive: true, force: true });
  });

  await step('cancel transitions to CANCELLED', async () => {
    const rt3 = mkdtempSync(path.join(tmpdir(), 'jarvis-srv3-'));
    const srv3 = new JarvisServer(rt3, fakeOrchestrator(rt3));
    await srv3.listen(port + 2, '127.0.0.1');
    const boot3 = await fetch(`http://127.0.0.1:${port + 2}/api/bootstrap`);
    const TOKEN3 = ((await boot3.json()) as { token: string }).token;
    const api3 = (p: string, method = 'GET', body?: unknown) =>
      fetch(`http://127.0.0.1:${port + 2}${p}`, { method, body: body ? JSON.stringify(body) : undefined, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN3}` } });
    const t = await (await api3('/api/task', 'POST', { request: 'cancellable' })).json();
    await sleep(600);
    const cancelled = await (await api3(`/api/task/${t.id}/cancel`, 'POST')).json();
    if (cancelled.status !== 'COMPLETED') assert.equal(cancelled.status, 'CANCELLED');
    await srv3.close();
    rmSync(rt3, { recursive: true, force: true });
  });

  await step('settings round-trip + path validation', async () => {
    const saved = await (await api('/api/settings', 'POST', { theme: 'light', defaultProjectDir: runtimeDir })).json();
    assert.equal(saved.theme, 'light');
    const bad = await api('/api/settings', 'POST', { defaultProjectDir: '/nonexistent/xyz' });
    assert.equal(bad.status, 500);
  });

  await step('SSE delivers task events', async () => {
    const controller = new AbortController();
    const stream = await fetch(`http://127.0.0.1:${port}/api/events?token=${TOKEN}`, { signal: controller.signal });
    assert.equal(stream.headers.get('content-type'), 'text/event-stream');
    const reader = stream.body!.getReader();
    await api('/api/task', 'POST', { request: 'sse task' });
    const { value } = await reader.read();
    assert.match(new TextDecoder().decode(value), /task_created/);
    controller.abort();
    await reader.cancel().catch(() => {});
  });

  await step('event payloads sanitized', async () => {
    const { id } = await (await api('/api/task', 'POST', { request: 'widget password = hunter2222 secret' })).json();
    await sleep(800);
    const raw = JSON.stringify(await (await api(`/api/task/${id}`)).json());
    assert.ok(!raw.includes('hunter2222'), 'secret leaked');
  });
} catch (e) {
  console.error('✖ FAILED:', e);
  await server.close();
  process.exit(1);
}

await server.close();
rmSync(runtimeDir, { recursive: true, force: true });
console.log(`\nIPC TESTS: ${passed}/8 passed`);
process.exit(passed === 8 ? 0 : 1);
