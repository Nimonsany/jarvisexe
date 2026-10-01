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
  (gitignored). **Execution pending** (queued after local build + m7 gate).
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

## In flight / pending
- CI run 36828399306 (980bb3c): mac/linux sidecar smoke + windows spawn probe.
- Local `build-dmg.sh` (Phase 6 DMG lifecycle) building; then `verify-dmg.sh`,
  `m7-clean-install.sh` full E2E (Phase 14/6), artifact inspection locally.
- Phase 19-21: updater A/B + tamper + rollback (local builds, config endpoint
  override to localhost + dangerousInsecureTransportProtocol for A/B test).
- Phase 7/8: signing/notarization evidence (ad-hoc only — honest NO for
  Developer ID / notarization; Windows Authenticode missing).
- Phase 15 preflight, 27 ownership regression (m8-ownership in suite ✓),
  28 privileges note, 30 rc history note (rc1/rc2 failed, rc3/rc4 valid).
- Phase 31: cut `v0.1.0-rc4` → release workflow full run → download assets →
  post-upload verification (manifest/checksums/inspection/latest.json).
- Phase 32/33 dogfood + stability on CI-built rc4 DMG.
- Phase 34 full regression; 35 security gate.
- Phase 36-40: verdicts + REQUIRED FINAL REPORT. Stable `v0.1.0` tag only if
  all gates pass (macOS signing/notarization + Windows cert + Windows
  launcher gap likely block `READY_FOR_V0.1.0_STABLE: YES` — honest report).

## Key facts for report
- Signing: updater Ed25519 ✓ signed; macOS ad-hoc (no Developer ID/notary
  account); Windows/Linux unsigned. Evidence files: macos-codesign.txt,
  release-manifest.json signingStatus per artifact.
- Secrets hygiene: runtime/auth-token was tracked once → untracked (still in
  git history; no rewrite per tag-preservation rule).
- TCC watcher, ad-hoc cdhash resets, never-kill owner services (7788 etc).
