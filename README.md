# Helium Synk

<img src="extension/public/icons/128.png" alt="Helium Synk" width="80" height="80" />

Private encrypted browser sync for Helium: opt-in bookmarks, current/closed/saved sessions with explicit restoration, and searchable history with original timestamps. A WXT extension stores durable offline work in IndexedDB; a Rust/Axum/SQLite relay runs privately on a server you control behind Tailscale. Passwords, cookies and native profile files are excluded.

The dashboard and compact popup share dark navy/blue/mint Tailwind/shadcn controls with square corners and bundled local fonts. Collections start off. Receiving or restoring another device’s session does not close its windows.

The [single release checklist](docs/plan.md) records current tests, native evidence, decisions and follow-ups. For everyday setup, read [setting up profiles and connecting another computer](docs/setup-guide.md). Technical references are [architecture and security contracts](docs/architecture.md) and the [deployment/publishing runbook](docs/deployment.md). Release preparation does not install a production service or publish artifacts.

Data handling and retention: [Privacy policy](PRIVACY.md).

## Development

Use Node 24.11+ (24.x) or 26+, pnpm 12.8.1, Rust 1.87+ and patched Homebrew SQLite. `scripts/cargo.sh` selects its headers/library on macOS; the relay refuses SQLite versions affected by the WAL-reset corruption issue. See [SQLite WAL guidance](https://sqlite.org/wal.html#wal_reset_bug).

```sh
pnpm exec vp install --frozen-lockfile
pnpm exec vp run check
pnpm exec vp run check:server
pnpm exec vp run test:integration
pnpm exec vp run check:versions
```

Vite+ 1.0.0 is pinned in the workspace catalog, following its [migration rules](https://viteplus.dev/guide/migrate-rules). `pnpm exec vp check` runs Oxfmt and Oxlint with type-aware/type checks; `pnpm exec vp test` runs the unit suite. `vp run check` additionally keeps the original TypeScript checks and production build. No global installation is required. With a global Vite+ CLI, omit `pnpm exec`.

**WXT owns the browser-extension build:** use `pnpm exec vp run dev` and `pnpm exec vp run build`. Built-in `vp dev`/`vp build` run ordinary Vite and do not invoke WXT; use the task commands here so the MV3 manifest/background/pages stay intact. Core is an internal source workspace, not a separately packed npm library.

The local commit hook can be installed with `pnpm exec vp run hooks:install`; see [CONTRIBUTING.md](CONTRIBUTING.md) for reviewed Changesets releases. CI checks main and pull requests. Manual workflows build releases and submit the extension to Chrome Web Store.

## Local relay and first setup

Keep development credentials/data in ignored `work/`, private and outside cloud sync. Production data goes outside the checkout.

```sh
mkdir -p work
./scripts/cargo.sh build --locked
./target/debug/synk-server --database work/relay.sqlite issue-device \
  --name 'Helium profile A' --output work/profile-a.credential.json
./target/debug/synk-server --database work/relay.sqlite serve
pnpm exec vp run build
```

The default listener is `127.0.0.1:4318`; health endpoints are `/health/live` and `/health/ready`.

In a disposable Helium profile, open `chrome://extensions`, enable developer mode and Load unpacked from `extension/.output/chrome-mv3`. Keep that directory and extension ID stable. The toolbar popup opens the full dashboard.

1. Choose **Set up my first device**, select the private connection file and connect. Content keys are generated locally.
2. Save a private recovery file from **Settings → Recovery & backups**, separately from relay backups.
3. From **Devices → Add device**, save an invitation and transfer it privately to the second profile. Choose **Connect another device**, select the file and connect with a distinct profile name. Invitations expire after 15 minutes; their embedded keys remain sensitive, so remove transfer copies after use.
4. Enable chosen collections explicitly. Bookmarks requires preview and saving its backup. Sessions offers explicit local restoration. History defaults to new visits; older import is optional.

Recovery into a new profile needs a fresh connection credential and a current private recovery bundle. Never clone an enrolled author’s credential/counters or clear a profile with pending work. Save a fresh recovery file after rotation.

## Persistence and retained data

Locally committed work and pending uploads survive relay downtime and tested worker/database restarts. Received data/cursor commits atomically; validated ACKs drain outgoing work. WebSocket notifications are hints, so reconnect always pulls missed records. Browser uninstall/profile loss/disk failure are separate cases; no extension can preserve data after its storage is destroyed.

The relay stores encrypted payloads and credential hashes; it sees author IDs/counters, sizes/timing and delivery metadata. Clients use AES-256-GCM, fresh nonces and HKDF-derived installation/domain keys. **Browser-profile secrets and decrypted caches are not encrypted at rest by this extension.** Device removal blocks API access and rotates future accepted content; it cannot erase previously downloaded content or old keys.

Opt-in history expiry uses authenticated live ciphertext purge. Opt-in session expiry removes visible archives/journal plaintext and preserves hashed duplicate receipts; **encrypted session copies remain on clients/relay**, and content caps are not disk limits. Update all clients before enabling session expiry. Native browser data, independent exports, historical backups and filesystem snapshots can retain copies.

Server epoch/account mismatch fails closed and preserves local queues/data. Automatic reconstruction from an older backup or server disk loss remains follow-up work; do not bypass guards by resetting clients. The deployment runbook describes safe isolated restore review.

## Release candidate

```sh
pnpm exec vp run release:prepare
```

This validates and builds an extension ZIP, native Rust relay with checksum-pinned static SQLite 3.53.4, `SHA256SUMS` and `build.json` in ignored `release/`. Building needs Python 3, `curl`, `cc`, `ar`, `zip` and `unzip`. Metadata records source commit and uncommitted state.

In GitHub Actions, **Build release** checks main, builds macOS/Linux ARM64 and x64 bundles, then creates a draft tagged release. Review assets and notes before publishing. **Chrome Web Store** uses WXT/API v2: authenticate only, upload a draft, or submit staged review. Configure its IDs/secrets first; see [publishing](docs/deployment.md#github-releases-and-chrome-web-store).

For macOS hosting, copy `config/macos.example.json` to ignored `deployment.local.json`, configure profiles/endpoints, then follow the [installation runbook](docs/deployment.md#install-on-macos). Additional independent profiles use `--add-profiles`; additional installations of an existing account use invitations. Deployment acceptance and publication stay in the checklist.
