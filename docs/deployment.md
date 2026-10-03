# Deployment

Browser steps: [setup-guide.md](setup-guide.md). Progress/limits: [plan.md](plan.md).

## Install on macOS

Server needs Python 3.9+, [Tailscale](https://tailscale.com/docs/install/mac) and a release matching its architecture. Building also needs the [development tools](../README.md#development) and patched Homebrew SQLite.

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

Back up relay and clients first. Upgrade relay before extensions; stop its serve job before replacing binaries/helpers. Preserve config, credentials, accounts and agent identities. Check SQLite linkage with `otool -L` and `brew --prefix sqlite`, including after Homebrew upgrades.

Replace extension files in the same folder, then **Reload** each installation. Preserve ID/storage/enrollment. Never remove/reinstall or clear storage to update. Update all clients before session expiry; older clients pause on its payloads.

Follow [Changesets](../CONTRIBUTING.md), then publish reviewed tagged artifacts only: extension ZIP, matching native binary, `SHA256SUMS`, `build.json`. No credentials/runtime data. No automatic/store updater.

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
