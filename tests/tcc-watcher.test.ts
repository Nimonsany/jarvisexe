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
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'tcc-watcher.sh');

function fileURLToPath(url: string): string {
  return url.replace(/^file:\/\//, '');
}

/** Extract the AppleScript heredoc body (between `<<EOF` and the closing `EOF`) */
function extractApplescript(script: string): string {
  const m = script.match(/<<EOF[^\n]*\n([\s\S]*?)\nEOF\n/);
  assert.ok(m, 'AppleScript heredoc not found in watcher script');
  return m![1];
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
  const script = readFileSync(scriptPath, 'utf8');
  assert.ok(script.includes('log "clicked " & bn'), 'clicks must be logged with the button name');
});

test('only Allow/OK-family buttons are clicked — never "Don\'t Allow"', () => {
  const script = readFileSync(scriptPath, 'utf8');
  const clickAllow = script.match(/if bn is in \{([^}]*)\} then/);
  assert.ok(clickAllow, 'click allowlist not found');
  const allowlist = clickAllow![1];
  assert.ok(allowlist.includes('"OK"'), 'allowlist must include OK');
  assert.ok(!/"Don't Allow"/.test(allowlist), 'allowlist must never include "Don\'t Allow"');
});
