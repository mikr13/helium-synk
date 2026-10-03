# Privacy

Updated October 3, 2026. Applies to the Helium Synk extension in this repository.

## Purpose and data

Helium Synk syncs selected browser collections between devices through a relay you control. Collections start off. Enabling a collection permits processing its bookmarks/folders, tab/window/group/session metadata, or browsing-history URLs, titles and visit times. Older-history import is optional.

The extension also stores device names/identifiers, connection settings, relay credentials, encryption keys, sync progress and offline queues. It does not sync passwords, cookies or complete browser profiles. It does not read webpage bodies, track clicks/keystrokes, or include advertising or analytics services.

## Storage and sharing

Selected content is encrypted before transmission to your configured relay. Authorized paired devices decrypt it. The relay sees encrypted records, device/account identifiers, sizes, timing and sync metadata; it stores credential hashes. Plain content keys are client-side or in private invitation/recovery exports.

Developers do not operate a default relay or receive your browsing data through this extension. A relay operator you choose may have its own privacy policy. Browser and network providers apply their own policies.

Browser-profile secrets and decrypted local caches are **not encrypted at rest by the extension**. Exports and backups are separate sensitive copies under your control.

## Controls and retention

Enable/pause collections, exclude history URLs, remove synced history, and manage retention in Settings. Native browser history is independent. Session expiry removes visible archives but can leave encrypted copies. Historical backups/exports may retain deleted content. Removing a device prevents future access and rotates future content keys; previously received data cannot be remotely erased.

Profile removal/uninstallation destroys its extension storage, including pending work. Automatic reconstruction after relay loss is not guaranteed. Keep current recovery keys and reviewed backups separately.

## Limited use and contact

Data is used for private sync, restoration and user-requested exports. The extension does not sell data, use it for advertising, or use it for creditworthiness/lending decisions. Transfers are limited to the configured relay, authorized paired devices and exports you request. Project developers have no routine access to your browsing content; do not send it in support reports unless you explicitly choose to share specific information.

Report privacy issues through the [project's issue tracker](https://github.com/mikr13/helium-synk/issues); do not post credentials, keys or private browsing data. Policy changes are recorded in this repository.
