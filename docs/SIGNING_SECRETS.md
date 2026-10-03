# Signing Credential Interface (M10 Phase 16)

Signing credentials come ONLY from secure environment / CI secrets. **No
credential value ever appears in this repository, in logs, or in this
document** — only the exact secret variable names and their purpose.

## Already wired (updater signing — used by every release build)

| Secret variable | Purpose | Used by |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | minisign private key for Tauri updater artifacts (`.sig` files) | `.github/workflows/release.yml` (all packaging jobs) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | password for the minisign key | same |

These are stored as GitHub Actions secrets on the repository. The local
updater key lives at `~/.jarvis/keys/updater.key` (mode 600, never printed,
never committed).

## macOS Developer ID signing + notarization (integration-ready, NOT yet signed)

To enable, add these GitHub Actions secrets and wire them in the macOS
packaging job (the pipeline steps to add are documented in the M10 report):

| Secret variable | Purpose |
|---|---|
| `MACOS_DEVELOPER_ID_CERT_P12` | Developer ID Application certificate (.p12, base64) |
| `MACOS_DEVELOPER_ID_CERT_PASSWORD` | .p12 export password |
| `KEYCHAIN_PROFILE` | `notarytool` keychain profile name (or use the three vars below) |
| `APPLE_ID` | Apple ID for `notarytool` (alternative to the keychain profile) |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for `notarytool` |
| `APPLE_TEAM_ID` | Apple Developer Team ID |

Signing order (implemented in the pipeline design): nested components first
(the core sidecar binary, embedded frameworks), then the outer app bundle;
`codesign --verify --deep --strict` after each; `notarytool submit` + `stapler
staple` for notarization; Gatekeeper verification last.

## Windows Authenticode signing (integration-ready, NOT yet signed)

| Secret variable | Purpose |
|---|---|
| `WINDOWS_PFX` | Authenticode code-signing certificate (.pfx, base64) |
| `WINDOWS_PFX_PASSWORD` | .pfx password |

Sign both `jarvis-desktop.exe` and the NSIS/MSI installers with `signtool
sign /fd SHA256 /tr <timestamp-server> /td SHA256`; verify with `signtool
verify /pa /all`.

## Rules

- Secrets enter the pipeline ONLY via `secrets:` context — never committed,
  never logged, never echoed.
- `MACOS_DEVELOPER_ID_SIGNED: NO` / `MACOS_NOTARIZED: NO` /
  `WINDOWS_SIGNED: NO` are the honest current states — integration-ready
  pipelines exist, credentials do not.
- Never fabricate a SIGNED/NOTARIZED verdict.
