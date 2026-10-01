# M9 BASELINE — Freeze & Baseline Record

Phase 0 evidence. Recorded before any M9 change. **Do not modify the rc3 tag.**

## Repository state at M9 start

| Item | Value |
|---|---|
| Repository | jarvis-orchvisexe / jarvis-orchestrator (origin: Nimonsany/jarvisexe) |
| Branch | `master` |
| HEAD | `aa4469a` |
| Working tree | **clean** (`git status --porcelain` empty) |
| RC tags present | `v0.1.0-rc1` (failed CI), `v0.1.0-rc2` (failed CI), `v0.1.0-rc3` (**valid RC**) |
| `v0.1.0-rc3` commit | `aa4469a` = HEAD ✓ |
| M8 verdicts | TECHNICAL PASS = YES · READY_FOR_V0.1.0_RC = YES |

## Toolchain versions

| Tool | Version |
|---|---|
| Node | v26.9.0 |
| npm (package manager) | 11.19.1 (`package-lock.json`) |
| rustc | 1.96.1 (Homebrew) |
| cargo | 1.96.1 |
| Tauri CLI (`npx tauri`) | tauri-cli 2.11.5 |
| Tauri runtime (Cargo.lock) | tauri 2.12.0 |
| tauri-plugin-shell | **not used** (lib.rs spawns sidecar via `std::process::Command`) |
| Tauri updater plugin | **not present** (M9 Phase 16 will add it) |
| vite / vitest / react | ^6.0.0 / ^3.0.0 / ^19.0.0 (apps/desktop) |
| tauri.conf version field | `0.1.0` |

## Fast baseline suite (run at freeze)

| Suite | Result |
|---|---|
| Unit (`npx tsx --test tests/*.test.ts`) | **32/32 pass, rc=0** |
| Typecheck core (`tsc --noEmit -p packages/core`) | **ok** |
| Typecheck desktop (`tsc --noEmit` in apps/desktop) | **ok** |
| CI on rc3 (run 36817443890) | **4/4 jobs green** (Test, macOS, Linux, Windows) |

Full regression (m7 13/13, m8 9/9, mts 51/51, vitest 13/13) was green at the rc3 cut
and is re-run in M9 Phase 34 before any stable verdict.

## CI state at freeze

- Workflow: `.github/workflows/build.yml` — 4 jobs (test ubuntu, build-macos, build-windows, build-linux).
- Triggers: `push.tags: v*`, `push.branches: [main]`, `workflow_dispatch`.
- Known gap (M9 Phase 1): pushes to **master** are NOT tested (repo branch is `master`, CI watches `main`).
- `tauri.conf.json` `bundle.targets: ["app"]` — CI builds compile the app but produce no
  installers (M9 Phase 4 fixes this in the release workflow).

## Constraints carried into M9

- Failed RC tags (rc1, rc2) remain historical records — never deleted or rewritten.
- No force-pushes; stable tag `v0.1.0` only after all mandatory gates pass.
- Signing credentials are never committed; unsigned/ad-hoc artifacts must be labeled as such.
