# Helium Synk

Private browser sync for Helium, built with WXT/TypeScript and a self-hosted Rust/Axum/SQLite relay on a Mac Mini behind Tailscale.

The current foundation build exchanges **encrypted diagnostic notes** between separately enrolled browser profiles. It includes a durable IndexedDB outbox, authenticated push/pull, idempotent acknowledgements, WebSocket hints, and an options dashboard. Bookmarks, history, and session capture/restoration are upcoming milestones. This is a development checkpoint; production hosting and browser lifecycle gates are pending.

Follow the [implementation checklist](docs/plan.md) and [verification record](docs/progress.md). Development source lives at `/Users/mihirpandey/Work/fun/helium-synk`, outside Documents/iCloud.

## Development

Use Node 24+, pnpm 12.8.1, Rust 1.87+, and patched SQLite with development headers. On macOS, `scripts/cargo.sh` selects the installed Homebrew SQLite headers/library. The relay refuses SQLite versions vulnerable to the documented WAL-reset corruption issue. See [SQLite's WAL guidance](https://sqlite.org/wal.html#wal_reset_bug).

```sh
cd /Users/mihirpandey/Work/fun/helium-synk
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm check
pnpm check:server
pnpm test:integration
pnpm check:versions
pnpm format:check
```

### Run a local diagnostic relay

Keep credentials and test data in ignored `work/`. Production data belongs outside the source checkout and cloud-synced folders.

```sh
mkdir -p work
./scripts/cargo.sh build --locked
./target/debug/synk-server --database work/relay.sqlite issue-device \
  --name 'Helium profile A' --output work/profile-a.credential.json
./target/debug/synk-server --database work/relay.sqlite issue-device \
  --name 'Helium profile B' --output work/profile-b.credential.json
./target/debug/synk-server --database work/relay.sqlite serve
```

The relay binds only to `127.0.0.1:4318`. Health endpoints are `/health/live` and `/health/ready`. Each credential file contains a distinct API token; use it for exactly one profile. Keep files private and never commit them.

### Load the extension

```sh
pnpm build
```

In a **disposable Helium profile**, open `chrome://extensions`, enable developer mode, and load `extension/.output/chrome-mv3` as an unpacked extension. Click its toolbar action to open the dashboard. Use another disposable profile for the second client. Keep the unpacked extension path stable; changing identity/origin can strand local storage.

1. Paste profile A's credential JSON into its dashboard. Leave the recovery-key field blank on the first profile.
2. Save the generated recovery file somewhere private, outside the source repository.
3. Paste profile B's separate credential JSON into its dashboard and enter **the same recovery key** from A's recovery file.
4. Queue a test note on each profile. Stop the relay, queue another note, and restart it to check catch-up synchronization.

A fresh profile generates a new key when the field is blank. Using different keys for the same account causes decryption failure; this checkpoint has no re-enrollment/key-correction UI. Diagnose with disposable profiles. Do not clear a profile that contains pending work.

`pnpm dev` runs WXT's development build. Browser loading may require the same manual unpacked-extension step. The ignored `extension/web-ext.config.ts` can select a local browser binary; it must never point at your normal browser profile for tests.

## Persistence and encryption

Notes enter the local records table and encrypted outbox in one IndexedDB transaction. A retry reuses the same ciphertext and operation identity. Pending work is removed only after a validated committed acknowledgement; received records and cursor progress commit together. After reconnect, clients pull missed records even if a WebSocket notification was missed.

If the Mini goes offline, locally committed data remains available and new notes queue locally. Profile removal, extension uninstall, disk loss, and storage failure are separate failure cases. Automated checks exercise short outages and database/server restarts; hours-long real-browser tests remain pending.

The relay stores encrypted content and token hashes. It sees author IDs, counters, delivery sequences, and traffic size/timing. Clients use AES-256-GCM with fresh nonces and HKDF-derived per-account/domain/author keys. This build auto-unlocks: the recovery key, API credential, and decrypted note cache are stored in the browser profile. **Local profile data is not encrypted at rest by this extension.** Keep the recovery key separately; a server backup cannot decrypt records.

Revocation removes API access but cannot erase downloaded data or revoke knowledge of an existing encryption key. Key rotation, quotas, short-lived pairing, full replica exports, and older-backup recovery procedures are later gates.

## Hosting and releases

The [Mac Mini hosting guide](docs/self-hosting.md) records the Tailscale/launchd/backup work required before production use. Tailscale and startup settings have not been changed on this machine. iCloud is future research only.

Use Conventional Commits for each coherent step and a Changeset for user-visible package changes. Packages are private and are not published to npm. [CONTRIBUTING.md](CONTRIBUTING.md) describes checks and the intentional, reviewed release/changelog procedure.
