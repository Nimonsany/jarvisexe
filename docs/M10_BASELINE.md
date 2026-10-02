# M10 Baseline — Cross-Platform Runtime Certification + Signing Gate

Frozen: 2026-10-02 (session start), before any M10 changes.

## Frozen state

| Item | Value |
|---|---|
| Branch | `master` |
| Baseline HEAD | `492b3b3` ("docs: M9 Phases 36-40 — platform verdicts, READY_FOR_V0.1.0_STABLE: NO, final report") |
| Working tree | clean (one runtime test artifact `runtime/owned-processes.json` removed + gitignored at freeze — regenerable runtime state, same class as `runtime/tasks/`) |
| Existing tags | `v0.1.0-rc1`, `v0.1.0-rc2` (failed, historical), `v0.1.0-rc3` (valid RC), `v0.1.0-rc4` = `4bbaa45` |
| rc4 tag | **NOT retagged, NOT modified, NOT published** (draft release only, per owner instruction) |
| CI at freeze | green on every commit incl. `492b3b3` |
| Remote | `https://github.com/Nimonsany/jarvisexe.git` |

## Inherited verdict (end of M9)

**READY_FOR_V0.1.0_STABLE: NO**

- macOS technically verified (m7 13/13, m8 9/9, suite 39/39 incl. real-voice) but ad-hoc signed only — no Developer ID, no notarization.
- Windows compile-only (CI green; setup.exe + .msi artifacts exist; no signing cert, no clean-machine E2E).
- Linux compile-only (CI green; AppImage + .deb artifacts exist; no clean-machine E2E).
- rc4 predates six post-rc4 fixes (they ride to rc5).

## M10 plan (39 phases)

Freeze → post-rc4 fix table → full pre-rc5 regression → rc5 cut → platform
matrix (PASS_REAL/PASS_BUILD_ONLY/BLOCKED/FAIL) → Windows real installer +
clean-machine E2E (GitHub-hosted windows runner) + ownership + Authenticode →
Linux AppImage + DEB + clean Docker E2E → macOS rc5 runtime recheck →
Developer ID/notarization pipelines (integration-ready, truthful SIGNED: NO if
no credentials) → credential interface docs → artifact scan → preflight →
ChatGPT login flow → opencode discovery → TCC watcher regression → silent
failure audit → timeout policy → voice dimensions → manifest → checksums →
SBOM → updater security → crash recovery → install/reinstall → uninstall →
dogfood → stability → final regression → per-platform public readiness →
REQUIRED REPORT.

## Constraints carried into M10

- Never publish rc4; never retag rc4; never delete/rewrite historical tags.
- Never force-push. Never create `v0.1.0` unless every stable gate passes.
- Never convert compile-only evidence into runtime PASS.
- Never convert integration-ready signing into SIGNED.
- Never publish publicly without explicit owner authorization.
- No signing private keys / P12 passwords / ASC keys / PFX in Git — ever.
- Machine realities (report as environment, not product): 8GB Intel MBP with
  chronic thrash; TCC consent prompts reappear per ad-hoc rebuild (watcher
  fixed in M9: `contains` not `matches`); `coreaudiod` can wedge (system
  daemon, root-level recovery only).
