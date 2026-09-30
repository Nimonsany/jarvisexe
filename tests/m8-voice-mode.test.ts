/**
 * M8-4 — voice engine/mode reporting check.
 * Run: npx tsx --test tests/m8-voice-mode.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { collectVoice, resolveWhisperBin } from '../packages/core/src/preflight.js';

test('M8-4 collectVoice reports engine + accelerator mode', () => {
  const v = collectVoice();
  assert.ok(v.engine === null || v.engine === 'whisper.cpp', `engine: ${v.engine}`);
  assert.ok(['metal', 'cpu', 'unknown'].includes(v.mode), `mode: ${v.mode}`);
  if (v.whisper === 'ready') {
    assert.ok(v.path, 'ready implies a resolved absolute path');
    assert.equal(v.engine, 'whisper.cpp');
    assert.notEqual(v.mode, 'unknown', 'otool-based mode detection works on an installed binary');
  }
});

test('M8-4 single resolution point: collectVoice and runtime agree on the binary', () => {
  const r = resolveWhisperBin();
  const v = collectVoice();
  assert.equal(v.path, r.path, 'collectVoice uses resolveWhisperBin (no PATH/jarvis-bin divergence)');
  assert.equal(v.source, r.source);
});

test('M8-4 reported mode matches the binary’s actual linked libraries', (t) => {
  const v = collectVoice();
  if (v.whisper !== 'ready' || v.mode === 'unknown') return t.skip('no whisper binary to inspect');
  const links = execFileSync('otool', ['-L', v.path!], { encoding: 'utf8' });
  const metal = /libggml-metal|Metal\.framework/.test(links);
  assert.equal(v.mode, metal ? 'metal' : 'cpu', 'mode derived from otool output');
});
