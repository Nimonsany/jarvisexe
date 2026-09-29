/**
 * Generates dist-core/build-manifest.json — version / git SHA / builtAt / arch / channel.
 * The Tauri bundle embeds it as core-runtime/build-manifest.json (verify-dmg + /api/version read it).
 * Run: npx tsx scripts/release/gen-manifest.mts [outfile]
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface BuildManifest {
  version: string;
  commit: string;
  dirty: boolean;
  builtAt: string;
  arch: string;
  channel: string;
}

export function buildManifest(opts: { version?: string; commit?: string; dirty?: boolean; channel?: string; now?: Date } = {}): BuildManifest {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const version = opts.version
    ?? JSON.parse(readFileSync(path.join(repoRoot, 'apps/desktop/src-tauri/tauri.conf.json'), 'utf8')).version;
  let commit = opts.commit;
  let dirty = opts.dirty;
  if (commit === undefined) {
    try {
      commit = execSync('git rev-parse --short HEAD', { cwd: repoRoot, encoding: 'utf8' }).trim();
      dirty = dirty ?? execSync('git status --porcelain', { cwd: repoRoot, encoding: 'utf8' }).trim().length > 0;
    } catch { commit = 'unknown'; }
  }
  return {
    version,
    commit,
    dirty: dirty ?? false,
    builtAt: (opts.now ?? new Date()).toISOString(),
    arch: process.arch,
    channel: opts.channel ?? process.env.RELEASE_CHANNEL ?? 'dev',
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = path.resolve(process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist-core/build-manifest.json'));
  const m = buildManifest();
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(m, null, 2) + '\n');
  if (!existsSync(out)) throw new Error(`manifest not written: ${out}`);
  console.log(`build manifest → ${out} (${m.version} ${m.commit}${m.dirty ? ' dirty' : ''} ${m.arch} ${m.channel})`);
}
