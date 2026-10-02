# Local storage limits

Each profile saves its limits in its local IndexedDB state. The options page shows estimated browser-origin bytes, queued operations/capture tasks and journal records. Limits survive worker/database reopening and appear in replica exports; changing them never deletes saved work.

| Limit                 | Default | Scope                                                                  |
| --------------------- | ------- | ---------------------------------------------------------------------- |
| Estimated local bytes | 512 MiB | Browser extension origin, when an estimate is available                |
| Pending work          | 100,000 | Outbox, drafts, purge requests and capture tasks                       |
| Journal records       | 500,000 | Diagnostic/operation journal, drafts and private erased-draft receipts |
| Capture tasks         | 30,000  | Bookmark events, history events/lookups/scans                          |

The byte and pending-work limits are editable in the dashboard. All four limits are validated by the core. Warnings appear at 80 percent. New content collection stops at capacity with a visible error, while saved retries, explicit deletion and authenticated erasure remain available. Existing history-specific 10,000-event/20,000-lookup caps also apply.

Admission counts run inside the same IndexedDB transaction as new journal drafts or event intent. Competing workers cannot both consume the last pending slot. New history visits, bookmark edits/imports, diagnostic notes and session snapshots use the shared check. An atomic batch can be refused before the displayed count reaches its limit if the whole batch would exceed it; saved discovery work remains available after increasing the limit or draining the queue. Wholly unencrypted current-session drafts can coalesce before admission; failed admission rolls back that replacement. Closed/saved snapshots are preserved. Session collection pauses before new native cache events while its budget is full; cached last-good windows remain for recovery.

New incoming content is checked transactionally against the journal/byte budget. A refused page does not move its cursor or enter quarantine. The verified server epoch can still be saved without processing records, permitting queued uploads to drain. Authentication, invalid records and epoch changes continue to stop the pass. Exact known records, deletion markers and certified erased targets can process at capacity. The next normal pull must commit before its processed ACK; raising a limit or freeing capacity resumes the same page.

Bytes use `navigator.storage.estimate()`, sampled at most once every five seconds, plus a conservative charge for incoming/new payloads. This API reports an estimate for the extension origin, including other origin storage. It is not exact per-table accounting, a disk-space reservation or a hard physical-space guarantee. If the estimate is missing/fails, count limits still apply. Native storage write failures still roll back affected transactions and surface errors. Physical writes can fail or usage can grow between samples.

Chromium documents origin-wide extension storage, this estimation API and the existing `unlimitedStorage` permission. That permission prevents normal quota/eviction restrictions; actual disk capacity remains finite. Native Helium behavior is a joint acceptance item. [Chrome storage guidance](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)

These limits provide admission control. Optional [history expiry](retention.md) removes eligible acknowledged visit content through permanent deletion and ciphertext purge; V1 retains causal deletion metadata and uncompacted journals. Session retention, full-scale performance, general quarantine/capture-copy policy and older-backup/server-loss recovery remain open. Increasing a limit does not create free disk space. Existing local data, browser-owned bookmarks/history and active restoration progress are not discarded to meet a lowered storage limit.

Eleven new unit/database tests cover limits/reopening/export, atomic/concurrent boundaries, retained drafts/counters, clear at capacity, current-session coalescing, unavailable estimates, byte warnings, download rollback, erasure while full and queue draining while a page is refused. A real relay integration uses a simulated full storage estimate, proves queued upload commits exactly once while the cursor stays behind the refused page, then raises the limit and receives the missing records. This does not simulate a physically full Helium disk.
