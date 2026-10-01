# Release Plan & Signing

## Release checklist (Milestone 9 — stable gate)

1. All suites green: unit/integration (`npx tsx --test tests/*.test.ts tests/*.mts`),
   `npx vitest run` (desktop), M7 clean-install E2E, M8 GUI release gate,
   M9 updater E2E (`npm run test:m9-updater`)
2. `npm audit --omit=dev` = 0 vulns; `cargo audit` gate green (release CI)
3. Secret scans green (tracked-files scan in CI; artifact inspection
   `scripts/release/inspect-artifact.py` in release packaging)
4. Sidecar launch smoke green on macOS + Linux CI; Windows spawn probe
   evidence collected (known launcher gap — see below)
5. Release workflow produces dmg/NSIS/MSI/AppImage/DEB + SHA256SUMS +
   release-manifest.json + SBOM + latest.json, artifact inspection clean
6. Updater E2E: signed A/B update, tamper reject, downgrade reject,
   wrong-platform reject, rollback reinstall all green
7. Signing status honestly reported (below) — **not** inferred from builds
8. Working tree clean, tag pushed, no force-push/tag rewrite ever

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

## Auto-update (M9 — implemented)

- Tauri updater plugin: GitHub Releases `latest.json` endpoint, Ed25519
  signature verified against the public key embedded at build time
  (private key: repo secret `TAURI_SIGNING_PRIVATE_KEY`,
  management in `docs/UPDATER_KEY_MANAGEMENT.md`).
- Bundles are signed during `release.yml` packaging
  (`createUpdaterArtifacts: true`); validation CI builds skip this.
- Downgrade protection and platform-key matching are enforced by the plugin
  (frontend never relaxes this) — verified by `tests/e2e/m9-updater.e2e.test.ts`
  (A/B update, tamper reject, downgrade reject, wrong-platform reject).
- Never auto-execute unsigned updates.

## Rollback procedure (M9 Phase 21)

1. Stop JARVIS (ownership-verified: `scripts/release/m7-clean-install.sh stop`
   or quit the app).
2. Keep previous-release artifacts — every GitHub release keeps its own DMG /
   setup.exe / AppImage + `SHA256SUMS.txt` + `release-manifest.json`.
3. Reinstall the previous artifact (DMG → drag to Applications, or
   `m7-clean-install.sh install` against the old DMG). App state
   (`~/.jarvis/runtime`-equivalent install state) survives reinstalls
   (m8 reinstall phase proves history survives).
4. Launch; verify the version in Settings → Updates ("Check for updates"
   must report **Up to date** against a latest.json that still holds the
   rolled-back version, or no update will be offered).

Automated path (rollback = reinstall previous artifact) is covered by
`m9-updater.e2e.test.ts` phase P6; in-app automatic downgrade is intentionally
blocked (tamper/downgrade/platform rejects = P3-P5).

## Tagging a release

```bash
git tag -a v0.1.0-rc4 -m "JARVIS v0.1.0-rc4 — M9 distribution RC"
git push origin v0.1.0-rc4   # triggers release.yml (v* tag)
```

## Privileges (M9 Phase 28)

- JARVIS never runs as root and never installs privileged helpers: user-level
  `.app`, user-level sidecar, updates install into the app's own writable
  location.
- macOS TCC: Desktop/Documents/Downloads access is user-granted at first use;
  ad-hoc builds get a per-cdhash identity (prompts reappear after every
  rebuild — Developer ID would make grants stable). Grants are never
  pre-seeded via private APIs; automated flows wait for the system prompt
  (TCC watcher clicks it during test runs only).
- No launchd agents or root LaunchAgents installed. `runtime/auth-token`
  stays mode-600, outside git.
- Windows/Linux installers request no elevation beyond conventional
  per-user install (NSIS user scope / DEB without postinst escalation).

## RC history (M9 Phase 30 — preserve, never rewrite)

| Tag | Outcome |
|-----|---------|
| `v0.1.0-rc1` | FAILED — macOS `delete-to-trash` hardcoded `~/.Trash` (Linux CI crash) |
| `v0.1.0-rc2` | FAILED — tests green, all three build jobs failed (arch/manifest/naming) |
| `v0.1.0-rc3` | VALID RC — all 4 CI jobs green (no packaging workflow yet) |
| `v0.1.0-rc4` | M9 distribution RC — full release workflow (dmg/NSIS/MSI/AppImage/DEB + updater) |

Failed RC tags remain as history. Tags are never deleted, moved or
force-pushed; stable `v0.1.0` does not exist until every stable gate passes.
