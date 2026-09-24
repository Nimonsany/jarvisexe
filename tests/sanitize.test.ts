import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitize, sanitizeTruncated } from '../packages/core/src/security/sanitize.js';

test('redacts JWTs, AWS keys, GitHub tokens, private keys, passwords, conn strings', () => {
  const cases: [string, RegExp][] = [
    ['token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c', /REDACTED/],
    ['AKIAIOSFODNN7EXAMPLE in config', /REDACTED/],
    ['ghp_1234567890abcdefghijklmnop', /REDACTED/],
    ['-----BEGIN RSA PRIVATE KEY-----\nABC\nDEF\n-----END RSA PRIVATE KEY-----', /REDACTED/],
    ['password = "hunter2supersecret"', /REDACTED/],
    ['postgres://user:secretpw@db.host:5432/app', /REDACTED/],
    ['Authorization: Bearer abcdef123456.abcdef', /REDACTED/],
  ];
  for (const [input, re] of cases) {
    const out = sanitize(input);
    assert.match(out, re, `not redacted: ${input}`);
    assert.ok(!out.includes('hunter2supersecret') && !out.includes('secretpw') && !out.includes('SflKxw'), `leaked: ${input}`);
  }
});

test('keeps normal text intact', () => {
  const text = 'Error: module "lodash" not found at src/index.ts';
  assert.equal(sanitize(text), text);
});

test('truncation', () => {
  const out = sanitizeTruncated('x'.repeat(10000), 100);
  assert.ok(out.length < 200);
});
