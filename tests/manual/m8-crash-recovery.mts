/**
 * Milestone 8 crash-recovery tests:
 *  1. Kill -9 the core MID-TASK → restart → task discovered → resume → completes
 *  2. Corrupt a status.json → recovery skips it gracefully
 *  Run: npx tsx tests/manual/m8-crash-recovery.mts  (core server running)
 */
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const token = readFileSync('runtime/auth-token', 'utf8').trim();
const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
let failures = 0;
const ok = (m: string) => console.log(`✔ ${m}`);
const fail = (m: string) => { failures++; console.log(`✖ ${m}`); };
const api = (p: string, method = 'GET', body?: unknown) =>
  fetch(`http://127.0.0.1:7788${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
const status = async (id: string) =>
  (await (await api(`/api/task/${id}`)).json() as { task: { status: string } }).task.status;

// ---------- TEST 1: kill -9 the core MID-TASK ----------
console.log('--- TEST 1: kill core mid-task → restart → resume ---');
let t: { id: string };
try {
  t = (await (await api('/api/task', 'POST', { request: `M8 crash recovery test: create a tiny HTML page crash.html with a working button and a node test script check-crash.js` })).json()) as { id: string };
} catch (e) {
  console.error('✖ task creation failed:', e instanceof Error ? e.message : e);
  process.exit(1);
}
if (!t.id) { console.error('✖ task creation failed'); process.exit(1); }
console.log('task:', t.id);

let s = '';
for (let i = 0; i < 90; i++) { s = await status(t.id); if (s === 'EXECUTING') break; await sleep(4000); }
if (s === 'EXECUTING') ok('task reached EXECUTING (opencode working)');
else fail(`task status=${s} before crash`);

await sleep(5000); // let opencode do some work

// KILL -9 the core server (hard crash simulation)
const serverPid = execFileSync('pgrep', ['-f', 'cli.ts serve'], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number).at(-1)!;
execFileSync('kill', ['-9', String(serverPid)]);
console.log(`killed core server (pid ${serverPid}) with SIGKILL`);
await sleep(2000);

// restart the server
const restart = spawn('npx', ['tsx', 'packages/core/src/cli.ts', 'serve'], { cwd: process.cwd(), detached: true, stdio: 'ignore' });
void restart;
await sleep(9000);
let up = false;
for (let i = 0; i < 10; i++) {
  try { await api('/api/health'); up = true; break; } catch { await sleep(2000); }
}
if (up) ok('core server restarted after SIGKILL');
else fail('core did not come back');

// the task must be discovered (crash recovery)
const disk = JSON.parse(readFileSync(`runtime/tasks/${t.id}/status.json`, 'utf8'));
if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(disk.status)) ok(`crash recovery: task discovered on disk (${disk.status})`);
else fail(`crash recovery: task was ${disk.status} — nothing to recover (may have finished before the kill)`);

// resume it (if not terminal) and let it finish
if (!['COMPLETED', 'CANCELLED', 'FAILED'].includes(disk.status)) {
  // the task may be EXECUTING (mid-flight on disk) — pause then resume to re-enter cleanly
  if (disk.status === 'EXECUTING') await api(`/api/task/${t.id}/pause`, 'POST');
  await sleep(1000);
  const r = await api(`/api/task/${t.id}/resume`, 'POST');
  if (r.ok) ok('resume after crash: task re-entered the loop');
  else fail(`resume after crash failed: ${r.status}`);
}

console.log('waiting for completion (a few minutes)...');
let final = '';
for (let i = 0; i < 150; i++) { final = await status(t.id); if (['COMPLETED', 'FAILED', 'WAITING_FOR_OWNER'].includes(final)) break; await sleep(4000); }
if (final === 'COMPLETED') ok('task COMPLETED after crash-recovery resume');
else fail(`final status=${final} (expected COMPLETED)`);

// ---------- TEST 2: corrupt status.json → graceful recovery ----------
console.log('--- TEST 2: corrupt status.json ---');
const t2 = (await (await api('/api/task', 'POST', { request: `M8 corrupt-state test (${Date.now()})` })).json()) as { id: string };
if (t2.id) {
  // corrupt the status file
  writeFileSync(`runtime/tasks/${t2.id}/status.json`, '{ CORRUPTED JSON !!!');
  // listIncomplete / listAll must skip it without crashing
  const list = await (await api('/api/tasks')).json();
  assert.ok(Array.isArray(list), 'listAll still works with a corrupt entry');
  const hasCorrupt = (list as { id: string }[]).some((x) => x.id === t2.id);
  if (!hasCorrupt) ok('corrupt status.json skipped gracefully (not listed, no crash)');
  else fail('corrupt task appears in the list (should be skipped)');
  // clean up the corrupt dir
  execFileSync('rm', ['-rf', `runtime/tasks/${t2.id}`]);
  ok('corrupt task dir removed');
} else fail('TEST 2: task creation failed');

console.log(failures === 0 ? '\nM8 CRASH-RECOVERY: ALL PASS' : `\nM8 CRASH-RECOVERY: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
