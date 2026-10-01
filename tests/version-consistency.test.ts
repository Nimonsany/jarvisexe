/**
 * M9 Phase 3 — version source of truth.
 *
 * tauri.conf.json `version` is authoritative (gen-manifest derives the release
 * build-manifest from it, /api/version serves it). Every other product-version
 * copy in the repo must equal it exactly. Failures mean someone bumped a copy
 * by hand and forgot the rest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function pkg(name: string): string {
  return JSON.parse(readFileSync(path.join(ROOT, name), 'utf8')).version as string;
}

test('version consistency: tauri.conf.json is the single source of truth', () => {
  const base = pkg('apps/desktop/src-tauri/tauri.conf.json');
  assert.match(base, /^\d+\.\d+\.\d+/, `tauri.conf version not semver: ${base}`);

  const copies: Record<string, string> = {
    'package.json': pkg('package.json'),
    'apps/desktop/package.json': pkg('apps/desktop/package.json'),
    'packages/core/package.json': pkg('packages/core/package.json'),
    'apps/desktop/src-tauri/Cargo.toml':
      readFileSync(path.join(ROOT, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8')
        .match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? 'MISSING',
  };
  for (const [file, v] of Object.entries(copies)) {
    assert.equal(v, base, `${file} version ${v} != tauri.conf ${base}`);
  }
});

test('version consistency: embedded source copies track the base version', () => {
  const base = pkg('apps/desktop/src-tauri/tauri.conf.json');

  // dev fallback served by /api/version when no build-manifest exists —
  // may carry a -dev/-rc suffix but must start with the base version.
  const server = readFileSync(path.join(ROOT, 'packages/core/src/server.ts'), 'utf8');
  const fallback = server.match(/version:\s*'([^']+)'\s*,\s*commit:\s*'dev'/)?.[1];
  assert.ok(fallback, 'server.ts dev version fallback not found');
  assert.ok(fallback!.startsWith(base), `server.ts fallback ${fallback} does not start with ${base}`);

  // context7 broker MCP clientInfo
  const broker = readFileSync(path.join(ROOT, 'packages/core/src/agents/context7-broker.ts'), 'utf8');
  const client = broker.match(/clientInfo[^}]*version:\s*'([^']+)'/)?.[1];
  assert.ok(client, 'context7-broker clientInfo version not found');
  assert.equal(client, base, `context7-broker clientInfo ${client} != ${base}`);
});
