#!/bin/bash
# M8/M9 TCC watcher — clicks macOS TCC *consent* prompts during test runs only.
# Two hosts: SecurityAgent (title match) and UserNotificationCenter (untitled —
# matched by TCC button signature: window has BOTH "Don't Allow" and "OK").
# Clicks ONLY "OK"/"Allow" family — never "Don't Allow", never password fields.
while true; do
  OUT=$(osascript "$(dirname "$0")/tcc-watcher.applescript" 2>&1)
  [ -n "$OUT" ] && echo "$(date +%H:%M:%S) $OUT" >> ${TCC_WATCHER_LOG:-/tmp/jarvis-tcc-watcher.log}
  sleep 5
done
