/**
 * M9 Phases 18-21 — signed updater lifecycle, driven through the REAL app UI:
 *
 *   npx tsx --test tests/e2e/m9-updater.e2e.test.ts
 *
 * Builds two signed app versions against a loopback latest.json endpoint
 * (config override — production endpoint untouched), installs A, then:
 *
 *   P1  A (0.1.0) launches via the m7 clean-install lifecycle, driver reports 0.1.0
 *   P2  UI "Check for updates" → download+install signed B → relaunch → driver
 *       reports 0.1.1 → re-check says "Up to date."          (Phase 19 A/B)
 *   P3  corrupted signature → "Update check failed", version stays 0.1.0,
 *       no relaunch                                            (Phase 20 tamper)
 *   P4  lower version (0.0.9) in latest.json → "Up to date."   (Phase 18/21
 *       downgrade rejection — frontend never relaxes this)
 *   P5  foreign platform key only → "Up to date."              (Phase 18 platform)
 *   P6  reinstall the saved A artifact → back on 0.1.0          (Phase 21 rollback)
 *
 * The dev server on 7788 is guarded throughout and never touched.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, chmodSync, readFileSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ROOT = process.env.M9_ROOT || `/tmp/jarvis-m9-upd-${process.pid}`;
const PORT = Number(process.env.M9_PORT || 7793);
const OWNER_API = 'http://127.0.0.1:7788';
const SCRIPTS = path.join(REPO, 'scripts/release');
const DEV_RUNTIME = path.join(REPO, 'runtime');
const APP_DIR = path.join(REPO, 'apps/desktop/src-tauri');
const BUNDLE_MACOS = path.join(APP_DIR, 'target/release/bundle/macos');
const INSTALL_APP = path.join(ROOT, 'install/JARVIS.app');
// shared across runs: A/B updater artifacts survive ROOT (pid-scoped) cleanup,
// so M9_SKIP_BUILDS=1 can reuse them instead of re-linking under memory thrash
const ARTIFACTS = process.env.M9_ARTIFACTS || '/tmp/jarvis-m9-artifacts';
const REPORT_PATH = path.join(REPO, 'm9-report.json');

let focusGuard: ReturnType<typeof setInterval> | null = null;
function armFocusGuard(): void {
  if (focusGuard) return;
  focusGuard = setInterval(() => {
    try {
      // respawn only when dead — and ALWAYS with the harness env, else the
      // replacement instance has no driver and the test silently loses it
      let alive = false;
      try { execFileSync('pgrep', ['-f', `${ROOT}/install/JARVIS.app/Contents/MacOS/jarvis-desktop`], { stdio: 'ignore' }); alive = true; } catch { /* dead */ }
      if (!alive) {
        console.log('  focusGuard: gui dead — respawning with e2e env');
        execFileSync('open', ['-n', '--env', `JARVIS_E2E=${HARNESS_URL}`, '--env', `JARVIS_PORT=${PORT}`,
          '--env', `JARVIS_RUNTIME_DIR=${ROOT}/state`, '--env', `JARVIS_ORPHAN_ROOT=${ROOT}/workspace`, INSTALL_APP],
          { timeout: 2000, stdio: 'ignore' });
      } else {
        execFileSync('open', [INSTALL_APP], { timeout: 2000, stdio: 'ignore' });
      }
    } catch { /* not up yet */ }
  }, 2000);
}
function disarmFocusGuard(): void { if (focusGuard) { clearInterval(focusGuard); focusGuard = null; } }

const results: Record<string, { ok: boolean; detail?: string }> = {};
let aborted = false;

const sh = (cmd: string, args: string[] = [], opts: { timeout?: number; env?: Record<string, string>; cwd?: string } = {}): string =>
  execFileSync(cmd, args, {
    cwd: opts.cwd ?? REPO,
    env: { ...process.env, M7_ROOT: ROOT, M7_PORT: String(PORT), ...opts.env },
    encoding: 'utf8',
    timeout: opts.timeout ?? 300_000,
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

// --- harness: driver queue + latest.json/pkg serving (one port) -------------
type HCmd = { id: string; cmd: string; sel?: string; value?: string; text?: string; timeoutMs?: number };
const pending: HCmd[] = [];
const finished = new Map<string, { ok: boolean; value?: string; error?: string }>();
let cmdSeq = 0;
let lastGetAt = 0;
let lastGetKey = '-';
let pageFloor = 0;
const resyncPages = (): void => { pageFloor = Date.now(); };
let HARNESS_URL = '';
/** latest.json body served to the updater — swapped per phase. */
let latestDoc: unknown = null;
/** file served at /pkg/update.app.tar.gz (B bundle). */
let pkgPath = '';
const pkgName = 'update.app.tar.gz';

const harness: Server = createServer((req, res) => {
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
    if (pageT && pageT < pageFloor) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('null'); return; }
    const c = pending.shift() ?? null;
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(c));
    return;
  }
  if (req.method === 'POST' && req.url === '/done') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      try {
        const d = JSON.parse(body) as { id: string; ok: boolean; value?: string; error?: string };
        console.log(`[h] done← ${d.id} ok=${d.ok} ${String(d.error ?? d.value ?? '').slice(0, 70)}`);
        finished.set(d.id, d);
      } catch { /* malformed */ }
      res.writeHead(204).end();
    });
    return;
  }
  if (req.method === 'GET' && req.url?.split('?')[0] === '/latest.json') {
    if (latestDoc === null) { res.writeHead(404).end(); return; }
    console.log(`[h] GET /latest.json @ ${new Date().toISOString()}`);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(latestDoc));
    return;
  }
  if (req.method === 'GET' && req.url?.split('?')[0] === `/pkg/${pkgName}`) {
    if (!pkgPath || !existsSync(pkgPath)) { res.writeHead(404).end(); return; }
    console.log(`[h] GET /pkg @ ${new Date().toISOString()}`);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    createReadStream(pkgPath).pipe(res);
    return;
  }
  res.writeHead(404).end();
});

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
  await sleep(100);
  const late = finished.get(id);
  if (late) {
    finished.delete(id);
    if (!late.ok) throw new Error(`driver ${c.cmd} sel=${c.sel ?? '-'} text=${c.text ?? '-'}: ${late.error}`);
    return late.value ?? '';
  }
  const i = pending.findIndex((p) => p.id === id);
  if (i >= 0) pending.splice(i, 1);
  const liveness = lastGetAt ? ` — driver last GET ${Math.round((Date.now() - lastGetAt) / 1000)}s ago via ${lastGetKey}` : ' — driver never polled';
  throw new Error(`harness timeout (${timeoutSec}s): ${c.cmd} sel=${c.sel ?? '-'} text=${c.text ?? '-'}${liveness}`);
}

/** Fire-and-forget variant: /done may be lost when the command's last act is
 *  killing the page (relaunch race) — caller polls ground truth instead. */
async function cmdMaybeLost(c: Omit<HCmd, 'id'>, timeoutSec: number): Promise<string | null> {
  try { return await cmd(c, timeoutSec); } catch { return null; }
}

async function ownerUp(): Promise<boolean> {
  try { return (await fetch(`${OWNER_API}/health`, { signal: AbortSignal.timeout(4000) })).ok; }
  catch { return false; }
}

const guiPids = (): string[] => {
  try { return execFileSync('pgrep', ['-f', `${ROOT}/install/JARVIS.app/Contents/MacOS/jarvis-desktop`], { encoding: 'utf8' }).split('\n').filter(Boolean); }
  catch { return []; }
};

async function apiVersion(): Promise<string> {
  const tokenFile = path.join(ROOT, 'state', 'auth-token');
  const token = existsSync(tokenFile) ? readFileSync(tokenFile, 'utf8').trim() : '';
  const r = await fetch(`http://127.0.0.1:${PORT}/api/version`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  return ((await r.json()) as { version: string }).version;
}

/** Launch via the m7 lifecycle (ownership-verified stop, health wait, E2E env). */
const launch = (budget = 240): string => sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['launch', String(budget)], { timeout: 600_000, env: { JARVIS_E2E: HARNESS_URL } });
const stop = (): string => sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['stop'], { timeout: 180_000 });

const navSettings = async (timeoutSec = 90): Promise<void> => {
  await cmd({ cmd: 'click', text: 'Settings', timeoutMs: 20_000 }, timeoutSec);
  await cmd({ cmd: 'wait', text: 'Check for updates', timeoutMs: 20_000 }, timeoutSec);
};
const clickCheck = async (): Promise<void> => { await cmd({ cmd: 'click', text: 'Check for updates', timeoutMs: 20_000 }, 90); };
const appVersion = (): Promise<string> => cmd({ cmd: 'app_version', timeoutMs: 15_000 }, 60);

const darwinKey = (): string => (process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64');
const withPlatform = (version: string, url: string, signature: string): unknown =>
  ({ version, platforms: { [darwinKey()]: { url, signature } } });

test('M9 updater E2E — signed A/B update, tamper reject, downgrade/platform guards, rollback', async () => {
  const ownerWasUp = await ownerUp();
  console.log(`owner dev server on 7788: ${ownerWasUp ? 'up (guarded)' : 'down at start'}`);

  // fixed port: --config endpoint stays byte-identical across runs → cargo/tauri
  // cache can hit (random port forced a full app recompile every run)
  await new Promise<void>((res, rej) => { harness.once('error', rej); harness.listen(PORT, '127.0.0.1', res); });
  HARNESS_URL = `http://127.0.0.1:${PORT}`;
  mkdirSync(ROOT, { recursive: true });
  mkdirSync(ARTIFACTS, { recursive: true });

  const keyFile = path.join(process.env.HOME ?? '', '.jarvis/keys/updater.key');
  assert.ok(existsSync(keyFile), `updater signing key present at ${keyFile}`);
  // passwordless key: PASSWORD must be set (empty) or the signer opens a TTY
  // prompt and dies with "Device not configured" under test runners
  const signEnv = {
    TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyFile, 'utf8'),
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
  };
  const endpoint = `${HARNESS_URL}/latest.json`;
  const updCfg = (extra: Record<string, unknown> = {}): string => JSON.stringify({
    ...extra,
    plugins: { updater: { endpoints: [endpoint], dangerousInsecureTransportProtocol: true } },
  });

  let B_TGZ = '';
  let B_SIG = '';

  await phase('P0 builds — A (0.1.0) + signed B bundle (0.1.1) on localhost endpoint', async () => {
    const aBin = path.join(ARTIFACTS, 'JARVIS-A.app/Contents/MacOS/jarvis-desktop');
    const sharedTgz = path.join(ARTIFACTS, 'B.app.tar.gz');
    if (process.env.M9_SKIP_BUILDS && existsSync(aBin) && existsSync(sharedTgz) && existsSync(`${sharedTgz}.sig`)) {
      B_TGZ = sharedTgz; B_SIG = `${sharedTgz}.sig`; pkgPath = sharedTgz;
      console.log('  M9_SKIP_BUILDS=1 — reusing shared A/B artifacts (stale-embed OK: no commit gate in m9)');
      return;
    }
    // freshness: manifest + core runtime + staged sidecar (build-dmg steps 1-2)
    sh('npx', ['tsx', 'scripts/release/gen-manifest.mts'], { timeout: 600_000 });
    sh('npx', ['tsx', 'packages/core/scripts/build-core-runtime.mts'], { timeout: 600_000 });
    const triple = sh('rustc', ['-vV']).split('\n').find((l) => l.startsWith('host: '))!.split(' ')[1];
    mkdirSync(path.join(APP_DIR, 'binaries'), { recursive: true });
    // node cpSync mode must be <= 7; set exec bit separately
    cpSync(path.join(REPO, 'dist-core/jarvis-core'), path.join(APP_DIR, 'binaries', `jarvis-core-${triple}`));
    chmodSync(path.join(APP_DIR, 'binaries', `jarvis-core-${triple}`), 0o755);

    // build under owner-load: single-job cargo + one retry (rustc gets silently
    // SIGKILLed by memory pressure on this box — no cargo error line, just death)
    const cargoEnv = { ...signEnv, CARGO_BUILD_JOBS: '1' };
    const build = (cfg: string, what: string): void => {
      try { sh('npx', ['tauri', 'build', '--bundles', 'app', '--config', cfg], { cwd: APP_DIR, env: cargoEnv, timeout: 3_600_000 }); }
      catch (e) {
        console.log(`  ${what} build failed — retrying once (${String(e).slice(0, 120)})`);
        sh('npx', ['tauri', 'build', '--bundles', 'app', '--config', cfg], { cwd: APP_DIR, env: cargoEnv, timeout: 3_600_000 });
      }
    };

    // build A (current version 0.1.0 from tauri.conf) with the localhost endpoint
    build(updCfg(), 'A');
    const appA = path.join(BUNDLE_MACOS, 'JARVIS.app');
    assert.ok(existsSync(path.join(appA, 'Contents/MacOS/jarvis-desktop')), 'A app built');
    rmSync(path.join(ARTIFACTS, 'JARVIS-A.app'), { recursive: true, force: true });
    cpSync(appA, path.join(ARTIFACTS, 'JARVIS-A.app'), { recursive: true });

    // build B: version override via --config (no tracked file edits)
    build(updCfg({ version: '0.1.1' }), 'B');
    const builtTgz = path.join(BUNDLE_MACOS, 'JARVIS.app.tar.gz');
    const builtSig = `${builtTgz}.sig`;
    assert.ok(existsSync(builtTgz), 'B update bundle produced');
    assert.ok(existsSync(builtSig), 'B updater signature produced');
    pkgPath = path.join(ARTIFACTS, 'B.app.tar.gz');
    cpSync(builtTgz, pkgPath);
    cpSync(builtSig, `${pkgPath}.sig`);
    B_TGZ = pkgPath;
    B_SIG = `${pkgPath}.sig`;
    console.log(`  A saved → ${path.join(ARTIFACTS, 'JARVIS-A.app')}; B sig=${readFileSync(B_SIG, 'utf8').slice(0, 24)}…`);
  });

  const bSig = (): string => (B_SIG && existsSync(B_SIG) ? readFileSync(B_SIG, 'utf8').trim() : '');
  const pkgUrl = (): string => `${HARNESS_URL}/pkg/${pkgName}`;

  await phase('P1 install A + launch — driver reports 0.1.0', async () => {
    rmSync(INSTALL_APP, { recursive: true, force: true });
    mkdirSync(path.dirname(INSTALL_APP), { recursive: true });
    cpSync(path.join(ARTIFACTS, 'JARVIS-A.app'), INSTALL_APP, { recursive: true });
    armFocusGuard();
    resyncPages();
    const out = launch();
    assert.match(out, /M7_HEALTH_OK/, 'health after launch');
    assert.equal(await appVersion(), '0.1.0', 'running app version is 0.1.0');
    assert.equal((await apiVersion()).slice(0, 5), '0.1.0', 'embedded core manifest version');
    if (ownerWasUp) assert.ok(await ownerUp(), 'owner 7788 alive after launch');
  });

  await phase('P2 UI update 0.1.0 → 0.1.1 (signed download, install, relaunch)', async () => {
    latestDoc = withPlatform('0.1.1', pkgUrl(), bSig());
    // network sniffer: where does check() actually connect? (baked endpoint
    // port unknown for prebuilt artifacts; also catches github fallback)
    const peers = new Set<string>();
    const sniff = setInterval(() => {
      try {
        const pids = guiPids();
        if (!pids.length) return;
        const out = execFileSync('bash', ['-c', `lsof -nP -iTCP -a -p ${pids.join(',')} 2>/dev/null | awk 'NR>1 {print $8, $9}'`], { encoding: 'utf8' });
        out.split('\n').map((s) => s.trim()).filter(Boolean).forEach((s) => peers.add(s));
      } catch { /* app mid-restart */ }
    }, 2000);
    try {
    await navSettings();
    const pidsBefore = guiPids();
    assert.ok(pidsBefore.length >= 1, 'gui running before update');
    // The message /done can be lost when relaunch() tears the page down — ground
    // truth is the pid change (old binary replaced + new process running).
    // sample the persisted updater status (localStorage survives app death)
    // instead of blind-waiting: we learn exactly how far the flow got and why
    // the process went away, even across a respawn.
    let lastMsg = '';
    const t0 = Date.now();
    while (Date.now() - t0 < 200_000) {
      let m: string | null = null;
      try { m = await cmdMaybeLost({ cmd: 'storage', value: 'jarvis.e2e.updMsg', timeoutMs: 4_000 }, 8); } catch { /* transient */ }
      if (m && !m.startsWith('unknown cmd') && m !== lastMsg) { console.log(`  [ui] ${m}`); lastMsg = m; }
      if (lastMsg.includes('Installed')) break;
      await sleep(3000);
    }
    if (lastMsg) console.log('  last updater status: ' + lastMsg);
    const plistVer = (): string => {
      try { return execFileSync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', path.join(INSTALL_APP, 'Contents/Info.plist')], { encoding: 'utf8' }).trim(); }
      catch (e) { return `unreadable:${e instanceof Error ? e.message : e}`; }
    };
    const deadline = Date.now() + 300_000;
    for (;;) {
      const now = guiPids();
      if (now.length >= 1 && !now.some((p) => pidsBefore.includes(p))) break; // entirely new pids
      if (Date.now() > deadline) throw new Error(`relaunch not detected (before=${pidsBefore} now=${now})`);
      await sleep(2000);
    }
    await sleep(2000); // install completes before relaunch() in the real flow
    console.log('  relaunch detected, new gui: ' + guiPids().join(',') + ' | installed version now ' + plistVer());
    // ground truth: relaunch() only runs after downloadAndInstall() resolved,
    // which only succeeds after the bundle is swapped — so version MUST be 0.1.1.
    const body = await cmdMaybeLost({ cmd: 'wait', timeoutMs: 5_000 }, 12); // no text → instant innerText dump
    if (body) console.log('  UI body after pid change: ' + body.replace(/\s+/g, ' ').slice(0, 400));
    const v = plistVer();
    if (v !== '0.1.1') throw new Error(`relaunch without install — bundle version still ${v} | last ui: ${lastMsg || 'none'} | pkg GET logged above | UI: ${(body ?? 'no driver').replace(/\s+/g, ' ').slice(0, 200)}`);
    disarmFocusGuard(); armFocusGuard(); // stale-page floor: only post-restart polls count
    resyncPages();
    } finally {
      clearInterval(sniff);
      console.log('  P2 peers (STATE ADDR): ' + ([...peers].join(' | ') || 'none'));
    }
  });

  await phase('P2b post-update re-check says Up to date + version 0.1.1', async () => {
    // driver / page must be the NEW app instance (floor enforced by resync)
    await cmd({ cmd: 'wait', text: 'JARVIS', timeoutMs: 60_000 }, 90);
    const v = await appVersion();
    assert.equal(v, '0.1.1', `driver-reported version after update (got ${v})`);
    await navSettings();
    await clickCheck();
    const txt = await cmd({ cmd: 'wait', text: 'Up to date.', timeoutMs: 120_000 }, 150);
    assert.match(txt, /Up to date\./, 're-check at new version');
  });

  await phase('P3 tampered signature rejected — stays 0.1.0, no relaunch', async () => {
    disarmFocusGuard();
    stop();
    rmSync(INSTALL_APP, { recursive: true, force: true });
    cpSync(path.join(ARTIFACTS, 'JARVIS-A.app'), INSTALL_APP, { recursive: true });
    latestDoc = withPlatform('0.1.1', pkgUrl(), 'Zm9yZ2VkLXNpZ25hdHVyZS1ub3QtYWxwaGFiZXQtbW9yZS10aGFuLTMycQ'); // invalid b64 garbage
    armFocusGuard();
    resyncPages();
    assert.match(launch(), /M7_HEALTH_OK/);
    assert.equal(await appVersion(), '0.1.0', 'fresh A again');
    await navSettings();
    const pidsBefore = guiPids();
    await clickCheck();
    const txt = await cmd({ cmd: 'wait', text: 'Update check failed', timeoutMs: 180_000 }, 200);
    console.log('  tamper surfaced: ' + txt.trim().replace(/\s+/g, ' ').slice(0, 300));
    assert.equal(await appVersion(), '0.1.0', 'version unchanged after tampered update');
    const pidsAfter = guiPids();
    assert.deepEqual(pidsAfter, pidsBefore, 'no relaunch on tampered signature');
    writeFileSync(path.join(ROOT, 'tamper-message.txt'), txt); // evidence for the report
  });

  await phase('P4 downgrade rejected — 0.0.9 in latest.json → Up to date', async () => {
    latestDoc = withPlatform('0.0.9', pkgUrl(), bSig());
    await clickCheck();
    const txt = await cmd({ cmd: 'wait', text: 'Up to date.', timeoutMs: 120_000 }, 150);
    assert.match(txt, /Up to date\./, 'lower version never offered');
    assert.equal(await appVersion(), '0.1.0', 'still 0.1.0');
  });

  await phase('P5 foreign platform rejected — linux-only latest.json → Up to date', async () => {
    latestDoc = { version: '0.1.1', platforms: { 'linux-x86_64': { url: pkgUrl(), signature: bSig() } } };
    await clickCheck();
    const txt = await cmd({ cmd: 'wait', text: 'Up to date.', timeoutMs: 120_000 }, 150);
    assert.match(txt, /Up to date\./, 'no darwin entry → no update for this platform');
  });

  await phase('P6 rollback — reinstall saved A artifact → 0.1.0 healthy', async () => {
    disarmFocusGuard();
    stop();
    rmSync(INSTALL_APP, { recursive: true, force: true });
    cpSync(path.join(ARTIFACTS, 'JARVIS-A.app'), INSTALL_APP, { recursive: true });
    armFocusGuard();
    resyncPages();
    assert.match(launch(), /M7_HEALTH_OK/);
    const v = await appVersion();
    assert.equal(v, '0.1.0', 'rollback restored 0.1.0');
  });

  after(() => {
    disarmFocusGuard();
    harness.close();
    try { sh(path.join(SCRIPTS, 'm7-clean-install.sh'), ['stop'], { timeout: 180_000 }); } catch { /* gone */ }
    try { execFileSync('pkill', ['-9', '-f', ROOT], { stdio: 'ignore' }); } catch { /* none */ }
    const pass = Object.values(results).every((r) => r.ok);
    writeFileSync(REPORT_PATH, JSON.stringify({
      suite: 'm9-updater', pass, ranAt: new Date().toISOString(),
      endpoints: { latestJson: `${HARNESS_URL}/latest.json` }, results,
      evidence: { tamperMessage: existsSync(path.join(ROOT, 'tamper-message.txt')) ? readFileSync(path.join(ROOT, 'tamper-message.txt'), 'utf8') : null },
    }, null, 2));
    console.log(pass ? 'M9_UPDATER_PASS: yes' : 'M9_UPDATER_PASS: no');
    if (ownerWasUp) { void ownerUp(); }
  });
});
