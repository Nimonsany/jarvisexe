import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Verifier } from '../packages/core/src/verifier/verifier.js';
import type { Task } from '../packages/core/src/task/types.js';

function fakeTask(dir: string): Task {
  return {
    id: 'TASK-V', owner_request: 'x', created_at: '', updated_at: '',
    status: 'VERIFYING', current_phase: 'verify', project_directory: dir,
    chatgpt_session: null, opencode_session: 's1', retry_count: 0,
    chatgpt_cycle_count: 0, last_error: null, result: null, verification_status: 'UNVERIFIED',
  };
}

test('node -e test command (brackets/parens) runs directly, no shell filter', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-ver-'));
  try {
    writeFileSync(path.join(dir, 'hello.html'), '<h1>JARVIS SMOKE OK</h1><p>centered</p>\n'.repeat(5));
    const v = new Verifier();
    const cmd = `node -e "const fs=require('fs');const s=fs.readFileSync('hello.html','utf8');if(!s.includes('JARVIS SMOKE OK')||!/<h1[\\s>]/i.test(s))process.exit(1);console.log('JARVIS_SMOKE_OK')"`;
    const r = await v.verifySoftware(fakeTask(dir), { required_files: ['hello.html'], test_command: cmd });
    assert.equal(r.passed, true, JSON.stringify(r.steps));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shell test commands with metacharacters (grep classes, $()) run', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-ver-'));
  try {
    writeFileSync(path.join(dir, 'hello.html'), '<h1>JARVIS SMOKE OK</h1>\n<p>centered</p>\n');
    const v = new Verifier();
    const cmd = `test -f hello.html && grep -Eq 'JARVIS[[:space:]]+SMOKE' hello.html && test "$(wc -l < hello.html)" -lt 40`;
    const r = await v.verifySoftware(fakeTask(dir), { test_command: cmd });
    assert.equal(r.passed, true, JSON.stringify(r.steps));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('failing test command reports failure (not filter)', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'jarvis-ver-'));
  try {
    const v = new Verifier();
    const r = await v.verifySoftware(fakeTask(dir), { test_command: 'test -f missing.txt' });
    assert.equal(r.passed, false);
    assert.doesNotMatch(r.steps[0].detail, /safety filter/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
