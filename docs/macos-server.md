# Native Mac server

Helium Synk Server is a companion app for Apple silicon Macs running macOS 13 or later. It bundles the Rust relay, patched static SQLite and a native background supervisor. End users need the app and Tailscale; they do not need Python, Homebrew, Rust or this repository. The browser extension remains a separate installation.

Signed, notarized installers are available on the [releases page](https://github.com/mikr13/helium-synk/releases/latest).

## Setup

1. Download the Apple silicon DMG. Drag **Helium Synk Server** into Applications and open it.
2. Connect Tailscale. The wizard detects its private hostname and chooses an unused local port and HTTPS endpoint. Existing Serve routes are checked before changes; public Funnel routes are not reused.
3. Name an independent account and its first browser device. The app creates private credentials, a database and a verified initial backup, then requests background operation.
4. If macOS requests approval, enable **Helium Synk Server** in **System Settings → General → Login Items**. The app exposes an Open Settings action when approval is pending.
5. Save the connection file. In the extension, choose **Set up my first device** and select it. Keep the file private and use it for one browser profile only. Additional installations join using **Devices → Add device** in the extension.

The app lives in the menu bar without a Dock icon. Choose **Open server overview** from its menu to reopen the window. The overview reports local readiness and private HTTPS reachability. It provides pause/resume, connection-file export, backup, data/log access and additional independent accounts. Accounts share the Mac but keep distinct databases and credentials. Closing the window leaves the menu-bar app available; quitting the app keeps an approved background server running. Availability requires the user to be logged in and the Mac to be awake.

## Existing installations

The app preserves data folders owned by another server installation and does not take over their jobs or mutate their accounts. Choose an empty folder for a separate installation. The app refuses occupied folders, duplicated account identifiers, overlapping endpoints and symlink redirects. Moving existing accounts into the app requires a reviewed handover with verified backups; it is not performed by first launch.

The selected data folder contains `deployment.json`, `native-installation.json`, `runtime.json`, account databases and private backups. The `com.heliumsynk.server.agent` background service reads the selected folder through the app's preferences domain. By default, data stays in `~/Library/Application Support/Helium Synk`; binaries stay inside the app bundle.

## Backups and updates

The helper runs each enabled account, restarts crashed relays, rotates private logs at 5 MiB with three prior files, and checks health hourly. Backups retain 7 daily / 4 weekly / 3 monthly snapshots by default. A missed schedule is caught up on the next run, and a new installation is backed up immediately. Backup creation and integrity checking use the same patched SQLite in the shipped relay. A failed backup does not prune older snapshots.

Choose **Check for Updates…** from the menu bar, or open **Update Settings…** to enable quiet automatic checks. Installation always requires your choice. Automatic download/install is disabled because Sparkle can install a staged update on app termination, bypassing a fresh server handover. The app uses Sparkle with an Ed25519-signed feed and signed downloads, verifies the download before extraction, and keeps Apple's Developer ID and notarization checks. The update settings also offer an optional **Open in the menu bar at login** toggle; the separate background server registration is retained.

Before installation, the running helper creates and verifies a fresh database snapshot for **every** account, including paused accounts, and saves configuration and credentials under `<data folder>/updates/<update ID>/`. These independent update snapshots are retained for manual recovery; they do not replace the regular backup rotation. Only after backup verification does it stop the relays and begin downloading the update. Sync stays paused through download and replacement; a slow download renews preparation before relaunch. The existing approved background registration starts the new helper at the same app path. Account ports, private HTTPS routes, paused preferences and browser enrollment stay intact. A cancelled or abandoned update resumes the old server; its preparation lease expires after ten minutes. Backup failure prevents replacement. The relaunched app checks local server readiness and preserved configuration; failures open Update Settings with a recovery message. It never restores over a live database automatically.

The first updater-enabled version must be installed manually for v0.3.0 users. Back up every account, disable its background server in the app, quit the app and replace it. Reopen it and re-enable the background server. Keep the data folder and browser enrollment intact. If an older helper is still running, an in-app update stops with an instruction to restart that helper once rather than replacing it unsafely. A disabled helper remains disabled during subsequent in-app updates. Data/schema compatibility must be checked before rolling back; never pair an older executable with an incompatible database.

To uninstall, disable the background service in the app first, then quit and remove the app. The data folder and backups remain. Remove private Tailscale routes separately after checking that no other service uses them. Deleting data is a separate deliberate operation.

## Build and verify

```sh
sh scripts/build-release-relay.sh
SYNK_TEST_RELAY="$PWD/target/release/synk-server" scripts/check-macos.sh
python3 scripts/build-macos-app.py --identity 'Developer ID Application: YOUR NAME (TEAMID)'
python3 scripts/smoke-native-bundle.py 'release/macos-arm64/Helium Synk Server.app'
```

The app uses Manrope and IBM Plex Mono, navy surfaces, blue panel accents, mint primary controls and square corners. Its menu-bar template draws the Helium six-spoke mark and sync arrows at the display's native scale. The sidebar and generated app-icon representations use the original 1254-pixel artwork, with explicit high-quality interpolation and antialiasing in the sidebar. `scripts/verify-macos-design.py` checks its 11 palette values against `extension/styles/theme.css`; fonts and their open-source licenses are bundled. SwiftUI previews can render every wizard screen without touching accounts, services, Tailscale or preferences:

```sh
target/swift/out/Products/Debug/synk-preview welcome /absolute/output.png macos/Resources
```

SwiftPM's output location varies by Xcode version; use `swift build --show-bin-path` with the package/scratch arguments from `scripts/check-macos.sh` to locate the executable.

## Signed release pipeline

The existing checked-source release matrix builds Apple silicon macOS and Linux ARM64/x64. The Mac job creates an ephemeral signing keychain, imports the release identity, validates the native flow, signs the relay before its checksums are calculated, then builds/signs the app and DMG. The app and DMG are notarized and stapled; signature, staple and Gatekeeper assessment failures prevent publication. CI restores its prior keychain search list and deletes temporary signing material even when a step fails.

The app bundle, agent, embedded relay and Sparkle's nested helpers use **Developer ID Application**, Hardened Runtime and secure timestamps. Sparkle XPC services retain their original entitlements. A separate Developer ID Installer certificate is not needed for this app/DMG distribution. Apple documents the [certificate types](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) and [notarization/stapling workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

Repository Actions secrets required for Mac releases:

| Secret                      | Value                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `APPLE_SIGNING_CERTIFICATE` | Base64 of a password-protected P12 containing the Developer ID Application certificate **and private key** |
| `APPLE_SIGNING_PASSWORD`    | That P12's export password                                                                                 |
| `APPLE_TEAM_ID`             | The signing certificate's team identifier                                                                  |
| `APPLE_NOTARY_KEY_ID`       | App Store Connect API key ID authorized for notarization                                                   |
| `APPLE_NOTARY_ISSUER_ID`    | The API key's issuer ID                                                                                    |
| `APPLE_NOTARY_PRIVATE_KEY`  | Complete API private-key P8 contents                                                                       |
| `SPARKLE_ED_PRIVATE_KEY`    | Helium-specific Sparkle Ed25519 private key, matching `macos/update-public-key.txt`                        |

Do not paste credentials into chat or commit them. A certificate in the local Keychain does not provision GitHub-hosted runners. Release jobs fail clearly if required credentials are missing; they never publish unsigned replacements. Linux and Chrome Web Store distribution retain their existing mechanisms.

For local notarization, provision a Keychain credential profile through Apple's `notarytool store-credentials` workflow, then build with `--notarize --notary-profile helium-synk`. The build reports signing and notarization independently. Local uncommitted candidates are recorded as such and must not be confused with a published release.

Sparkle is pinned in `macos/Package.resolved`. Local feed signing uses its `generate_appcast` tool and the dedicated Keychain account `com.heliumsynk.server.updates`; retain this key across releases and keep it separate from other apps. CI supplies the matching private key through `SPARKLE_ED_PRIVATE_KEY`, never a repository file. The checked-in public key is embedded in the app. Changing it requires a reviewed key-rotation transition, not generating a new key each release. See [Sparkle's documentation](https://sparkle-project.org/documentation/) for key backup and recovery.

After notarization and stapling, `scripts/macos-update.py` signs the **final DMG bytes** and generates `appcast.xml`. Publication independently verifies the payload signature, feed signature, version, source commit, clean source metadata, download URL and checksum. The workflow uploads the feed and all payloads to a draft GitHub release, then publishes it as latest. The app follows `releases/latest/download/appcast.xml`; release assets must not be replaced after publication. This updates only the native Mac app; browser store updates and Linux administration retain their existing mechanisms. Homebrew distribution is deferred until the native update flow has passed release acceptance; users do not need Homebrew.

## Bundled font provenance

The bundled TTF files come from Google's open-source font repository: [Manrope](https://github.com/google/fonts/tree/main/ofl/manrope) and [IBM Plex Mono](https://github.com/google/fonts/tree/main/ofl/ibmplexmono). Their licenses are copied from the extension's existing license files. SHA-256 of this checked-in input:

- Manrope: `3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6`
- IBM Plex Mono Regular: `6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46`
