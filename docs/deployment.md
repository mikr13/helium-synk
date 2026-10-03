# Deployment

Browser steps: [setup-guide.md](setup-guide.md). Progress/limits: [plan.md](plan.md).

## Install on macOS

Server needs macOS 13+, Python 3.9+, [Tailscale](https://tailscale.com/docs/install/mac) and its matching release bundle. Extract it, then pass that directory with `--release-dir`. Release relays include patched static SQLite; development builds use Homebrew SQLite.

```sh
pnpm exec vp run release:prepare
cp config/macos.example.json deployment.local.json
```

Edit the [example config](../config/macos.example.json): profile identifiers, unused loopback ports, distinct HTTPS `.ts.net` origins, device names and local `HH:MM` backup times. Rename/remove/add profiles as needed. Local config is ignored.

```sh
python3 scripts/install-macos.py --config deployment.local.json --check
python3 scripts/install-macos.py --config deployment.local.json
```

Installer checks hashes/architecture, creates independent credentials/databases, takes initial backups and installs three LaunchAgents per profile. It refuses existing data/agents; it is not an upgrader.

Default root: `~/Library/Application Support/Helium Synk`. Overrides: `--root`, `--release-dir`, `--python`, `--label-prefix`. `--no-start` defers loading until login; `--check` writes no installation files. Full options: `python3 scripts/install-macos.py --help`.

Inspect partial files after failure before retrying. Legacy installs without deployment metadata require a reviewed upgrade.

## Private Tailscale endpoints

Inspect existing routes first. Example config uses HTTPS 443/8443 with localhost 4318/4319:

```sh
tailscale serve status
tailscale serve --bg --https=443 http://127.0.0.1:4318
tailscale serve --bg --https=8443 http://127.0.0.1:4319
tailscale serve status --json
```

Match your config. Enable tailnet HTTPS; keep public Funnel disabled. Restrict intended clients; application credentials remain required. See [Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

Check each endpoint's `/health/ready`, then verify real cross-device sync and account isolation. Installer does not configure Tailscale, browser extensions or power settings.

## Add an independent profile

Create `additional.deployment.local.json` with only new identifiers, unused ports, distinct endpoints and unchanged retention. Use the original `--root` if customized.

```sh
python3 scripts/install-macos.py --config additional.deployment.local.json --add-profiles --check
python3 scripts/install-macos.py --config additional.deployment.local.json --add-profiles
```

Requires the matching installed helper. Existing accounts/files/jobs stay intact. Add its private Serve route, then [connect its first device](setup-guide.md#3-connect-the-first-device-of-a-new-account).

## Files and jobs

Inside the root: `bin/`, `extension/`, `accounts/PROFILE/`, `recovery/PROFILE/`, `logs/`, `deployment.json`, `installation.json`, `build.json`.

Private directories: 0700; files: 0600; executable: 0700. Keep data/credentials/keys outside Git and cloud sync.

Jobs use `local.helium-synk.PROFILE.{serve,backup,monitor}` unless customized. Login required; FileVault may need unlock after reboot. Test sleep, logout and power restoration on your hardware.

Backups: configurable 7 daily / 4 weekly / 3 monthly by default. Same-day retries verify, not replace; failed creation preserves prior snapshots. Logs: 5 MiB, three prior files. Monitor: hourly; warns below 2 GiB free, at 80% journal usage or after 30 hours without a valid backup. Status files are local; no external alerts. Check browser queues separately.

```sh
python3 "$HOME/Library/Application Support/Helium Synk/bin/macos-ops.py" --root "$HOME/Library/Application Support/Helium Synk" backup personal
python3 "$HOME/Library/Application Support/Helium Synk/bin/macos-ops.py" --root "$HOME/Library/Application Support/Helium Synk" monitor personal
```

Replace `personal` and the root with yours.

## Updates and publishing

Back up relay and clients first. Upgrade relay before extensions; stop its serve job before replacing binaries/helpers. Preserve config, credentials, accounts and agent identities. Release binaries include SQLite; local development binaries may depend on Homebrew SQLite.

Replace extension files in the same folder, then **Reload** each installation. Preserve ID/storage/enrollment. Never remove/reinstall or clear storage to update. Update all clients before session expiry; older clients pause on its payloads.

Unpacked and store installations have different extension identities/storage. Switching channels needs invitation/recovery enrollment; do not uninstall an enrolled profile with pending work. Existing unpacked installs keep manual updates.

## GitHub releases and Chrome Web Store

1. Merge reviewed [Changesets/version changes](../CONTRIBUTING.md#release-procedure). Successful **Checks** for a main push automatically starts **Build release**, pinned to that checked commit. Failed, cancelled, PR and foreign-repository checks cannot publish.
2. The workflow publishes `vX.Y.Z` using the extension's Changesets-managed package version, with matching server version required. Assets include the extension ZIP, macOS ARM64/x64 and Linux ARM64/x64 bundles, extension build metadata and checksums. Each bundle contains relay, identical extension ZIP, `build.json` and `SHA256SUMS`. Only generated artifacts are uploaded. Already published versions and older delayed builds are skipped; an existing draft or orphan tag requires resolution. Merge a reviewed version bump to create another release.
3. Chrome submission follows successful GitHub publication and verifies that release's source/version/ZIP hash before submitting the same ZIP. Google publishes it after approval. Linux binaries target glibc 2.35+; configure your service/backups separately. The macOS installer does not apply to Linux.
4. Upload the extension ZIP once through the Chrome dashboard to create its listing. Finish listing/privacy/screenshots, then save its extension ID. Choose the intended publisher.
5. Enable Chrome Web Store API in Google Cloud and link a service account to that publisher. Follow [Google's setup](https://developer.chrome.com/docs/webstore/service-accounts). Store credentials in GitHub, never source/chat.

Repository Actions variables: `CHROME_EXTENSION_ID`, `CHROME_PUBLISHER_ID`.
Actions secrets: `CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL`, `CHROME_SERVICE_ACCOUNT_PRIVATE_KEY` (complete PEM value from its private key).

The publishing helper accepts the complete RSA PEM, a JSON-quoted PEM, escaped newlines, or the service-account JSON's `private_key`. It validates and normalizes the key in memory without printing or saving it. Invalid keys fail with the GitHub secret name to correct. Publishing tools are checked out from the workflow revision separately from the verified tagged app, so store retries can use fixed tooling without replacing release assets.

For retries or diagnostics, run **Chrome Web Store** manually on main. `dry-run` authenticates only and may leave the tag empty to test credentials before a release. `upload-draft` and `submit-review` require an existing release tag, verify its source/version/ZIP hashes and submit that ZIP without rebuilding. `DEFAULT_PUBLISH` goes live after approval; `STAGED_PUBLISH` waits for Publish in the dashboard. Manual runs default to staging; the automatic release chain selects `submit-review` and `DEFAULT_PUBLISH`. Store failures fail the release workflow and leave the GitHub release/assets intact. Retry the store workflow with the same tag instead of rebuilding or replacing the release. Manual **Build release** on main reruns checks and follows the same publication chain.

Store copy, permission explanations and reviewer steps: [listing.md](../assets/store/listing.md). Publish [PRIVACY.md](../PRIVACY.md) before submitting its URL.

WXT uses API v2. Existing API v1 OAuth workflows need migration; [Google ends v1 support October 15, 2026](https://developer.chrome.com/docs/webstore/api/v1).

## Backup and recovery

Keep an encrypted off-host copy and current client recovery keys separately. Relay snapshots contain no content keys. Historical backups may retain deleted content.

Use a new private filename; never copy only a live WAL database's main file:

```sh
/absolute/path/synk-server --database /private/data/relay.sqlite backup --output /private/backups/relay-2026-10-02.sqlite
sqlite3 /private/backups/relay-2026-10-02.sqlite 'PRAGMA integrity_check;'
```

Require `ok`. For isolated restore review, stop the owning relay; use a separate private copy without old WAL/SHM files. Check integrity first:

```sh
sqlite3 /private/restore/relay.sqlite 'SELECT server_epoch FROM settings WHERE id=1;'
/absolute/path/synk-server --database /private/restore/relay.sqlite mark-restored --expected-epoch UUID-FROM-SNAPSHOT
/absolute/path/synk-server --database /private/restore/relay.sqlite serve --port 4399
```

Marking changes epoch, resets delivery progress and invalidates invitations. Clients stop and preserve state. Do not reconnect daily-use clients until missing operations, deletions, membership and key generations are reconciled. Automatic older-backup/server-loss reconstruction remains unfinished; never reset clients to bypass guards.
