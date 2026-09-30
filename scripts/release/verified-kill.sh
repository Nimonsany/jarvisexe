#!/usr/bin/env bash
# M8 BLOCKER 2 — ownership-verified kills, shared by the lifecycle scripts.
# A pid is signalled ONLY after its live command line proves it belongs to the
# expected install path (exact substring of our unique install). No fuzzy names,
# no bare port kills — an unrelated process must survive any stop/cleanup.
# Unit-tested by tests/m8-ownership.test.ts.

# verified_kill_pid PID IDENTITY [SIGNAL]
#   0 → already gone, or proven ours and signalled
#   1 → identity mismatch: NOT signalled (refusal is reported, never ignored silently)
verified_kill_pid() {
  local pid="$1" ident="$2" sig="${3:-TERM}" args pgid
  [ -n "${pid:-}" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0                 # already gone — nothing to prove
  args=$(ps -ww -p "$pid" -o args= 2>/dev/null) || return 0  # raced away
  case "$args" in
    *"$ident"*) ;;
    *)
      echo "OWNERSHIP_REFUSED: pid $pid args '${args:0:140}' lacks identity '$ident' — not signalled" >&2
      return 1
      ;;
  esac
  # if the pid leads its own process group, sweep the group it owns; otherwise
  # signal exactly this pid (never a group we don't lead)
  pgid=$(ps -p "$pid" -o pgid= 2>/dev/null | tr -d ' ' || true)
  if [ -n "$pgid" ] && [ "$pgid" = "$pid" ]; then
    kill "-$sig" -"$pid" 2>/dev/null || kill "-$sig" "$pid" 2>/dev/null || true
  else
    kill "-$sig" "$pid" 2>/dev/null || true
  fi
  return 0
}
