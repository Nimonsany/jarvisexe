# Release Plan & Signing

## Release checklist (Milestone 8)

1. All test suites green: M1 12/12 · M2 9/9 · M3 15/15 · M4 10/10 · M5 8/8 · M6 4/4 · IPC 8/8
2. `npm audit --omit=dev` clean (production deps: 0 vulnerabilities)
3. No secrets in the repo (`git ls-files` scan + history audit) — runtime state git-बाहिर
4. Crash-recovery verified: SIGKILL → restart → discover → resume → COMPLETED; corrupt status.json skipped
5. Installer verified: DMG → install → launch → sidecar up → uninstall clean
6. CI valid (4 jobs), cross-platform builds defined
7. Working tree clean, tagged

## Tagging a release

```bash
git tag -a v0.1.0 -m "JARVIS v0.1.0 — Milestones 1-7"
git push origin v0.1.0        # triggers the CI build-* jobs (v* tags)
```

## macOS signing + notarization (when an Apple Developer ID is available)

1. Import the Developer ID Application certificate into the CI keychain (`APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` secrets).
2. In the CI build-macos job add:
   ```yaml
   env:
     APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
     APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
     APPLE_SIGNING_IDENTITY: Developer ID Application
     APPLE_ID: ${{ secrets.APPLE_ID }}
     APPLE_PASSWORD: ${{ secrets.APPLE_APP_SPECIFIC_PASSWORD }}
     APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
   ```
   Tauri signs + notarizes automatically when these are present.
3. Verify: `codesign -dv --verbose=4 JARVIS.app` and `spctl -a -t exec -vv JARVIS.app`.
4. Never commit or log the certificates/passwords.

## Windows signing (Authenticode)

- Add the code-signing certificate as a CI secret; sign the NSIS/MSI installers with `signtool` in the CI job.
- Verify: `signtool verify /pa /v JARVIS-Setup.exe`.

## Linux

- AppImage/DEB: GPG-sign the `.deb` Release file and the AppImage (`--appimage-sign`), publish checksums (SHA256SUMS) with each release.

## Auto-update (later milestone)

- Detect new signed releases via the GitHub Releases API.
- Verify signatures/checksums BEFORE executing any update binary.
- Never auto-execute unsigned updates.
