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
npx tsx packages/core/scripts/build-core-runtime.mts   # core runtime + sidecar
cp dist-core/jarvis-core "apps/desktop/src-tauri/binaries/jarvis-core-x86_64-apple-darwin"
cd apps/desktop/src-tauri && npx tauri build           # app + dmg
```

Tauri's own DMG step (`bundle_dmg.sh`) can hang on Finder automation permissions;
fall back to a plain `hdiutil` DMG:

```bash
cd target/release/bundle
mkdir -p dmg-staging && cp -R macos/JARVIS.app dmg-staging/ && ln -s /Applications dmg-staging/Applications
hdiutil create -volname "JARVIS" -srcfolder dmg-staging -ov -format UDZO dmg/JARVIS_0.1.0_x64.dmg
```

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
- OpenCode CLI on PATH
- Google Chrome (ChatGPT browser channel)
- macOS: microphone permission (voice), Accessibility (keyboard/mouse fallback)
