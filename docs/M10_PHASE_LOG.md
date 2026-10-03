# M10 Phase Log — Cross-Platform Runtime Certification + Signing Gate

Baseline: `docs/M10_BASELINE.md` (frozen at `492b3b3`, rc4 untouched/unpublished).

## Phases 1-2 — Freeze + post-rc4 fix table

Done (see the baseline for the table). 9 commits after rc4, all in the rc5+
lineage. TCC watcher committed as `scripts/tcc-watcher.sh` (native `contains`,
observable stderr via `2>&1`, click logging) + permanently regression-tested
by `tests/tcc-watcher.test.ts` (5 checks incl. osacompile syntax validation).

## Phase 3 — Full pre-rc5 regression at 687de8e

ALL GREEN:
- tsc core + desktop OK; `npm audit --omit=dev` 0 vulns; secret-scan clean
- desktop vitest 13/13
- root unit suite 44/44 (incl. voice REAL transcribe, tcc-watcher, all M1-M8 unit suites)
- m9-updater E2E P0-P6 GREEN (30min: signed A/B update, tamper reject, downgrade/platform guards, rollback)
- m7 E2E 13/13 GREEN (53min)
- m8 E2E 9/9 GREEN (21min)

## Phase 4 — rc5 cut

`v0.1.0-rc5` = `687de8e` (clean tree, fully regression-tested, CI green).
Release run 37037329538: all 5 jobs green, 19 assets, draft (NOT published).
SHA256SUMS 17/17 verified.

## Phases 5-12 — Platform matrix + Windows/Linux real E2E (fix-cycle RCs)

Fix-cycle evidence (every failure root-caused, fixed, re-run):

- **rc5 Windows E2E**: the sidecar is a 344-byte BATCH SCRIPT renamed `.exe` —
  CreateProcess cannot execute it (ERROR_BAD_EXE_FORMAT) → the app never
  spawned the core (`jarvis-core` literal name never exists() on Windows).
  **Fixed (rc6-rc9)**: sidecar = a REAL .exe launcher compiled with csc at
  packaging (`scripts/release/jarvis-core-launcher.cs`) with a Job Object
  (KILL_ON_JOB_CLOSE) for orphan-safe app-quit; lib.rs sidecar lookup finds
  `jarvis-core.exe`.
- **rc5 Linux DEB E2E**: the deb did not declare nodejs → the core could not
  start on a clean machine. **Fixed (rc6)**: `Depends: libwebkit2gtk-4.1-0,
  libgtk-3-0, nodejs`.
- **rc7**: csc source path (forward slashes misparsed) → backslashes (rc8).
- **Linux E2E further findings (rc10-rc13)**:
  - playwright refuses Node < 20 AT IMPORT and its check calls
    `process.exit(1)` — even a lazy import only deferred the whole-core death
    (ubuntu 24.04 = node 18.19.1). **Fixed (rc11+rc13)**: playwright import is
    lazy AND never imported on Node < 20 — the core boots everywhere now and
    ChatGPT planning degrades with an actionable error
    (`ChatGPT automation requires Node.js >= 20; system node is 18.19.1 —
    install a newer Node.js or leave ChatGPT planning unavailable`).
  - opencode discovery: construction-time bin froze the fallback bare name
    forever when opencode was installed after core boot. **Fixed (rc11)**:
    re-discovered at EVERY detect/start call; Windows .exe/.cmd variants probed.
  - the launcher's absolute `/usr/lib` candidates missed the AppImage
    extraction prefix. **Fixed (rc12)**: relative `../lib/` candidates added
    (cover deb + AppImage extraction + FUSE mounts).
- **rc14**: a task that throws immediately after creation got stuck at NEW
  forever (the catch's NEW→FAILED transition was invalid per the matrix).
  **Fixed (rc14)**: `NEW: ['PLANNING','PAUSED','FAILED','CANCELLED']`.

### FINAL platform E2E results (rc14 artifacts, all green)

**Windows (GH-hosted windows-latest clean runner, runs 37095379180 + prior
green runs)**: download installer → NSIS /S per-user install → launch →
**SPAWN: core sidecar spawned by the app** → **CORE_STARTUP: OK (core online,
graceful preflight)** → handshake (core identity, protocol 1, commit) →
**PHASE 19: ChatGPT login required identified** (task waits for a manual
login — correct clean-machine behavior) → **cancel → CANCELLED** (documented
STOP path) → graceful quit → **core sidecar died with graceful quit** (Job
Object) → relaunch → **history: 1 task(s)** → **OWNERSHIP: PASS — unrelated
notepad survived** → uninstall → install dir removed ✓.

**Linux (clean ubuntu:24.04 Docker containers, run17)**: DEB install +
dependency resolution ✓ → core startup + health ✓ → handshake (identity,
commit 48eb446) ✓ → smoke task → **FAILED GRACEFULLY** with the actionable
ChatGPT/node error (Phase 18/19) ✓ → ownership-verified stop ✓ → uninstall ✓;
AppImage: chmod+extract (amd64, sidecar + manifest) ✓ → core startup ✓ →
handshake ✓ → smoke graceful-fail ✓ → stop + cleanup ✓.

**macOS**: m7 13/13 at the rc5-era HEAD (687de8e) + m8 9/9 + suite 44/44;
rc14-era recheck in progress (Phase 13).

## Phases 13-24 — evidence so far

- **Phase 17 artifact scan**: 0 matches for `.env`/browser-profile/cookies/
  auth-token/id_rsa/private keys across the rc14 DMG/exe/AppImage/deb (+
  the CI inspect-artifact step in every release build).
- **Phase 21 TCC watcher regression**: permanent (`tests/tcc-watcher.test.ts`,
  5 checks, osacompile syntax validation, observable stderr, click evidence).
- **Phase 22 silent-failure audit**: scripts/ — all `2>/dev/null`/`|| true`
  occurrences classified as polling/probe/optional-seed/cleanup idioms where
  the FOLLOWING check observes the result; the one dangerous case (the TCC
  watcher discarding AppleScript stderr) was FIXED in M10 (`2>&1` + logging).
  Core src: 15 `.catch(() => {})` — all best-effort event-emit/secondary-
  transition/cleanup patterns with observable follow-ups (task status, files,
  response timeouts); no catch{} swallowing primary-path failures.
- **Phase 23 timeout policy** (taxonomy, not blanket raises):
  - startup: checkOpencode 30s (health probe), wait_health 120s (install launch)
  - progress: runBotTask 420s (bounded extension justified by observed
    progress: bot commands complete, the final turn needs more under load)
  - absolute: task terminal 1800s, T6 review wait 480s, ask() 900s×2
    (the ChatGPT login wait — Phase 19 design)
  - no progress → fail WITH evidence (the fail-fast review_skipped reason,
    the actionable node<20 error, the "did not start within 20s" orphan-cancel)
  - KNOWN ISSUE (documented): createTask's 20s poll vs opencode's first-boot
    initialization (30-60s in a fresh env) — the POST returns "did not start"
    while the task continues in the background; a warmed second attempt works.
- **Phase 24 voice dimensions**: VOICE_CORRECTNESS: PASS (REAL transcribe
  test green whenever the audio stack works — 39/39 + 44/44 suites);
  VOICE_PERFORMANCE: SLOW (whisper.cpp transcribe on CPU, Intel MBP);
  VOICE_ACCELERATION: CPU (Metal not required, not implemented). KNOWN ISSUE:
  the system `coreaudiod` daemon wedges periodically (`say`/`afplay` hang in
  HAL init) — system-level, root recovery only; recovered once (~7h), wedged
  again — env, not product.
