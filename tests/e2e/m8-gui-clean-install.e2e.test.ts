/**
 * M8 — Release Integration Gate: TRUE GUI clean-install E2E. The single M8
 * verification entry:
 *
 *   npm run test:m8
 *
 * The installed app itself performs every step: the packaged desktop UI
 * (WKWebView) runs an env-gated in-app driver that observes handshake state,
 * types the task into Execute, clicks, and reads status + verification from
 * the UI. There is NO direct API task submission anywhere in this flow —
 * task creation goes through the real React handler → JarvisClient path.
 *
 * Flow: DMG verify/rebuild → install --seed → GUI launch (harness env) →
 * packaged-UI handshake to Ready (BLOCKER 1 proof) → GUI-driven smoke task →
 * Completed + verification PASSED read from the UI → quit → relaunch →
 * history visible → reinstall → relaunch → history survived → uninstall →
 * ownership-clean removal, ending with M8_TECHNICAL_PASS / READY_FOR_V0.1.0_RC.
 *
 * The dev server on 7788 is guarded throughout and never touched.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const M8_ROOT = process.env.M8_ROOT || `/tmp/jarvis-m8-gui-${process.pid}`;
const PORT = Number(process.env.M8_PORT || 7791);
const API = `http://127.0.0.1:${PORT}`;
const OWNER_API = 'http://127.0.0.1:7788';
const SCRIPTS = path.join(REPO, 'scripts/release');
const DEV_RUNTIME = path.join(REPO, 'runtime');
const WORKSPACE = path.join(M8_ROOT, 'workspace');
const STATE = path.join(M8_ROOT, 'state');
const REPORT_PATH = path.join(REPO, 'm8-report.json');

/** Re-activates the app every 2s while the run is live: the planner's headful
 *  Chrome (and any ChatGPT popup) raises itself over our window; an occluded
 *  WKWebView suspends its JS timers and the driver stops polling the harness. */
let focusGuard: ReturnType<typeof setInterval> | null = null;
/** Keep the installed GUI foregrounded while we WAIT on it: WebKit App Nap /
 *  occlusion suspends timers, which freezes the in-page driver mid-wait (and
 *  `open` only activates — it never spawns — while the app is running). Must be
 *  OFF during stop/reinstall windows or it relaunches the app env-less. */
function armFocusGuard(): void {
  if (focusGuard) return;
  focusGuard = setInterval(() => {
    try { execFileSync('open', [path.join(M8_ROOT, 'install/JARVIS.app')], { timeout: 2000, stdio: 'ignore' }); } catch { /* not up yet */ }
  }, 2000);
}
function disarmFocusGuard(): void {
  if (focusGuard) { clearInterval(focusGuard); focusGuard = null; }
}

const results: Record<string, { ok: boolean; detail?: string }> = {};
let aborted = false;

const sh = (cmd: string, args: string[] = [], opts: { timeout?: number; env?: Record<string, string> } = {}): string =>
  execFileSync(cmd, args, {
    cwd: REPO,
    env: { ...process.env, M7_ROOT: M8_ROOT, M7_PORT: String(PORT), ...opts.env },
    encoding: 'utf8',
    timeout: opts.timeout,
    maxBuffer: 64 * 1024 * 1024,
  });

const phase = async (name: string, fn: () => Promise<void>): Promise<void> => {
  if (aborted) { results[name] = { ok: false, detail: 'skipped after earlier failure' }; console.log(`- ${name}: skipped`); return; }
  try { await fn(); results[name] = { ok: true }; console.log(`✔ ${name}`); }
  catch (e) {
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    results[name] = { ok: false, detail: msg.split('\n')[0] };
    console.log(`✖ ${name}\n${msg}`);
    aborted = true;
  }
};

// ---------------------------------------------------------------- harness ----
// Loopback command server: the in-page driver (window.__JARVIS_E2E__, injected
// by the desktop shell only when JARVIS_E2E is set) polls /cmd and posts /done.
type HCmd = { id: string; cmd: string; sel?: string; value?: string; text?: string; timeoutMs?: number };
const pending: HCmd[] = [];
const finished = new Map<string, { ok: boolean; value?: string; error?: string }>();
let cmdSeq = 0;

// --- lost-/done diagnostics + at-least-once requeue -------------------------
// The harness shifts a cmd on fetch: if the driver's /done never lands (one
// failed send, or the fetcher went silent), the waiter would hang forever.
// Long read-only cmds are requeued after timeoutMs+90s so a still-polling
// driver gets a fresh copy; timestamps + idle-poll lines say which failure
// mode we're in (silent driver vs liveness without completion).
const ts = (): string => new Date().toISOString().slice(11, 23);
const inFlight = new Map<string, { c: HCmd; at: number }>();
const requeued = new Set<string>();
const RETRYABLE = new Set(['wait', 'wait_testid', 'get', 'body']);
let lastGetAt = 0;
let lastGetKey = '-';
let lastIdleLog = 0;
/** Pages loaded before this ms are stale (set at every launch start). */
let pageFloor = 0;
const seenStale = new Set<string>();
const resyncPages = (): void => { pageFloor = Date.now(); };

const harness = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  if (req.method === 'GET' && req.url?.startsWith('/cmd')) {
    const now = Date.now();
    lastGetAt = now;
    const u = new URL(req.url, 'http://x');
    lastGetKey = u.searchParams.get('k') ?? '-';
    const pageT = Number(u.searchParams.get('t') ?? '0');
    // Stale-page rejection: after a relaunch, pages loaded before pageFloor are
    // orphans of the killed app (WebKit WebContent survives its desktop process
    // and is invisible to our path-based pgrep). Never shift a cmd onto them.
    if (pageT && pageT < pageFloor) {
      if (!seenStale.has(lastGetKey)) {
        seenStale.add(lastGetKey);
        console.log(`[h] ${ts()} stale-reject key=${lastGetKey} t=${pageT} < floor=${pageFloor}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('null');
      return;
    }
    for (const [id, e] of [...inFlight]) {
      if (RETRYABLE.has(e.c.cmd) && !requeued.has(id) && now - e.at > (e.c.timeoutMs ?? 20_000) + 90_000) {
        pending.push(e.c); requeued.add(id); inFlight.delete(id);
        console.log(`[h] ${ts()} REQUEUE ${id} (fetched ${Math.round((now - e.at) / 1000)}s ago, no /done)`);
      }
    }
    const c = pending.shift() ?? null;
    if (c) {
      inFlight.set(c.id, { c, at: now });
      console.log(`[h] ${ts()} cmd→ ${c.id} ${c.cmd} ${c.sel ?? ''} via ${lastGetKey}`);
    } else if (inFlight.size && now - lastIdleLog > 10_000) {
      lastIdleLog = now;
      const ages = [...inFlight].map(([id, e]) => `${id}:${Math.round((now - e.at) / 1000)}s`).join(' ');
      console.log(`[h] ${ts()} idle-poll via ${lastGetKey} in-flight ${ages}`);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(c));
    return;
  }
  if (req.method === 'POST' && req.url === '/done') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        const d = JSON.parse(body) as { id: string; ok: boolean; value?: string; error?: string };
        inFlight.delete(d.id);
        console.log(`[h] ${ts()} done← ${d.id} ok=${d.ok} ${String(d.error ?? d.value ?? '').slice(0, 60)}`);
        finished.set(d.id, d);
      } catch { console.log(`[h] ${ts()} done← MALFORMED`, body.slice(0, 80)); }
      res.writeHead(204).end();
    });
    return;
  }
  res.writeHead(404).end();
});
let HARNESS_URL = '';
  // Always stop the disposable install — a failed P5 must not leak GUI/core/
  // Chrome processes (orphans stacked load to 350+ across failed runs).
  after(() => {
    if (focusGuard) clearInterval(focusGuard);
    harness.close();
    try { sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['stop'], { timeout: 120_000 }); } catch { /* already gone */ }
    // Safety net: stop under load can die mid-sequence and leak GUI/core/Chrome
    // (orphan piles pushed the machine to load 350). Kill anything under our root.
    try { execFileSync('pkill', ['-9', '-f', M8_ROOT], { stdio: 'ignore' }); } catch { /* none left */ }
  });

/** Queue one driver command and await its result (asserts ok). */
async function cmd(c: Omit<HCmd, 'id'>, timeoutSec: number): Promise<string> {
  const id = `c${++cmdSeq}`;
  pending.push({ ...c, id });
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const r = finished.get(id);
    if (r) {
      finished.delete(id);
      if (!r.ok) throw new Error(`driver ${c.cmd} sel=${c.sel ?? '-'} text=${c.text ?? '-'}: ${r.error}`);
      return r.value ?? '';
    }
    await sleep(200);
  }
  // Deadline hit — but on a starved event loop due timers fire before I/O
  // poll, so a /done that already arrived can sit unread in the socket while
  // this loop exits. One grace beat lets the poll phase run before failing.
  await sleep(100);
  const late = finished.get(id);
  if (late) {
    finished.delete(id);
    if (!late.ok) throw new Error(`driver ${c.cmd} sel=${c.sel ?? '-'} text=${c.text ?? '-'}: ${late.error}`);
    return late.value ?? '';
  }
  const i = pending.findIndex((p) => p.id === id);
  if (i >= 0) pending.splice(i, 1);
  inFlight.delete(id);
  const liveness = lastGetAt ? ` — driver last GET ${Math.round((Date.now() - lastGetAt) / 1000)}s ago via ${lastGetKey}` : ' — driver never polled';
  console.log(`[h] ${ts()} TIMEOUT ${id} after ${timeoutSec}s (${c.cmd} ${c.sel ?? ''}) — no /done matched${liveness}`);
  throw new Error(`harness timeout (${timeoutSec}s): ${c.cmd} sel=${c.sel ?? '-'} text=${c.text ?? '-'}`);
}

// ---------------------------------------------------------------- helpers ----
async function api(p: string): Promise<Response> {
  const tokenFile = path.join(STATE, 'auth-token');
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  let lastErr: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return await fetch(API + p, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    } catch (e) { lastErr = e; await sleep(1000); }
  }
  throw lastErr;
}

async function ownerUp(): Promise<boolean> {
  try { return (await fetch(`${OWNER_API}/health`, { signal: AbortSignal.timeout(4000) })).ok; }
  catch { return false; }
}

const corePids = (): string[] => {
  try { return execFileSync('lsof', ['-nP', `-iTCP:${PORT}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean); }
  catch { return []; }
};

const guiPids = (): string[] => {
  try { return execFileSync('pgrep', ['-f', `${M8_ROOT}/install/JARVIS.app/Contents/MacOS/jarvis-desktop`], { encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch { return []; }
};

const smokeRequest =
  'Create a file named m8-smoke.txt in the project directory containing exactly the text JARVIS_M8_SMOKE_OK (plain, unquoted). Create no other files.';

test('M8 release integration gate — GUI clean-install E2E', async () => {
  const ownerWasUp = await ownerUp();
  console.log(`owner dev server on 7788: ${ownerWasUp ? 'up (guarded)' : 'down at start (no survival assertion)'}`);

  await new Promise<void>((r) => harness.listen(0, '127.0.0.1', r));
  HARNESS_URL = `http://127.0.0.1:${(harness.address() as AddressInfo).port}`;
  const e2eEnv = { JARVIS_E2E: HARNESS_URL };

  await phase('P1 verify DMG (rebuild if stale)', async () => {
    const attempt = () => { try { return { ok: true, out: sh(path.join(SCRIPTS, 'verify-dmg.sh')) }; } catch (e) { return { ok: false, out: String((e as { stdout?: string }).stdout ?? '') + String((e as Error).message) }; } };
    let r = attempt();
    if (!r.ok) {
      console.log(`verify-dmg failed, rebuilding…\n${r.out.slice(0, 500)}`);
      sh(path.join(SCRIPTS, 'build-dmg.sh'), [], { timeout: 3_600_000 });
      r = attempt();
    }
    assert.ok(r.ok, `verify-dmg after rebuild: ${r.out.slice(0, 800)}`);
    assert.match(r.out, /VERIFY_DMG_OK/);
  });

  await phase('P2 install --seed (fresh clean-install root)', async () => {
    const out = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['install', '--seed', DEV_RUNTIME]);
    assert.match(out, /M7_INSTALL_OK/);
    if (ownerWasUp) assert.ok(await ownerUp(), 'owner 7788 alive after install');
  });

  let taskId = '';
  await phase('P3 GUI launch with harness env + version identity', async () => {
    armFocusGuard();
    resyncPages(); // pages loaded from this launch on are fresh; earlier ones are stale
    const out = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['launch', '240'], { timeout: 600_000, env: e2eEnv });
    assert.match(out, /M7_HEALTH_OK/);
    const version = (await (await api('/api/version')).json()) as { core: string; protocol: number; version: string };
    assert.equal(version.core, 'jarvis-core', 'version endpoint core identity');
    assert.equal(version.protocol, 1, 'version endpoint protocol');
    assert.equal(version.version, '0.1.0');
    if (ownerWasUp) assert.ok(await ownerUp(), 'owner 7788 alive after GUI launch');
  });

  await phase('P4 packaged-UI handshake → Ready (BLOCKER 1, GUI-side)', async () => {
    // The installed app itself resolved the endpoint (Tauri invoke), completed
    // the identity handshake, and loaded data — observed only via the UI.
    const txt = await cmd({ cmd: 'wait', sel: '[data-testid="core-state"]', text: 'Ready', timeoutMs: 120_000 }, 180);
    assert.match(txt, /Ready/, 'sidebar core-state shows Ready');
  });

  await phase('P5 GUI-driven smoke task → Completed + verification PASSED in the UI', async () => {
    // ponytail: generous harness budgets — owner machine runs load 150+
    // (Docker VM + multiple opencode sessions); a 30s budget starves mid-spike.
    await cmd({ cmd: 'set', sel: '#task-request', value: smokeRequest }, 90);
    await cmd({ cmd: 'set', sel: 'input[aria-label="Project directory"]', value: WORKSPACE }, 90);
    await cmd({ cmd: 'click', sel: 'button[aria-label="Execute task"]' }, 90);
    // Task id comes from the rendered panel — not from any API response.
    const idText = await cmd({ cmd: 'wait', sel: 'section.current-task h2.task-link', timeoutMs: 120_000 }, 180);
    taskId = idText.trim();
    assert.ok(taskId.length > 0, 'task id visible in current-task panel');
    console.log(`  GUI-created task: ${taskId}`);

    const deadline = Date.now() + 1800 * 1000;
    let status = '';
    for (;;) {
      status = await cmd({ cmd: 'get', sel: 'section.current-task [data-testid="status-pill"]', timeoutMs: 85_000 }, 145);
      if (/Completed|Failed|Cancelled|Waiting for you/.test(status)) break;
      if (Date.now() > deadline) throw new Error(`task not terminal after 1800s (last status: ${status})`);
      await sleep(10_000);
    }
    assert.match(status, /Completed/, `terminal status from UI pill: ${status}`);

    await cmd({ cmd: 'click', sel: 'section.current-task h2.task-link' }, 90);
    const ver = await cmd({ cmd: 'wait', sel: '[data-testid="verification-status"]', text: 'PASSED', timeoutMs: 140_000 }, 200);
    assert.match(ver, /PASSED/, 'verification_status read from the detail page');

    const file = path.join(WORKSPACE, 'm8-smoke.txt');
    assert.ok(existsSync(file), 'm8-smoke.txt created by the real chain');
    assert.equal(readFileSync(file, 'utf8').trim(), 'JARVIS_M8_SMOKE_OK', 'exact content');
  });

  await phase('P6 quit → relaunch → history visible in the UI', async () => {
    if (focusGuard) { clearInterval(focusGuard); focusGuard = null; }
    const outStop = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['stop'], { timeout: 120_000 });
    console.log('[P6] ' + outStop.trim().split('\n').pop());
    assert.match(outStop, /M7_STOP_OK/);
    assert.equal(corePids().length, 0, 'port released after stop');
    assert.equal(guiPids().length, 0, 'GUI process gone after stop');
    if (ownerWasUp) assert.ok(await ownerUp(), 'owner 7788 alive after stop');

    resyncPages(); // orphan pages from the app we just stopped are now stale
    const outLaunch = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['launch', '240'], { timeout: 600_000, env: e2eEnv });
    console.log('[launch] ' + outLaunch.trim().split('\n').pop());
    assert.match(outLaunch, /M7_HEALTH_OK/);
    await cmd({ cmd: 'wait', sel: '[data-testid="core-state"]', text: 'Ready', timeoutMs: 120_000 }, 180);
    await cmd({ cmd: 'click', text: 'Tasks' }, 30);
    await cmd({ cmd: 'wait', text: taskId, timeoutMs: 120_000 }, 180);
    const row = await cmd({ cmd: 'get', sel: 'tr[role="button"]', text: taskId }, 90);
    assert.match(row, /Completed/, `history row status from UI: ${row.slice(0, 160)}`);
  });

  await phase('P7 reinstall → relaunch → history survived', async () => {
    const outStop = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['stop'], { timeout: 120_000 });
    console.log('[P7] ' + outStop.trim().split('\n').pop());
    assert.match(outStop, /M7_STOP_OK/);
    const outRe = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['reinstall']);
    assert.match(outRe, /M7_REINSTALL_OK/);
    assert.match(outRe, /task history intact/, 'state preserved across reinstall');

    resyncPages(); // orphan pages from the app we just stopped are now stale
    const outLaunch = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['launch', '240'], { timeout: 600_000, env: e2eEnv });
    console.log('[launch] ' + outLaunch.trim().split('\n').pop());
    assert.match(outLaunch, /M7_HEALTH_OK/);
    armFocusGuard();
    await cmd({ cmd: 'wait', sel: '[data-testid="core-state"]', text: 'Ready', timeoutMs: 120_000 }, 180);
    await cmd({ cmd: 'click', text: 'Tasks' }, 30);
    await cmd({ cmd: 'wait', text: taskId, timeoutMs: 60_000 }, 120);
  });

  await phase('P8 uninstall → ownership-clean removal', async () => {
    disarmFocusGuard();
    const out = sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['uninstall'], { timeout: 60_000 });
    assert.match(out, /M7_UNINSTALL_OK/);
    assert.equal(corePids().length, 0, 'no core listener on our port');
    assert.equal(guiPids().length, 0, 'no GUI process of this install');
    let leftovers: string[] = [];
    try { leftovers = execFileSync('pgrep', ['-f', `${M8_ROOT}/install`], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch { /* none */ }
    assert.equal(leftovers.length, 0, `no processes remain under the install root, got [${leftovers}]`);
    if (ownerWasUp) assert.ok(await ownerUp(), 'owner 7788 alive after uninstall');
  });

  await phase('P9 owner dev server survived (regression guard)', async () => {
    if (ownerWasUp) assert.ok(await ownerUp(), 'owner 7788 still up at the end');
  });

  // ---------------------------------------------------------------- verdict --
  const phases = Object.keys(results);
  const failed = phases.filter((p) => !results[p].ok);
  const technicalPass = !aborted && failed.length === 0;
  // RC readiness demands the whole clean-install GUI flow passed — including
  // this test's GUI-driven task, handshake, relaunch, reinstall and uninstall.
  const rcReady = technicalPass;
  console.log('');
  console.log(`M8_PHASES_TOTAL: ${phases.length}`);
  console.log(`M8_PHASES_FAILED: ${failed.length}${failed.length ? ` (${failed.join(', ')})` : ''}`);
  console.log(`M8_TECHNICAL_PASS: ${technicalPass ? 'YES' : 'NO'}`);
  console.log(`READY_FOR_V0.1.0_RC: ${rcReady ? 'YES' : 'NO'}`);
  writeFileSync(REPORT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    phases: results,
    taskId,
    harnessUrl: HARNESS_URL,
    ownerServerGuarded: ownerWasUp,
    verdicts: { m8TechnicalPass: technicalPass, readyForV010Rc: rcReady },
  }, null, 2) + '\n');
  console.log(`report → ${REPORT_PATH}`);

  assert.ok(technicalPass, `M8 not green: ${failed.join(', ')}`);
});
