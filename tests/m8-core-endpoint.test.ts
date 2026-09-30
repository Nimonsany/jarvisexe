/**
 * M8 BLOCKER 1 — Core endpoint discovery + identity handshake.
 * Run: npx tsx --test tests/m8-core-endpoint.test.ts
 *
 * - resolution: Tauri invoke → VITE_JARVIS_CORE_URL → CORE_ENDPOINT_UNRESOLVED
 * - handshake: /api/version must carry the jarvis-core identity marker
 * - real JarvisServer: identity route returns core/protocol for a live core
 * - blocker regression: no hardcoded 127.0.0.1:7788/7789 anywhere in React
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  resolveCoreEndpoint,
  handshakeCore,
  CORE_IDENTITY,
  CORE_PROTOCOL,
} from '../apps/desktop/src/services/coreEndpoint.js';
import { JarvisServer } from '../packages/core/src/server.js';
import type { Orchestrator } from '../packages/core/src/orchestrator.js';
import { TaskStore } from '../packages/core/src/task/store.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal orchestrator stand-in — only what JarvisServer's routes touch. */
function fakeOrchestrator(runtimeDir: string): Orchestrator {
  const store = new TaskStore(runtimeDir);
  return {
    taskStore: store,
    async run() { throw new Error('not used'); },
    async cancel() { /* not used */ },
    emergencyStopped: false,
    securityLog: { entries: [] as unknown[], async record() { /* not used */ } },
    approvals: { async list() { return []; }, async decide() { /* not used */ } },
  } as unknown as Orchestrator;
}

/** Tiny HTTP server that answers /api/version with an arbitrary body. */
async function decoy(body: string, status = 200): Promise<{ url: string; close: () => Promise<void> }> {
  const srv: Server = createServer((req, res) => {
    if (req.url === '/api/version') {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => srv.close(() => r())),
  };
}

test('resolveCoreEndpoint: Tauri invoke wins, env is fallback, neither → unresolved', async () => {
  const fromInvoke = await resolveCoreEndpoint({
    invoke: async (cmd: string) => (cmd === 'jarvis_core_endpoint' ? 'http://127.0.0.1:7789/' : ''),
    envUrl: 'http://127.0.0.1:9999',
  });
  assert.equal(fromInvoke, 'http://127.0.0.1:7789');

  const fromEnv = await resolveCoreEndpoint({ invoke: async () => { throw new Error('no tauri'); }, envUrl: 'http://127.0.0.1:9999/' });
  assert.equal(fromEnv, 'http://127.0.0.1:9999');

  const invokeSilent = await resolveCoreEndpoint({ invoke: async () => null, envUrl: 'http://127.0.0.1:9999' });
  assert.equal(invokeSilent, 'http://127.0.0.1:9999');

  await assert.rejects(() => resolveCoreEndpoint({ invoke: null, envUrl: null }), /CORE_ENDPOINT_UNRESOLVED/);
  await assert.rejects(() => resolveCoreEndpoint({ invoke: async () => 'not-a-url', envUrl: 'ftp://bad' }), /CORE_ENDPOINT_UNRESOLVED/);
});

test('handshakeCore: identity mismatch for a wrong service on the port', async () => {
  const d = await decoy(JSON.stringify({ version: '9.9.9', commit: 'x', dirty: false, builtAt: '', arch: 'x64', channel: 'stable' }));
  try {
    await assert.rejects(
      () => handshakeCore({ invoke: null, envUrl: d.url }),
      /CORE_IDENTITY_MISMATCH/,
    );
  } finally { await d.close(); }
});

test('handshakeCore: non-JSON body counts as identity mismatch', async () => {
  const d = await decoy('<html>some other server</html>');
  try {
    await assert.rejects(() => handshakeCore({ invoke: null, envUrl: d.url }), /CORE_IDENTITY_MISMATCH/);
  } finally { await d.close(); }
});

test('handshakeCore: nothing listening → CORE_UNAVAILABLE', async () => {
  // reserve a port, then close it so nothing answers
  const d = await decoy('{}');
  const url = d.url;
  await d.close();
  await assert.rejects(() => handshakeCore({ invoke: null, envUrl: url }), /CORE_UNAVAILABLE/);
});

test('real JarvisServer: /api/version carries core identity + protocol', async () => {
  const runtimeDir = mkdtempSync(path.join(tmpdir(), 'jarvis-m8-ver-'));
  const srv = new JarvisServer(runtimeDir, fakeOrchestrator(runtimeDir));
  await srv.listen(7796, '127.0.0.1');
  try {
    const { base, version } = await handshakeCore({ invoke: null, envUrl: 'http://127.0.0.1:7796' });
    assert.equal(base, 'http://127.0.0.1:7796');
    assert.equal(version.core, CORE_IDENTITY);
    assert.equal(version.protocol, CORE_PROTOCOL);
    assert.ok(version.version.length > 0);
  } finally {
    await srv.close();
    rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('BLOCKER 1 regression: no hardcoded core URL in React sources', () => {
  const srcRoot = path.join(repoRoot, 'apps/desktop/src');
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx)$/.test(name)) continue;
      const text = readFileSync(p, 'utf8');
      for (const m of text.matchAll(/127\.0\.0\.1:778[89]|localhost:778[89]/g)) {
        offenders.push(`${path.relative(repoRoot, p)} → ${m[0]}`);
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(offenders, [], `hardcoded Core URLs found:\n${offenders.join('\n')}`);
});

test('dialog self-check: module actually loaded (guards silent import failure)', async () => {
  assert.ok(typeof handshakeCore === 'function');
  assert.equal(CORE_IDENTITY, 'jarvis-core');
  await sleep(1);
});
