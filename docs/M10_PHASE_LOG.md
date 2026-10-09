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

## Phases 13-16 — macOS m7 rerun + signing gate

- **Phase 13 (m7)**: 13/13 GREEN at `e2d1a73` (36min incl. DMG rebuild),
  `READY_FOR_V0.1.0_RC: YES` — log `/tmp/m10-agentA-m7.log`, report
  `/tmp/m10-agentA-m7-report.json`; T9 force-kill recovery, T11 reinstall,
  T12 uninstall all green.
- **Phases 14-16 signing (`m10/signing`, merged `3c8fe96`)**: secrets-gated
  macOS Developer ID keychain import → codesign → spctl → notarytool →
  staple, and Windows Authenticode injected during bundling via `--config`
  (keeps the updater `.sig` valid). Secrets absent → byte-identical skip
  path, verdicts stay `DEVELOPER_ID_SIGNED=NO / NOTARIZED=NO` (never faked).
  Credential interface: `docs/SIGNING_SECRETS.md`.

## Asset/audit NEEDS_DIAGNOSTIC fixes (`11963d7`, commit subject "Phases 18/22/25/27")

- Audit baseline: 19/19 rc14 assets present, artifact content scan 0
  matches, SHA256SUMS re-verified 17/17; 4 open findings — all fixed:
  - createTask captures the pre-create run error → `task failed to start:
    <reason>` (fail-fast 153ms verified; cold boot keeps the 20s message;
    orphan-cancel path preserved).
  - release workflow `GITHUB_ENV` export split (`VER=`/`ARCH=` on separate
    echos) — root cause of `build-info-macos.json.arch == ""`.
  - `scripts/release/sbom-enrich.py` chained after `npm sbom` — SBOM
    8 → 470 packages (react, react-dom, +460 Cargo.lock crates).
  - release-notes sed strips the `v` tag prefix.
- Full CI glob green in-branch: 44/44.

## Phases 29-31 — kill -9 crash recovery + reinstall/uninstall safety

- **Harness (`96c952e`)**:
  - `scripts/release/linux-e2e.sh`: exit-code honesty fix (`LINUX_E2E_PASS:
    no` exits 1), CRASH_RECOVERY block (force-kill both procs on a live
    in-flight task → relaunch → history shows a documented state + exactly
    one core), REINSTALL (dpkg -i over existing install), UNINSTALL_SAFETY
    (seeded user file survives uninstall).
  - `.github/workflows/windows-e2e.yml`: pre-kill liveness of BOTH procs,
    kill -9 mid-flight → relaunch → CRASH_RECOVERY from live history,
    reinstall-over-existing, ownership (unrelated notepad survives),
    UNINSTALL_SAFETY (opencode + seed file survive).
- **pwsh normalization fix (`20e301d`)**: `Invoke-RestMethod` delivers a
  JSON array as ONE wrapped object — `@(...).Count` reported 1 for a 2-task
  history and `[string]$hit.status` joined statuses into `PAUSED CANCELLED`,
  failing the assertion while the product behaved correctly. Fixed:
  `tasks raw:` first-300-chars evidence print, `history.json` = exact API
  bytes, `ConvertFrom-Json -InputObject` + `@()` normalization, scalar
  status guard (`<non-scalar:...>` otherwise).
- **Windows E2E GREEN (run 37297293114, rc14 assets, merged to master)**:
  `CRASH_RECOVERY: PASS (state=PAUSED)` · `REINSTALL: PASS (2 task(s)
  preserved, 1 core)` · `OWNERSHIP: PASS — notepad survived` ·
  `UNINSTALL_SAFETY: PASS`. Raw API = flat
  `[{TASK-000002 PAUSED}, {TASK-000001 CANCELLED}]` — no data loss across
  force-kill.

## Linux E2E reruns — zombie false-positive + clock-jump smoke root cause (all green)

- **run1 (rc14, `LINUX_E2E_PASS: no`, 15/5)**: kill-check used `ps -p` pid
  presence — but pid1 is `sleep infinity`, which never reaps, so the
  SIGKILLed core stayed a **zombie** and read as alive → false
  `CRASH_RECOVERY: FAIL` + snapshot/reinstall cascades (core never
  restarted). Both smokes: `POST_ERR: timed out` (35s client).
- **Fixes (`aa407f4`)**: zombie-aware kill check (`stat` `Z*` = dead),
  restart core on kill-fail (no cascade), smoke warmed-retry + HTTP
  error-body evidence, AppImage smoke retry, crash-create raw echo.
- **run2 (17/2)**: crash recovery, reinstall (+history preserved),
  uninstall safety, AppImage all PASS. Smokes still timed out → probed
  with a timed diagnostic container:
  - `opencode --version`: 3-4s via bash, **14s via node-spawn**; bare
    `opencode` not on core's PATH (ENOENT) — `discoverOpencode` carries it.
  - POST with 120s timeout → `HTTP_500 "task did not start within 20s"`
    at 33s (120 slow `listAll` iterations); record materialized minutes
    later, then FAILED gracefully in 1s.
  - **Root cause proven**: host sleep/wake + Docker VM resyncs jumped the
    container clock mid-request, breaking `createTask`'s
    `created_at >= startedAt - 1000` match. Same POST on stable clocks →
    **200 in 0.0s with record**. Product healthy; environment flake.
- **Fixes (`a351c44`)**: POST timeout 35→120s; 3-min late-registration
  poll on `/api/tasks` for both smokes (clock-jump tolerant); run under
  `caffeinate -i` (no sleep-induced jumps).
- **run3 GREEN (19/19, `LINUX_E2E_PASS: yes`, exit 0)**: DEB smoke
  `TASK-000001` created instantly → FAILED gracefully (node18/ChatGPT
  actionable error) · crash recovery (state=FAILED) · reinstall (+history
  preserved) · uninstall safety · AppImage smoke graceful-fail + removal.
  Merged ff to master (`a351c44`).

## m7 T7 root cause — resume-before-plan race (`c0a81ee`)

- **Symptom (3/4 m7 runs)**: T7 task COMPLETED (+verifier PASSED) but
  `m7-pause.txt` missing (ENOENT), or resume → FAILED. Modes vary with
  timing; T6 consistently green alongside.
- **Trace (snapshotted task dir)**: paused during WAITING_FOR_CHATGPT →
  resumed before the plan landed → session 1 ran the 164-char generic
  continue-prompt with NO plan, inspected a workspace containing T6's
  `m7-smoke.txt`, declared "SMOKE PASS", exited 0 → vacuous-spec
  verification (`steps: []`) → false COMPLETED. The loop never re-parsed
  the spec after the plan arrived late.
- **Fix (`orchestrator.resume`)**: when paused pre-plan, poll up to 300s
  for the in-flight ask to land (pause never aborts it); timeout →
  CANCELLED with clear error (PAUSED→FAILED is illegal). Resume with the
  full plan-derived objective (mirrors `run()`), re-parse spec from the
  landed plan — never an objective-less first session.
- **Verified**: focused resume test — post-plan immediate EXECUTING +
  objective prompt; late plan (+10s) → waited 12s → EXECUTING; no plan →
  CANCELLED at 301s with clear error. Minimal T7 repro of pause/resume
  mechanics PASSED on `c60c1db`.

## Phases 32-33 — Final full regression at `f0367c9` + rc15 cut

**Phase 32 — full regression at rc15 candidate `f0367c9` (clean tree):**

| Suite | Result | Evidence |
|---|---|---|
| root unit (tsx) | **47/47**, 12.1s, exit 0 | incl. resume-attempt-lifecycle **5/5** (new Test E), m8-ownership **6/6** |
| **m7 full (no filter)** | **13/13**, 21min, `filter: null`, `READY_FOR_V0.1.0_RC: YES` | `/tmp/jarvis-m7-full-f0367c9.log`, `m7-report.json` (failed: []) |
| m7 T7 gate metrics @this HEAD | stale=0, task_resumed=1, sessionStarts=1, resume→resumed **58s** (<300) | `/tmp/jarvis-t7-evidence.json` |
| **m8 GUI clean-install** | **P1–P9 green**, 11.6min | `/tmp/jarvis-m8-f0367c9.log` |
| **m9 updater E2E** | **green**, 18min (A/B builds + signed update flow) | `/tmp/jarvis-m9-f0367c9.log` |
| diagnostic (not counted as full M7) | T7-only green @`ec1dabd` (19min); T8–T11 green @`f0367c9` (7.6min) | `/tmp/jarvis-t7-ec1dabd.log`, `/tmp/jarvis-t8-11-r2.log` |

**Root causes found+fixed in this cycle (every T7/T9 failure):**

- `b39bac2` **attempt lifecycle**: `resume()` Branch A compared stale guards
  against `prevAttemptId` instead of the new `expectedAttemptId` → valid
  resumed response classified stale → task stuck PAUSED → T7 1800s timeout.
  Regression tests A/B/C fail on `efc3499`, pass on fix.
- `7c917c4` **pause/resume livelock**: `pause()` during WAITING_FOR_CHATGPT
  left run()'s in-flight `chatgpt.ask` driving the page; resume issued a
  second concurrent ask → livelock → resume POST exceeded undici 300s →
  `TypeError: fetch failed` (both failed T7 runs). `pause()` now aborts the
  ask AFTER PAUSED is persisted; resume Branch A relaunches the browser
  (idempotent) before the fresh ask.
- `aa44885` **recovery resume no-op**: boot recovery marks PAUSED without
  `pause()` ever seeding `planningAttemptId` in the fresh process → Branch B
  guard `get() !== expectedAttemptId` compared `undefined !== 0` → silent
  200 return, task never re-entered work (T9 600s timeout; evidence: zero
  resume-path events, status still PAUSED). All three attempt compares now
  `?? 0` (pause()'s own comment at the guard already documented this trap).
  Regression Test E fails on old code, passes on fix.
- Test-infra (not product): `9e1ad86` `JARVIS_M7_ONLY` filter for isolated
  phase diagnosis; `ec1dabd`/`7c2ba16` evidence dumps (task/events + core
  log) to /tmp before T12 deletes the root; `f0367c9` T10 history floor is
  filter-aware (filtered T6 creates no task → full-run floor 4 only).
- Environment (not product): ChatGPT web session expired mid-cycle →
  re-login into `runtime/browser-profile` (verified by scripted ask
  `ASK_OK`); transient `ERR_INTERNET_DISCONNECTED` killed one T9 run
  (relaunched green); opencode `--version` transiently hung ~25min while
  the user's TUI sessions refreshed `models.json` (unit suite hung on the
  probe child — re-ran green after refresh); box load1m 79 / swap 81%
  during runs (T13 recorded `resource-pressure`, never fatal).

**Phase 33 — rc15 cut:** `v0.1.0-rc15` = `f0367c9` (clean tree, fully
regression-tested per Phase 32, pushed). Release run **37874610552**: all 5
jobs green (Gate 30s · macOS DMG 4m41s · Linux 5m3s · Windows 5m21s · Draft
11s) → **draft, 19 assets, NOT published**.

## Phase 34 — signing gate re-affirmation at rc15

Secrets absent → byte-identical skip path (Phases 14-16 pipeline, `3c8fe96`).
CI `macos-codesign.txt`: `Signature=adhoc`, `TeamIdentifier=not set` →
`DEVELOPER_ID_SIGNED=NO · NOTARIZED=NO · AUTHENTICODE=NO` — never faked.
Credential interface + generation steps: `docs/SIGNING_SECRETS.md`.
Owner blocker unchanged.

## Phase 35 — rc15 asset/audit re-scan

- **19/19 assets present** (123MB downloaded); **SHA256SUMS 17/17 verified**.
- `inspect-artifact.py` on dmg/AppImage/deb/setup.exe/msi locally: **clean**
  (CI ran the same per-platform step in every job, green).
- Phase-25/27 fixes verified on rc15 outputs: `build-info-macos.json.arch`
  = `"arm64"` (non-empty), SBOM **470 packages** (npm prod + Cargo.lock),
  release-notes tag prefix stripped.
- `latest.json`: `darwin-aarch64` only — x64 macOS updater-feed gap
  persists (M9 gate item).

## Phase 36 — Platform verdict evidence (rc15, HEAD `f0367c9`)

| Platform | Artifacts (rc15) | Signing | Real-machine E2E | Verdict |
|---|---|---|---|---|
| **macOS (x64 + arm64)** | CI `arm64.dmg` + `.app.tar.gz` + `.sig`; local x64 DMG for E2E | **Ad-hoc only** | **YES @rc15 HEAD** — m7 13/13, m8 9/9, m9 updater, unit 47/47, clean-install lifecycle, uninstall clean | **TECHNICALLY PASS — distribution blocked on signing credentials** |
| **Windows** | `setup.exe` + `.sig`, `.msi` (unsigned) | No Authenticode | **YES @rc14-era** — GH-hosted windows-latest clean runner: NSIS install → sidecar spawn → core online → login-required → cancel → Job-Object quit → history → ownership PASS → uninstall ✓ (rc15 delta is platform-neutral core/resume + test-infra; not re-run) | **PASS (rc14 artifacts) — blocked on signing cert** |
| **Linux (amd64)** | `AppImage` + `.sig`, `.deb` (unsigned) | No GPG/repo signing | **YES @rc14-era** — ubuntu:24.04 Docker, 19/19: DEB deps → health → handshake → graceful ChatGPT/node fail → ownership stop → uninstall; AppImage extract/start/stop ✓ (rc15 delta platform-neutral; not re-run) | **PASS (rc14 artifacts) — unsigned** |

Manifests: `release-manifest.json` + `SHA256SUMS.txt` (17/17) +
`sbom.spdx.json` (470) + `latest.json` (3 platforms, updater sigs present).

## Phase 37 — Stable-release gate decision

**READY_FOR_V0.1.0_STABLE: NO**

1. No signing credentials on any platform: macOS ad-hoc only (no Developer
   ID, no notarization), Windows unsigned (no Authenticode), Linux unsigned.
2. Windows/Linux real E2E last ran on **rc14-era** artifacts (rc15's 8
   platform-neutral commits not re-verified on those runners).
3. x64 macOS updater artifact absent from `latest.json` (CI runner arm64).
4. ChatGPT automation depends on a manually-established web session
   (expired sessions require owner re-login — documented clean-machine
   behavior, but a stable-grade gate item).

`v0.1.0` is **not created** and must not be created until: signing
credentials exist, Windows/Linux E2E re-runs green on the tagged build,
x64 ships in the updater feed, and a re-cut RC passes the full gate.

## Phase 38 — rc15 publish decision

`v0.1.0-rc15` exists as a **draft** (owner decision pending; publishing is
an owner-level public action). `releases/latest/download/*` only resolves
once a non-prerelease is published.

## Phase 39 — What changed vs rc14 (release-engineering ledger, 28 commits)

- **Signing pipelines** `1b0330e`/`3c8fe96` (secrets-gated Developer ID +
  notarization + Authenticode injection; skip cleanly, verdicts stay NO).
- **TCC watcher made real** `b8140ed`/`5ad7807` (extracted AppleScript,
  live target detection, start regression 8/8 — was silently clicking
  nothing since v1).
- **Audit NEEDS_DIAGNOSTIC fixes** `0df3e18`/`11963d7`: pre-create task
  failures surfaced with reason; `GITHUB_ENV` arch export (empty
  `build-info.arch`); SBOM 8→470 packages; release-notes `v`-prefix strip.
- **Crash/reinstall/uninstall safety** `63819a8`/`96c952e`/`20e301d`:
  kill -9 recovery asserts, reinstall-over-existing history, uninstall
  user-data survival, pwsh `/api/tasks` normalization, exit-code fixes.
- **Linux/Windows E2E fix cycle** `b6af4df`/`8028da8`/`6093a25`/
  `aa407f4`/`a351c44` (token via docker exec, DEB singular route, zombie-
  aware SIGKILL, 120s POST timeout, clock-jump-tolerant late poll) → final
  19/19 `LINUX_E2E_PASS: yes`.
- **T7 resume-before-plan race** `c0a81ee` (wait for late plan, resume with
  full plan-derived objective — kills the false-COMPLETED smoke).
- **This cycle's pause/resume/recovery hardening**: `efc3499` continuity
  guards · `b39bac2` attempt-ID lifecycle (stale vs expected) · `7c917c4`
  abort-ask-on-pause + relaunch-on-resume (undici 300s livelock) ·
  `aa44885` recovery `undefined!==0` silent resume no-op · test infra
  `9e1ad86`/`ec1dabd`/`7c2ba16`/`f0367c9`.

## Phase 40 — REQUIRED FINAL REPORT

**M10 — Cross-Platform Runtime Certification & Signing Gate**

Result: all phases executed through 40. Final regression at `f0367c9`
green (unit 47/47, m7 full 13/13, m8 9/9, m9 updater green); every T7/T9
failure root-caused and fixed with regression tests; rc15 cut from the
tested commit, CI release all-5-green, draft with 19 assets, SHA256SUMS
17/17, artifact scan clean.

Platform verdicts:
- macOS: TECHNICALLY PASS (full E2E at rc15 HEAD) — blocked on Developer
  ID/notarization (ad-hoc only).
- Windows: PASS on rc14-era clean-runner E2E — blocked on Authenticode.
- Linux: PASS on rc14-era Docker E2E — unsigned.

**READY_FOR_V0.1.0_STABLE: NO** — blocked on signing credentials, Win/Linux
re-run on the tagged build, x64 updater feed. `v0.1.0` intentionally NOT
created.

Environment (not product): expired ChatGPT web session (owner re-login);
one transient network drop killed a T9 run (re-ran green); opencode
`--version` transient hang during TUI `models.json` refresh (suite re-ran
green); load1m 79 / swap 81% pressure recorded by T13, never fatal.

Pending owner decisions: publish the rc15 draft; obtain signing
credentials (`docs/SIGNING_SECRETS.md`) before any stable tag.
