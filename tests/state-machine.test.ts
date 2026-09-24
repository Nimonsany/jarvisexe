import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TaskStore } from '../packages/core/src/task/store.js';
import { assertTransition } from '../packages/core/src/task/types.js';

test('legal transitions pass, illegal transition throws', () => {
  assert.doesNotThrow(() => assertTransition('NEW', 'PLANNING'));
  assert.doesNotThrow(() => assertTransition('VERIFYING', 'COMPLETED'));
  assert.throws(() => assertTransition('COMPLETED', 'EXECUTING'));
  assert.throws(() => assertTransition('NEW', 'EXECUTING'));
});

test('task lifecycle persists and survives reload', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-test-'));
  try {
    const store = new TaskStore(dir);
    const task = await store.create('build a thing', '/tmp/proj');
    assert.equal(task.id, 'TASK-000001');
    for (const s of ['PLANNING', 'WAITING_FOR_CHATGPT', 'PLAN_RECEIVED', 'PREPARING_EXECUTION', 'EXECUTING', 'MONITORING', 'TESTING', 'VERIFYING'] as const) {
      await store.transition(task, s);
    }
    await store.transition(task, 'COMPLETED');
    const reloaded = await new TaskStore(dir).load(task.id);
    assert.equal(reloaded.status, 'COMPLETED');
    assert.equal(reloaded.owner_request, 'build a thing');
    assert.equal((await new TaskStore(dir).listIncomplete()).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('incomplete tasks are listed for crash recovery', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-test-'));
  try {
    const store = new TaskStore(dir);
    const t = await store.create('interrupted', '/tmp/proj2');
    await store.transition(t, 'PLANNING');
    const incomplete = await store.listIncomplete();
    assert.equal(incomplete.length, 1);
    assert.equal(incomplete[0].status, 'PLANNING');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
