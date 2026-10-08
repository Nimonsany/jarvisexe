/**
 * M7 — Release Hardening + Clean Install E2E. The single M7 verification entry:
 *
 *   npm run test:m7
 *
 * Proves the packaged app end-to-end against a disposable root (/tmp/jarvis-m7-*,
 * core on JARVIS_PORT=7789 — the dev server on 7788 is never touched):
 *   DMG verify → install → first launch (GUI) → health/version/preflight →
 *   smoke task (full chain + reality review) → pause/resume → cancel →
 *   kill -9 restart recovery → relaunch + history → reinstall (+smoke again) →
 *   uninstall → cleanup, ending with READY_FOR_V0.1.0_RC: YES|NO.
 *
 * Auto-rebuilds if verify-dmg.sh reports a missing/stale DMG.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { buildManifest } from '../../scripts/release/gen-manifest.mts';
import { discoverOpencode, opencodeCandidates } from '../../packages/core/src/opencode/discover.js';
import { collectResources, collectVoice } from '../../packages/core/src/preflight.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const M7_ROOT = process.env.M7_ROOT || `/tmp/jarvis-m7-${process.pid}`;
const PORT = Number(process.env.M7_PORT || 7789);
const API = `http://127.0.0.1:${PORT}`;
const SCRIPTS = path.join(REPO, 'scripts/release');
const DEV_RUNTIME = path.join(REPO, 'runtime');
const WORKSPACE = path.join(M7_ROOT, 'workspace');
const STATE = path.join(M7_ROOT, 'state');
const PIDFILE = path.join(M7_ROOT, 'run/core.pid');
const REPORT_PATH = path.join(REPO, 'm7-report.json');

const results: Record<string, { ok: boolean; detail?: string }> = {};
const REPORTS: Record<string, any> = {}; // evidence for m7-report.json
let aborted = false;

// JARVIS_M7_ONLY=T7 → diagnostic run: T1-T6/T12/T13 still execute (build,
// install, launch, teardown), only the listed functional phases run; the
// rest are recorded as filtered, not as failures. Unset = full M7.
const M7_ONLY = (process.env.JARVIS_M7_ONLY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const SETUP_PHASES = new Set(['T1', 'T2', 'T3', 'T4', 'T5', 'T6']);

const sh = (cmd: string, args: string[] = [], timeout?: number): string =>
  execFileSync(cmd, args, {
    cwd: REPO,
    env: { ...process.env, M7_ROOT, M7_PORT: String(PORT) },
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });

const phase = async (name: string, fn: () => Promise<void>, always = false): Promise<void> => {
  const id = (name.match(/^T\d+/) ?? [''])[0];
  if (M7_ONLY.length && !always && !SETUP_PHASES.has(id) && !M7_ONLY.includes(id)) {
    results[name] = { ok: true, detail: 'filtered (JARVIS_M7_ONLY)' };
    console.log(`- ${name}: filtered (JARVIS_M7_ONLY)`);
    return;
  }
  if (aborted && !always) { results[name] = { ok: false, detail: 'skipped after earlier failure' }; console.log(`- ${name}: skipped`); return; }
  try { await fn(); results[name] = { ok: true }; console.log(`✔ ${name}`); }
  catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    results[name] = { ok: false, detail: msg.split('\n')[0] };
    console.log(`✖ ${name}\n${msg}`);
    aborted = true;
  }
};

async function api(p: string, method = 'GET', body?: unknown): Promise<Response> {
  const tokenFile = path.join(STATE, 'auth-token');
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  const once = () => fetch(API + p, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  // GETs are idempotent — tolerate the restart-boundary race (stale keep-alive
  // conn / brief listener gap right after stop→launch). POSTs never retry.
  if (method !== 'GET') return once();
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try { return await once(); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw lastErr;
}

async function taskOf(id: string): Promise<{ status: string; verification_status?: string; events?: { timestamp: string; component: string; event: string; severity: string; data?: Record<string, unknown> }[] }> {
  const r = await api(`/api/task/${id}`);
  if (!r.ok) throw new Error(`GET /api/task/${id} → ${r.status}`);
  const j = (await r.json()) as { task: { status: string; verification_status: string }; events: [] };
  return { status: j.task.status, verification_status: j.task.verification_status, events: j.events as never };
}

async function until(label: string, fn: () => Promise<boolean>, timeoutSec: number, everyMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try { if (await fn()) return; lastErr = ''; } catch (e) { lastErr = ` (${e instanceof Error ? e.message : e})`; }
    await sleep(everyMs);
  }
  throw new Error(`timeout after ${timeoutSec}s waiting for: ${label}${lastErr}`);
}

async function postTask(request: string, project: string): Promise<string> {
  let id = '';
  await until('POST /api/task accepted', async () => {
    const r = await api('/api/task', 'POST', { request, project });
    if (!r.ok) return false;
    id = ((await r.json()) as { id: string }).id;
    return Boolean(id);
  }, 600, 15000);
  return id;
}

const corePids = (): string[] => {
  try { return execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean); }
  catch { return []; }
};

const workspaceChildCount = (): number => {
  let pids: string[] = [];
  try { pids = execFileSync('pgrep', ['-f', 'opencode|Chromium|headless_shell'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return 0; }
  let n = 0;
  for (const pid of pids) {
    try {
      const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (out.split('\n').some((l) => l === `n${WORKSPACE}` || l.startsWith(`n${WORKSPACE}/`))) n++;
    } catch { /* gone */ }
  }
  return n;
};

const procCwd = (pid: string): string => {
  try {
    const out = execFileSync('lsof', ['-a', '-p', pid, '-d', 'cwd', '-Fn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '';
  } catch { return ''; }
};

test('M7 release hardening E2E', async () => {
  await phase('T1 build manifest generator', async () => {
    const m = buildManifest({ version: '9.9.9', commit: 'abc1234', dirty: false, channel: 'test', now: new Date('2026-01-02T03:04:05Z') });
    assert.deepEqual(m, { version: '9.9.9', commit: 'abc1234', dirty: false, builtAt: '2026-01-02T03:04:05.000Z', arch: process.arch, channel: 'test' });
    const real = buildManifest();
    assert.match(real.commit, /^[0-9a-f]{7,}$|^unknown$/, 'real git commit captured');
    assert.equal(real.version, '0.1.0', 'version read from tauri.conf');
  });

  await phase('T2 opencode discovery (FR-5)', async () => {
    const hit = discoverOpencode();
    assert.ok(hit, 'opencode discovered on this machine');
    assert.ok(path.isAbsolute(hit!.path), `discovered path absolute: ${hit!.path}`);
    assert.ok(['env', 'settings', 'bundled', 'user-local', 'path'].includes(hit!.source));
    // precedence: env wins when it points at a real executable, falls through when bogus
    const real = hit!.path;
    assert.equal(discoverOpencode({ env: { ...process.env, OPENCODE_BIN: real } })?.source, 'env');
    const fake = discoverOpencode({ env: { ...process.env, OPENCODE_BIN: '/nonexistent/opencode-xyz' }, home: '/nonexistent-home', execDir: '/nonexistent-exec' });
    assert.ok(fake === null || fake.path !== '/nonexistent/opencode-xyz', 'bogus env binary not returned as a hit');
    // no cwd-relative candidate is ever considered executable
    const cands = opencodeCandidates({ env: { PATH: '.' }, home: '/x', execDir: '/x' });
    assert.ok(cands.every((c) => c.source !== 'path' || path.isAbsolute(c.path)), 'PATH candidates always absolute');
    const none = discoverOpencode({ env: { PATH: '' }, home: '/nonexistent-home', execDir: '/nonexistent-exec' });
    assert.equal(none, null, 'empty search space → null (useful diagnostic, not a silent cwd pick)');
  });

  await phase('T3 resource + voice preflight helpers (FR-6/7)', async () => {
    const v = collectVoice();
    assert.ok(['ready', 'missing'].includes(v.whisper));
    if (v.whisper === 'ready') {
      assert.ok(path.isAbsolute(v.path!), `whisper path absolute: ${v.path}`);
      assert.ok(['jarvis-bin', 'path'].includes(v.source!));
    }
    const r = await collectResources();
    assert.ok(['ok', 'resource-pressure'].includes(r.status));
    assert.equal(typeof r.load1m, 'number');
    assert.ok(Array.isArray(r.reasons));
    if (r.status === 'resource-pressure') assert.ok(r.reasons.length > 0, 'pressure comes with reasons');
    REPORTS.t3 = { voice: v, resources: r };
  });

  await phase('T4 verify DMG (rebuild if stale) (FR-15/17)', async () => {
    const attempt = () => { try { return { ok: true, out: sh(path.join(SCRIPTS, 'verify-dmg.sh')) }; } catch (e) { return { ok: false, out: String((e as { stdout?: string }).stdout ?? '') + String((e as Error).message) }; } };
    let r = attempt();
    if (!r.ok) {
      console.log(`verify-dmg failed, rebuilding…\n${r.out.slice(0, 500)}`);
      sh(path.join(SCRIPTS, 'build-dmg.sh')); // full rebuild (long)
      r = attempt();
    }
    assert.ok(r.ok, `verify-dmg after rebuild: ${r.out.slice(0, 800)}`);
    assert.match(r.out, /VERIFY_DMG_OK/);
    REPORTS.t4 = r.out.trim();
  });

  await phase('T5 install + first launch + health/version/preflight (FR-1..7)', async () => {
    const outInstall = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['install', '--seed', DEV_RUNTIME]);
    assert.match(outInstall, /M7_INSTALL_OK/);
    const outLaunch = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['launch', '240'], 600_000);
    assert.match(outLaunch, /M7_HEALTH_OK/);

    const health = (await (await fetch(`${API}/health`)).json()) as Record<string, string>;
    assert.equal(health.core, 'online');
    assert.equal(health.opencode, 'ready', 'opencode discovered + responds');
    assert.equal(health.storage, 'ready');
    assert.equal(health.chatgptProfile, 'ready', 'seeded profile present');
    assert.ok(['ready', 'missing'].includes(health.voice));

    const version = (await (await api('/api/version')).json()) as { version: string; commit: string; channel: string };
    assert.equal(version.version, '0.1.0');
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    assert.equal(version.commit, head, 'embedded manifest commit == git HEAD (FR-17 freshness)');

    const pf = (await (await api('/api/preflight')).json()) as { opencode: { status: string; path: string; source: string }; voice: { whisper: string; model: string }; resources: { status: string } };
    assert.equal(pf.opencode.status, 'ready');
    assert.ok(path.isAbsolute(pf.opencode.path), 'discovery path absolute (FR-5)');
    assert.ok(['env', 'settings', 'bundled', 'user-local', 'path'].includes(pf.opencode.source));
    assert.ok(['ready', 'missing'].includes(pf.voice.whisper));
    assert.ok(['ok', 'resource-pressure'].includes(pf.resources.status));
    REPORTS.t5 = { health, version, preflight: pf };

    // exactly one core on our port; no duplicate supervisors
    const pids = corePids();
    assert.equal(pids.length, 1, `exactly one core listener on ${PORT}, got [${pids}]`);
    // GUI present + core process not rooted in the repo cwd (FR-5 no-cwd rule)
    const gui = execFileSync('pgrep', ['-f', `${M7_ROOT}/install/JARVIS.app/Contents/MacOS/jarvis-desktop`], { encoding: 'utf8' }).split('\n').filter(Boolean);
    assert.ok(gui.length >= 1, 'GUI running');
    const cwd = procCwd(pids[0]);
    assert.ok(!cwd.startsWith(REPO), `core cwd not the repo: ${cwd}`);
    REPORTS.t5.corePid = pids[0];
    REPORTS.t5.coreCwd = cwd;

    const outStop = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['stop'], 60_000);
    assert.match(outStop, /M7_STOP_OK/);
    assert.equal(corePids().length, 0, 'port released after stop');
  });

  let smokeTaskId = '';
  await phase('T6 smoke task — full chain (FR-8)', async () => {
    sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['launch-core', '240'], 600_000);
    if (M7_ONLY.length) { REPORTS.t6 = 'launch-core only (filtered run)'; return; }
    smokeTaskId = await postTask(
      'Create a file named m7-smoke.txt in the project directory containing exactly the text JARVIS_M7_SMOKE_OK (plain, unquoted). Create no other files.',
      WORKSPACE,
    );
    await until(`task ${smokeTaskId} terminal`, async () => {
      const s = (await taskOf(smokeTaskId)).status;
      return ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_FOR_OWNER'].includes(s);
    }, 1800, 10_000);
    const task = await taskOf(smokeTaskId);
    assert.equal(task.status, 'COMPLETED', `smoke task status=${task.status}`);
    assert.equal(task.verification_status, 'PASSED', 'verifier PASSED');

    const file = path.join(WORKSPACE, 'm7-smoke.txt');
    assert.ok(existsSync(file), 'm7-smoke.txt created');
    assert.equal(readFileSync(file, 'utf8').trim(), 'JARVIS_M7_SMOKE_OK', 'exact content');

    // FR-8: pipeline components captured + reality review
    const evs = task.events ?? [];
    const comps = new Set(evs.map((e) => e.component));
    for (const want of ['chatgpt', 'opencode', 'verifier', 'supervisor']) {
      if (!comps.has(want)) console.log(`  note: component '${want}' produced no events (captured: ${[...comps].join(',')})`);
    }
    assert.ok(comps.has('opencode'), 'opencode events captured');
    // wait for either outcome — a skip fails fast WITH its reason instead of a blind 480s timeout
    await until('bot review outcome', async () => (await taskOf(smokeTaskId)).events!.some((e) => e.event === 'bot.review_completed' || e.event === 'bot.review_skipped'), 480, 10_000);
    const revEvs = (await taskOf(smokeTaskId)).events!.filter((e) => e.event.startsWith('bot.review_'));
    const completed = revEvs.find((e) => e.event === 'bot.review_completed');
    const skipped = revEvs.find((e) => e.event === 'bot.review_skipped');
    assert.ok(completed, `bot review not completed: ${skipped ? JSON.stringify(skipped.data) : 'no bot.review_* event at all'}`);
    REPORTS.t6 = { taskId: smokeTaskId, status: task.status, verification: task.verification_status, components: [...comps], events: evs.length };
  });

  await phase('T7 pause / resume (FR-9/10)', async () => {
    let id = '';
    try {
      id = await postTask(
        'Create a file named m7-pause.txt in the project directory containing exactly PAUSE_RESUME_OK. Create no other files.',
        WORKSPACE,
      );
      await until(`task ${id} pausable`, async () => ['WAITING_FOR_CHATGPT', 'EXECUTING', 'MONITORING'].includes((await taskOf(id)).status), 900, 5000);
      const pr = await api(`/api/task/${id}/pause`, 'POST');
      assert.ok(pr.ok, `pause → ${pr.status}`);
      await until(`task ${id} PAUSED`, async () => (await taskOf(id)).status === 'PAUSED', 60, 2000);
      await sleep(3000);
      const before = (await taskOf(id)).events!.length;
      await sleep(10_000); // FR-9: no new consequential steps while paused
      const t7 = await taskOf(id);
      assert.equal(t7.status, 'PAUSED', 'stays PAUSED');
      assert.equal(t7.events!.length, before, `no events while paused (before=${before} after=${t7.events!.length})`);

      const resumeAt = Date.now();
      const rr = await api(`/api/task/${id}/resume`, 'POST');
      assert.ok(rr.ok, `resume → ${rr.status}`);
      await until(`task ${id} COMPLETED after resume`, async () => ['COMPLETED', 'FAILED'].includes((await taskOf(id)).status), 1800, 10_000);
      const done = await taskOf(id);
      assert.equal(done.status, 'COMPLETED', `resume completed (got ${done.status})`); // FR-10
      assert.equal(readFileSync(path.join(WORKSPACE, 'm7-pause.txt'), 'utf8').trim(), 'PAUSE_RESUME_OK', 'no duplicate/corrupt output');

      // gate evidence: stale attempts, fresh-attempt id, resume/OpenCode starts
      const evs = done.events!;
      const stale = evs.filter((e) => e.event === 'planner_response_stale');
      const replanIds = evs.filter((e) => e.event === 'resume_replan_from_pause').map((e) => e.data?.attemptId);
      const resumedEvs = evs.filter((e) => e.event === 'task_resumed');
      const sessions = evs.filter((e) => e.event === 'session_start').length;
      assert.equal(stale.length, 0, `planner_response_stale fired for valid attempt(s): ${JSON.stringify(stale.map((e) => e.data))}`);
      assert.equal(resumedEvs.length, 1, `task_resumed exactly once (got ${resumedEvs.length})`);
      assert.ok(sessions >= 1, `OpenCode started after resume (session_start=${sessions})`);
      // the bug symptom: resume() returns before task_resumed → nothing after it for 300s+
      const resumeToResumedSec = resumedEvs.length ? Math.max(0, Math.round((Date.parse(resumedEvs[0].timestamp) - resumeAt) / 1000)) : -1;
      assert.ok(resumeToResumedSec >= 0 && resumeToResumedSec < 300, `no 300s wait: resume→task_resumed ${resumeToResumedSec}s`);
      REPORTS.t7 = { taskId: id, pauseEvents: before, finalEvents: evs.length, stale: stale.length, replanAttemptIds: replanIds, taskResumed: resumedEvs.length, sessionStarts: sessions, resumeToResumedSec };
    } finally {
      // T12 deletes M7_ROOT even on failure — dump evidence first
      try {
        const snap = id ? { task: await taskOf(id).catch(() => null), reports: REPORTS.t7 ?? null, pauseFile: (() => { try { return readFileSync(path.join(WORKSPACE, 'm7-pause.txt'), 'utf8'); } catch { return null; } })() } : { reports: REPORTS.t7 ?? null };
        writeFileSync('/tmp/jarvis-t7-evidence.json', JSON.stringify(snap, null, 2) + '\n');
      } catch (e) { console.log(`  evidence dump failed: ${e}`); }
      // core log carries the chatgpt automation trail ('Please sign in…', ask retries)
      try { const lg = readFileSync(path.join(M7_ROOT, 'logs/core.log'), 'utf8'); writeFileSync('/tmp/jarvis-t7-core.log', lg.slice(-400_000)); } catch (e) { console.log(`  core log dump failed: ${e}`); }
    }
  });

  await phase('T8 cancel (FR-11)', async () => {
    const id = await postTask(
      'Create a file named m7-cancel.txt in the project directory containing exactly CANCEL_OK. Create no other files.',
      WORKSPACE,
    );
    await until(`task ${id} cancellable`, async () => ['PLANNING', 'WAITING_FOR_CHATGPT', 'EXECUTING', 'MONITORING'].includes((await taskOf(id)).status), 600, 5000);
    const cr = await api(`/api/task/${id}/cancel`, 'POST');
    assert.ok(cr.ok, `cancel → ${cr.status}`);
    await until(`task ${id} CANCELLED`, async () => (await taskOf(id)).status === 'CANCELLED', 60, 2000);
    await sleep(3000);
    const before = (await taskOf(id)).events!.length;
    await sleep(12_000);
    const t8 = await taskOf(id);
    assert.equal(t8.status, 'CANCELLED', 'stays CANCELLED');
    assert.equal(t8.events!.length, before, 'no work after cancel');
    REPORTS.t8 = { taskId: id };
  });

  await phase('T9 kill -9 → restart recovery (FR-12/13)', async () => {
    let t9id = '';
    try {
    t9id = await postTask(
      'Create a Node script add.js exporting add(a,b) plus a check-add.js test proving add(2,3)===5, and run the test. Keep both files in the project directory.',
      WORKSPACE,
    );
    const id = t9id;
    await until(`task ${id} mid-flight`, async () => {
      const s = (await taskOf(id)).status;
      return ['EXECUTING', 'MONITORING', 'TESTING', 'VERIFYING'].includes(s);
    }, 1200, 5000);
    const orphansBefore = workspaceChildCount();

    const pid = readFileSync(PIDFILE, 'utf8').trim();
    process.kill(Number(pid), 'SIGKILL'); // hard crash
    await until(`core pid ${pid} dead`, async () => { try { process.kill(Number(pid), 0); return false; } catch { return true; } }, 30, 500);

    sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['launch-core', '240'], 600_000); // boot recovery runs inside
    const t9 = await taskOf(id);
    assert.equal(t9.status, 'PAUSED', `interrupted task marked PAUSED on boot (got ${t9.status})`);
    const rec = t9.events!.find((e) => e.event === 'recovery_interrupted');
    assert.ok(rec, 'recovery_interrupted event emitted');
    const prev = (rec!.data as { previous_status: string }).previous_status;
    assert.ok(['EXECUTING', 'MONITORING', 'TESTING', 'VERIFYING'].includes(prev), `marked from an in-flight state (got ${prev})`);
    if (orphansBefore > 0) assert.equal(workspaceChildCount(), 0, 'orphaned workspace children killed on boot');
    assert.equal(corePids().length, 1, 'single core after restart');

    const rr = await api(`/api/task/${id}/resume`, 'POST');
    assert.ok(rr.ok, `resume → ${rr.status}`); // FR-12 user retry path
    await until(`task ${id} re-enters work after resume`, async () => ['EXECUTING', 'MONITORING', 'TESTING', 'VERIFYING'].includes((await taskOf(id)).status), 600, 5000);
    const cc = await api(`/api/task/${id}/cancel`, 'POST'); // close out — full crash-resume completion covered by m8-crash-recovery
    assert.ok(cc.ok, `cancel after recovery → ${cc.status}`);
    await until(`task ${id} CANCELLED`, async () => (await taskOf(id)).status === 'CANCELLED', 60, 2000);
    REPORTS.t9 = { taskId: id, orphansBefore };
    } finally {
      // T12 deletes M7_ROOT even on failure — dump evidence first
      try {
        const snap = t9id ? await taskOf(t9id) : null;
        writeFileSync('/tmp/jarvis-t9-evidence.json', JSON.stringify({ task: snap }, null, 2) + '\n');
      } catch (e) { console.log(`  t9 evidence dump failed: ${e}`); }
      try { const lg = readFileSync(path.join(M7_ROOT, 'logs/core.log'), 'utf8'); writeFileSync('/tmp/jarvis-t9-core.log', lg.slice(-400_000)); } catch (e) { console.log(`  t9 core log dump failed: ${e}`); }
    }
  });

  await phase('T10 relaunch — history + no duplicates (FR-15)', async () => {
    const before = (await (await api('/api/tasks')).json()) as { id: string }[];
    // full run: T6+T7+T8+T9 each create a task; filtered T6 creates none —
    // floor = task-creating phases that actually ran this run
    const minHistory = M7_ONLY.length ? M7_ONLY.filter((p) => ['T7', 'T8', 'T9'].includes(p)).length : 4;
    assert.ok(before.length >= minHistory, `history present before relaunch (${before.length})`);
    sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['stop'], 60_000);
    assert.equal(corePids().length, 0, 'core fully stopped');
    sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['launch-core', '240'], 600_000);
    const after = (await (await api('/api/tasks')).json()) as { id: string }[];
    assert.equal(after.length, before.length, 'task history unchanged by relaunch');
    assert.equal(corePids().length, 1, 'still exactly one core');
    REPORTS.t10 = { tasks: after.length };
  });

  let smoke2Id = '';
  await phase('T11 reinstall → smoke passes again (FR-14/16/17)', async () => {
    sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['reinstall']);
    sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['launch-core', '240'], 600_000);
    const version = (await (await api('/api/version')).json()) as { commit: string };
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO, encoding: 'utf8' }).trim();
    assert.equal(version.commit, head, 'reinstalled app carries fresh manifest');
    const tasksBefore = ((await (await api('/api/tasks')).json()) as unknown[]).length;

    smoke2Id = await postTask(
      'Create a file named m7-smoke-reinstall.txt in the project directory containing exactly the text JARVIS_M7_SMOKE_OK_2 (plain, unquoted). Create no other files.',
      WORKSPACE,
    );
    await until(`task ${smoke2Id} terminal`, async () => ['COMPLETED', 'FAILED', 'CANCELLED', 'WAITING_FOR_OWNER'].includes((await taskOf(smoke2Id)).status), 1800, 10_000);
    const t11 = await taskOf(smoke2Id);
    assert.equal(t11.status, 'COMPLETED', `post-reinstall smoke status=${t11.status}`);
    assert.equal(t11.verification_status, 'PASSED');
    assert.equal(readFileSync(path.join(WORKSPACE, 'm7-smoke-reinstall.txt'), 'utf8').trim(), 'JARVIS_M7_SMOKE_OK_2');
    const tasksAfter = ((await (await api('/api/tasks')).json()) as unknown[]).length;
    assert.ok(tasksAfter >= tasksBefore, 'history kept across reinstall');
    sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['stop'], 60_000);
    REPORTS.t11 = { taskId: smoke2Id, history: tasksAfter };
  });

  const T12 = async () => {
    const out = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['uninstall'], 60_000);
    assert.match(out, /M7_UNINSTALL_OK/);
    const cl = sh(path.join(SCRIPTS, 'm7-cleanup.sh'), [], 60_000);
    assert.match(cl, /M7_CLEANUP_OK/);
    assert.ok(!existsSync(M7_ROOT), 'disposable root removed');
    assert.equal(corePids().length, 0, 'no core left on our port');
    const procs = (): string[] => { try { return execFileSync('pgrep', ['-f', M7_ROOT], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { return []; } };
    let guiLeft = procs(); // Chrome can take a few seconds to finish tearing down
    for (let i = 0; i < 15 && guiLeft.length > 0; i++) { await sleep(1000); guiLeft = procs(); }
    assert.equal(guiLeft.length, 0, 'no processes left referencing our root');
    REPORTS.t12 = 'uninstalled + cleaned';
  };

  const T13 = async () => {
    const r = await collectResources();
    REPORTS.t13 = r;
    console.log(`  machine: load1m=${r.load1m.toFixed(0)} swap=${r.swapUsedPct}% disk=${r.diskFreeGb}GB status=${r.status}${r.reasons.length ? ' (' + r.reasons.join('; ') + ')' : ''}`);
  };

  // cleanup + machine record always run, even after an earlier failure
  await phase('T12 uninstall + cleanup (FR-18/19)', T12, true);
  await phase('T13 machine resource record (FR-7 — recorded, never fatal)', T13, true);

  // final verdict + report — written even when earlier phases failed
  const failed = Object.entries(results).filter(([, r]) => !r.ok);
  const verdict = failed.length === 0 ? 'YES' : 'NO';
  const report = { generatedAt: new Date().toISOString(), verdict, readyForV0_1_0_RC: verdict, filter: M7_ONLY.length ? M7_ONLY : null, failed: failed.map(([n, r]) => ({ phase: n, detail: r.detail })), results, evidence: REPORTS };
  try { writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n'); } catch { /* best effort */ }
  console.log(`\n${failed.length === 0 ? '' : 'FAILED PHASES:\n' + failed.map(([n, r]) => `  ✖ ${n}: ${r.detail}`).join('\n')}\nREADY_FOR_V0.1.0_RC: ${verdict}  (report: ${REPORT_PATH}${M7_ONLY.length ? `, filter: ${M7_ONLY.join(',')}` : ''})`);
  assert.equal(failed.length, 0, `M7 phases failed: ${failed.map(([n]) => n).join(', ')}`);
});
