# Deployment

Browser steps: [setup-guide.md](setup-guide.md). Progress/limits: [plan.md](plan.md).

## Install on macOS

Use the [Helium Synk Server app](macos-server.md#setup) on macOS 13 or later. It bundles the relay and background supervisor; end users need the app, Tailscale and the browser extension.

1. Download the Apple silicon or Intel DMG once the native release is published, drag the app into Applications and open it.
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
2. The workflow publishes `vX.Y.Z` using the extension's Changesets-managed package version, with matching server version required. Assets include the extension ZIP, signed/notarized macOS ARM64/x64 app DMGs, macOS/Linux ARM64/x64 relay bundles, build metadata and checksums. Each bundle contains relay, identical extension ZIP, `build.json` and `SHA256SUMS`. Only generated artifacts are uploaded. Already published versions and older delayed builds are skipped; an existing draft or orphan tag requires resolution. Merge a reviewed version bump to create another release.
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

Marking changes epoch, resets delivery progress and invalidates invitations. Clients stop and preserve state. Do not reconnect daily-use clients until missing operations, deletions, membership and key generations are reconciled. Automatic older-backup/server-loss reconstruction remains unfinished; never reset clients to bypass guards.
