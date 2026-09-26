/**
 * Gate B: real end-to-end Pause/Resume with an active task (ChatGPT + OpenCode).
 * Run: npx tsx tests/manual/gate-b-pause-resume.mts  (core server running)
 *
 * Flow: create task → EXECUTING (opencode running) → PAUSE → no new actions
 * → state persists → RESUME → continues → COMPLETED.
 */
import { execFileSync } from 'node:child_process';

const token = execFileSync('cat', ['runtime/auth-token'], { encoding: 'utf8' }).trim();
const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (m: string) => console.log(`✔ ${m}`);
const fail = (m: string) => { failures++; console.log(`✖ ${m}`); };

const api = async (p: string, method = 'GET', body?: unknown) =>
  fetch(`http://127.0.0.1:7788${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });

const status = async (id: string) => (await (await api(`/api/task/${id}`)).json() as { task: { status: string } }).task.status;

// 1. create task
const t = (await (await api('/api/task', 'POST', { request: 'Create a simple tip calculator HTML page (tip.html) with 15% tip calculation and a node test script verify-tip.js that checks the logic' })).json()) as { id: string };
console.log('task:', t.id);

// 2. wait for EXECUTING
console.log('waiting for EXECUTING (ChatGPT planning ~2-4 min)...');
let s = '';
for (let i = 0; i < 120; i++) { s = await status(t.id); if (s === 'EXECUTING') break; await sleep(4000); }
if (s === 'EXECUTING') ok('task reached EXECUTING (opencode running)');
else fail(`task did not reach EXECUTING (status=${s})`);

await sleep(8000); // let opencode actually start working

// 3. PAUSE
await api(`/api/task/${t.id}/pause`, 'POST');
for (let i = 0; i < 30; i++) { s = await status(t.id); if (s === 'PAUSED') break; await sleep(2000); }
if (s === 'PAUSED') ok('PAUSE: status PAUSED (safe checkpoint reached)');
else fail(`PAUSE: status=${s}`);

// 4. no new actions occur: opencode session count must not grow
const events1 = (await (await api(`/api/task/${t.id}`)).json() as { events: { event: string }[] }).events.filter((e) => e.event === 'session_start').length;
await sleep(15000);
const events2 = (await (await api(`/api/task/${t.id}`)).json() as { events: { event: string }[] }).events.filter((e) => e.event === 'session_start').length;
if (events2 === events1) ok(`PAUSE: no new opencode sessions started (${events1} total)`);
else fail(`PAUSE: sessions grew ${events1} -> ${events2}`);

// 5. state persists on disk
const disk = JSON.parse(execFileSync('cat', [`runtime/tasks/${t.id}/status.json`], { encoding: 'utf8' }));
if (disk.status === 'PAUSED') ok('PAUSE: state persisted on disk');
else fail(`PAUSE: disk status=${disk.status}`);

// 6. RESUME
await api(`/api/task/${t.id}/resume`, 'POST');
for (let i = 0; i < 10; i++) { s = await status(t.id); if (s !== 'PAUSED') break; await sleep(2000); }
if (s === 'EXECUTING' || s === 'MONITORING' || s === 'TESTING' || s === 'VERIFYING') ok(`RESUME: task continuing (${s})`);
else fail(`RESUME: unexpected status=${s}`);

// 7. wait for COMPLETED
console.log('waiting for COMPLETED (a few minutes)...');
let done = false;
for (let i = 0; i < 150; i++) { s = await status(t.id); if (s === 'COMPLETED' || s === 'FAILED' || s === 'WAITING_FOR_OWNER') break; await sleep(4000); }
if (s === 'COMPLETED') { done = true; ok('RESUME: task COMPLETED'); }
else fail(`RESUME: final status=${s} (expected COMPLETED)`);

const detail = (await (await api(`/api/task/${t.id}`)).json()) as { task: { verification_status: string; result: string | null } };
if (done) console.log('verification:', detail.task.verification_status, '|', detail.task.result);

console.log(failures === 0 ? '\nGATE B: ALL PASS' : `\nGATE B: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
