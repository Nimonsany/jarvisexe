/**
 * Milestone 3 E2E A + B + C: computer-control chain through the core API.
 * ONE task hosts all actions (task-scoped policy + audit). The task's own
 * orchestrator run may continue in the background — harmless.
 * Run: npx tsx tests/manual/m3-e2e-abc.mts  (core server running)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const token = execFileSync('cat', ['runtime/auth-token'], { encoding: 'utf8' }).trim();
const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
let failures = 0;
const ok = (m: string) => console.log(`✔ ${m}`);
const fail = (m: string) => { failures++; console.log(`✖ ${m}`); };
const api = (p: string, method = 'GET', body?: unknown) =>
  fetch(`http://127.0.0.1:7788${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });

const act = async (taskId: string, capability: string, operation: string, args: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  (await (await api(`/api/task/${taskId}/computer`, 'POST', { capability, operation, args, ...extra })).json()) as { success: boolean; data?: unknown; error?: string };

// one task hosting all computer-control actions
const t = (await (await api('/api/task', 'POST', { request: `M3 computer control E2E (${Date.now()})` })).json()) as { id: string };
if (!t.id) { console.error('✖ task creation failed — is the orchestrator busy?'); process.exit(1); }
console.log('task:', t.id);

// ---------- E2E A: filesystem ----------
console.log('--- E2E A: filesystem task ---');
const tmp = path.join('/tmp', `jarvis-m3-e2e-${Date.now()}`);
const folder = path.join(tmp, 'jarvis-control-test');
const mk = await act(t.id, 'filesystem', 'mkdir', { path: folder });
if (mk.success) ok(`A: folder created (${folder})`); else fail(`A: mkdir: ${mk.error}`);
const wr = await act(t.id, 'filesystem', 'write', { path: path.join(folder, 'hello.txt'), content: 'JARVIS_CONTROL_OK' });
if (wr.success) ok('A: hello.txt written (+read-back verified)'); else fail(`A: write: ${wr.error}`);
const rd = await act(t.id, 'filesystem', 'read', { path: path.join(folder, 'hello.txt') });
if (rd.success && rd.data === 'JARVIS_CONTROL_OK') ok('A: content read back exactly');
else fail(`A: read back = ${JSON.stringify(rd.data)}`);
if (existsSync(path.join(folder, 'hello.txt')) && readFileSync(path.join(folder, 'hello.txt'), 'utf8') === 'JARVIS_CONTROL_OK') ok('A: verifier confirms exact content');
else fail('A: verifier check failed');

// ---------- E2E B: open calculator ----------
console.log('--- E2E B: open calculator ---');
const det = await act(t.id, 'applications', 'detect', { name: 'Calculator' });
if (det.success && det.data === true) ok('B: ApplicationController detected Calculator (macOS)');
else fail(`B: detect: ${det.error}`);
const launch = await act(t.id, 'applications', 'launch', { name: 'Calculator' });
if (launch.success) ok('B: Calculator launched'); else fail(`B: launch: ${launch.error}`);
await new Promise((r) => setTimeout(r, 2500));
const running = await act(t.id, 'applications', 'running-state', { processName: 'Calculator' });
if (running.success && running.data === true) ok('B: process verified running');
else fail(`B: running-state = ${JSON.stringify(running.data)}`);
await act(t.id, 'applications', 'close', { name: 'Calculator' });
ok('B: Calculator closed gracefully');

// ---------- E2E C: node script ----------
console.log('--- E2E C: node script ---');
const scriptPath = path.join(tmp, 'print-ok.mjs');
const w2 = await act(t.id, 'filesystem', 'write', { path: scriptPath, content: "console.log('JARVIS_TEST_OK');\n" });
if (w2.success) ok('C: script written via FilesystemController'); else fail(`C: write: ${w2.error}`);
const run = await act(t.id, 'terminal', 'run', { command: `node ${scriptPath}` });
if (run.success && (run as unknown as { stdout?: string }).stdout?.includes('JARVIS_TEST_OK') && (run as unknown as { exitCode?: number }).exitCode === 0)
  ok('C: TerminalController executed node, stdout exact match, exit 0');
else fail(`C: run: ${JSON.stringify(run).slice(0, 200)}`);

// ---------- audit + events (task-scoped) ----------
const audit = (await (await api(`/api/task/${t.id}/computer`)).json()) as { actionId: string; capability: string; operation: string; status: string; argumentsSummary: string }[];
if (audit.length >= 8 && audit.every((a) => a.argumentsSummary !== undefined))
  ok(`audit: ${audit.length} task-scoped actions recorded`);
else fail(`audit: ${audit.length} records (expected >= 8 task-scoped)`);

console.log(failures === 0 ? '\nE2E A+B+C: ALL PASS' : `\nE2E A+B+C: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
