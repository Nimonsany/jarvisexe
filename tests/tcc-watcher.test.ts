/**
 * M10 Phase 21 — TCC watcher permanent regression.
 * The v1/v2 watcher's AppleScript used `matches` (not a valid osascript
 * operator) and never compiled; the error was swallowed by 2>/dev/null and
 * the watcher silently clicked nothing for months.
 *
 * Run: npx tsx --test tests/tcc-watcher.test.ts
 *
 * - AppleScript is syntax-validated (osacompile) before any use
 * - failures are observable: stderr is captured to the log, not discarded
 * - watcher startup/clicks generate evidence in the log
 * - only Allow/OK-family buttons are clicked (never "Don't Allow")
 * - LIVE: the real detection query runs against System Events (exits 0)
 * - LIVE: the watcher shell loop actually starts and survives one iteration
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(here, '..', 'scripts', 'tcc-watcher.sh');
const applescriptPath = path.resolve(here, '..', 'scripts', 'tcc-watcher.applescript');

function fileURLToPath(url: string): string {
  return url.replace(/^file:\/\//, '');
}

/** Body of the AppleScript that the watcher executes: heredoc if present
 *  (pre-Phase-21 layout), otherwise the referenced scripts/*.applescript file. */
function extractApplescript(script: string): string {
  const m = script.match(/<<EOF[^\n]*\n([\s\S]*?)\nEOF\n/);
  if (m) return m[1];
  const ref = script.match(/\$\(dirname "\$0"\)\/([A-Za-z0-9._-]+\.applescript)/);
  assert.ok(ref, 'AppleScript source not found in watcher script (no heredoc, no .applescript reference)');
  return readFileSync(path.resolve(path.dirname(scriptPath), ref![1]), 'utf8');
}

test('watcher script exists and passes bash syntax check', () => {
  const r = spawnSync('bash', ['-n', scriptPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, `bash -n failed: ${r.stderr}`);
});

test('AppleScript compiles (osacompile) — the v1 `matches` regression', { skip: process.platform !== 'darwin' }, () => {
  const script = readFileSync(scriptPath, 'utf8');
  const as = extractApplescript(script);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tcc-watcher-test-'));
  const asPath = path.join(dir, 'watcher.applescript');
  try {
    // v1 regression: `matches` was an invalid operator and osacompile rejected it
    assert.ok(!/\bmatches\b/.test(as), 'AppleScript must not use the invalid `matches` operator');
    writeFileSync(asPath, as);
    execFileSync('osacompile', ['-o', path.join(dir, 'out.scpt'), asPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stderr is captured to the log — never blindly discarded (M10 Phase 21/22)', () => {
  const script = readFileSync(scriptPath, 'utf8');
  assert.ok(!script.includes('2>/dev/null'), 'watcher must not discard stderr (2>/dev/null forbidden)');
  assert.ok(script.includes('2>&1'), 'watcher must capture stderr alongside stdout');
  assert.ok(/TCC_WATCHER_LOG/.test(script), 'watcher must log to an overridable log file');
  assert.ok(/>> *(\$\{TCC_WATCHER_LOG)/.test(script), 'watcher must append evidence to the log');
});

test('click logging present — intended interaction generates evidence', () => {
  const as = readFileSync(applescriptPath, 'utf8');
  assert.ok(as.includes('log "clicked " & bn'), 'clicks must be logged with the button name');
});

test('only Allow/OK-family buttons are clicked — never "Don\'t Allow"', () => {
  const as = readFileSync(applescriptPath, 'utf8');
  const clickAllow = as.match(/if bn is in \{([^}]*)\} then/);
  assert.ok(clickAllow, 'click allowlist not found');
  const allowlist = clickAllow![1];
  assert.ok(allowlist.includes('"OK"'), 'allowlist must include OK');
  assert.ok(!/"Don't Allow"/.test(allowlist), 'allowlist must never include "Don\'t Allow"');
});

test('osacompile validates scripts/tcc-watcher.applescript — the real source file', { skip: process.platform !== 'darwin' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tcc-watcher-src-'));
  try {
    execFileSync('osacompile', ['-o', path.join(dir, 'out.scpt'), applescriptPath], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LIVE detection: target query runs against System Events and exits 0', { skip: process.platform !== 'darwin' }, () => {
  // Executes has_dont/has_ok/title-match logic on real SecurityAgent /
  // UserNotificationCenter windows. No dialogs are created, so with none
  // present this must exit 0 with empty output. An AppleEvents TCC denial
  // (error -1743) makes execFileSync throw and fails — never masked here.
  const out = execFileSync('osascript', [applescriptPath], { encoding: 'utf8', timeout: 60_000 });
  assert.equal(out.trim(), '', 'detection with no matching dialogs must produce no clicks');
});

test('WATCHER START: bash scripts/tcc-watcher.sh runs and survives one iteration', { skip: process.platform !== 'darwin', timeout: 30_000 }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tcc-watcher-start-'));
  const logPath = path.join(dir, 'watcher.log');
  const child = spawn('bash', [scriptPath], {
    env: { ...process.env, TCC_WATCHER_LOG: logPath },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  try {
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    await new Promise((r) => setTimeout(r, 7000)); // > one 5s loop iteration
    assert.equal(child.exitCode, null, `watcher died within 7s (exit=${child.exitCode}) stderr=${stderr}`);
    assert.ok(!child.killed, 'watcher was killed before the liveness check');
  } finally {
    try { process.kill(-child.pid!, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
    await new Promise((r) => setTimeout(r, 500));
    if (child.exitCode === null) {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
    child.unref();
    rmSync(dir, { recursive: true, force: true });
  }
});
