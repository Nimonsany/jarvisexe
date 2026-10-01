/**
 * Milestone 6 tests: dashboard static serving, remote access auth (device token).
 * Run: npx tsx tests/m6-remote.test.mts  (core server running, dist built)
 */
import * as assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE = 'http://127.0.0.1:7788';
// These tests exercise a RUNNING core server (see header). On fresh clones / CI
// no server exists — skip cleanly instead of failing the suite.
try {
  await fetch(BASE + '/', { signal: AbortSignal.timeout(2000) });
  readFileSync('runtime/auth-token', 'utf8');
} catch {
  console.log('SKIP m6-remote: core server on 7788 or runtime/auth-token not available');
  process.exit(0);
}
const token = readFileSync('runtime/auth-token', 'utf8').trim();
let passed = 0;
const TOTAL = 4;
const step = async (name: string, fn: () => Promise<void> | void) => {
  try { await fn(); passed++; console.log(`✔ ${name}`); }
  catch (e) { console.error(`✖ ${name}:`, e instanceof Error ? e.message : e); process.exitCode = 1; }
};

// simulate a REMOTE device origin (non-allowlisted): use a fake Origin header
const remoteOrigin = { 'Origin': 'http://100.101.102.103:7788', 'Content-Type': 'application/json' };

try {
  await step('dashboard UI served at 7788 (index.html + assets)', async () => {
    const r = await fetch(BASE + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    const html = await r.text();
    assert.match(html, /<div id="root">/);
    // asset served
    const js = html.match(/src="(\/assets\/[^"]+\.js)"/);
    assert.ok(js, 'js asset referenced');
    const r2 = await fetch(BASE + js![1]);
    assert.equal(r2.status, 200);
    assert.match(r2.headers.get('content-type') ?? '', /javascript/);
  });

  await step('remote access ON: untrusted origin token-gated (401 without token, 200 with)', async () => {
    const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    await fetch(BASE + '/api/settings', { method: 'POST', headers: H, body: JSON.stringify({ remoteAccess: true }) });
    for (const path of ['/api/health', '/api/tasks', '/api/settings', '/api/bootstrap']) {
      const r = await fetch(BASE + path, { headers: remoteOrigin });
      assert.equal(r.status, 401, `${path} remote without token → 401`);
    }
    const rpost = await fetch(BASE + '/api/task', { method: 'POST', headers: remoteOrigin, body: '{}' });
    assert.equal(rpost.status, 401);
    for (const path of ['/api/health', '/api/tasks']) {
      const r = await fetch(BASE + path, { headers: { ...remoteOrigin, 'Authorization': `Bearer ${token}` } });
      assert.equal(r.status, 200, `${path} with device token → 200`);
    }
    // bootstrap stays local-only even with the token
    const rb = await fetch(BASE + '/api/bootstrap', { headers: { ...remoteOrigin, 'Authorization': `Bearer ${token}` } });
    assert.equal(rb.status, 401, 'bootstrap never serves the token to remote origins');
    // an untrusted web origin (https://evil.com) also token-gated when remote ON
    const r3 = await fetch(BASE + '/api/health', { headers: { 'Origin': 'https://evil.com' } });
    assert.equal(r3.status, 401);
    const r4 = await fetch(BASE + '/api/health', { headers: { 'Origin': 'https://evil.com', 'Authorization': `Bearer ${token}` } });
    assert.equal(r4.status, 200);
    // restore remote OFF (default)
    await fetch(BASE + '/api/settings', { method: 'POST', headers: H, body: JSON.stringify({ remoteAccess: false }) });
    const s2 = await (await fetch(BASE + '/api/settings', { headers: H })).json();
    assert.equal(s2.remoteAccess, false);
  });

  await step('remote access OFF: foreign origin rejected outright (403)', async () => {
    const settings = await (await fetch(BASE + '/api/settings', { headers: { 'Authorization': `Bearer ${token}` } })).json();
    assert.equal(settings.remoteAccess, false);
    const r = await fetch(BASE + '/api/health', { headers: { 'Origin': 'https://evil.com' } });
    assert.equal(r.status, 403, 'foreign origin with remote OFF → 403');
    const r2 = await fetch(BASE + '/api/task', { method: 'POST', headers: { 'Origin': 'https://evil.com', 'Authorization': `Bearer ${token}` }, body: '{}' });
    assert.equal(r2.status, 403, 'foreign origin with remote OFF → 403 even with token');
  });

  await step('remote settings persisted + type-validated', async () => {
    const raw = JSON.parse(readFileSync('runtime/settings.json', 'utf8'));
    assert.equal(raw.remoteAccess, false, 'default off after restore');
    const H = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    const r = await fetch(BASE + '/api/settings', { method: 'POST', headers: H, body: JSON.stringify({ remoteAccess: 'yes-please' }) });
    assert.equal(r.status, 500, 'non-boolean remoteAccess rejected');
  });
} catch (e) {
  console.error('FATAL:', e);
  process.exit(1);
}

console.log(`\nM6 REMOTE/UI TESTS: ${passed}/${TOTAL} passed`);
process.exit(process.exitCode === 1 ? 1 : 0);
