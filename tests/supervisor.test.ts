import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Supervisor, MAX_SELF_REPAIRS, formatIncident } from '../packages/core/src/supervisor/supervisor.js';
import type { Task } from '../packages/core/src/task/types.js';

function fakeTask(cycles = 0): Task {
  return {
    id: 'TASK-1', owner_request: 'calc', created_at: '', updated_at: '',
    status: 'MONITORING', current_phase: 'build', project_directory: '/tmp/x',
    chatgpt_session: null, opencode_session: 's1', retry_count: 0,
    chatgpt_cycle_count: cycles, last_error: null, result: null, verification_status: 'UNVERIFIED',
  };
}

const failureOut = ['compiling...', 'Error: test calculator failed: expected 2 got 3'];

test('success output → ok', () => {
  const s = new Supervisor();
  assert.equal(s.decide(fakeTask(), ['all 12 tests passed ✓'], 0).kind, 'ok');
});

test('failure → self_repair twice, then consult_chatgpt, then give_up after max cycles', () => {
  const s = new Supervisor();
  const t = fakeTask();
  const v1 = s.decide(t, failureOut, 1);
  assert.equal(v1.kind, 'self_repair');
  const v2 = s.decide(t, failureOut, 1);
  assert.equal(v2.kind, 'self_repair');
  const v3 = s.decide(t, failureOut, 1);
  assert.equal(v3.kind, 'consult_chatgpt');
  if (v3.kind === 'consult_chatgpt') {
    assert.equal(v3.incident.attempts, MAX_SELF_REPAIRS + 1);
    assert.match(formatIncident(v3.incident), /OPENCODE CORRECTIVE PROMPT/);
  }
  // after chatgpt cycles exhausted
  const s2 = new Supervisor();
  s2.decide(fakeTask(), failureOut, 1); s2.decide(fakeTask(), failureOut, 1);
  const t2 = fakeTask(3);
  const v4 = s2.decide(t2, failureOut, 1);
  assert.equal(v4.kind, 'give_up');
});

test('conversational meta-talk about errors (exit 0) is not a failure', () => {
  const s = new Supervisor();
  const ramble = [
    'Honest report: there is no earlier output or failure in this session.',
    'I cannot diagnose an error I never produced.',
    'If a run failed, paste the error text or tell me which command to run.',
  ];
  assert.equal(s.decide(fakeTask(), ramble, 0).kind, 'ok');
  // hard artifacts with exit 0 still fail
  assert.equal(s.decide(fakeTask(), ['All good', 'Error: module not found: x'], 0).kind, 'self_repair');
});
