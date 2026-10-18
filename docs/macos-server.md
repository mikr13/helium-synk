# Native Mac server

Helium Synk Server is a macOS 13+ companion app. It bundles the Rust relay, patched static SQLite and a native background supervisor. End users need the app and Tailscale; they do not need Python, Homebrew, Rust or this repository. The browser extension remains a separate installation.

The native app is implemented in this checkout. Its first public signed/notarized release is pending the [release checks](plan.md#native-macos-server-app).

## Setup

1. Download the DMG for Apple silicon or Intel once the native release is published. Drag **Helium Synk Server** into Applications and open it.
2. Connect Tailscale. The wizard detects its private hostname and chooses an unused local port and HTTPS endpoint. Existing Serve routes are checked before changes; public Funnel routes are not reused.
3. Name an independent account and its first browser device. The app creates private credentials, a database and a verified initial backup, then requests background operation.
4. If macOS requests approval, enable **Helium Synk Server** in **System Settings → General → Login Items**. The app exposes an Open Settings action when approval is pending.
5. Save the connection file. In the extension, choose **Set up my first device** and select it. Keep the file private and use it for one browser profile only. Additional installations join using **Devices → Add device** in the extension.

The overview reports local readiness and private HTTPS reachability. It provides pause/resume, connection-file export, backup, data/log access and additional independent accounts. Accounts share the Mac but keep distinct databases and credentials. Closing or quitting the app keeps an approved background server running. Availability requires the user to be logged in and the Mac to be awake.

## Existing installations

The app preserves data folders owned by another server installation and does not take over their jobs or mutate their accounts. Choose an empty folder for a separate installation. The app refuses occupied folders, duplicated account identifiers, overlapping endpoints and symlink redirects. Moving existing accounts into the app requires a reviewed handover with verified backups; it is not performed by first launch.

The selected data folder contains `deployment.json`, `native-installation.json`, `runtime.json`, account databases and private backups. The `com.heliumsynk.server.agent` background service reads the selected folder through the app's preferences domain. By default, data stays in `~/Library/Application Support/Helium Synk`; binaries stay inside the app bundle.

## Backups and updates

The helper runs each enabled account, restarts crashed relays, rotates private logs at 5 MiB with three prior files, and checks health hourly. Backups retain 7 daily / 4 weekly / 3 monthly snapshots by default. A missed schedule is caught up on the next run, and a new installation is backed up immediately. Backup creation and integrity checking use the same patched SQLite in the shipped relay. A failed backup does not prune older snapshots.

Before replacing the app, back up every account, pause the accounts and quit the app. Replace the application, reopen it and resume the accounts. Keep the data folder and browser enrollment intact. Data/schema compatibility must be checked before rolling back to an older app; never pair an older executable with an incompatible database. Automatic download/install updates are not included.

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

The existing checked-source release matrix builds macOS ARM64/Intel and Linux ARM64/x64. Mac jobs create an ephemeral signing keychain, import the release identity, validate the native flow, sign the relay before its checksums are calculated, then build/sign the app and DMG. The app and DMG are notarized and stapled; signature, staple and Gatekeeper assessment failures prevent publication. CI restores its prior keychain search list and deletes temporary signing material even when a step fails.

The app bundle, agent and embedded relay use **Developer ID Application**, Hardened Runtime and secure timestamps. A separate Developer ID Installer certificate is not needed for this app/DMG distribution. Apple documents the [certificate types](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/) and [notarization/stapling workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow).

Repository Actions secrets required for Mac releases:

| Secret                      | Value                                                                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `APPLE_SIGNING_CERTIFICATE` | Base64 of a password-protected P12 containing the Developer ID Application certificate **and private key** |
| `APPLE_SIGNING_PASSWORD`    | That P12's export password                                                                                 |
| `APPLE_TEAM_ID`             | The signing certificate's team identifier                                                                  |
| `APPLE_NOTARY_KEY_ID`       | App Store Connect API key ID authorized for notarization                                                   |
| `APPLE_NOTARY_ISSUER_ID`    | The API key's issuer ID                                                                                    |
| `APPLE_NOTARY_PRIVATE_KEY`  | Complete API private-key P8 contents                                                                       |

Do not paste credentials into chat or commit them. A certificate in the local Keychain does not provision GitHub-hosted runners. Release jobs fail clearly if required credentials are missing; they never publish unsigned replacements. Linux and Chrome Web Store distribution retain their existing mechanisms.

For local notarization, provision a Keychain credential profile through Apple's `notarytool store-credentials` workflow, then build with `--notarize --notary-profile helium-synk`. The build reports signing and notarization independently. Local uncommitted candidates are recorded as such and must not be confused with a published release.

## Bundled font provenance

The bundled TTF files come from Google's open-source font repository: [Manrope](https://github.com/google/fonts/tree/main/ofl/manrope) and [IBM Plex Mono](https://github.com/google/fonts/tree/main/ofl/ibmplexmono). Their licenses are copied from the extension's existing license files. SHA-256 of this checked-in input:

- Manrope: `3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6`
- IBM Plex Mono Regular: `6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46`
