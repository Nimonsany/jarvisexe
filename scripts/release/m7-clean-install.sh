#!/usr/bin/env bash
# M7 Phase 6 — clean install lifecycle against the release DMG (FR-1..FR-4, FR-14..FR-19).
# Disposable, fully isolated: app copy, runtime state, workspace, logs and pid all live
# under $M7_ROOT (default /tmp/jarvis-m7). Never touches /Applications or the dev runtime.
# Core runs on JARVIS_PORT=7789 so the dev server on 7788 stays untouched.
set -euo pipefail
cd "$(dirname "$0")/../.."

ROOT="${M7_ROOT:-/tmp/jarvis-m7}"
PORT="${M7_PORT:-7789}"
VER=$(node -p "require('./apps/desktop/src-tauri/tauri.conf.json').version")
DMG="apps/desktop/src-tauri/target/release/bundle/dmg/JARVIS_${VER}_x64.dmg"
APP_SRC="$ROOT/install/JARVIS.app"
RUN="$ROOT/run"; LOGS="$ROOT/logs"; STATE="$ROOT/state"; WORKSPACE="$ROOT/workspace"
PIDFILE="$RUN/core.pid"; MNT="$ROOT/.dmg-mnt"
HEALTH_URL="http://127.0.0.1:$PORT/health"

fail() { echo "M7_INSTALL_FAIL: $*" >&2; exit 1; }
[ -n "${1:-}" ] || fail "usage: m7-clean-install.sh install|launch|launch-core|health|stop|reinstall|uninstall|status [args]"
CMD="$1"; shift || true

mount_dmg() {
  [ -f "$DMG" ] || fail "DMG not found: $DMG (run scripts/release/build-dmg.sh)"
  mkdir -p "$MNT"
  hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null || fail "dmg mount failed"
}
unmount_dmg() { hdiutil detach "$MNT" -force >/dev/null 2>&1 || true; }

copy_app_from_dmg() {
  mount_dmg
  rm -rf "$APP_SRC"
  mkdir -p "$ROOT/install"
  cp -R "$MNT/JARVIS.app" "$APP_SRC" || { unmount_dmg; fail "app copy failed"; }
  unmount_dmg
  [ -x "$APP_SRC/Contents/MacOS/jarvis-desktop" ] || fail "main binary missing after install"
  [ -x "$APP_SRC/Contents/MacOS/jarvis-core" ] || fail "sidecar missing after install"
  warm_first_exec
}

WARM_PORT=7797
warm_first_exec() { # first exec of freshly-copied binaries can block in macOS
  # (XProtect assessment) for minutes — pay that cost here, once, so the
  # user-visible launches are not capped by the health wait
  local wrt="$ROOT/.warm-rt" wws="$ROOT/.warm-ws" wpid="$RUN/warm.pid"
  mkdir -p "$RUN" "$LOGS" "$wrt" "$wws"
  ( cd "$wws" && { JARVIS_PORT="$WARM_PORT" JARVIS_RUNTIME_DIR="$wrt" JARVIS_ORPHAN_ROOT="$wws" \
      nohup "$APP_SRC/Contents/MacOS/jarvis-core" >"$LOGS/warm.log" 2>&1 </dev/null & echo $! >"$wpid"; } )
  local deadline=$(( $(date +%s) + 400 )) ok=0
  while [ "$(date +%s)" -lt "$deadline" ]; do
    curl -s -m 2 "http://127.0.0.1:$WARM_PORT/health" 2>/dev/null | grep -q '"core":"online"' && { ok=1; break; }
    sleep 2
  done
  [ -f "$wpid" ] && kill "$(cat "$wpid")" 2>/dev/null || true
  sleep 1
  [ -f "$wpid" ] && kill -9 "$(cat "$wpid")" 2>/dev/null || true
  rm -rf "$wrt" "$wws" "$wpid" "$LOGS/warm.log"
  [ "$ok" = 1 ] || echo "M7_INSTALL: warm-up did not confirm health (assessment still slow?)" >&2
}

seed_state() { # $1 = dev runtime to seed browser profile + auth + settings from (fresh install only)
  local seed="$1"
  [ -d "$seed" ] || fail "seed dir not found: $seed"
  mkdir -p "$STATE"
  cp -R "$seed/browser-profile" "$STATE/" 2>/dev/null || true
  cp -R "$seed/auth-token" "$STATE/" 2>/dev/null || true
  cp -R "$seed/settings.json" "$STATE/" 2>/dev/null || true
  rm -f "$STATE/browser-profile"/Singleton* 2>/dev/null || true   # stale Chromium lock from the source runtime
}

port_free() { ! lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; }

wait_health() { # $1 = max seconds
  local deadline=$(( $(date +%s) + ${1:-90} ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if curl -s -m 2 "$HEALTH_URL" 2>/dev/null | grep -q '"core":"online"'; then
      echo "M7_HEALTH_OK: $(curl -s -m 3 "$HEALTH_URL")"; return 0
    fi
    sleep 1
  done
  echo "M7_HEALTH_FAIL: no healthy core at $HEALTH_URL" >&2
  tail -20 "$LOGS/core.log" 2>/dev/null >&2 || true
  return 1
}

do_stop() { # stop core AND the GUI; assert the port is released (no duplicate core survives)
  stop_core
  pkill -f "$APP_SRC/Contents/MacOS/jarvis-desktop" 2>/dev/null || true
  for _ in $(seq 1 25); do port_free && break; sleep 0.4; done
  if ! port_free; then
    local_pids=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u)
    for p in $local_pids; do kill "$p" 2>/dev/null || true; done
    sleep 2
    pkill -9 -f "$APP_SRC/Contents/MacOS" 2>/dev/null || true
    for _ in $(seq 1 25); do port_free && break; sleep 0.4; done
  fi
  port_free || fail "port $PORT still in use after stop"
  echo "M7_STOP_OK: port $PORT free"
}

stop_core() {
  if [ -f "$PIDFILE" ]; then
    local pid; pid=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 25); do kill -0 "$pid" 2>/dev/null || break; sleep 0.4; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
}

case "$CMD" in
  install) # install [--seed DEV_RUNTIME]
    mkdir -p "$RUN" "$LOGS" "$STATE" "$WORKSPACE"
    copy_app_from_dmg
    if [ "${1:-}" = "--seed" ]; then
      [ -d "$STATE/tasks" ] && echo "M7_INSTALL: existing task history kept (seed skipped)" || seed_state "${2:?--seed needs a runtime dir}"
    fi
    echo "M7_INSTALL_OK: $APP_SRC"
    ;;

  launch) # GUI first launch (FR-2): spawns the packaged sidecar with our env inherited
    [ -d "$APP_SRC" ] || fail "not installed — run install first"
    mkdir -p "$RUN" "$LOGS" "$STATE" "$WORKSPACE"
    open -n --env "JARVIS_PORT=$PORT" --env "JARVIS_RUNTIME_DIR=$STATE" --env "JARVIS_ORPHAN_ROOT=$WORKSPACE" "$APP_SRC" || fail "open failed"
    wait_health "${1:-120}"
    ;;

  launch-core) # direct sidecar launch (task phases — no window); pidfile + log
    [ -d "$APP_SRC" ] || fail "not installed — run install first"
    mkdir -p "$RUN" "$LOGS" "$STATE" "$WORKSPACE"
    stop_core
    # background INSIDE the braces so the subshell exits at once and the sidecar
    # cannot inherit (and hold) the caller's stdout pipe — spawnSync would block on it
    ( cd "$WORKSPACE" && { JARVIS_PORT="$PORT" JARVIS_RUNTIME_DIR="$STATE" JARVIS_ORPHAN_ROOT="$WORKSPACE" \
        nohup "$APP_SRC/Contents/MacOS/jarvis-core" >"$LOGS/core.log" 2>&1 </dev/null & echo $! >"$PIDFILE"; } )
    wait_health "${1:-120}"
    ;;

  health)
    if [ "${1:-}" = "--wait" ]; then wait_health "${2:-90}"; else
      curl -s -m 5 "$HEALTH_URL" || fail "no core at $HEALTH_URL"
      echo
    fi
    ;;

  stop)
    do_stop
    ;;

  reinstall) # FR-16/17: replace the app from the DMG; runtime state (history) untouched
    copy_app_from_dmg
    [ -d "$STATE/tasks" ] && echo "M7_REINSTALL: task history intact ($(ls -1 "$STATE/tasks" | wc -l | tr -d ' ') task dir(s))"
    echo "M7_REINSTALL_OK: $APP_SRC"
    ;;

  uninstall) # FR-18: remove the installed app only — exact-path guard, nothing else
    case "$ROOT" in
      *jarvis-m7*) ;;
      *) fail "refusing to uninstall: M7_ROOT '$ROOT' lacks the jarvis-m7 guard" ;;
    esac
    do_stop
    rm -rf "$ROOT/install"
    [ ! -e "$ROOT/install" ] || fail "install dir still present"
    echo "M7_UNINSTALL_OK: $ROOT/install removed (state/logs kept at $ROOT)"
    ;;

  status)
    echo "root=$ROOT port=$PORT"
    echo "app=$([ -d "$APP_SRC" ] && echo present || echo absent) pid=$([ -f "$PIDFILE" ] && cat "$PIDFILE" || echo -)"
    echo "core=$(curl -s -m 3 "$HEALTH_URL" 2>/dev/null || echo down)"
    ;;

  *) fail "unknown command: $CMD" ;;
esac
