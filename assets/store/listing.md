# Chrome Web Store draft

Use the fields below for the matching release. Save a draft; review source, graphics and declarations before submission.

## Listing

Name: **Helium Synk**. Category: **Tools**. Language: **English**.

Homepage: https://github.com/mikr13/helium-synk

Support: https://github.com/mikr13/helium-synk/issues

Privacy policy: https://github.com/mikr13/helium-synk/blob/main/PRIVACY.md — must be publicly available before submission.

### Description

Privately sync bookmarks, sessions and browsing history across your Helium installations using a relay you control.

- Merge bookmarks and folders across paired devices.
- Browse current sessions, closed windows and previous snapshots. Restore pages explicitly without closing the source session.
- Search received history by title, URL, source profile and date.
- Keep locally committed work available offline and reconcile when the relay returns.
- Enable only the collections you want. All collection starts off.

Content is encrypted before transmission. Run your own Rust relay behind private Tailscale HTTPS and pair installations through expiring invitation files. Separate contexts use separate accounts and keys.

Requires a compatible Helium browser and your own configured relay. Passwords, cookies, browser settings and installed extensions are excluded. Browser-profile secrets and decrypted local caches are not encrypted at rest by this extension. Backups and exported files are separate sensitive copies you control.

This community project is not an official Helium service. Setup instructions and source are available at the project homepage.

## Privacy tab

### Single purpose

Privately synchronize the user's selected bookmarks, sessions and browsing history between authorized browser installations through a self-hosted encrypted relay, with offline access and explicit session restoration.

### Permission justifications

| Field            | Text                                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| storage          | Store device enrollment, relay credentials, encryption keys, collection choices and sync progress locally so the extension can resume after browser or worker restarts.                                                                                                   |
| unlimitedStorage | Retain IndexedDB collection caches, durable offline queues and restore progress. Configurable limits pause new collection while preserving pending work. This supports offline sync without relying on the small default extension quota.                                 |
| alarms           | Schedule background sync retries and collection/retention maintenance when the Manifest V3 service worker wakes.                                                                                                                                                          |
| bookmarks        | Read and merge bookmark folders/links and apply received bookmark changes after the user previews and enables bookmark sync.                                                                                                                                              |
| tabs             | Read tab URLs, titles, order, pins and window membership for enabled session capture, and open/update tabs during user-requested restoration. No content scripts or webpage-body reading.                                                                                 |
| tabGroups        | Capture group names, colors, membership and collapsed state, and recreate groups during user-requested session restoration.                                                                                                                                               |
| sessions         | Read recently closed normal windows/tabs to include them in the user's saved sessions. Private windows are excluded.                                                                                                                                                      |
| history          | Capture new visit URLs, titles and original timestamps when history collection is enabled. Older-history import requires a separate user choice. Search shared visits inside Synk; received visits are not inserted into native history.                                  |
| Host permission  | Connect to the user's relay on localhost/127.0.0.1 for local setup, or a private HTTPS *.ts.net endpoint with optional permission requested during enrollment. HTTP access is loopback-only. These origins support authenticated sync and pairing, not webpage injection. |

Remote code: **No**. All JavaScript and UI resources are bundled; relay responses are data, never executable code.

Disclose **Authentication information**, **Web history** and **Website content**. Relay credentials/keys are authentication information. URLs, titles and visit times are browsing history; bookmark and session links/titles are website metadata. No webpage bodies are collected. Device labels are user-defined; disclose **Personally identifiable information** conservatively because users may enter names and persistent account/device identifiers are handled.

No dedicated health, financial, communications, location or click/keystroke tracking features. Do not claim the extension handles no data merely because storage/relay are user-controlled.

The three limited-use declarations match the current implementation: no sale, no unrelated use/transfer, and no creditworthiness/lending use. Review them as the publisher before submission.

## Test instructions

No paid account or developer-hosted login is required. The extension is a self-hosted client. Use disposable normal browser profiles with generic links; no production credentials are supplied.

1. Install the submitted build in two compatible browser profiles. Pin its icon and open the popup, then the full dashboard. With no enrollment it shows first-device/join choices; collections are off.
2. Download the matching relay for macOS ARM64/x64 or Linux ARM64/x64 from the project's release. Extract it and verify `SHA256SUMS`. The server is a separate native program; it is not downloaded or executed by the extension.
3. In an empty private directory, run the commands below. Use the extracted relay's absolute path. These create fresh review-only credentials and a loopback relay, with no Tailscale or cloud account needed.

```sh
umask 077
mkdir helium-synk-review
cd helium-synk-review
/absolute/path/synk-server --database relay.sqlite issue-device \
  --name 'Review Laptop' --server-url http://127.0.0.1:4318 \
  --output connection.json
/absolute/path/synk-server --database relay.sqlite serve --port 4318
```

4. In profile A choose **Set up my first device**, select `connection.json`, then **Connect this device**. Wait for **Connected**. Keep the server terminal running.
5. In A choose **Devices → Add device → Save invitation file**. In B choose **Connect another device**, select the invitation, name it **Review Desktop**, and connect within 15 minutes. Each invitation is single-use.
6. **Bookmarks:** preview the merge, save the offered bookmark backup, then enable in both. Create a generic bookmark in A and rename it in B. Check both native bookmark trees converge.
7. **Sessions:** enable capture, open several public pages and a tab group in A. In B open **Sessions**, inspect A's current snapshot and explicitly restore a tab/window. A stays intact. Close a normal window in A and inspect **Closed**. Internal/unsupported URLs are skipped during restoration.
8. **History:** enable **New visits only** in both; visit a public page in A. Search for it in B's Synk History and filter by source/date. Received visits do not appear in B's native History. Removing a selected review visit requires confirmation and removes synced copies while native history remains.
9. Stop the relay with Ctrl-C. Home shows offline; saved data remains available. Make a bookmark change, restart the same relay/database and choose **Sync now**. Pending work drains. Inspect **Settings** for capture, retention and storage controls.

Review-only connection/invitation files contain private credentials/keys. Do not publish them or reuse them for real browsing. No remote reviewer access to a personal tailnet or daily-use account is required.

## Graphics

Use the bundled 128 px icon. Capture the actual dashboard with synthetic **Laptop · Demo** and **Desktop · Demo** records: Home, Sessions/session detail and History. No personal profiles or browsing data.

Screenshots: 1280×800 JPEG, up to five. Small promo tile: 440×280. Optional marquee: 1400×560. Do not present demo screenshots as additional product capabilities.
