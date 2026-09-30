#!/usr/bin/env bash
# M8 — post-run cleanup: our processes, our mounts, our temp root, dmg temps.
# M8 BLOCKER 2: broad name-based kills and bare port kills are forbidden here —
# every process must prove (live argv contains the exact install path) that it
# belongs to THIS install before it may be signalled. Unrelated processes
# always survive.
set -euo pipefail
cd "$(dirname "$0")/../.."

ROOT="${M7_ROOT:-/tmp/jarvis-m7}"
PORT="${M7_PORT:-7789}"
case "$ROOT" in
  *jarvis-m7*) ;;
  *) echo "M7_CLEANUP_FAIL: M7_ROOT '$ROOT' lacks the jarvis-m7 guard" >&2; exit 1 ;;
esac
RUN="$ROOT/run"; PIDFILE="$RUN/core.pid"
APP_IDENT="$ROOT/install/JARVIS.app"

# 1. our processes — pidfile + exact install-path identity proof only
. scripts/release/verified-kill.sh
if [ -f "$RUN/gui.pid" ]; then
  verified_kill_pid "$(cat "$RUN/gui.pid")" "$APP_IDENT/Contents/MacOS/jarvis-desktop" TERM || true
  rm -f "$RUN/gui.pid"
fi
if [ -f "$PIDFILE" ]; then
  verified_kill_pid "$(cat "$PIDFILE")" "$APP_IDENT" TERM || true
  rm -f "$PIDFILE"
fi
# belt: anything still running FROM this install path (pgrep matches the exact
# unique install path in argv; verified_kill_pid re-proves it before signalling)
for p in $(pgrep -f "$APP_IDENT" 2>/dev/null || true); do
  verified_kill_pid "$p" "$APP_IDENT" TERM || true
done
sleep 2
for p in $(pgrep -f "$APP_IDENT" 2>/dev/null || true); do
  verified_kill_pid "$p" "$APP_IDENT" KILL || true
done

# 2. whatever still holds our port — only killed if proven to be this install
if PIDS=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null); then
  for p in $PIDS; do verified_kill_pid "$p" "$APP_IDENT" TERM || true; done
  sleep 2
  for p in $PIDS; do verified_kill_pid "$p" "$APP_IDENT" KILL || true; done
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
echo "M7_CLEANUP_OK: procs stopped (ownership-verified), mounts released, $ROOT removed, port $PORT free"
