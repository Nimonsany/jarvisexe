import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Orchestrator } from '../packages/core/src/orchestrator.js';
import { TaskStore } from '../packages/core/src/task/store.js';

const PLAN = `=== OPENCODE MASTER PROMPT ===
Build the feature phase by phase, run the tests after each phase, and report the results honestly.
===`;

/** Fresh orchestrator with a fake ChatGPT (no browser) and a stubbed
 *  runLoopInBackground so resume() stops at EXECUTING + execution start. */
function makeOrch() {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), 'jarvis-attempt-'));
  const orch = new Orchestrator({
    runtimeDir,
    plannerPromptTemplate: 'Plan for: {{OWNER_REQUEST}}',
    opencodeRules: 'RULES',
    headless: true,
  });
  let askImpl: () => Promise<string> = async () => PLAN;
  let askCalls = 0;
  let abortCalls = 0;
  let launchCalls = 0;
  (orch as any).chatgpt = {
    ask: () => { askCalls++; return askImpl(); },
    abort: async () => { abortCalls++; },
    launch: async () => { launchCalls++; },
    close: async () => {},
  };
  let starts = 0;
  (orch as any).runLoopInBackground = () => { starts++; };
  return {
    orch,
    runtimeDir,
    store: orch.taskStore as TaskStore,
    getAskCalls: () => askCalls,
    getAbortCalls: () => abortCalls,
    getLaunchCalls: () => launchCalls,
    getStarts: () => starts,
    setAsk: (fn: () => Promise<string>) => { askImpl = fn; },
    cleanup: () => rmSync(runtimeDir, { recursive: true, force: true }),
  };
}

/** Task parked in WAITING_FOR_CHATGPT (mid-planning), as T7 pauses it. */
async function planningTask(h: ReturnType<typeof makeOrch>) {
  const task = await h.store.create('do the thing', '/tmp/proj');
  await h.store.transition(task, 'PLANNING');
  await h.store.transition(task, 'WAITING_FOR_CHATGPT');
  return task;
}

function attemptIds(events: { event: string; data?: Record<string, unknown> }[]): number[] {
  return events
    .filter((e) => e.event === 'resume_replan_from_pause')
    .map((e) => e.data!.attemptId as number);
}

test('A: valid resumed plan is accepted, not classified stale, execution starts once', async () => {
  const h = makeOrch();
  try {
    const task = await planningTask(h);
    await h.orch.pause(task.id); // pause during WAITING_FOR_CHATGPT
    assert.equal(h.getAbortCalls(), 1, 'pause during planning must abort the in-flight ask');

    const resumed = await h.orch.resume(task.id);
    const events = await h.store.events(task.id);

    assert.equal(resumed.status, 'EXECUTING', 'fresh resumed plan must transition to EXECUTING');
    assert.equal(h.getLaunchCalls(), 1, 'Branch A must relaunch the browser before the fresh ask');
    assert.equal(h.getStarts(), 1, 'OpenCode execution must start exactly once');
    assert.ok(
      !events.some((e) => e.event === 'planner_response_stale'),
      'valid resumed response must not emit planner_response_stale',
    );
    assert.equal(attemptIds(events).length, 1, 'one Branch-A replan recorded');
    assert.ok(existsSync(path.join(h.store.taskDir(task.id), 'chatgpt-plan.md')), 'plan file written');
  } finally {
    h.cleanup();
  }
});

test('B: stale superseded response rejected before write; recovery starts exactly once', async () => {
  const h = makeOrch();
  try {
    const task = await planningTask(h);
    const dir = h.store.taskDir(task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'chatgpt-plan.md'), 'ORIGINAL PLAN');

    await h.orch.pause(task.id); // generation 0 -> 1

    // in-flight Branch-A ask (attempt 2) that resolves only when we say so
    let release!: (v: string) => void;
    h.setAsk(() => new Promise<string>((r) => { release = r; }));
    const first = h.orch.resume(task.id);
    await new Promise((r) => setTimeout(r, 20)); // let resume reach the ask

    // a newer generation supersedes attempt 2 (what pause() invalidation does)
    (h.orch as any).planningAttemptId.set(task.id, 3);

    release('STALE PLAN CONTENT');
    await first;

    const afterStale = await h.store.events(task.id);
    assert.ok(
      afterStale.some((e) => e.event === 'planner_response_stale'),
      'stale response must emit planner_response_stale',
    );
    assert.equal(
      readFileSync(path.join(dir, 'chatgpt-plan.md'), 'utf8'),
      'ORIGINAL PLAN',
      'stale response must not overwrite chatgpt-plan.md',
    );
    assert.equal(h.getStarts(), 0, 'stale response must not start execution');

    // recovery: a current attempt succeeds
    h.setAsk(async () => PLAN);
    const resumed = await h.orch.resume(task.id);
    assert.equal(resumed.status, 'EXECUTING');
    assert.equal(h.getStarts(), 1, 'execution starts exactly once after recovery');
    assert.equal(
      readFileSync(path.join(dir, 'chatgpt-plan.md'), 'utf8'),
      PLAN,
      'current response writes the plan',
    );
  } finally {
    h.cleanup();
  }
});

test('C: attempt IDs monotonic across multiple pause/resume cycles, never reset/reused', async () => {
  const h = makeOrch();
  try {
    const task = await planningTask(h);

    await h.orch.pause(task.id);          // generation 0 -> 1
    await h.orch.resume(task.id);         // Branch A: attempt 2, EXECUTING

    // back into planning for a second cycle (legal transitions only);
    // reload — resume() persisted a newer status than our local copy
    const t2 = await h.store.load(task.id);
    assert.equal(t2.status, 'EXECUTING');
    await h.store.transition(t2, 'DEBUGGING');
    await h.store.transition(t2, 'WAITING_FOR_CHATGPT');

    await h.orch.pause(task.id);          // must invalidate 2 -> 3, NOT reset to 0
    await h.orch.resume(task.id);         // Branch A: attempt 4

    const ids = attemptIds(await h.store.events(task.id));
    assert.equal(ids.length, 2, 'two Branch-A replans recorded');
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i] > ids[i - 1], `attempt IDs must strictly increase: ${ids.join(',')}`);
    }
    assert.deepEqual(ids, [2, 4], 'expected progression 2 -> 4 with no reset/reuse');
    assert.equal(h.getStarts(), 2, 'one execution start per accepted cycle');
    assert.equal(h.getAbortCalls(), 2, 'each planning pause aborts the in-flight ask');
    assert.equal(h.getLaunchCalls(), 2, 'each Branch-A resume relaunches the browser');
  } finally {
    h.cleanup();
  }
});

test('D: Branch B (pause outside planning) keeps original plan-file resume path', async () => {
  const h = makeOrch();
  try {
    const task = await h.store.create('executing task', '/tmp/proj');
    await h.store.transition(task, 'PLANNING');
    await h.store.transition(task, 'WAITING_FOR_CHATGPT');
    await h.store.transition(task, 'PLAN_RECEIVED');
    await h.store.transition(task, 'PREPARING_EXECUTION');
    await h.store.transition(task, 'EXECUTING');
    const dir = h.store.taskDir(task.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'chatgpt-plan.md'), PLAN);

    await h.orch.pause(task.id); // NOT during planning -> Branch B
    const resumed = await h.orch.resume(task.id);
    const events = await h.store.events(task.id);

    assert.equal(resumed.status, 'EXECUTING', 'Branch B resumes via existing plan file');
    assert.equal(h.getStarts(), 1, 'execution starts once');
    assert.equal(
      events.filter((e) => e.event === 'resume_replan_from_pause').length,
      0,
      'Branch B must not trigger a fresh ChatGPT replan',
    );
    assert.equal(
      events.filter((e) => e.event === 'planner_response_stale').length,
      0,
      'Branch B with matching attempt must not be rejected stale',
    );
    assert.equal(readFileSync(path.join(dir, 'chatgpt-plan.md'), 'utf8'), PLAN, 'plan file untouched');
    assert.equal(h.getAbortCalls(), 0, 'pause outside planning must not touch the browser');
    assert.equal(h.getLaunchCalls(), 0, 'Branch B needs no browser (plan file only)');
  } finally {
    h.cleanup();
  }
});
