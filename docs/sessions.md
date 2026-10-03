# Session capture, sync and restoration

Sessions are owned by their source installation. Receiving or restoring a snapshot does not close or edit source windows. The WXT adapter is implemented; real Helium API/lifecycle acceptance is pending the joint disposable-profile test.

## Snapshot and transport contract

- A snapshot contains a source name/UUID, source revision, capture time, current/closed/previous kind, ordered windows/tabs, titles/URLs, pins, active selection and group metadata. Runtime browser IDs stay local; replicated identities are UUIDs.
- The source revision is the first reserved author counter. Each fragment occupies the next contiguous counter. Authenticated envelope author/counter values must agree with the encrypted fragment metadata.
- JSON is split into at most 256 fragments of 45,000 bytes. Each encrypted envelope stays below the relay's 64 KiB ciphertext limit; existing byte/count batch bounds still apply. Limits are 100 windows, 10,000 tabs total and 500 groups per window. A rejected capture leaves the previous snapshot intact and surfaces an error.
- Only a fully assembled and validated snapshot replaces that source's current snapshot. Higher source revision wins; capture/receipt clocks do not decide freshness ordering. Incomplete assemblies remain durable across cursor pages and restarts.
- Snapshot fragments, logical projection and reserved counters commit together in IndexedDB v4. Encryption moves drafts into immutable operations/outbox entries transactionally. Only wholly unencrypted current drafts may coalesce; closed/saved snapshots and snapshots with any encrypted fragment remain retained.
- Incoming records, projection and cursor commit together. Invalid complete assemblies and cross-domain author-counter reuse quarantine the failed page without advancing its cursor.
- Encrypted historical current snapshots remain available as previous history until their source expires them. Explicitly saving the current snapshot creates a separate previous record with its original capture time and `previous_of` link. The opt-in [retention backend](retention.md) defaults to 30 days, 100 combined archives and 50 MiB content per source; pending/current/active restoration work stays protected. Settings controls, ciphertext/capture-copy cleanup and native acceptance remain open; no native profile has enabled it.

## Browser capture

Collection is opt-in. The extension requests `tabs`, `tabGroups` and `sessions`, with incognito disabled. It does not request browsing-site host access or inject content scripts. Collection targets regular, non-private windows. Its own temporary restoration markers are excluded.

Tab/window/group listeners register synchronously. Event-provided tab details update the durable window cache before the two-second publication debounce, capped at five seconds during continuous activity. Window-closing tab-removal events do not erase that cache. Window removal archives the cached last valid contents atomically with its outgoing snapshot intent. A missed removal is recovered from cache during reconciliation. Temporary group/pin transition states preserve the previous valid cache until a full native scan settles.

Alarms, startup, network reconciliation, explicit sync and enabled event handling run full scans. A browser-incarnation marker lives in `storage.session` solely to distinguish ephemeral native-ID lifetimes; essential snapshots, queues and maps live in IndexedDB. Worker revival keeps the marker; browser/extension restart resets it. A changed incarnation saves the last good current snapshot as previous, discards stale runtime maps and allocates fresh IDs. Startup emptiness does not replace the last good snapshot while native windows are still unavailable.

The recently-closed API supplements missed closed windows, at most 25 records per scan. Opaque local session IDs and close time deduplicate repeated scans. Matching cache/API records consume matches one-to-one, so identical separately closed windows remain separate. Cache records retain their richer group metadata. API-only records show `groups_unavailable` because live group lookup cannot recover their group metadata.

Pausing preserves existing snapshots and stops event capture. Re-enabling drops the stale live cache and baselines the current recently-closed list, so closures during the pause are not retroactively imported. It then captures the currently open windows.

Abrupt termination before an event is durably captured can lose transient details; neither the cache nor recently-closed API is a complete archive. Collection/storage failures are visible and preserve the last good data. Snapshot age is displayed separately from this installation's relay connection state; it is not a peer heartbeat.

## Restoration journal

The session list links to a focused `/sessions/$snapshotId` page with open-tab, open-window and open-all controls. Its progress belongs to the selected snapshot and appears above the tab list. Type/source filters survive Back and reload. Only HTTP/HTTPS URLs without embedded credentials restore automatically. Internal/file/data/javascript/unsupported URLs remain in the source snapshot and are skipped with an explanation/count. Destination windows use browser-default geometry and state rather than source monitor coordinates.

Each request has an immutable UUID and a saved job. Repeating the same request ID/selection returns that job. Opening a single tab uses a regular local window when available; window/all actions create destination windows. Work is serial and bounded to 40 steps per pass, with a 100-step hard ceiling. Jobs resume through the next pass or an alarm after worker interruption.

Window/tab creation saves intent before calling the API. Unique packaged marker URLs identify created objects after a lost result; returned native IDs persist before navigating to the real page. A repeated pass finds the exact marker instead of blindly creating another window/tab. Missing/multiple markers pause for review. An interrupted navigation recognizes the expected target URL/pin state; a changed page or moved/closed tab pauses and preserves user activity.

After tab creation the adapter restores pins, relative ordering, groups/metadata and active selection, then removes only its exact placeholder tab. Group creation can recover from existing membership after a lost reply. Changed group membership pauses rather than regrouping user edits. One destination is focused at completion. Cancelling leaves all opened tabs intact.

Browser restart invalidates saved runtime IDs. A partially completed job then pauses instead of reusing potentially unrelated IDs. Review existing windows, cancel to preserve them and make a new explicit request if needed. Ambiguous interruption across a redirect/user navigation also requires review. Progress shows pages opened, windows ready, skipped URLs and the current failure; it does not promise a web page has finished loading.

## Verification at this checkpoint

- 7 snapshot/fragment model tests: partial assembly, revision ordering, identities, structure and URL schemes.
- 7 durable-sync tests: offline reopen, retries, coalescing, multipart cursor pages, quarantine, cross-domain counters and v3 migration/export preservation.
- 10 native-capture port tests: closures, restart/incarnation boundaries, missed removals, duplicate windows, pause/private exclusion and storage rollback.
- 8 restoration port tests: tabs/windows/groups/pins/order, interrupted API results, changed pages/markers, cancellation and per-pass bounds.
- A real Rust-process test stops the relay, persists multipart current/closed records, reopens IndexedDB, restarts the relay and verifies two-source convergence, empty queues and encrypted SQLite envelopes.
- Actual dashboard components were exercised with synthetic replies, including opt-in controls, unsupported URL display and partial/recovered progress, at desktop and 390 px width with no horizontal overflow or console errors.

Live Helium events, supported pin/group behavior, DevTools-closed lifecycle, measured latency and hours-long outage/restoration tests remain pending. This checkpoint does not close the M4 exit gate.
