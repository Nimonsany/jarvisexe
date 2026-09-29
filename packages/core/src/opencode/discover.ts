/**
 * FR-5 OpenCode binary discovery — precedence: configured (env/settings) →
 * bundled → user-local → PATH (absolute entries only; never a cwd-relative binary).
 * The returned path is always absolute so runs can be recorded safely.
 */
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export type OpencodeSource = 'env' | 'settings' | 'bundled' | 'user-local' | 'path';
export interface OpencodeHit { path: string; source: OpencodeSource }

export interface DiscoveryOpts {
  configured?: string;
  env?: NodeJS.ProcessEnv;
  home?: string;
  execDir?: string;
}

function isExecutable(p: string): boolean {
  try {
    if (!path.isAbsolute(p) || !statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch { return false; }
}

/** Ordered candidate list (same order as discovery). Used for search + diagnostics. */
export function opencodeCandidates(opts: DiscoveryOpts = {}): OpencodeHit[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  const execDir = opts.execDir ?? path.dirname(process.execPath);
  const hits: OpencodeHit[] = [];
  if (env.OPENCODE_BIN) hits.push({ path: env.OPENCODE_BIN, source: 'env' });
  if (opts.configured && opts.configured !== env.OPENCODE_BIN) hits.push({ path: opts.configured, source: 'settings' });
  hits.push(
    { path: path.join(execDir, 'opencode'), source: 'bundled' },
    { path: '/Applications/JARVIS.app/Contents/MacOS/opencode', source: 'bundled' },
    { path: path.join(home, '.opencode', 'bin', 'opencode'), source: 'user-local' },
    { path: path.join(home, '.local', 'bin', 'opencode'), source: 'user-local' },
  );
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir || dir === '.' || !path.isAbsolute(dir)) continue;
    hits.push({ path: path.join(dir, 'opencode'), source: 'path' });
  }
  return hits;
}

export function discoverOpencode(opts: DiscoveryOpts = {}): OpencodeHit | null {
  for (const c of opencodeCandidates(opts)) if (isExecutable(c.path)) return c;
  return null;
}
