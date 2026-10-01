# JARVIS Release Notes

## JARVIS <version>

### What this release is
Fourth and final release candidate for JARVIS v0.1.0. Built, packaged and
verified by the M9 distribution pipeline.

### Distribution
- macOS: `JARVIS_<version>_arm64.dmg` (App bundle, ad-hoc signed — see below)
- Windows: `JARVIS_<version>_x64-setup.exe` (NSIS), `JARVIS_<version>_x64.msi` (MSI, secondary)
- Linux: `JARVIS_<version>_amd64.AppImage`, `JARVIS_<version>_amd64.deb`
- `SHA256SUMS.txt` — checksums for every asset (verify after download)
- `release-manifest.json` — machine-readable build metadata (commit, toolchain,
  per-artifact sha256 + signing status)
- `sbom.spdx.json` — software bill of materials (npm production dependency tree)
- `latest.json` — Tauri updater metadata (Ed25519-signed)

### Update mechanism
In-app **Settings → Updates → Check for updates** downloads signed update
bundles from GitHub Releases and verifies the Ed25519 signature before
installing. Public key is embedded in the application; private key lives only
in the repo secret `TAURI_SIGNING_PRIVATE_KEY` (see
`docs/UPDATER_KEY_MANAGEMENT.md`).

### Signing status (honest)
- **Updater bundles**: signed (Ed25519).
- **macOS DMG/App**: ad-hoc signed (local machine verification only).
  Notarized distribution requires an Apple Developer ID — **not yet available**.
- **Windows installers**: unsigned. Distribution requires an Authenticode
  code-signing certificate — **not yet available**.
- **Linux packages**: unsigned (normal for this class of app).

### Platform test status
- macOS: full test + lifecycle suite (clean-install, DMG lifecycle, updater).
- Windows/Linux: compiled and packaged by CI; runtime coverage is limited —
  expect `BUILT_NOT_RUNTIME_TESTED` where not executed on a real machine.

### Known limitations
- No auto-launcher/updater background service yet (update check is manual).
- No cross-platform rollback automation (rollback procedure documented in
  `docs/UPDATER_KEY_MANAGEMENT.md` / `docs/RELEASE.md`).
- Ad-hoc signature resets on every rebuild → macOS Gatekeeper prompts reappear
  (TCC watcher covers interactive sessions).
