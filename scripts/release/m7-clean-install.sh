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
# M8 BLOCKER 2: every kill goes through ownership verification (exact install path)
. "$(dirname "$0")/verified-kill.sh"

# Pids whose argv STARTS with this install's gui binary (anchored — wrappers
# that merely mention the path never match).
gui_pids() {
  local p
  for p in $(pgrep -f "$APP_SRC/Contents/MacOS/jarvis-desktop" 2>/dev/null); do
    case "$(ps -ww -p "$p" -o args= 2>/dev/null)" in
      "$APP_SRC/Contents/MacOS/jarvis-desktop"*) echo "$p" ;;
    esac
  done
}
gui_sweep() { # SIG — ownership-verified signal to every gui pid of this install
  local p
  for p in $(gui_pids); do
    verified_kill_pid "$p" "$APP_SRC/Contents/MacOS/jarvis-desktop" "$1" || true
  done
}

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
  if [ -f "$wpid" ]; then
    verified_kill_pid "$(cat "$wpid")" "$APP_SRC" TERM || true
    sleep 1
    verified_kill_pid "$(cat "$wpid")" "$APP_SRC" KILL || true
  fi
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
  local nb n1 n2
  nb=$(gui_pids | grep -c . || true)
  # GUI: pid captured at OUR launch; live argv must still be this install's binary
  if [ -f "$RUN/gui.pid" ]; then
    verified_kill_pid "$(cat "$RUN/gui.pid")" "$APP_SRC/Contents/MacOS/jarvis-desktop" TERM || true
    rm -f "$RUN/gui.pid"
  fi
  # Sweep EVERY gui process of this install (M8 P7): a stale/absent pidfile can
  # leave an old instance alive — port-free only proves the CORE died, never the
  # GUI — and a surviving old GUI steals harness commands from the relaunched one
  # (two in-page drivers polling /cmd: split brain). Anchored argv match so we
  # never signal wrappers (pgrep/grep/open) that merely mention the path.
  gui_sweep TERM
  for _ in $(seq 1 25); do [ -z "$(gui_pids)" ] && break; sleep 0.4; done
  n1=$(gui_pids | grep -c . || true)
  gui_sweep KILL
  sleep 0.5
  n2=$(gui_pids | grep -c . || true)
  [ "${n2:-0}" = "0" ] || fail "stop left ${n2} gui process(es) of this install"
  for _ in $(seq 1 25); do port_free && break; sleep 0.4; done
  if ! port_free; then
    # port fallback: only a holder whose argv proves it is THIS install gets killed
    local p
    for p in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u); do
      verified_kill_pid "$p" "$APP_SRC" TERM || true
    done
    sleep 2
    for p in $(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u); do
      verified_kill_pid "$p" "$APP_SRC" KILL || true
    done
    for _ in $(seq 1 25); do port_free && break; sleep 0.4; done
  fi
  port_free || fail "port $PORT still in use after stop (foreign holder would be refused, never killed)"
  echo "M7_STOP_OK: port $PORT free gui=${nb}->${n1}->${n2}"
}

stop_core() {
  if [ -f "$PIDFILE" ]; then
    local pid; pid=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      # proof first: live argv must contain our exact install path
      verified_kill_pid "$pid" "$APP_SRC" TERM || true
      for _ in $(seq 1 25); do kill -0 "$pid" 2>/dev/null || break; sleep 0.4; done
      verified_kill_pid "$pid" "$APP_SRC" KILL || true
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
    # M8 GUI E2E: pass the harness URL through when set (production never sets it)
    E2E_ARGS=()
    [ -n "${JARVIS_E2E:-}" ] && E2E_ARGS+=(--env "JARVIS_E2E=$JARVIS_E2E")
    open -n --env "JARVIS_PORT=$PORT" --env "JARVIS_RUNTIME_DIR=$STATE" --env "JARVIS_ORPHAN_ROOT=$WORKSPACE" ${E2E_ARGS[@]+"${E2E_ARGS[@]}"} "$APP_SRC" || fail "open failed"
    wait_health "${1:-120}"
    # capture OUR gui pid with an exact-path identity proof (for ownership-verified stop)
    local_gp=$(pgrep -f "$APP_SRC/Contents/MacOS/jarvis-desktop" 2>/dev/null | head -1 || true)
    if [ -n "${local_gp:-}" ]; then
      case "$(ps -ww -p "$local_gp" -o args= 2>/dev/null)" in
        *"$APP_SRC/Contents/MacOS/jarvis-desktop"*) echo "$local_gp" > "$RUN/gui.pid" ;;
        *) echo "M7_LAUNCH: gui pid $local_gp failed identity proof — not recorded" >&2 ;;
      esac
    fi
    # exactly one instance may exist after launch — a leftover from a previous
    # phase would be a second in-page driver (M8 P7 split-brain)
    n=$(gui_pids | grep -c . || true)
    echo "M7_LAUNCH_GPIDS: ${n:-0} pidfile=${local_gp:-none}"
    [ "${n:-0}" = "1" ] || fail "expected exactly 1 gui after launch, found ${n:-0}"
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
      *jarvis-m7*|*jarvis-m8*) ;;
      *) fail "refusing to uninstall: M7_ROOT '$ROOT' lacks the jarvis-m7/m8 guard" ;;
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
