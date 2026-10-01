# Updater Key Management (M9 Phase 17)

Tauri updater signing uses an Ed25519 (minisign) keypair. The **public key is
embedded in the app** (`tauri.conf.json → plugins.updater.pubkey`); the
**private key signs every release artifact** and must never leave secure storage.

## Current key

| Item | Value |
|---|---|
| Generated | 2026-10-01, `npx tauri signer generate --ci -w ~/.jarvis/keys/updater.key` |
| Private key (owner machine) | `~/.jarvis/keys/updater.key` (mode 600, outside the repo) |
| Public key (committed) | `apps/desktop/src-tauri/tauri.conf.json → plugins.updater.pubkey` |
| Password | none (passwordless key; CI env `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` unset) |
| CI secret | GitHub Actions secret `TAURI_SIGNING_PRIVATE_KEY` (repo `Nimonsany/jarvisexe`), set via `gh secret set` **from the key file — content never printed/logged** |

## Generation

```bash
npx tauri signer generate --ci -f -w ~/.jarvis/keys/updater.key
# writes updater.key (private) + updater.key.pub (public)
# NEVER print the private key; NEVER commit either file (both live outside the repo)
```

## Backup

- The private key exists in exactly one place today: `~/.jarvis/keys/updater.key`
  on the owner's machine, plus the GitHub Actions secret (same bytes).
- **Owner action recommended:** copy `~/.jarvis/keys/updater.key` to a password
  manager / offline backup. If both copies are lost, no future update can be
  trusted by already-installed clients (see Disaster recovery).

## Rotation strategy

1. Generate a **new** keypair (do not overwrite the old files — keep them as
   `updater.key.old`).
2. Ship a bridge release whose app embeds the NEW public key **and** which is
   still signed with the OLD private key (older clients verify against old key).
   From then on all releases are signed with the new key.
3. Update the CI secret to the new private key after the bridge release.
4. Tauri also supports pubkey override at runtime from **Rust only**
   (`updater_builder().pubkey(...)`) for advanced rotation — frontend JS cannot
   change the key (that would defeat the trust model).

## CI configuration

- Secret name: `TAURI_SIGNING_PRIVATE_KEY` (content of `updater.key`).
- Optional: `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (release.yml always passes
  this env — empty string while the key is passwordless, which is what stops
  the signer from opening a TTY prompt in CI/scripts; required real value if
  the key is ever re-protected).
- The release workflow injects it as an env var for `tauri build` **only**.
  `.env` files do not work with Tauri and are not used.
- The private key is never checked into Git, never written to logs, and never
  uploaded as a release asset.

## Disaster recovery

**If the private key is lost:** clients that already installed an updater-enabled
build will reject every future update signed with a replacement key (signature
verified against the embedded public key). Recovery options:

1. Restore the key from backup (best).
2. Ship a **manually distributed** new installer (users re-download; the new
   installer embeds a new pubkey). Existing installs cannot be updated
   in-place — this is a deliberate security property, not a bug.
3. Never "fix" this by shipping unsigned updates — the updater refuses
   unsigned artifacts by design and that refusal must not be relaxed.

**If the GitHub secret is leaked:** rotate per the Rotation strategy above and
audit GitHub Actions history for misuse.
