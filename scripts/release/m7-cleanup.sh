#!/usr/bin/env bash
# M7 Phase 12 — post-run cleanup: our processes, our mounts, our temp root, dmg temps.
# Exact-path/name guards only — never a broad pattern that could hit foreign processes.
set -euo pipefail
cd "$(dirname "$0")/../.."

ROOT="${M7_ROOT:-/tmp/jarvis-m7}"
PORT="${M7_PORT:-7789}"
case "$ROOT" in
  *jarvis-m7*) ;;
  *) echo "M7_CLEANUP_FAIL: M7_ROOT '$ROOT' lacks the jarvis-m7 guard" >&2; exit 1 ;;
esac

# 1. processes belonging to this install (argv contains the exact install path)
pkill -f "$ROOT/install/JARVIS.app" 2>/dev/null || true
# 2. whatever still holds our port
if PIDS=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null); then
  for p in $PIDS; do kill "$p" 2>/dev/null || true; done
  sleep 2
  for p in $PIDS; do kill -9 "$p" 2>/dev/null || true; done
fi
# 3. dmg mounts created under our root (grep may match nothing — that's fine)
hdiutil info | { grep -F "$ROOT" || true; } | awk '{print $1}' | while read -r dev; do
  [ -e "$dev" ] || continue
  hdiutil detach "$dev" -force >/dev/null 2>&1 || true
done
# 4. stale bundler temp images (exact dir, exact pattern)
rm -f apps/desktop/src-tauri/target/release/bundle/dmg/rw.*.dmg
# 5. the disposable root itself
rm -rf "$ROOT"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "M7_CLEANUP_FAIL: port $PORT still in use" >&2; exit 1
fi
[ ! -e "$ROOT" ] || { echo "M7_CLEANUP_FAIL: $ROOT still present" >&2; exit 1; }
echo "M7_CLEANUP_OK: procs stopped, mounts released, $ROOT removed, port $PORT free"
