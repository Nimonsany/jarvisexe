# M9 Phase Log (working notes for REQUIRED FINAL REPORT)

## Done & verified
- **0** baseline: `docs/M9_BASELINE.md` (repo state, toolchain, suite, constraints).
- **1** `ci.yml`: push-master/PR/dispatch validation (typecheck, secret scan,
  `npm audit --omit=dev`, tsx tests, vitest, sidecar smoke, builds).
  Live-verified green on master (run 36827000063 all 4 jobs).
- **2** `release.yml`: tag/dispatch packaging (dmg, NSIS+MSI, AppImage+DEB,
  draft release). Test-gate dispatch validated; full tag run pending rc4.
- **3** version source-of-truth test (`tests/version-consistency.test.ts`) ✓.
- **4** release workflow = `release.yml` (build.yml deleted) ✓.
- **5** sidecar matrix:
  - macOS: launched in-app throughout m7/m8 clean-install E2E ✓ + CI smoke.
  - Linux: CI launch smoke (staged bundle → `/api/health` 200) added 980bb3c.
  - Windows: **KNOWN GAP** — sidecar staged as `jarvis-core.cmd` renamed
    `.exe` (batch content, not PE) → `Command::new` cannot execute it;
    empirical spawn probe added to CI (evidence, non-gating).
    Verdict: `BUILT_NOT_RUNTIME_TESTED` + launcher gap = Windows blocker.
- **16** updater wiring: tauri-plugin-updater + process, endpoint GitHub
  latest.json, pubkey embedded, `createUpdaterArtifacts: true`,
  Settings "Check for updates" UI (download→install→relaunch) ✓.
  Root-cause fix: CI validation build overrides `createUpdaterArtifacts:false`
  (signing key only in release.yml); local `build-dmg.sh` exports
  `~/.jarvis/keys/updater.key`.
- **17** `docs/UPDATER_KEY_MANAGEMENT.md` (gen/backup/rotation/CI secret/
  disaster recovery); key OUTSIDE repo (600), GH secret set, never printed.
- **18** capability `updater:default` + `process:default` in default.json.
- **18-21** `tests/e2e/m9-updater.e2e.test.ts` written (run via
  `npm run test:m9-updater`, mac-only, heavy): real UI-driven signed A/B
  update 0.1.0→0.1.1 + relaunch (19), tampered-signature reject with version
  unchanged + no relaunch (20), downgrade 0.0.9 reject + wrong-platform
  reject (18), rollback = reinstall saved A artifact → 0.1.0 (21).
  e2eDriver gains env-gated `app_version` cmd; evidence → m9-report.json
  (gitignored). **EXECUTED + GREEN** (runs 15/16: P0-P6 all pass,
  `M9_UPDATER_PASS: yes`, clean exit; test15 report pass=true).
  Root causes fixed en route: port split (harness 7793/core 7794), restored
  lost clickCheck, updater /tmp symlink (StartingBinary) → ~/.cache ROOT,
  post-restart pageFloor = pre-restart pageT (Date.now() floor rejected the
  fresh relaunched page → starved cmds), P5 asserts plugin TargetsNotFound
  rejection (Update check failed), syn sampler interval leak.
- **22** `scripts/release/release-manifest.py` + per-job `build-info.py`
  (commit/toolchain/artifact sha256/signing facts), wired before checksums.
- **23** SHA256SUMS.txt with `sha256sum -c` verify (release publish job) ✓.
- **24** SBOM: `npm sbom --sbom-format spdx` → release asset; **Test job
  green** on CI (36826714221) ✓.
- **25** audits: `npm audit --omit=dev` = 0 vulns; `cargo audit` gate added
  (taiki-e/install-action) — **Test job green** = no blocking RustSec vulns ✓.
  Local cargo-audit install: in progress (background).
- **26** `scripts/release/inspect-artifact.py` (PEM/AWS/GH-token bytes scan,
  dotenv assignment scan, deb `dpkg-deb` member listing, dmg hdiutil
  walk+scan) wired into all 3 release package jobs ✓ (first run = rc4).
- **29** `docs/RELEASE_NOTES.md` with `<version>` substitution in publish ✓.
- **31** rc4 cut: tag `v0.1.0-rc4` = `4bbaa45`, release run 36916215492 all
  5 jobs green (Gate, macOS, Linux, Windows, Draft release); 19 assets;
  `sha256 -c SHA256SUMS.txt` 17/17 OK; release-manifest gitCommit 4bbaa45;
  latest.json 3 platforms w/ sigs; inspect-artifact "clean"; macos-codesign
  = ad-hoc evidence. **Draft release left unpublished — owner decision**
  (publishing flips prerelease → affects `releases/latest` endpoint).
- **32** dogfood: local x64 DMG rebuilt from rc4 code → BUILD_DMG_OK,
  VERIFY_DMG_OK (commit 4bbaa45); m7 E2E **13/13 green**,
  `READY_FOR_V0.1.0_RC: YES` (~19 min).
- **33** stability: installed + launched, 30×60s sampling →
  **30/30 samples healthy** (version commit 4bbaa45 dirty:false).
- **34** full regression at HEAD (evidence per commit):
  - tsc core ✓ + tsc desktop ✓ (apps/desktop), secret scan clean,
    `npm audit --omit=dev` 0 vulns — all re-run at 6165648.
  - root tsx suite (`tests/*.test.ts tests/*.mts`): **39 tests / 0 fail,
    exit 0** at 6165648 (817s; run /tmp/m9-reg-tsx3.log).
  - desktop vitest: **13/13** at 6165648.
  - **m8 clean-install E2E: 9/9 green** at 6165648 (auto-rebuilt DMG at
    HEAD; m8-report.json m8TechnicalPass=true, readyForV010Rc=true;
    /tmp/m9-reg-m8-run2.log). First rerun attempt (run1) failed P5
    "task not terminal" while UI pill froze — root cause = machine thrash
    (load 427, swap 6.9/8G, orphaned WebKit 46% CPU) NOT product; run2
    green after killing orphan + calm load.
  - m7: run2 failed T6 (bot.review timeout) — root cause = TCC roster prompt
    for the rebuilt ad-hoc cdhash never clicked (old watcher watched
    SecurityAgent; prompts live in UserNotificationCenter). run3 T6 green
    after watcher v2, but **T7 failed: PAUSED→FAILED** — pre-existing pause
    race (stale in-memory task clobbers disk PAUSED after ChatGPT await;
    `pauseRequested` flag is dead code). Fixed at be0734d (disk-wins
    guards after launch/ask + in catch). run4 failed T6 differently:
    verifier ran plan test commands under `sh` while the planner emitted a
    bashism (`<(...)` process substitution) → syntax error → verification
    FALSE-NEGATIVE on a correct artifact. Fixed at ee948df (plan/agent
    commands run under `bash` — verifier.ts + computer/terminal.ts).
    Post-fix suite 38/38 (voice excluded: coreaudiod wedge).
    run5: T6 failed AGAIN — two independent root causes found:
    (1) the TCC watcher's AppleScript never compiled (uses `matches`, which
    plain osascript rejects as an identifier — compile error swallowed by
    2>/dev/null since watcher v1) → it NEVER clicked any prompt, ever; the
    run3 T6 pass was due to a manual grant click. Fixed: native `contains`
    instead of `matches`; watcher now compiles clean, logs clicks, polls
    every 5s.
    (2) the bot review `opencode run` (run f2e8cc38, 04:38Z) started but
    never streamed a model turn — starved under load 241-332 + swap 85%
    (owner Docker VM 2.4GB + java + 3 opencode sessions) → runBotTask
    180s SIGTERM → ok:false → review_skipped → test's blind 480s wait
    timed out with no reason surfaced. Fixes: runBotTask bound 180→300s
    (documented; T6 allows 480), skip emit now carries reason + analysis
    tail, T6 test fails fast on review_skipped WITH the reason instead of
    a blind timeout.
    Probe experiment confirmed roster loads (283 bots, no prompt) once the
    cdhash is granted. run6 (209bffa): T6 failed fast WITH the reason —
    bot ran all its verification commands (saw VERIFY: PASS, correct
    18-byte file) but opencode's final summary turn never started before
    the 300s SIGTERM: first turn alone took ~4min under thrash (load
    241-332). Fixed at 7c23853: review bound 300→420s (T6 allows 480).
    **m7 run7 (7c23853): ALL 13 GREEN, 53min** — Phase 34 m7 leg complete.
    **m8 run3 (7c23853): ALL 9 GREEN, 15min** (fresh DMG from run7).
    **Full suite at final HEAD 7c23853: 39/39 GREEN incl. real-voice
    transcribe** (coreaudiod recovered; prior 3 "hangs" were not hangs —
    the two server e2e files completed all steps but ran ~10min under
    load 312-332 thrash + parallel opencode cold starts; standalone child
    confirmed finishing normally at load ~40).
    `npm audit --omit=dev`: 0 vulnerabilities. Secret scan: only the
    pre-reviewed secret-name references in workflow files/README.
    Phase 34 full regression COMPLETE at final HEAD.
  - voice REAL transcribe (say/whisper): green at 6165648 (tsx3, 08:14);
    later runs blocked by system `coreaudiod` wedge (afplay+say both hang
    in HAL init; root-level recovery only — env issue, voice code untouched
    by M9 fixes).
- **35** security gate: CI Gate green on rc4 + 0362220 + 6165648 + be0734d
  (cargo audit + npm audit + secret scan); local secret scan clean;
  `npm audit` 0 vulns; inspect-artifact clean. Local cargo-audit binary not
  installed — CI Gate evidence used.
- **health-probe fixes** (post-rc4, ride to next tag — rc4 predates):
  - `0362220` bound `checkOpencode` with 10s SIGKILL (health hung forever
    on `opencode --version` stall → blocked m8 owner-server guards).
  - Root causes found after: (a) TCC Desktop-folder consent dialog
    unanswered → opencode stuck in dyld init indefinitely; (b) cold start
    measured **15.05s** (1.8GB db) > 10s bound → health falsely `missing`.
    Fix `6165648`: bound raised to 30s. Owner server health verified
    `opencode:"ready"` after restart. m7 T5 (asserts 'ready') green post-fix.
  - m8-watcher v2: clicks TCC prompts in BOTH SecurityAgent (title match)
    and UserNotificationCenter (button-signature match: Don't Allow+OK) —
    v1 watched only SecurityAgent (absent on this macOS) and never fired.

## In flight / pending
- m7 run4 at be0734d (pause fix) — completes Phase 34 m7 leg.
- Phase 7/8 signing/notarization evidence (ad-hoc only — honest NO for
  Developer ID / notarization; Windows Authenticode missing).
- Phase 15 preflight note, 27 ownership regression (m8-ownership in suite ✓),
  28 privileges note, 30 rc history (rc1/rc2 failed, rc3/rc4 valid).
- Phase 36-40: platform verdicts + REQUIRED FINAL REPORT. Stable `v0.1.0`
  tag only if all gates pass (macOS signing/notarization + Windows cert +
  Windows launcher gap + arm64-only CI macOS block
  `READY_FOR_V0.1.0_STABLE: YES` — honest NO expected).
- Owner decision pending: publish rc4 draft release.

## Key facts for report
- Signing: updater Ed25519 ✓ signed; macOS ad-hoc (no Developer ID/notary
  account); Windows/Linux unsigned. Evidence files: macos-codesign.txt,
  release-manifest.json signingStatus per artifact.
- Secrets hygiene: runtime/auth-token was tracked once → untracked (still in
  git history; no rewrite per tag-preservation rule).
- TCC watcher v2, ad-hoc cdhash resets (per-rebuild re-prompts), never-kill
  owner services (7788 etc).
- Platform gap: CI macOS runner = arm64 → latest.json has darwin-aarch64
  only; local x64 DMG built/tested separately (m7/m8/33).
- Environment (report as environment, not product): 8GB machine chronic
  thrash (load spikes 400+, swap ~85%) caused 2 test flakes (m8 P5 run1,
  m7 T6-adjacent timing); `coreaudiod` wedged post-08:14 → voice REAL
  tests env-blocked after tsx3 green run.
- Test-count note: root tsx suite reports 39 top-level tests / 85 subtests
  across 14 files (baseline counted 32+51 differently — suites evolved).
