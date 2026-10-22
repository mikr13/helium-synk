# Deployment

Browser steps: [setup-guide.md](setup-guide.md). Progress/limits: [plan.md](plan.md).

## Install on macOS

Use the [Helium Synk Server app](macos-server.md#setup) on an Apple silicon Mac running macOS 13 or later. It bundles the relay and background supervisor; end users need the app, Tailscale and the browser extension.

1. Download the Apple silicon DMG once the native release is published, drag the app into Applications and open it.
2. Connect Tailscale and follow the account setup. The app checks existing routes, selects an unused local port and private HTTPS endpoint, and creates a verified initial backup.
3. Enable background operation if macOS requests approval. Save the connection file and [connect the first browser device](setup-guide.md#3-connect-the-first-device-of-a-new-account).

The overview provides **Add independent account**, pause/resume, connection-file export, **Back up now**, logs and health status. Use extension invitations for additional installations of an existing account.

Data stays in the selected private folder, by default `~/Library/Application Support/Helium Synk`; executables stay inside the app bundle. The app preserves folders owned by another server installation. Account data and browser enrollment must not be replaced to complete setup.

## Private Tailscale endpoints

The wizard configures private Serve HTTPS routes without resetting existing services or using public Funnel endpoints. Tailnet access rules and application credentials both apply. See [the native setup](macos-server.md#setup) for the flow.

The overview checks local readiness and the existing private HTTPS endpoint. Verify intended client access and cross-device sync before relying on a new account. Availability requires login and an awake Mac; check sleep and power behavior on your hardware.

## Updates and publishing

Follow the [native app backup and update procedure](macos-server.md#backups-and-updates). Preserve the selected data folder, account credentials and browser enrollment. Upgrade the relay before browser extensions when a release requires it.

For an unpacked extension, replace files in the same folder, then **Reload** each installation. Preserve ID/storage/enrollment. Never remove/reinstall or clear storage to update. Update all clients before enabling session expiry; older clients pause on its payloads.

Unpacked and store installations have different extension identities/storage. Switching channels needs invitation/recovery enrollment; do not uninstall an enrolled profile with pending work. Existing unpacked installs keep manual updates.

## GitHub releases and Chrome Web Store

1. Merge reviewed [Changesets/version changes](../CONTRIBUTING.md#release-procedure). Successful **Checks** for a main push automatically starts **Build release**, pinned to that checked commit. Failed, cancelled, PR and foreign-repository checks cannot publish.
2. The workflow publishes `vX.Y.Z` using the extension's Changesets-managed package version, with matching server version required. Assets include the extension ZIP, the signed/notarized Apple silicon app DMG, macOS ARM64 and Linux ARM64/x64 relay bundles, build metadata and checksums. Each bundle contains relay, identical extension ZIP, `build.json` and `SHA256SUMS`. Only generated artifacts are uploaded. Already published versions and older delayed builds are skipped; an existing draft or orphan tag requires resolution. Merge a reviewed version bump to create another release.
3. Chrome submission follows successful GitHub publication and verifies that release's source/version/ZIP hash before submitting the same ZIP. Google publishes it after approval. Linux binaries target glibc 2.35+; configure your service/backups separately. The native Mac app does not apply to Linux.
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
/absolute/path/synk-server verify-backup --path /private/backups/relay-2026-10-02.sqlite
```

Require a successful integrity check. For isolated restore review, stop the owning relay; use a separate private copy without old WAL/SHM files. Check integrity first:

```sh
sqlite3 /private/restore/relay.sqlite 'SELECT server_epoch FROM settings WHERE id=1;'
/absolute/path/synk-server --database /private/restore/relay.sqlite mark-restored --expected-epoch UUID-FROM-SNAPSHOT
/absolute/path/synk-server --database /private/restore/relay.sqlite serve --port 4399
```

Marking changes epoch, resets delivery progress and invalidates invitations. Clients stop and preserve state. Do not reconnect daily-use clients until missing operations, deletions, membership and key generations are reconciled. For missing acknowledged data or server disk loss, use the client replay rebuild below. It deliberately creates a new database instead of replaying over a potentially stale membership/key registry. Never reset clients to bypass guards.

## Storage compaction

Before upgrading, save a verified relay snapshot and preserve the existing browser profiles/recovery keys. Upgrade the relay before all clients. Older binaries must not open a migrated database; review rollback using an isolated pre-migration snapshot, never by restoring over a running account. Session retention compacts expired live ciphertext automatically. **Settings → Local storage → Compact old bookmark versions** explicitly compacts superseded synced edits/moves/reorders in bounded batches; save a local data backup first. Current values, concurrent alternatives, births, deletions, pending work and immutable retry receipts remain. Repeat the action for more than 2,000 candidates. Once used, incompatible clients stop with an upgrade-required response.

SQLite reuses freed pages. To return free pages to the filesystem, stop the owning relay/helper and use a new private backup filename:

```sh
/absolute/path/synk-server --database /private/data/relay.sqlite compact --backup /private/backups/before-compaction.sqlite
```

The process lease rejects a serving database. Backup creation and integrity verification precede VACUUM; an existing backup filename is rejected. Integrity is checked again afterward. Keep the backup for rollback. Space for both the backup and SQLite’s rebuild is required. Neither this command nor content expiry securely erases filesystem snapshots or historical backups.

## Rebuild from a surviving client

Use this for server disk loss or an older backup missing acknowledged work. Keep the original server stopped, preserve every surviving browser profile and save current private recovery/local-data exports before recovery. Use the surviving profile with the most current complete key ring as the authority; finish/review any pending key rotation first. A stale profile cannot manufacture a content key it never received.

1. On other surviving profiles, open **Settings → Recovery & backups → Rebuild a lost server → Save relay rebuild file**. Keep these private; each contains that installation’s connection credential and encrypted replay.
2. On the authority profile, select those files in the optional peer-files field, then save its combined rebuild file. Client-side authentication and operation/counter validation run before the proposal is saved. Resolve quarantined data first. Unchanged exports retry the same proposal; export again after new acknowledged data to refresh it. Keep this exact authority profile intact: its new future-content key is stored locally, never in the server file.
3. Transfer the authority file privately to the server. Build into a **new** path with the expected original account UUID from the file:

   ```sh
   /absolute/path/synk-server --database /private/recovery/rebuilt.sqlite rebuild --input /private/transfer/helium-synk-relay-rebuild.json --expected-account ORIGINAL-ACCOUNT-UUID
   /absolute/path/synk-server verify-backup --path /private/recovery/rebuilt.sqlite
   ```

   Reconstruction uses a staging database, validates the manifest and certified receipt references, preserves author counters/operation identities and verifies integrity before publication. It refuses any existing destination. The only active credential is the authority’s existing credential; historical authors are retained as revoked provenance. Previously revoked access is never restored. The replay includes source-owned pending work and supplied peer operations; data absent from all supplied copies is not recovered. The CLI bounds input to 2 GiB and 1,000,000 entries, preserves the 256-author maximum, and raises default account budgets only as needed to admit the validated replay.

4. Start only the rebuilt database behind the authority profile’s existing private endpoint. Preserve the old database and service configuration for rollback. On the native Mac installation, stop the owning helper before an operator-reviewed path/configuration cutover; do not overwrite a running account database or reset Tailscale routes. The CLI verifies a stopped/new database; automated GUI cutover and physical installation acceptance are separate.
5. On the authority profile choose **Connect to rebuilt server**. The authenticated receipt must match the saved recovery ID, account, manifest, future epoch and source. Adoption atomically resets delivery progress, retains author counters/native mappings/pending work and installs the new root. Old-epoch synchronization stays blocked until this action. If newer acknowledged data appeared after the file was saved, re-export and rebuild into another new path; do not bypass the check.
6. Wait for **Connected** and an empty pending queue. Check bookmarks, sessions and history, save a fresh private recovery file and a verified relay snapshot, then issue new invitations for other profiles. Use fresh enrolled profiles/installation credentials; retain old profiles/exports until their recovered work has been checked. Old credentials are rejected and future content uses a fresh independent key. Original browser data and old downloaded copies are not remotely erased.
7. Remove private transfer copies once recovery and independent backups are verified. Never restart the old relay concurrently with the rebuilt one. Before adoption, rollback is simply returning to the untouched original server. After adoption, preserve both states and reconcile explicitly; pointing the adopted client at an old epoch fails closed rather than rolling back keys/counters.

This is explicit reconstruction from available client data, not unattended failover. A recovery-key file plus an incomplete old server backup cannot recreate records that exist in no surviving data copy.
