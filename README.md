# Helium Synk

<img src="extension/public/icons/128.png" alt="Helium Synk" width="80" height="80" />

Private browser sync for Helium, built with WXT/TypeScript and a self-hosted Rust/Axum/SQLite relay on a Mac Mini behind Tailscale.

The development build supports encrypted diagnostic notes and **opt-in bookmark sync**: durable native-event capture, causal merges, conservative import previews, recovery backups, and journaled browser application. It uses IndexedDB, authenticated push/pull, idempotent acknowledgements, and WebSocket hints. It also supports **opt-in session capture and restoration**: source-owned current/closed/previous snapshots, encrypted multipart transport and a durable restoration journal. It also supports **opt-in history capture and local search**, with original timestamps, profile filters and logical removal. The dashboard also supports private pairing, installation removal with future-content key rotation, durable rotation retries and private recovery bundles. Authenticated history ciphertext purge and opt-in source-owned expiry are implemented; general retained-copy/backup policy remains pending. Basic native pairing/domain/short-outage/worker checks pass; full Helium acceptance and production hosting remain pending.

Read the [bookmark merge contract](docs/bookmark-merge.md) and [native adapter/recovery contract](docs/bookmark-browser.md). Read the [session capture/restoration contract](docs/sessions.md). Automated native-adapter tests use a simulated browser port; they do not establish live Helium compatibility.

Follow the [implementation checklist](docs/plan.md) and [verification record](docs/progress.md). Development source lives at `/Users/mihirpandey/Work/fun/helium-synk`, outside Documents/iCloud.

The dashboard and restoration page share a dark navy/blue/mint [design system](docs/design-system.md), with square Tailwind/shadcn controls and bundled local fonts. Extension TypeScript source uses the `@/` alias. History removal clears suppressed journal plaintext, cancels unencrypted erased visits and removes obsolete saved capture jobs for observed clears. Selected cached records lose optional native metadata; late native queries cannot restore canceled jobs. Authenticated client/relay purge removes certified live ciphertext; unresolved/shared capture copies, general quarantine and backup expiration remain pending; see the [history policy](docs/history.md).

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

### Run a local development relay

Keep credentials and test data in ignored `work/`. Production data belongs outside the source checkout and cloud-synced folders.

```sh
mkdir -p work
./scripts/cargo.sh build --locked
./target/debug/synk-server --database work/relay.sqlite issue-device \
  --name 'Helium profile A' --output work/profile-a.credential.json
./target/debug/synk-server --database work/relay.sqlite serve
```

The relay binds only to `127.0.0.1:4318`. Health endpoints are `/health/live` and `/health/ready`. Each credential file contains a distinct API token; use it for exactly one profile. Keep files private and never commit them.

### Load the extension

```sh
pnpm build
```

The [first native smoke checklist](docs/native-smoke.md) covers the initial hands-on pass.

In a **disposable Helium profile**, open `chrome://extensions`, enable developer mode, and load `extension/.output/chrome-mv3` as an unpacked extension. Click its toolbar action to open the dashboard. Use another disposable profile for the second client. Keep the unpacked extension path stable; changing identity/origin can strand local storage.

1. In profile A, choose **Set up my first device**, select `work/profile-a.credential.json`, then **Connect this device**. Keys are generated locally.
2. Open **Settings → Recovery & backups** and save a private recovery file separately from server backups.
3. Open **Devices → Add device → Save invitation file**. Transfer it privately to profile B. There, choose **Connect another device**, select the invitation file, name the device and connect. Each browser profile gets its own credential. Retry a saved connection attempt if a reply is lost.
4. Choose which collections to enable. **Bookmarks** requires a merge preview and saving a bookmark backup. **Sessions** enables capture and offers explicit tab/window restoration. **History** starts with new visits only; importing older visits is optional.
5. To check the connection, send a test message from **Settings → Diagnostics** and look for it on the other profile. The [native smoke record](docs/native-smoke.md) distinguishes observed browser results from remaining acceptance work.

The [routed UI contract](docs/extension-ux.md) describes the focused setup and page architecture. The redesigned UI still needs its packaged native profile pass. Keep the invitation private and remove its transfer copy after pairing. Invitations expire after 15 minutes, but their keys remain sensitive. Save a fresh recovery file after key rotation.

For recovery when no connected profile remains, issue a fresh credential and choose **Restore from a recovery file**. Use the new connection file with an updated recovery file; never copy an enrolled profile's credential to another profile. This checkpoint has no re-enrollment/key-correction UI. Do not clear a profile that contains pending work.

`pnpm dev` runs WXT's development build. Browser loading may require the same manual unpacked-extension step. The ignored `extension/web-ext.config.ts` can select a local browser binary; it must never point at your normal browser profile for tests.

## Persistence and encryption

Notes enter the local records table and encrypted outbox in one IndexedDB transaction. A retry reuses the same ciphertext and operation identity. Pending work is removed only after a validated committed acknowledgement; received records and cursor progress commit together. After reconnect, clients pull missed records even if a WebSocket notification was missed.

If the Mini goes offline, locally committed data remains available and notes, enabled bookmark edits and captured sessions queue locally. Closed/saved session snapshots remain distinct; unsent current snapshots may coalesce conservatively. Profile removal, extension uninstall, disk loss, and storage failure are separate failure cases. Automated checks exercise short outages and database/server restarts; hours-long real-browser tests remain pending.

The relay stores encrypted content and token hashes. It sees author IDs, counters, delivery sequences, and traffic size/timing. Clients use AES-256-GCM with fresh nonces and HKDF-derived per-account/domain/author keys. This build auto-unlocks: the recovery key, API credential, and decrypted content caches are stored in the browser profile. **Local profile data is not encrypted at rest by this extension.** Keep the recovery key separately; a server backup cannot decrypt records.

CLI revocation removes API access. The dashboard's installation-removal flow also rotates future accepted content keys for retained installations. Neither action can erase downloaded data or revoke knowledge of historical roots. The options page exports the local replica separately from recovery keys. The relay enforces persisted account envelope budgets and exposes authenticated usage/progress. Clients ACK committed journal cursors and retry lost replies durably; native browser effects retain separate progress. Upgrade the relay before this client. Read the [relay protocol/budget contract](docs/relay-protocol.md). Additional profiles can join using a private single-use pairing bundle with durable registration retries; read the [pairing contract](docs/pairing.md). Read the [key lifecycle and rotation contract](docs/key-rotation.md) for durable adoption, offline re-encryption, private version-2 bundles and the relay/membership trust boundary. Per-profile [local storage limits](docs/local-storage.md) now preserve pending work and expose admission warnings. Opt-in [history retention](docs/retention.md) expires acknowledged source-owned visits through the existing ciphertext purge. Session expiry, native acceptance, scale and older-backup/server-loss recovery remain open gates.

## Hosting and releases

The relay provides `backup --output` for consistent private SQLite snapshots and `mark-restored --expected-epoch` for stopped-database restore marking. See [relay snapshots and restore guards](docs/relay-recovery.md). Surviving clients keep their local work after rejected synchronization; missing acknowledged-operation replay and safe recovery/resume remain unfinished.

The [Mac Mini hosting guide](docs/self-hosting.md) records the Tailscale/launchd/backup work required before production use. Tailscale and startup settings have not been changed on this machine. iCloud is future research only.

Use Conventional Commits for each coherent step and a Changeset for user-visible package changes. Packages are private and are not published to npm. [CONTRIBUTING.md](CONTRIBUTING.md) describes checks and the intentional, reviewed release/changelog procedure.
