# Packaging

## What ships

| Platform | Artifact | Built on |
|----------|----------|----------|
| macOS | `JARVIS.app` + `JARVIS_<version>_x64.dmg` | macOS (CI macos-latest / locally) |
| Windows | `JARVIS_<version>_x64-setup.exe` (NSIS) / `.msi` | Windows (CI windows-latest) |
| Linux | `JARVIS_<version>_amd64.AppImage` / `.deb` | Linux (CI ubuntu-latest) |

The bundle contains:
- the Tauri desktop shell (`jarvis-desktop`) with the React UI
- the **core sidecar** (`jarvis-core` launcher + `core-runtime/server.js` + node_modules with playwright/playwright-core)
- no secrets, no browser profiles, no .env — runtime state lives in `~/.jarvis/runtime` (created at first run)

## App startup flow (production)

```
JARVIS.app launch
  → Rust spawns the core sidecar (dist-core/jarvis-core launcher)
      → launcher locates node (PATH + common locations) + core runtime
      → node server.js → local API on 127.0.0.1:7788 (token-gated)
  → webview loads the React UI → connects to the core
  → app exit → sidecar killed
```

## Local build (macOS)

```bash
npm install
bash scripts/release/build-dmg.sh    # manifest → core bundle → .app → hdiutil DMG + .sha256
bash scripts/release/verify-dmg.sh   # mount + layout + manifest freshness + secret-filename scan
```

`build-dmg.sh` embeds `dist-core/build-manifest.json` (version / git SHA / builtAt / arch /
channel) as `JARVIS.app/Contents/Resources/core-runtime/build-manifest.json`; `verify-dmg.sh`
fails if it is stale vs the working tree. Tauri's `bundle.targets` is `["app"]` on purpose —
its DMG step (`bundle_dmg.sh`) hangs on Finder automation permissions, so the script owns DMG
creation via a plain foreground `hdiutil create`.

## Release hardening (M7)

```bash
npm run test:m7   # clean-install E2E: DMG → install → first launch → smoke → pause/resume →
                  # cancel → kill/restart recovery → relaunch → reinstall → uninstall → cleanup
```

Runs against a disposable `/tmp/jarvis-m7-*` root on port **7789** (the dev server on 7788
stays untouched), writes `m7-report.json`, and prints `READY_FOR_V0.1.0_RC: YES|NO`.
`scripts/release/m7-clean-install.sh` (`install|launch|launch-core|health|stop|reinstall|uninstall|status`)
and `scripts/release/m7-cleanup.sh` are also usable standalone.

## CI (GitHub Actions)

`.github/workflows/build.yml`:
- `test` — typechecks + all unit suites (ubuntu)
- `build-macos` — DMG
- `build-windows` — NSIS/MSI
- `build-linux` — AppImage/DEB

Run via `workflow_dispatch` or push to `main`/`v*` tags. Artifacts upload per platform.
The repo is never pushed automatically — the owner controls the remote.

## Signing

- macOS: set `APPLE_CERTIFICATE` / team ID in CI for Developer ID signing + notarization (not configured in this repo).
- Windows: Authenticode cert in CI secrets (not configured).
- Auto-update (later milestone) must verify signatures before executing any update binary.

## Requirements after install

- Node.js 20+ (the sidecar launcher locates it; a bundled Node runtime can replace this later)
- OpenCode CLI (discovery: configured → bundled → user-local → PATH; see `/api/preflight`)
- Google Chrome (ChatGPT browser channel)
- macOS: microphone permission (voice), Accessibility (keyboard/mouse fallback)
