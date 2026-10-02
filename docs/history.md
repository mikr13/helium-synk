# History capture, timeline and clear policy

The development build implements opt-in native capture, encrypted history transport, indexed local search, logical removal, suppressed-journal plaintext cleanup and cleanup of obsolete saved capture jobs. It is tested through simulated browser ports and a real Rust relay. Complete plaintext/ciphertext erasure and live Helium acceptance remain open gates; removal is not yet a complete privacy feature.

## Individual visits and encryption

A visit retains its original native timestamp, source installation/name, profile incarnation, opaque native visit ID, URL, observed title and available transition/referring-visit metadata. Its identity includes source UUID, incarnation UUID, encoded native ID and original timestamp. Separate visits to a URL stay separate; repeat capture of an identity deduplicates. The original timestamp also distinguishes native ID reuse at a later time.

The earliest operation remains canonical. A newer URL-level title cannot move that visit into a different clear generation. Reusing an identity with a different URL/tag, changing an operation or reusing an author counter rejects the journal.

Capture resolves native individual visits with `getVisits`, excludes visits whose locality is false, and preserves the API timestamps. Missing locality/time retains work with a visible error. Browser titles are URL-level observations, not historical titles per visit. The native port never writes remote history into the browser. [Chrome history API](https://developer.chrome.com/docs/extensions/reference/api/history)

A separate account index key is derived using HKDF-SHA256 and retained in trusted recovery material. HMAC-SHA256 tags the exact native URL. Tags are checked during encryption and decryption; invalid tags quarantine the incoming page without advancing its cursor. Future content-key rotation must retain this index key. Replica exports exclude keys and credentials; recovery bundles carry the index key separately.

## Durable capture and import

IndexedDB v5 adds history metadata, a timeline index, capture inbox, seen identities, import/audit jobs, native lookup batches and URL incarnations. The migration retains earlier outgoing work and interrupted session restoration.

Synchronous WXT listeners start the capture transaction immediately. Raw event intent and its observed clear context persist before HMAC, native lookup or encryption, independently of reconciliation work. Native lookups persist their results/position; visits, seen identities, drafts and logical counters commit together. Restart or a failed write resumes saved work. Encryption then creates immutable outgoing envelopes through the shared transport.

Initial import accepts 0–365 days. Native URL search ranges bisect when truncated rather than advancing past tied timestamps. A job remembers discovered URL tags so split boundaries do not repeat lookups. Each URI lookup preserves individual timestamps and imports only the requested time window. Later overlap scans cover five minutes before the previous scan boundary; alarms/startup/manual sync/reconnect supplement events.

Known local URLs also receive bounded audits on browser startup, manual sync and daily reconciliation. These detect partial removals and URLs missing entirely from native search. An audit compares against a durable author-counter boundary captured before fetching native visits, so newer records published during the lookup are not falsely erased. Native expiry detected this way also removes the corresponding synchronized source records.

## Pause, exclusions and baselines

Collection is opt-in; the manifest disables incognito access. Native imported visits and private records are excluded. Hostname exclusions include subdomains and affect future collection; changing an exclusion does not erase already synchronized entries.

Pausing cancels unfetched native import/audit queries, while keeping saved event/removal intent, retrieved individual-visit batches and outgoing records. Resuming inventories existing native identities before normal collection continues. Captured batches remain publishable even if the resume baseline reaches them first. A newly backdated visit during the pause cannot be imported through a cancelled older query.

A source/global clear changes the source incarnation and pauses collection during the full inventory. A URL clear establishes a separate URL incarnation and baseline; an unknown URL is baselined when its first native item becomes available. A genuine event saved after the URL clear retains its new-generation context and is processed after that baseline. Old native records are suppressed rather than retagged. Native ID/time reuse after a clear receives a new identity.

Baseline intervals are explicit collection pauses, not complete archival coverage. Abrupt termination before intent commits, native records no longer available at lookup, unobserved visits outside import/overlap windows, or unusual native event timestamp behavior can leave capture gaps. Clock-skew and worker-lifecycle behavior require live Helium verification. Original visit timestamps never decide causal merge/clear ordering.

## Deletion and generations

Selected-record removal uses permanent identity tombstones. Clear scopes are every source, one source, or one URL tag on one source. Native clear-all affects only its source. Partial native removal compares individual ID/time pairs; complete URL removal creates a source-scoped URL barrier. Multi-URL removal progress survives interruption.

Visits carry the matching clear generations observed at capture. Visibility requires covering every applicable barrier. Stale uploads from an offline source remain hidden even if they arrive after a clear. Unrelated URL traffic cannot advance a visit generation. Every concurrent matching barrier matters; learning one clear does not override another unseen clear. V1 retains barriers and tombstones indefinitely. Future compaction requires retirement/acknowledgement frontiers and stale-source rebootstrap.

Logical removal deletes entries from the live timeline index and removes suppressed visit plaintext from the operation journal. IndexedDB schema 8 replaces that plaintext with local `erased-visit` receipts containing only the operation/revision, visit identity, source UUID, opaque URL tag and captured generation. The composite visit identity still contains native ID/time components needed for suppression; receipts are metadata, not anonymization. URLs, titles, source names, transitions and referring IDs are removed from those journal copies. Every receipt requires an applicable deletion/clear proof, and the original revision continues to detect reused counters and retagged duplicate identities.

Unencrypted erased drafts are canceled into a separate receipt store, preserving their reserved headers/counters without publishing their content. Their suppression metadata remains private to that profile, so peers need not have identical metadata for canceled visits; their visible timelines and clear barriers still converge. Later genuinely new visits can publish normally. Migration applies the same policy to v7 journals transactionally. Draft cancellation wins against encryption already in flight.

Encrypted visits retain their exact original envelopes and outgoing retries until a coordinated ciphertext-purge protocol proves it safe to remove them. Receiving/replaying the same envelope cannot persist its suppressed plaintext again. After key rotation, proven-missing encrypted work can be re-encrypted from retained ciphertext in memory without restoring the plaintext journal. Local receipts are never accepted as encrypted wire operations.

IndexedDB schema 9 removes saved inbox/lookup/scan work whose observed generation predates a matching global, source or URL clear. Cleanup commits with the clear proof, timeline/journal changes and incoming cursor, including while capture is paused. A failed cleanup write rolls back that transaction. Unrelated URLs and already observed generations remain saved. Completed native-removal URLs are dropped from the remaining intent rather than retained before a position cursor. Migration applies existing proofs to v8 saved jobs without changing pending envelope bytes or counters.

Selected deletions scrub transition/referring metadata from matching cached native records, retaining a local identity-only erased marker so cached positions and native audit comparisons remain valid. A batch needed by unrelated visits retains its shared URL, with the old optional title removed; a wholly erased batch is canceled. Fetching selected native records after their deletion proof also avoids saving the erased content. Every native query checks its saved job and current clear proofs before writing results; canceled jobs cannot be recreated by late responses. URL-tag matching of raw inbox intents uses short WebCrypto work with [Dexie's documented transaction lifetime helper](<https://dexie.org/docs/Dexie/Dexie.waitFor()>). No browser API or network request runs inside that cleanup transaction.

Authenticated client/relay ciphertext purge is implemented; full erasure remains open for general quarantine and unresolved/shared capture copies. Unfetched selected events may retain their URL/title until native resolution determines which individual visits they contain; shared jobs retain content needed by unrelated visits. New native inventory/baseline jobs may also temporarily save browser-owned content that still exists in native history. Sync removal does not delete that native browser history. Backups and exports made before removal remain separate stored copies. Remaining capture-policy work and explicit backup-expiration/restore behavior are required before the erasure gate can pass. The UI continues to disclose this boundary at removal confirmation. No secure deletion of physical IndexedDB pages, filesystem snapshots or independently saved copies is claimed.

Optional [history retention](retention.md) expires acknowledged visits owned by this source using original timestamps. It creates permanent selected-deletion proofs and uses the same ciphertext-purge path; pending uploads and duplicate native-identity copies remain protected. The saved period initially shows 90 days, with expiry off until selected.

## Bounded work and remaining scale gate

Search uses time/source compound indexes, at most 200 returned records and 2,000 examined rows. Its cursor resumes after the last examined row, including filtered-out rows and tied timestamps. Empty filtered pages can continue searching older records. Source filters and date boundaries stay local.

Each capture pass processes up to 20 inbox items, five ready URL lookups with 100 native records per lookup, and one discovery range. Removal work stages at most 800 selected IDs per item/pass. An audit discovers at most 50 distinct local URLs per range. The event/lookup queues cap at 10,000/20,000 items; discovery retains an overflowing range and errors remain visible. A native timestamp bucket exceeding 10,000 URLs pauses that import range. The unpaginated native visits API has a 100,000-record per-URL ceiling; exceeding it retains progress and reports recovery required. Retries back off, and an unavailable URL does not starve other ready URLs.

The current causal projection still replays the uncompacted history journal when staging or receiving records. Indexed reads are bounded, but no full 50,000-visit performance result is claimed. Account/local quotas and broader scale acceptance remain pending.

## Evidence

Nine model tests cover stable IDs, source/global/URL and concurrent clears, selected deletion, prevention of retagged imports, and all 120 delivery orders of an offline-source clear case. Eight pipeline tests cover encrypted offline delivery/reopen/lost acknowledgement, HMAC validation and quarantine, atomic index failure, bounded tied-time search, and v4 migration. Twenty-one native-port tests cover durable event/lookup progress, initial import, locality/private filtering, clear baselines, pause/clock boundaries, exclusions, storage failures, bounded lookup/audit progress and native-removal races.

The fifth real Rust-process integration test preserves fractional original timestamps across client/relay restarts, uploads a clear before an offline source returns, verifies stale uploads stay hidden, and checks logical selected deletion plus absence of URLs/titles/keys in SQLite envelopes. This is a short outage, not an hours-long endurance result.

The actual dashboard components were exercised with synthetic localhost responses: opt-in, text search, selection/removal refresh, exact source-clear preview and narrow-window wrapping. The 390 px layout has no horizontal overflow and produced no warning/error logs. The preview was closed; no actual Helium profile was read or changed.

## Client and relay purge implementation checkpoint

The schema-5 relay and schema-10 client now replace live ciphertext with authenticated header/digest receipts. Suppressed encrypted visits receive a content-free permanent selected-deletion certificate, committed through a durable purge request. The client authenticates certificates on ordinary pulls and attached redacted slots, removes local ciphertext/outbox/quarantine copies transactionally, and prevents exact old retries from resurrecting content. Pending certificates survive lost replies/reopening and adopt a new encryption epoch only with an explicit missing-record proof.

The [erasure protocol](history-erasure-protocol.md) records the trusted-client, compatibility and retained-copy boundaries. General quarantine retention, unresolved/shared native capture copies, physical SQLite/WAL pages, historical exports/backups and old-backup restore policy remain open. Browser-owned native history is not deleted by sync removal. Full erasure, storage/scale/recovery and native acceptance gates remain open.
