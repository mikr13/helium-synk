# Deployment and publishing runbook

Deployment is in progress on Mihir’s Mini. Version 0.2.0 is installed and pinned in ABI and Syngenta, with separate persistent enrollments, two local relay services and scheduled local backups/monitoring. Private HTTPS activation, collection opt-in/backups, sleep configuration, off-Mini backups and coordinated restart tests remain pending. Track progress only in [plan.md](plan.md).

## Installed profile separation

The permanent private root is `~/Library/Application Support/Helium Synk`, mode 0700. ABI and Syngenta are independent work domains: different relay databases/account IDs, credentials, content keys and recovery directories. Never import one domain’s connection/invitation/recovery file into the other profile.

| Profile  | Database                         | Local port | Proposed private HTTPS endpoint                  |
| -------- | -------------------------------- | ---------- | ------------------------------------------------ |
| ABI      | `accounts/abi/relay.sqlite`      | 4318       | `https://mihirs-mac-mini.tailcc574a.ts.net`      |
| Syngenta | `accounts/syngenta/relay.sqlite` | 4319       | `https://mihirs-mac-mini.tailcc574a.ts.net:8443` |

Both profiles load the same verified build from `extension/`, ID `pikiooiaammpflcchkojkjghgofhphjf`, with independent browser storage and enrollment. Existing bookmarks require an export/preview before collection; new history visits only, with no historical import or automatic expiry. Install/permission approval was received and both enrollments completed. Mihir approved HTTPS access for all devices in his private tailnet, protected by separate application credentials. Serve is awaiting administrator sign-in/enablement; public Funnel remains excluded.

`scripts/install-macos.py` installs a **fresh** release only, verifies the binary and extension ZIP hashes, refuses an existing installation, and creates six per-user LaunchAgents. It is not an upgrade tool. The helper uses the stable Homebrew Python path. Services start after user login, not before FileVault unlock. Do not imply unattended recovery after power loss.

Each profile has `net.imput.helium-synk.PROFILE.serve`, `.backup` and `.monitor` agents in `~/Library/LaunchAgents`. Relay workers forward SIGTERM gracefully; launchd keeps them running with a ten-second restart throttle. Server logs rotate at 5 MiB, retaining three prior files per profile, with 64 KiB maximum read chunks. Launchd stdout/stderr are discarded; the server log and private status files provide operational evidence.

Backups run at 03:10 (ABI) and 03:20 (Syngenta) local time. Monitoring runs hourly, writing `accounts/PROFILE/health-status.json`: readiness, free disk, DB/WAL size, encrypted-journal usage, unprocessed deliveries and backup age/failure. Warnings include less than 2 GiB free, 80% journal budget and missing/failed/older-than-30-hour backups. Relay delivery lag does not expose a browser’s unsent local queue: check its popup/Home status too. These local status files and job exit codes are the current failure reporting; external alerts remain unconfigured.

To run the installed tasks manually:

```sh
python3 "$HOME/Library/Application Support/Helium Synk/bin/macos-ops.py" --root "$HOME/Library/Application Support/Helium Synk" backup abi
python3 "$HOME/Library/Application Support/Helium Synk/bin/macos-ops.py" --root "$HOME/Library/Application Support/Helium Synk" monitor abi
```

Use `syngenta` for the other domain. Consistent snapshots retain 7 daily, 4 weekly and 3 monthly files. Weekly/monthly snapshots are created on the first successful run in that calendar period, so a missed first day does not skip the period. Same-day retries verify the existing snapshot; they do not claim it contains newer writes. Backup age uses the snapshot modification time, not the latest verification time. Failed creation never rotates prior snapshots and records `ok: false` in `backup-status.json`. Off-Mini encryption/copy and client recovery exports remain separate pending work.

## Chosen V1 distribution

Start with a GitHub release in the existing repository containing the unpacked Chrome MV3 extension ZIP and the Mac Mini Rust binary. Packages remain private; nothing is published to npm. Manual extension updates use one permanent installation directory and the existing browser extension ID. A browser-store listing or signed automatic updater is later work. Keep native History unchanged.

Build/check the release candidate with `pnpm exec vp run release:prepare`. Artifacts go to ignored `release/`; SHA-256 sums and build metadata accompany them. The artifact version remains the reviewed package version until the explicit Changesets release procedure in [CONTRIBUTING.md](../CONTRIBUTING.md) runs. A candidate built from a dirty worktree is not a published tagged release.

For unpacked installs, extract into a permanent private directory such as `~/Library/Application Support/Helium Synk/extension`. In `chrome://extensions`, enable developer mode and Load unpacked once. Record its ID. Before updates export the local replica and a current private recovery bundle; retain the previous artifact. Replace files in that exact directory and use Reload on that exact extension. Confirm the ID, profile name, opt-in collection settings, saved collections and queued work survive. Do not remove/re-add the extension or clear browser storage. Update every connected profile before enabling session retention. A rollback to a pre-expiry client cannot consume schema-2 expiry payloads and will pause until upgraded.

## Mac Mini installation

Use an absolute persistent data directory outside the checkout and cloud sync, for example `~/Library/Application Support/Helium Synk`, mode 0700, with private credential/database/backup files. Install the release binary in a stable explicit path. The build uses patched Homebrew SQLite on macOS; inspect `otool -L` and verify the deployed binary against that library before and after Homebrew upgrades. Preserve FileVault.

Serve using an absolute `--database` path and the default localhost-only port 4318. `/health/live` proves process response; `/health/ready` includes schema/protocol/SQLite/package versions. Never bind the relay publicly. Upgrade the relay before the clients, take a consistent backup first and preserve a matching old binary/database pair for rollback; never downgrade a migrated database into an incompatible binary.

The installed per-user LaunchAgents use absolute paths, KeepAlive, restart throttling and Umask 077. Login is required. Tailscale is the installed macOS GUI application with its CLI wrapper. Measure logout, reboot, cold start and power restoration instead of assuming pre-login availability. Current readbacks: FileVault on, automatic power restart enabled, system sleep one minute and display sleep ten minutes. Setting system sleep to Never requires the pending explicit approval; do not disable FileVault.

## Tailnet endpoint

Inspect existing Tailscale configuration before changing it. [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) terminates private tailnet HTTPS and proxies localhost:

```sh
tailscale serve --bg --https=443 http://127.0.0.1:4318
tailscale serve --bg --https=8443 http://127.0.0.1:4319
tailscale serve status
```

Mihir approved all devices in his private tailnet as the intended clients. The first command has reached Tailscale’s administrator enablement gate; complete sign-in/Serve activation, then finish both routes and inspect their effective access. The last CLI inventory contained only this Mini, no peers and no health warnings. Use the actual stable `.ts.net` origins and keep application bearer credentials as an independent check. Both browser installations imported their own issued HTTPS connection file and granted the required private host permission. Verify HTTPS pull/push and authenticated WSS before claiming connected acceptance. Public Funnel is excluded.

## Operational defaults

Use daily consistent SQLite snapshots, keeping 7 daily, 4 weekly and 3 monthly backups. Keep one encrypted off-Mini copy; confirm its destination during deployment. Store current private content-key recovery separately. Backup deletion is delayed by these retention windows; purged live data can remain in old backups. Do not promise immediate erasure of historical backups or filesystem snapshots.

Monitor readiness, available disk, SQLite/WAL growth, relay envelope usage, pending queue/last-sync age and backup success. Rotate logs with a concrete bounded policy and test backup failure reporting. Reconnect both clients after a relay/Tailscale restart and confirm queue drain before daily use.

## Backup and recovery

The relay can create a consistent private SQLite snapshot while serving. Restore marking changes the server epoch before a stopped database is served again. Surviving clients retain their replicas, queues and keys when an older or missing server rejects synchronization. Recovering missing acknowledged operations and resuming those clients remains unfinished; these commands do not reconstruct a lost relay.

### Create a snapshot

Use the same compatible relay version as the running service. Choose a private destination directory outside the checkout and synchronized folders. The destination must be a new filename; the command never replaces an existing backup.

```sh
/absolute/path/synk-server --database /private/data/relay.sqlite backup --output /private/backups/relay-2026-10-02.sqlite
sqlite3 /private/backups/relay-2026-10-02.sqlite 'PRAGMA integrity_check;'
```

Accept the artifact only when the command succeeds and the integrity result is `ok`. `VACUUM INTO` includes committed WAL content in an independent snapshot; the relay syncs the resulting file and parent directory before reporting success. Ordinary errors remove only the newly created output. Process interruption can leave an incomplete artifact, so check integrity before using it. Never copy just the main database file of a running WAL database. See [SQLite VACUUM INTO](https://sqlite.org/lang_vacuum.html#vacuuminto).

On Unix, the output is created with mode 0600. It contains encrypted records, credential hashes and operational metadata, including historical records that might since have been removed. It does not contain client content keys. Protect backup storage and separate private client recovery bundles. Local scheduling, rotation and status reporting are installed; encrypted off-host storage and private client recovery exports remain pending.

### Review an isolated restore

1. Preserve surviving client replicas and their current private recovery bundles. Keep pending work and deletion proofs intact.
2. Stop the relay that owns the target database. Restore into a separate private directory with a fresh filename and no leftover WAL/SHM files. Verify integrity before opening it.
3. Inspect the snapshot's recorded epoch, then mark that isolated database using the exact expected UUID:

   ```sh
   sqlite3 /private/restore/relay.sqlite 'SELECT server_epoch FROM settings WHERE id=1;'
   /absolute/path/synk-server --database /private/restore/relay.sqlite mark-restored --expected-epoch UUID-FROM-SNAPSHOT
   /absolute/path/synk-server --database /private/restore/relay.sqlite serve --port 4399
   ```

4. Use a separate loopback port for review. Do not reconnect daily-use profiles or replace the live service until missing operations, deletion proofs, membership and key generations have been reconciled through a verified recovery workflow.

Restore marking atomically generates a new epoch, resets sent/processed delivery progress and invalidates pending pairing invitations. It preserves account identity, credential hashes, operations, sequences, author counters and stored key-rotation records. A mismatched expected epoch or failed transaction leaves recovery state unchanged. Restart serving after marking so the process reads the new epoch.

The Unix CLI holds a process lease while serving or marking a database; competing current-version processes using its canonical path are refused. Older binaries do not honor this lease. Stop them explicitly before marking their database. The lease is an operational guard, not a replacement for private filesystem permissions or exclusive control of database copies/aliases.

### Surviving clients

A changed epoch stops ordinary synchronization. An older snapshot can reject a newer key generation or cursor with HTTP 409 before returning an epoch page. A newly created relay after disk loss has another account and rejects old credentials. Those failures retain local content, pending drafts/envelopes, counters, keys and deletion proofs; they do not reset the client or authorize replay into an unrelated account.

The isolated real-process tests cover live WAL snapshots, integrity, private/no-overwrite output, stopped-database marking, an older backup followed by history erasure and key rotation, and server disk loss. Exact surviving exports and keys remain unchanged after rejected synchronization. Missing acknowledged journal replay, safe restore reconciliation/resume, physical power-loss/disk-full backup tests and native-browser recovery remain open gates.
