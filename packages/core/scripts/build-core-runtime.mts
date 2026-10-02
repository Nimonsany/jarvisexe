/**
 * Builds the standalone core runtime for packaging:
 *   dist-core/server.js      — esbuild bundle (prompts embedded, playwright external)
 *   dist-core/node_modules/  — playwright + playwright-core + runtime deps
 *   dist-core/jarvis-core    — sidecar launcher script
 * The Tauri bundle ships this directory as resources; the shell spawns the launcher.
 * Run: npm run build-core (from packages/core)
 */
import { build } from 'esbuild';
import { mkdirSync, cpSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '../../../dist-core');
mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(here, '../src/bin/server-entry.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: path.join(out, 'server.js'),
  external: ['playwright', 'playwright-core', 'chromium-bidi'],
  loader: { '.md': 'text' },
  minify: false,
  sourcemap: false,
  logLevel: 'info',
});

// runtime deps for the ChatGPT browser controller (Chrome channel — no bundled browsers)
const nm = path.join(out, 'node_modules');
mkdirSync(nm, { recursive: true });
const repoNm = path.resolve(here, '../../../node_modules');
for (const pkg of ['playwright', 'playwright-core']) {
  const src = path.join(repoNm, pkg);
  if (existsSync(src)) {
    cpSync(src, path.join(nm, pkg), { recursive: true });
    // nested transitive deps (e.g. chromium-bidi inside playwright-core)
    const nested = path.join(src, 'node_modules');
    if (existsSync(nested)) cpSync(nested, path.join(nm, pkg, 'node_modules'), { recursive: true });
  } else console.warn(`missing runtime dep: ${pkg}`);
}

// sidecar launcher: finds server.js next to itself OR in the bundle's Resources dir.
// App-spawned processes get a minimal environment (no PATH) — locate node explicitly.
const launcher = path.join(out, 'jarvis-core');
writeFileSync(launcher, `#!/bin/sh
# JARVIS core sidecar launcher — spawned by the desktop shell
DIR="$(cd "$(dirname "$0")" && pwd)"
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:/usr/bin:/bin:$PATH"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  for CAND in /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.local/bin/node"; do
    [ -x "$CAND" ] && NODE_BIN="$CAND" && break
  done
fi
if [ -z "$NODE_BIN" ]; then echo "node not found — install Node.js" >&2; exit 1; fi
for CAND in "$DIR/core-runtime" "$DIR/../Resources/core-runtime" "$DIR/../core-runtime" "$DIR/../../../Resources/core-runtime" "$DIR" "/usr/lib/jarvis/core-runtime" "/usr/lib/JARVIS/core-runtime" "/usr/local/lib/jarvis/core-runtime"; do
  if [ -f "$CAND/server.js" ]; then
    export NODE_PATH="$CAND/node_modules:$NODE_PATH"
    exec "$NODE_BIN" "$CAND/server.js" "$@"
  fi
done
echo "JARVIS core runtime not found next to the sidecar" >&2
exit 1
`);
chmodSync(launcher, 0o755);

// Windows launcher (CI builds on windows-latest)
if (process.platform === 'win32') {
  const cmdLauncher = path.join(out, 'jarvis-core.cmd');
  writeFileSync(cmdLauncher, `@echo off
set DIR=%~dp0
set NODE_CMD=node
where node >nul 2>nul || set NODE_CMD=%ProgramFiles%\\nodejs\\node.exe
if exist "%DIR%core-runtime\\server.js" (
  set NODE_PATH=%DIR%core-runtime\\node_modules;%NODE_PATH%
  "%NODE_CMD%" "%DIR%core-runtime\\server.js" %*
) else (
  echo JARVIS core runtime not found next to the sidecar 1>&2
  exit /b 1
)
`);
  console.log('windows launcher written');
}

console.log('core runtime built at:', out);
