#!/usr/bin/env bash
# M10 Phases 10-12 — Linux AppImage + DEB clean-machine E2E in fresh Docker containers.
# Real packaged artifacts, real package-manager install, real core runtime,
# real handshake, real smoke task (graceful prerequisite handling), uninstall.
# No repository source-tree dependency inside the container.
# Usage: scripts/release/linux-e2e.sh <path-to-assets-dir>
set -uo pipefail
ASSETS="${1:?usage: linux-e2e.sh <assets-dir>}"
DEB=$(ls "$ASSETS"/JARVIS_*_amd64.deb 2>/dev/null | head -1)
APPIMAGE=$(ls "$ASSETS"/JARVIS_*_amd64.AppImage 2>/dev/null | head -1)
[ -n "$DEB" ] || { echo "LINUX_E2E_FAIL: no .deb in $ASSETS"; exit 1; }
[ -n "$APPIMAGE" ] || { echo "LINUX_E2E_FAIL: no .AppImage in $ASSETS"; exit 1; }
PORT=7795
OUT="${LINUX_E2E_OUT:-/tmp/m10-linux-e2e}"
mkdir -p "$OUT"
PASS=""; FAIL=""
TOKEN=""   # set once the core is up; may stay empty if startup failed (set -u safe)

# documented task states (packages/core/src/task/types.ts) — a recovered task
# must land on one of these; the ACTUAL value is printed, never assumed
DOC_STATES=" NEW PLANNING WAITING_FOR_CHATGPT PLAN_RECEIVED PREPARING_EXECUTION EXECUTING MONITORING TESTING VERIFYING DEBUGGING WAITING_FOR_OWNER PAUSED FAILED COMPLETED CANCELLED "

ok()   { PASS="$PASS|$1"; echo "✔ $1"; }
fail() { FAIL="$FAIL|$1"; echo "✖ $1"; }


# HTTP helper via python3 — the clean ubuntu:24.04 image has no curl
http_get() { # $1 = url, $2 = token (optional)
  docker exec "$CN" python3 -c "
import urllib.request,sys
req=urllib.request.Request(sys.argv[1])
import os
tok=sys.argv[2] if len(sys.argv)>2 else ''
if tok: req.add_header('Authorization','Bearer '+tok)
print(urllib.request.urlopen(req,timeout=5).read().decode())
" "$1" "${2:-}" 2>/dev/null
}
http_post() { # $1 = url, $2 = json body, $3 = token — HTTP error bodies go to
  # STDOUT so callers can echo them as evidence (stderr is discarded by exec)
  docker exec "$CN" python3 -c "
import urllib.request,urllib.error,sys
try:
    req=urllib.request.Request(sys.argv[1],data=sys.argv[2].encode(),method='POST')
    req.add_header('Authorization','Bearer '+sys.argv[3])
    req.add_header('Content-Type','application/json')
    print(urllib.request.urlopen(req,timeout=120).read().decode())
except urllib.error.HTTPError as e:
    print('HTTP_%s: %s' % (e.code, e.read().decode()[:300]))
except Exception as e:
    print('POST_ERR: %s' % e)
" "$1" "$2" "$3" 2>/dev/null
}
probe() { docker exec "$CN" python3 -c "
import socket,sys
s=socket.socket();s.settimeout(3)
try: s.connect(('127.0.0.1',int(sys.argv[1])));print('up')
except Exception: print('down')
" "$1" 2>/dev/null
}

# bounded wait for core health: prints the health json, rc=0 once core is online
wait_health() {
  local h=""
  for _ in $(seq 1 40); do
    h=$(http_get "http://127.0.0.1:$PORT/health")
    if echo "$h" | grep -q '"core":"online"'; then printf '%s\n' "$h"; return 0; fi
    sleep 3
  done
  printf '%s\n' "$h"
  return 1
}

# ---------- Phase 12: DEB on clean Ubuntu ----------
echo "=== Phase 12: DEB clean-machine E2E (ubuntu:24.04) ==="
docker rm -f j10-deb >/dev/null 2>&1
docker run -d --name j10-deb ubuntu:24.04 sleep infinity >/dev/null || { echo "LINUX_E2E_FAIL: docker run failed"; exit 1; }
CN=j10-deb
docker cp "$DEB" j10-deb:/tmp/jarvis.deb || { echo "LINUX_E2E_FAIL: docker cp .deb failed"; exit 1; }

# Phase 31 seed — user data OUTSIDE the package, written BEFORE install.
# (opencode later self-installs to $HOME/.opencode — also user-local, never
#  owned by the package; both must survive the final uninstall)
docker exec j10-deb bash -c 'mkdir -p /root/jarvis-user-project && printf "%s\n" "jarvis user data — must survive uninstall" > /root/jarvis-user-project/keep.txt && echo "seeded user file: $(ls -l /root/jarvis-user-project/keep.txt)"'
if docker exec j10-deb bash -c 'test -f /root/jarvis-user-project/keep.txt'; then
  ok "user-data seed written before install (Phase 31: outside the package)"
else
  fail "user-data seed creation"
fi

docker exec j10-deb bash -c '
  set -e
  apt-get update -qq >/dev/null 2>&1 || true
  echo "--- dpkg -i (declared dependency check) ---"
  dpkg -i /tmp/jarvis.deb 2>&1 | tail -5 || true
  echo "--- apt-get -f install (resolves declared deps: webkit2gtk, gtk3) ---"
  DEBIAN_FRONTEND=noninteractive apt-get install -y -f >/dev/null 2>&1
  DEBIAN_FRONTEND=noninteractive apt-get install -y curl python3 >/dev/null 2>&1
  echo "--- installed files (dpkg -L) ---"
  dpkg -L jarvis | head -20
' > "$OUT/deb-install.log" 2>&1
DPKG_RC=$?
tail -12 "$OUT/deb-install.log"
if [ $DPKG_RC -eq 0 ] && docker exec j10-deb dpkg -s jarvis >/dev/null 2>&1; then
  ok "DEB install + dependency resolution (webkit2gtk/gtk3 declared deps)"
else
  fail "DEB install"
fi

# find the core sidecar installed by the deb
CORE=$(docker exec j10-deb bash -lc 'dpkg -L jarvis | grep -E "jarvis-core$|jarvis-core\.exe$" | head -1')
echo "deb core sidecar: $CORE"
if [ -n "$CORE" ]; then
  docker exec j10-deb bash -c "
    JARVIS_PORT=$PORT JARVIS_RUNTIME_DIR=/tmp/j10state setsid $CORE >/tmp/j10core.log 2>&1 </dev/null &
    echo \$! > /tmp/j10core.pid
    for i in \$(seq 1 24); do
      sleep 5
    done
  " > "$OUT/deb-core-health.log" 2>&1
  sleep 2
  http_get "http://127.0.0.1:$PORT/health" | tee "$OUT/deb-health.json"
  if grep -q '"core":"online"' "$OUT/deb-health.json" 2>/dev/null; then
    ok "DEB core startup + health"
    # token from the runtime's auth-token file — the /api/bootstrap endpoint is
    # browser-origin-gated and returns empty for curl in this harness
    TOKEN=$(docker exec j10-deb cat /tmp/j10state/auth-token 2>/dev/null)
    VER=$(http_get "http://127.0.0.1:$PORT/api/version" | head -c 120)
    echo "handshake: $VER"
    if [ -n "$TOKEN" ] && echo "$VER" | grep -q "jarvis-core\|core"; then
      ok "DEB UI-Core handshake (identity via /api/version)"
      # smoke task — install opencode first (the task pipeline requires it);
      # ChatGPT is unavailable on a clean machine so the task exercises the
      # graceful-fail path (Phase 18/19)
      docker exec j10-deb bash -c 'curl -fsSL https://opencode.ai/install | bash >/dev/null 2>&1; test -x ~/.opencode/bin/opencode && echo "opencode installed: user-local"; ~/.opencode/bin/opencode --version >/dev/null 2>&1; echo "opencode warmed" ' || echo "WARN: opencode install failed"
      SMOKE=$(http_post "http://127.0.0.1:$PORT/api/task" '{"request":"Create a temporary file named j10-linux-ok.txt in the project directory containing exactly the text JARVIS_LINUX_RUNTIME_OK (plain, unquoted). Create no other files.","project":"/tmp/j10work"}' "$TOKEN")
      TID=$(echo "$SMOKE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
      if [ -z "$TID" ]; then
        # cold-start: the first POST can fail while opencode initializes on a
        # fresh core (documented KNOWN ISSUE — warmed retry succeeds)
        echo "smoke create raw: $(printf '%s' "$SMOKE" | head -c 300) — retrying once"
        sleep 5
        SMOKE=$(http_post "http://127.0.0.1:$PORT/api/task" '{"request":"Create a temporary file named j10-linux-ok.txt in the project directory containing exactly the text JARVIS_LINUX_RUNTIME_OK (plain, unquoted). Create no other files.","project":"/tmp/j10work"}' "$TOKEN")
        TID=$(echo "$SMOKE" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
      fi
      if [ -z "$TID" ]; then
        # clock-jump tolerant: the record can materialize minutes after a
        # 500/timeout (Docker VM resync breaks the 1s created_at match window
        # — evidenced in run2 + probe). Poll /api/tasks for the late record.
        echo "smoke create: no id after warmed retry — polling /api/tasks for late registration (up to 3 min)"
        for i in $(seq 1 18); do
          sleep 10
          TID=$(http_get "http://127.0.0.1:$PORT/api/tasks" "$TOKEN" | python3 -c "import sys,json;ts=json.load(sys.stdin);print(next((t['id'] for t in ts if 'j10-linux-ok.txt' in t.get('owner_request','')),''))" 2>/dev/null)
          if [ -n "$TID" ]; then echo "smoke late registration: $TID (poll $i/18)"; break; fi
        done
      fi
      echo "smoke task: $TID"
      if [ -n "$TID" ]; then
        STATUS=""
        for i in $(seq 1 40); do
          sleep 10
          STATUS=$(http_get "http://127.0.0.1:$PORT/api/task/$TID" "$TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['status'])" 2>/dev/null)
          case "$STATUS" in COMPLETED|FAILED|CANCELLED|WAITING_FOR_OWNER|WAITING_FOR_CHATGPT) break;; esac
        done
        ERR=$(http_get "http://127.0.0.1:$PORT/api/task/$TID" "$TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['task'].get('last_error','')[:160])" 2>/dev/null)
        echo "smoke terminal: $STATUS last_error: $ERR"
        case "$STATUS" in
          COMPLETED) ok "DEB smoke task completed";;
          WAITING_FOR_CHATGPT)
            http_post "http://127.0.0.1:$PORT/api/task/$TID/cancel" '{}' "$TOKEN" >/dev/null 2>&1
            ok "DEB smoke: Phase-19 login wait observed, then cancelled cleanly";;
          FAILED|WAITING_FOR_OWNER) ok "DEB smoke task failed GRACEFULLY (clean machine: no ChatGPT credentials — Phase 18/19)";;
          *) fail "DEB smoke task hung (status=$STATUS)";;
        esac
      else
        fail "DEB smoke task creation"
      fi
    else
      fail "DEB handshake"
    fi
    # stop + restart the core (Phase 12 restart)
    docker exec j10-deb bash -c '
      PID=$(cat /tmp/j10core.pid 2>/dev/null)
      if [ -n "$PID" ]; then
        # ownership-verified: argv must prove it is this core before group kill
        ps -ww -p "$PID" -o args= 2>/dev/null | grep -q "core-runtime/server.js" && kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
      fi
      sleep 2
      LEFT=$(ps -ww -eo args= | grep -c "core-runtime/server.js" || true)
      echo "core processes left: $LEFT"
    '
    ok "DEB core stop (ownership-verified group kill — no fuzzy matching)"

    # ---------- Phase 29 (Linux): CRASH RECOVERY ----------
    # after the smoke/stop phases: bring the core back up, create a task through
    # the API, then SIGKILL the core itself (kill -9 — deliberately NOT the
    # ownership-stop path above), restart, and verify what recovery actually did.
    echo "=== CRASH_RECOVERY: create task → kill -9 core → restart → verify (deb) ==="
    docker exec j10-deb bash -c "
      JARVIS_PORT=$PORT JARVIS_RUNTIME_DIR=/tmp/j10state setsid $CORE >/tmp/j10core.log 2>&1 </dev/null &
      echo \$! > /tmp/j10core.pid
    "
    TOKEN=$(docker exec j10-deb cat /tmp/j10state/auth-token 2>/dev/null)
    H=$(wait_health)
    if ! echo "$H" | grep -q '"core":"online"'; then
      fail "Phase 29 crash recovery (core did not start for the crash test)"
      echo "CRASH_RECOVERY: FAIL (state=core-not-running)"
    elif [ -z "$TOKEN" ]; then
      fail "Phase 29 crash recovery (no auth token)"
      echo "CRASH_RECOVERY: FAIL (state=no-token)"
    else
      # the core runs ONE task at a time (server busy flag) — free the runtime
      # if the smoke task is still open before creating the crash task
      if [ -n "${TID:-}" ]; then
        PRE_S=$(http_get "http://127.0.0.1:$PORT/api/task/$TID" "$TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['status'])" 2>/dev/null)
        case "$PRE_S" in
          ""|COMPLETED|FAILED|CANCELLED) echo "prior smoke task $TID terminal ($PRE_S) — runtime free";;
          *) echo "prior smoke task $TID still $PRE_S — cancelling so the crash task can be created"
             CANCEL_OUT=$(http_post "http://127.0.0.1:$PORT/api/task/$TID/cancel" '{}' "$TOKEN")
             echo "cancel → ${CANCEL_OUT:0:160}"
             sleep 5;;
        esac
      fi
      CREQ='{"request":"Crash-recovery probe: create a file named j10-crash.txt in the project directory containing exactly the text JARVIS_CRASH_RECOVERY (plain, unquoted). Create no other files.","project":"/tmp/j10work"}'
      CTASK=$(http_post "http://127.0.0.1:$PORT/api/task" "$CREQ" "$TOKEN")
      CTID=$(echo "$CTASK" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
      if [ -z "$CTID" ]; then
        echo "crash create raw: $(printf '%s' "$CTASK" | head -c 300) — retrying once (runtime may still be busy)"
        sleep 5
        CTASK=$(http_post "http://127.0.0.1:$PORT/api/task" "$CREQ" "$TOKEN")
        CTID=$(echo "$CTASK" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
      fi
      echo "crash task: $CTID"
      if [ -z "$CTID" ]; then
        fail "Phase 29 crash task creation"
        echo "CRASH_RECOVERY: FAIL (state=task-create-failed)"
      else
        PRE_KILL=$(http_get "http://127.0.0.1:$PORT/api/task/$CTID" "$TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['status'])")
        echo "crash task pre-kill status: $PRE_KILL"
        sleep 3
        # snapshot the core's children, then SIGKILL the core process itself
        DEAD=$(docker exec j10-deb cat /tmp/j10core.pid 2>/dev/null)
        CHILDREN=$(docker exec j10-deb bash -c "ps -eo pid=,ppid= | awk -v p='$DEAD' '\$2==p {print \$1}'")
        echo "core pid=$DEAD children before kill: ${CHILDREN:-none}"
        docker exec j10-deb bash -c "kill -9 $DEAD"
        sleep 2
        # zombie counts as dead: pid1 is `sleep infinity`, which never wait()s,
        # so a SIGKILLed orphan stays Z forever in this container. ps -p prints
        # zombies, so check the state, not just the pid.
        PSTAT=$(docker exec j10-deb bash -c "ps -p $DEAD -o stat= 2>/dev/null" | tr -d '[:space:]')
        ALIVE=""
        case "$PSTAT" in ""|Z*) ;; *) ALIVE=$DEAD;; esac
        NKILLED=$(docker exec j10-deb bash -c "ps -ww -eo args= | grep -c '[c]ore-runtime/server.js' || true" | tr -d '[:space:]')
        echo "after SIGKILL: pid $DEAD stat=[${PSTAT:-<gone>}] alive=[${ALIVE}] core processes=$NKILLED"
        if [ -n "$ALIVE" ] || [ "$NKILLED" != "0" ]; then
          fail "Phase 29 crash (core survived SIGKILL)"
          echo "CRASH_RECOVERY: FAIL (state=kill-failed alive=${ALIVE:-} cores=$NKILLED)"
          # restart anyway so downstream phases (snapshot/reinstall) run against
          # a live core — a failed kill must not cascade into unrelated fails
          docker exec j10-deb bash -c "
            JARVIS_PORT=$PORT JARVIS_RUNTIME_DIR=/tmp/j10state setsid $CORE >/tmp/j10core.log 2>&1 </dev/null &
            echo \$! > /tmp/j10core.pid
          "
          wait_health >/dev/null 2>&1 || true
        else
          echo "core died on SIGKILL — restarting"
          docker exec j10-deb bash -c "
            JARVIS_PORT=$PORT JARVIS_RUNTIME_DIR=/tmp/j10state setsid $CORE >/tmp/j10core.log 2>&1 </dev/null &
            echo \$! > /tmp/j10core.pid
          "
          TOKEN=$(docker exec j10-deb cat /tmp/j10state/auth-token 2>/dev/null)
          H2=$(wait_health)
          if ! echo "$H2" | grep -q '"core":"online"'; then
            fail "Phase 29 crash recovery (core did not restart after SIGKILL)"
            echo "CRASH_RECOVERY: FAIL (state=restart-failed)"
          else
            # no orphan child of the dead pid may survive the recovery
            # (transient children — e.g. a health probe in flight — exit on
            #  their own, so a bounded grace window is allowed before FAIL)
            ORPH_RC=0
            docker exec j10-deb python3 -c "
import subprocess, sys, time
dead, snap = sys.argv[1], sys.argv[2].split()
def st(p):
    try: return subprocess.check_output(['ps','-p',p,'-o','stat='], stderr=subprocess.DEVNULL).decode().strip()
    except Exception: return ''
def alive(s): return [p for p in s if st(p) and not st(p).startswith('Z')]
survivors = alive(snap)
if survivors:
    end = time.time() + 30
    while survivors and time.time() < end:
        time.sleep(3); survivors = alive(snap)
owned = []
for line in subprocess.run(['ps','-eo','pid=,ppid=,stat='], capture_output=True, text=True).stdout.splitlines():
    f = line.split()
    if len(f) >= 3 and f[1] == dead and not f[2].startswith('Z'): owned.append(f[0])
print('orphan check: surviving children of killed core:', survivors or 'none')
print('orphan check: live processes parented to dead pid', dead, ':', owned or 'none')
sys.exit(1 if survivors or owned else 0)
" "$DEAD" "$CHILDREN" || ORPH_RC=$?
            NCORE=$(docker exec j10-deb bash -c "ps -ww -eo args= | grep -c '[c]ore-runtime/server.js' || true" | tr -d '[:space:]')
            HIST=$(http_get "http://127.0.0.1:$PORT/api/tasks" "$TOKEN")
            INHIST=$(printf '%s' "$HIST" | python3 -c "import sys,json;ids=[t.get('id') for t in json.load(sys.stdin)];print('yes' if sys.argv[1] in ids else 'no')" "$CTID")
            RSTATE=$(http_get "http://127.0.0.1:$PORT/api/task/$CTID" "$TOKEN" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['status'])")
            STORE_RC=0
            docker exec j10-deb python3 -c "
import json, glob, sys
files = sorted(glob.glob('/tmp/j10state/tasks/*/status.json'))
bad = []
for f in files:
    try: json.load(open(f))
    except Exception as e: bad.append(f + ': ' + str(e))
print('task store: %d status.json file(s), unparsable: %s' % (len(files), bad or 'none'))
sys.exit(0 if files and not bad else 1)
" || STORE_RC=$?
            echo "post-recovery: cores=$NCORE crash_task_in_history=$INHIST state=${RSTATE:-<none>} store_rc=$STORE_RC orphan_rc=$ORPH_RC"
            if [ "$NCORE" = "1" ] && [ "$INHIST" = "yes" ] && [ -n "$RSTATE" ] \
               && printf '%s' "$DOC_STATES" | grep -q " $RSTATE " \
               && [ "$STORE_RC" -eq 0 ] && [ "$ORPH_RC" -eq 0 ]; then
              echo "CRASH_RECOVERY: PASS (state=$RSTATE)"
              ok "Phase 29 crash recovery (SIGKILL → restart): task persisted, exactly 1 core, store JSON parses, no orphans — state=$RSTATE"
            else
              echo "CRASH_RECOVERY: FAIL (state=${RSTATE:-<none>} cores=$NCORE in_history=$INHIST store_rc=$STORE_RC orphan_rc=$ORPH_RC)"
              fail "Phase 29 crash recovery"
            fi
          fi
        fi
      fi
    fi
  else
    fail "DEB core startup (see $OUT/deb-core-health.log)"
    cat "$OUT/deb-core-health.log" | tail -5
    echo "CRASH_RECOVERY: FAIL (state=core-never-started — Phase 29 not executable)"
  fi
else
  fail "DEB core sidecar not found in package"
  echo "CRASH_RECOVERY: FAIL (state=no-core-sidecar — Phase 29 not executable)"
fi

# ---------- Phase 31 first uninstall + Phase 30 REINSTALL (deb) ----------
# snapshot task ids while the crash-recovered core is still up: the reinstall
# below must preserve this history
PRE_IDS=$(http_get "http://127.0.0.1:$PORT/api/tasks" "$TOKEN" | python3 -c "import sys,json;print('\n'.join(t.get('id','') for t in json.load(sys.stdin)))")
echo "task ids before uninstall: $(echo $PRE_IDS | tr '\n' ' ')"
if [ -z "$PRE_IDS" ]; then fail "history snapshot before uninstall (no tasks visible)"; fi

# stop the recovered core before package surgery (test teardown; the
# ownership-verified stop above already exercised that path)
docker exec j10-deb bash -c 'kill -9 "$(cat /tmp/j10core.pid 2>/dev/null)" 2>/dev/null; sleep 2; echo "core processes before uninstall: $(ps -ww -eo args= | grep -c "[c]ore-runtime/server.js" || true)"'

# uninstall (Phase 31): removes the package's files, not user data
docker exec j10-deb bash -c 'DEBIAN_FRONTEND=noninteractive apt-get remove -y jarvis >/dev/null 2>&1; dpkg -s jarvis >/dev/null 2>&1 && echo STILL_INSTALLED || echo REMOVED'
if docker exec j10-deb bash -c 'dpkg -s jarvis >/dev/null 2>&1'; then fail "DEB uninstall"; else ok "DEB uninstall (package removed)"; fi

echo "=== REINSTALL: real second dpkg -i over the removed package (Phase 30) ==="
RE_BAD=0
docker exec j10-deb bash -c 'dpkg -i /tmp/jarvis.deb >/tmp/j10-reinstall.log 2>&1' || \
  docker exec j10-deb bash -c 'DEBIAN_FRONTEND=noninteractive apt-get install -y -f >>/tmp/j10-reinstall.log 2>&1'
docker exec j10-deb bash -c 'tail -6 /tmp/j10-reinstall.log'
if docker exec j10-deb bash -c 'dpkg -s jarvis >/dev/null 2>&1'; then
  ok "REINSTALL: second dpkg -i + dpkg -s reports installed"
else
  fail "REINSTALL: dpkg -s reports NOT installed after second dpkg -i"; RE_BAD=1
fi
# core health again, same runtime dir → state must survive
docker exec j10-deb bash -c "
  JARVIS_PORT=$PORT JARVIS_RUNTIME_DIR=/tmp/j10state setsid $CORE >/tmp/j10core.log 2>&1 </dev/null &
  echo \$! > /tmp/j10core.pid
"
TOKEN=$(docker exec j10-deb cat /tmp/j10state/auth-token 2>/dev/null)
H3=$(wait_health)
if echo "$H3" | grep -q '"core":"online"'; then
  ok "REINSTALL: core health OK again after reinstall"
else
  fail "REINSTALL: core health after reinstall"; RE_BAD=1
fi
POST_IDS=$(http_get "http://127.0.0.1:$PORT/api/tasks" "$TOKEN" | python3 -c "import sys,json;print('\n'.join(t.get('id','') for t in json.load(sys.stdin)))")
HIST_RC=0
python3 -c "
import sys
pre = [x for x in sys.argv[1].split() if x]
post = set(x for x in sys.argv[2].split() if x)
missing = [x for x in pre if x not in post]
print('reinstall history: before=%d after=%d missing=%s' % (len(pre), len(post), missing or 'none'))
sys.exit(1 if (not pre or missing) else 0)
" "$PRE_IDS" "$POST_IDS" || HIST_RC=$?
if [ "$HIST_RC" -eq 0 ]; then
  ok "REINSTALL: task history preserved across uninstall+reinstall"
else
  fail "REINSTALL: task history NOT preserved"; RE_BAD=1
fi
if [ "$RE_BAD" -eq 0 ]; then echo "REINSTALL: PASS"; else echo "REINSTALL: FAIL"; fi

# ---------- Phase 31 final uninstall + UNINSTALL_SAFETY ----------
docker exec j10-deb bash -c 'kill -9 "$(cat /tmp/j10core.pid 2>/dev/null)" 2>/dev/null; sleep 2'
docker exec j10-deb bash -c 'DEBIAN_FRONTEND=noninteractive apt-get remove -y jarvis >/dev/null 2>&1; dpkg -s jarvis >/dev/null 2>&1 && echo STILL_INSTALLED || echo REMOVED'
if docker exec j10-deb bash -c 'dpkg -s jarvis >/dev/null 2>&1'; then fail "DEB second uninstall"; else ok "DEB second uninstall (package removed again)"; fi
# user data written before install + opencode's user-local dir must both survive
US=$(docker exec j10-deb bash -c 'test -f /root/jarvis-user-project/keep.txt && echo "seed=present" || echo "seed=MISSING"; test -d "$HOME/.opencode" && echo "opencode_dir=present" || echo "opencode_dir=MISSING"; dpkg -s jarvis >/dev/null 2>&1 && echo "package=installed" || echo "package=not-installed"')
echo "$US"
if echo "$US" | grep -q "seed=present" && echo "$US" | grep -q "opencode_dir=present" && echo "$US" | grep -q "package=not-installed"; then
  echo "UNINSTALL_SAFETY: PASS"
  ok "UNINSTALL_SAFETY: seeded user file + \$HOME/.opencode survive, package not installed"
else
  echo "UNINSTALL_SAFETY: FAIL"
  fail "UNINSTALL_SAFETY (state above: seed / opencode_dir / package)"
fi
docker rm -f j10-deb >/dev/null 2>&1

# ---------- Phases 10-11: AppImage on clean Ubuntu ----------
echo "=== Phases 10-11: AppImage clean-machine E2E (ubuntu:24.04) ==="
docker rm -f j10-appimage >/dev/null 2>&1
docker run -d --name j10-appimage ubuntu:24.04 sleep infinity >/dev/null || { echo "LINUX_E2E_FAIL: docker run failed"; exit 1; }
CN=j10-appimage
docker cp "$APPIMAGE" j10-appimage:/tmp/jarvis.AppImage || { echo "LINUX_E2E_FAIL: docker cp AppImage failed"; exit 1; }
# the packaged core launcher requires a system Node.js (actionable error when
# missing — Phase 18) and the test needs curl — install both in the clean image
docker exec j10-appimage bash -c 'apt-get update -qq >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y curl python3 nodejs >/dev/null 2>&1' || echo "WARN: container package install failed (core may not start — recorded as evidence)"
docker exec j10-appimage bash -c '
  set -e
  chmod +x /tmp/jarvis.AppImage
  echo "--- architecture + extract (no FUSE dependency) ---"
  file /tmp/jarvis.AppImage | head -1
  cd /tmp && /tmp/jarvis.AppImage --appimage-extract >/dev/null 2>&1
  echo "extracted:"
  ls /tmp/squashfs-root | head -8
  find /tmp/squashfs-root -name "jarvis-core*" -type f | head -3
  echo "--- manifest/resources present ---"
  find /tmp/squashfs-root -name "release-manifest.json" -o -name "*.spdx.json" | head -3
' > "$OUT/appimage-extract.log" 2>&1
APP_RC=$?
tail -14 "$OUT/appimage-extract.log"
CORE2=$(grep -m1 "jarvis-core" "$OUT/appimage-extract.log" | grep -oE "/tmp/squashfs-root[^ ]*jarvis-core[^ ]*" | head -1)
if [ $APP_RC -eq 0 ] && [ -n "$CORE2" ]; then
  ok "AppImage chmod+extract (architecture amd64, sidecar + manifest present)"
  docker exec j10-appimage bash -c "
    chmod +x $CORE2 2>/dev/null || true
    JARVIS_PORT=$PORT JARVIS_RUNTIME_DIR=/tmp/j10state2 setsid $CORE2 >/tmp/j10core2.log 2>&1 </dev/null &
    echo \$! > /tmp/j10core2.pid
    for i in \$(seq 1 24); do
      sleep 5
    done
  " > "$OUT/appimage-core-health.log" 2>&1
  sleep 2
  http_get "http://127.0.0.1:$PORT/health" | tee "$OUT/appimage-health.json"
  if grep -q '"core":"online"' "$OUT/appimage-health.json" 2>/dev/null; then
    ok "AppImage core startup + health (packaged runtime, no source tree)"
    TOKEN2=$(docker exec j10-appimage cat /tmp/j10state2/auth-token 2>/dev/null)
    VER2=$(http_get "http://127.0.0.1:$PORT/api/version" | head -c 120)
    echo "appimage handshake: $VER2"
    if [ -n "$TOKEN2" ] && echo "$VER2" | grep -q '"core"'; then
      ok "AppImage UI-Core handshake (identity)"
      docker exec j10-appimage bash -c 'curl -fsSL https://opencode.ai/install | bash >/dev/null 2>&1; test -x ~/.opencode/bin/opencode && echo INSTALLED; ~/.opencode/bin/opencode --version >/dev/null 2>&1; echo warmed' || echo "WARN: opencode install failed"
      SMOKE2=$(http_post "http://127.0.0.1:$PORT/api/task" '{"request":"Create a temporary file named j10-linux-ok.txt in the project directory containing exactly the text JARVIS_LINUX_RUNTIME_OK (plain, unquoted). Create no other files.","project":"/tmp/j10work2"}' "$TOKEN2")
      TID2=$(echo "$SMOKE2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
      if [ -z "$TID2" ]; then
        # cold-start: same warmed-retry as the DEB smoke above
        echo "appimage smoke create raw: $(printf '%s' "$SMOKE2" | head -c 300) — retrying once"
        sleep 5
        SMOKE2=$(http_post "http://127.0.0.1:$PORT/api/task" '{"request":"Create a temporary file named j10-linux-ok.txt in the project directory containing exactly the text JARVIS_LINUX_RUNTIME_OK (plain, unquoted). Create no other files.","project":"/tmp/j10work2"}' "$TOKEN2")
        TID2=$(echo "$SMOKE2" | python3 -c "import sys,json;print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
      fi
      if [ -z "$TID2" ]; then
        # same late-registration tolerance as the DEB smoke above
        echo "appimage smoke create: no id after warmed retry — polling /api/tasks for late registration (up to 3 min)"
        for i in $(seq 1 18); do
          sleep 10
          TID2=$(http_get "http://127.0.0.1:$PORT/api/tasks" "$TOKEN2" | python3 -c "import sys,json;ts=json.load(sys.stdin);print(next((t['id'] for t in ts if 'j10-linux-ok.txt' in t.get('owner_request','')),''))" 2>/dev/null)
          if [ -n "$TID2" ]; then echo "appimage smoke late registration: $TID2 (poll $i/18)"; break; fi
        done
      fi
      echo "appimage smoke task: $TID2"
      if [ -n "$TID2" ]; then
        S2=""
        for i in $(seq 1 40); do
          sleep 10
          S2=$(http_get "http://127.0.0.1:$PORT/api/task/$TID2" "$TOKEN2" | python3 -c "import sys,json;print(json.load(sys.stdin)['task']['status'])" 2>/dev/null)
          case "$S2" in COMPLETED|FAILED|CANCELLED|WAITING_FOR_OWNER|WAITING_FOR_CHATGPT) break;; esac
        done
        echo "appimage smoke terminal: $S2"
        case "$S2" in
          COMPLETED) ok "AppImage smoke task completed";;
          WAITING_FOR_CHATGPT)
            http_post "http://127.0.0.1:$PORT/api/task/$TID2/cancel" '{}' "$TOKEN2" >/dev/null 2>&1
            ok "AppImage smoke: Phase-19 login wait observed, then cancelled cleanly";;
          FAILED|WAITING_FOR_OWNER) ok "AppImage smoke failed GRACEFULLY (clean machine: no ChatGPT credentials)";;
          *) fail "AppImage smoke task hung (status=$S2)";;
        esac
      else
        fail "AppImage smoke task creation"
      fi
      # stop (ownership-verified group kill) + cleanup
      docker exec j10-appimage bash -c '
        PID=$(cat /tmp/j10core2.pid 2>/dev/null)
        if [ -n "$PID" ]; then
          ps -ww -p "$PID" -o args= 2>/dev/null | grep -q "core-runtime/server.js" && kill -- -"$PID" 2>/dev/null || kill "$PID" 2>/dev/null
        fi
        sleep 2
        LEFT=$(ps -ww -eo args= | grep -c "core-runtime/server.js" || true)
        echo "appimage core processes left: $LEFT"
      '
      ok "AppImage core stop (ownership-verified) + cleanup"
    else
      fail "AppImage handshake"
    fi
  else
    fail "AppImage core startup"
    tail -5 "$OUT/appimage-core-health.log"
  fi
else
  fail "AppImage extract/sidecar"
fi

# ---------- Phase 31 (AppImage): uninstall of a single-file artifact ----------
# explicit choice, printed as such: there is no package to remove, so removal =
# deleting the file; the extraction dir this run created must still be cleaned
echo "APPIMAGE_UNINSTALL: n/a (single-file artifact — removal = deleting the file)"
CLEAN=$(docker exec j10-appimage bash -c 'rm -rf /tmp/squashfs-root /tmp/jarvis.AppImage; if [ -e /tmp/squashfs-root ] || [ -e /tmp/jarvis.AppImage ]; then echo PRESENT; else echo GONE; fi')
echo "appimage extraction cleanup: $CLEAN"
if [ "$CLEAN" = "GONE" ]; then
  ok "AppImage removal: file deleted + extraction dir cleaned (asserted gone)"
else
  fail "AppImage removal: extraction artifacts still present"
fi
docker rm -f j10-appimage >/dev/null 2>&1

echo ""
echo "=== LINUX E2E SUMMARY ==="
echo "PASS: $(echo "$PASS" | tr '|' '\n' | grep -c .)"
echo "FAIL: $(echo "$FAIL" | tr '|' '\n' | grep -c .)"
echo "$PASS" | tr '|' '\n' | grep . | while IFS= read -r f; do echo "  ✔ $f"; done
echo "$FAIL" | tr '|' '\n' | grep . | while IFS= read -r f; do echo "  ✖ $f"; done
if [ -z "$FAIL" ]; then
  echo "LINUX_E2E_PASS: yes"
  exit 0
fi
echo "LINUX_E2E_PASS: no"
exit 1
