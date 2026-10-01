#!/usr/bin/env bash
# Builds a fresh release DMG (M7 Phase 2):
#   manifest → core bundle → stage sidecar → tauri build (.app only) →
#   freshness gate → hdiutil dmg (bundle_dmg.sh hangs on this machine) → sha256 → temp cleanup.
# tauri.conf bundle.targets is ["app"] on purpose — dmg creation is owned by this script.
set -euo pipefail
cd "$(dirname "$0")/../.."

VER=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
# createUpdaterArtifacts: true requires the private key for ANY bundled build
if [ -f "$HOME/.jarvis/keys/updater.key" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.jarvis/keys/updater.key")"
  # passwordless key: set the password env explicitly, else the signer opens a
  # TTY prompt ("Device not configured" when run from a script/CI)
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
fi
APP=apps/desktop/src-tauri/target/release/bundle/macos/JARVIS.app
DMG_DIR=apps/desktop/src-tauri/target/release/bundle/dmg
DMG="$DMG_DIR/JARVIS_${VER}_x64.dmg"
BIN=apps/desktop/src-tauri/binaries/jarvis-core-x86_64-apple-darwin

# 1. fresh build manifest (git SHA of THIS build)
npx tsx scripts/release/gen-manifest.mts

# 2. core bundle (server.js + node_modules + launcher) and stage the sidecar
npx tsx packages/core/scripts/build-core-runtime.mts
cp dist-core/jarvis-core "$BIN"

# 3. desktop app (cargo + bundler; .app only — dmg comes next)
(cd apps/desktop/src-tauri && npx tauri build)

# 4. freshness gate — the .app must embed THIS build's manifest, sidecar and server
test -f "$APP/Contents/Resources/core-runtime/build-manifest.json" || { echo "BUILD_DMG_FAIL: manifest not embedded in .app" >&2; exit 1; }
cmp -s dist-core/build-manifest.json "$APP/Contents/Resources/core-runtime/build-manifest.json" || { echo "BUILD_DMG_FAIL: embedded manifest stale" >&2; exit 1; }
cmp -s "$BIN" "$APP/Contents/MacOS/jarvis-core" || { echo "BUILD_DMG_FAIL: embedded sidecar stale" >&2; exit 1; }
cmp -s dist-core/server.js "$APP/Contents/Resources/core-runtime/server.js" || { echo "BUILD_DMG_FAIL: embedded server.js stale" >&2; exit 1; }

# 4b. ad-hoc sign — unsigned apps get no stable TCC identity: every install
#     re-prompts (Desktop/Documents/Downloads/…) and an unclicked prompt can
#     freeze the requesting thread mid-run. A cdhash makes grants persist per
#     build. No hardened runtime: the embedded node needs JIT and we are not
#     notarizing.
codesign --force --deep --sign - "$APP" || { echo "BUILD_DMG_FAIL: codesign failed" >&2; exit 1; }
codesign --verify --strict "$APP" || { echo "BUILD_DMG_FAIL: codesign verify failed" >&2; exit 1; }

# 5. dmg via hdiutil (foreground — background hdiutil dies without a tty)
rm -f "$DMG" "$DMG.sha256"
mkdir -p "$DMG_DIR"
STAGING=$(mktemp -d /tmp/jarvis-dmg-XXXXXX)
cleanup() { rm -rf "$STAGING"; }
trap cleanup EXIT
cp -R "$APP" "$STAGING/"
ln -s /Applications "$STAGING/Applications"
hdiutil create -volname JARVIS -srcfolder "$STAGING" -ov -format UDZO "$DMG"

# 6. checksum (verify-dmg.sh checks it)
shasum -a 256 "$DMG" >"$DMG.sha256"

# 7. stale bundler temp images (exact pattern, exact dir only)
rm -f "$DMG_DIR"/rw.*.dmg

echo "BUILD_DMG_OK: $DMG ($(du -h "$DMG" | cut -f1))"
