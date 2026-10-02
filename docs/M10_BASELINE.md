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

## Phase 2 — Post-rc4 fixes (inspected from actual git history, 4bbaa45..82b40af)

9 commits after rc4. All exist in the intended rc5 commit (cut from this lineage).

| Commit | Reason | Affected subsystem | Tests covering it |
|---|---|---|---|
| `0362220` | `opencode --version` probe can stall minutes (1.8GB local db) — health hung forever, blocking m8 owner-server guards | `core/server.ts` checkOpencode | `tests/m8-core-endpoint.test.ts` (health), m8 E2E P9 owner-server guard |
| `6165648` | 15s cold start measured → 10s bound too tight | `core/server.ts` checkOpencode | same |
| `be0734d` | pause/cancel landing mid-await clobbered by stale in-memory status; `pauseRequested` was dead code | `core/orchestrator.ts` run() | m7 E2E T7 (pause/resume), `tests/state-machine.test.ts` |
| `ee948df` | POSIX `sh` rejects planner bashisms (`<(...)`) → false-negative verification of correct artifacts | `core/verifier/verifier.ts`, `core/computer/terminal.ts` | `tests/verifier.test.ts`, `tests/computer.test.mts`, m7 E2E T6 |
| `209bffa` | bot review: blind 480s timeout on skip with zero reason surfaced; TCC watcher never compiled (`matches` invalid operator, errors swallowed) | `core/orchestrator.ts`, m7 E2E test, `scripts/tcc-watcher.sh` | m7 E2E T6 fail-fast, `tests/tcc-watcher.test.ts` (new, permanent) |
| `7c23853` | opencode boot+turns under thrash measured >300s | `core/orchestrator.ts` (review bound 300→420s) | m7 E2E T6 |
| `492b3b3` | M9 final report + platform verdicts (docs) | `docs/M9_PHASE_LOG.md` | n/a (docs) |
| `87a772a` | M9 Phase 34 completion record (docs) | `docs/M9_PHASE_LOG.md` | n/a (docs) |
| `82b40af` | M10 baseline freeze + gitignore runtime test state | `docs/M10_BASELINE.md`, `.gitignore` | n/a |

Voice/coreaudiod: **no code change** — the wedge was a system daemon
(`coreaudiod`, pid 213) requiring root-level recovery; the voice test file is
unchanged and re-ran green after recovery (39/39 suite incl. voice at
`7c23853`). Real-voice coverage: `tests/voice.test.mts` (real `/usr/bin/say`).

TCC watcher correction + click logging: the script previously lived only in
`/tmp` — now committed as `scripts/tcc-watcher.sh` (native `contains` instead
of invalid `matches`, stderr captured via `2>&1` — never discarded, clicks
logged with button name, poll every 5s, `TCC_WATCHER_LOG` overridable) and
permanently regression-tested by `tests/tcc-watcher.test.ts` (5 checks incl.
osacompile syntax validation).
