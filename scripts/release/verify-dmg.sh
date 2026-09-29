#!/usr/bin/env bash
# Verifies the release DMG without installing it (M7 Phase 3):
#   checksum → read-only mount → app layout → embedded manifest == build manifest == git HEAD →
#   SEC-5 secret-filename scan → detach (always, via trap).
set -euo pipefail
cd "$(dirname "$0")/../.."

VER=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
DMG="apps/desktop/src-tauri/target/release/bundle/dmg/JARVIS_${VER}_x64.dmg"
MOUNT="/Volumes/JARVIS-verify.$$"

fail() { echo "VERIFY_DMG_FAIL: $*" >&2; exit 1; }

test -f "$DMG" || fail "DMG not found: $DMG (run scripts/release/build-dmg.sh)"
[ -f "$DMG.sha256" ] && shasum -a 256 -c "$DMG.sha256" >/dev/null || fail "checksum mismatch"

hdiutil attach -nobrowse -readonly -mountpoint "$MOUNT" "$DMG" >/dev/null || fail "mount failed"
cleanup() { hdiutil detach "$MOUNT" -force >/dev/null 2>&1 || true; }
trap cleanup EXIT

APP="$MOUNT/JARVIS.app"
test -d "$APP" || fail "JARVIS.app missing in DMG"
test -x "$APP/Contents/MacOS/jarvis-desktop" || fail "main binary missing"
test -x "$APP/Contents/MacOS/jarvis-core" || fail "sidecar missing"
test -f "$APP/Contents/Resources/core-runtime/server.js" || fail "server.js missing"
test -f "$APP/Contents/Resources/core-runtime/build-manifest.json" || fail "build-manifest.json missing"

# freshness: embedded manifest == repo manifest == git HEAD (FR-17)
cmp -s dist-core/build-manifest.json "$APP/Contents/Resources/core-runtime/build-manifest.json" || fail "embedded manifest != dist-core manifest (stale DMG)"
HEAD_SHA=$(git rev-parse --short HEAD)
APP_SHA=$(node -p 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).commit' "$APP/Contents/Resources/core-runtime/build-manifest.json")
[ "$HEAD_SHA" = "$APP_SHA" ] || fail "manifest commit $APP_SHA != HEAD $HEAD_SHA (stale DMG)"

# SEC-5: no secret-looking filenames inside the bundle
SECRETS=$(find "$APP" \( -iname "auth-token" -o -iname "*.pem" -o -iname "*.key" -o -iname "*.p12" -o -iname "*.pfx" -o -iname "id_rsa*" -o -iname ".env*" -o -iname "*credential*" -o -iname "*secret*" \) -print)
[ -z "$SECRETS" ] || fail "secret-looking files in bundle: $SECRETS"

echo "VERIFY_DMG_OK: $DMG (commit $APP_SHA)"
