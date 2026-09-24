import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlanResponse, parseCorrectiveResponse } from '../packages/core/src/browser/parser.js';

test('extracts OPENCODE MASTER PROMPT section', () => {
  const res = parsePlanResponse(`# PLAN\nstuff\n\n=== OPENCODE MASTER PROMPT ===\nBuild the app per the plan above. Do the phases in order and test.\n===\nMore chatter`);
  assert.equal(res.usedFallback, false);
  assert.match(res.opencodePrompt, /Build the app/);
  assert.ok(res.plan.includes('PLAN'));
});

test('falls back when master prompt missing, keeps full plan', () => {
  const res = parsePlanResponse('just some unstructured plan text without markers');
  assert.equal(res.usedFallback, true);
  assert.match(res.opencodePrompt, /unstructured plan text/); // plan embedded in fallback
  assert.match(res.opencodePrompt, /Inspect existing files/);
});

test('extracts corrective prompt', () => {
  const res = parseCorrectiveResponse(`analysis...\n=== OPENCODE CORRECTIVE PROMPT ===\nFix the off-by-one in calculator.ts, rerun tests.\n===`);
  assert.match(res, /Fix the off-by-one/);
});

test('corrective fallback returns whole response', () => {
  const res = parseCorrectiveResponse('no markers just advice');
  assert.equal(res, 'no markers just advice');
});
