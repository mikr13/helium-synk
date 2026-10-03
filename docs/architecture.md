# Architecture and contracts

This is the engineering reference for the V1 release candidate. The single progress checklist, current verification and known limitations live in [plan.md](plan.md); operating and recovery procedures live in [deployment.md](deployment.md). Protocol contracts remain explicit below. Historical per-checkpoint test counts have been removed.

Client database schema: 10. Relay schema: 5. Envelope protocol: 1. Collections are opt-in. Passwords, cookies, native profile files, iCloud and public relay hosting are outside V1.

<a id="bookmark-merge"></a>

## Bookmark merge contract

Bookmark identity and causal merge rules are independent of native profile IDs.

Each operation carries its own UUID, installation author/counter, logical revision, and observed vector context. The logical revision increases after observing another revision and is independent of delivery sequence or wall time. Known references with impossible causal/logical order and reused author counters are rejected.

Title and URL are separate causal registers. Placement is one atomic parent/position register. Each register retains concurrent candidates, chooses the highest logical revision then canonical author ID/counter/operation ID, and discards a frontier candidate only when a later edit causally observes it. The full immutable operation journal retains prior values after conflict resolution; `bookmarkRecoveryVersions` retrieves them for recovery.

Entity creation assigns a logical UUID. Browser-local IDs will be mapped to it by the adapter. Intentional duplicates use different UUIDs. Reserved identities describe bookmark-bar/other/mobile root roles and the common recovered folder; mutable operations cannot edit/remove those identities.

Deletion is permanent in V1. A folder removal names the descendants actually observed by its author, rather than deleting every future node whose parent happens to match. Concurrent unseen children survive. Deleted entities retain their merged title/URL/placement and original operations. Explicit restoration creates a new UUID linked through `restored_from`; it never removes the old tombstone.

The visible tree is a deterministic projection. Missing/deleted/non-folder parents route children to a common Recovered bookmarks folder under Other bookmarks. A cyclic folder component routes its lexicographically smallest logical identity there, retaining its requested placement in the recovery journal. When a merely missing parent arrives later, the original placement becomes usable again. A tombstone cannot be undone that way.

Positions are canonical exact fractions, compared by cross multiplication. New positions use a mediant between adjacent bounds; simultaneous inserts at the same token use logical UUIDs as the final tie-breaker. Native browser indexes come from the resulting sorted sibling list. Reorder/rebalance operations carry explicit observed child identities with canonical integer positions. They neither delete unmentioned concurrent inserts nor change entity identities. Concurrent movement/reordering competes in the atomic placement register; the losing placement remains recoverable. The projection therefore converges even if an offline client used old positions. Token length is bounded and a folder reorder is required before pathological position growth exceeds that bound.

`bookmarks.test.ts` checks independent edits, concurrent alternatives and subsequent resolution, permanent deletion and new-identity restoration, observed subtree deletion with unseen children, folder cycles, missing/invalid parents, equal-position inserts, concurrent rebalance/insertion/movement, intentional duplicates, duplicate delivery, invalid identities/clocks, and long sequential edit histories. Multiple scenarios enumerate every delivery permutation; the six-operation rebalance scenario checks 720 permutations. Exact-position tests exercise 5,000 repeated inserts into one gap.

<a id="bookmark-adapter"></a>

## Native bookmark adapter

Bookmark sync is opt-in through the options page: preview, save the recovery copy, then confirm. Automated adapter checks use a browser port with fake IndexedDB; the recorded native baseline is in the plan. Use disposable profiles for further checks.

### Identity and joining

Native IDs belong to one profile. IndexedDB maps them to logical UUIDs; a separate random incarnation marker in `storage.local` detects lost mapping metadata or a changed profile. Missing markers/mappings or unavailable selected roots pause application instead of inferring mass deletion.

Roots are discovered using Chromium's `folderType`, `syncing` and `unmodifiable` capabilities. Local roots are preferred when unique; ambiguous choices require explicit selection. Root names and numeric IDs are not assumptions. The manifest now requires Chromium 134 because the [root-role properties arrived in 134](https://developer.chrome.com/docs/extensions/reference/api/bookmarks#type-BookmarkTreeNode). Actual Helium compatibility is not established by that version floor alone. Managed nodes and unselected roots remain outside the merge. Moving a mapped entry into an excluded root pauses application rather than moving it back silently.

The first profile imports its existing hierarchy. Later profiles match only unique exact entries under the same logical parent. Folder matching also requires an exact child-content signature. Ambiguous duplicates and unmatched entries receive separate UUIDs. Preview confirmation revalidates both the native tree and shared replica; changed data requires a fresh preview. The original tree and replica backup persist locally before import actions/mappings commit together. The UI also offers a separate backup download. Ordinary replica exports include pending drafts/events, bindings and application effects, and exclude credentials/root keys.

### Capture and causality

WXT registers native creation/change/move/removal/reorder listeners synchronously. Each event and its reserved author counter/logical revision/context enter the durable inbox in the same transaction. Encryption and network transfer happen later. Echo events can leave unused counters; counters need to be unique and increasing at reservation, not contiguous on the relay. A delayed event retains its original reserved revision even if a peer download or newer local operation completes before it is processed.

Changed events retain their prior observed fields so an unchanged title carried with a URL change does not overwrite a concurrent title edit. Full-tree reconciliation also emits only fields that differ from the native baseline. Startup, alarms, manual synchronization, imports and notifications reconcile missed events. For missed changes whose exact event time is unavailable, the adapter uses the last completed application frontier conservatively rather than assuming every newer downloaded record was visible natively.

A captured event is removed only in the transaction that commits its logical draft and updated bindings. Local storage failure aborts that transaction and leaves the event available for retry. A browser termination before the event transaction commits can still lose a transient create/delete or intermediate edit; the surviving full tree is reconciled after restart.

### Applying changes and recovery

Every create/update/move/remove intent commits before the browser API is called. Its observed result and mapping commit afterward. Expected events match the specific effect, native ID and resulting fields; they are consumed once. There is no global ignore-events flag. Genuine events before/during/after application remain captured, including a rename that the in-flight API call temporarily overwrites.

Interrupted updates/moves/removals reconcile actual state before replanning. An unbound interrupted create with possible matching new entries pauses for explicit review: associate a validated existing candidate, or preserve all candidates and create a separate copy. It never blindly retries an ambiguous creation.

Application orders ancestry changes to avoid moving a folder into its current descendant. It removes only leaves/empty folders; surviving or unseen children move out before a deleted parent is removed. Logical recovery folders and unavailable bar/mobile roles have local proxy folders when needed. Managed entries and unexpected identity/type changes pause application.

Work is bounded to 200 inbox events and 100 browser effects per reconciliation pass. Remaining work stays durable and continues on a later alarm/sync. Large imports stage actions in one batch and replay the logical journal once. V1 logical journals and application evidence are retained; growth monitoring and quotas remain subsequent work.

<a id="sessions"></a>

## Session capture, sync and restoration

Sessions are owned by their source installation. Receiving or restoring a snapshot does not close or edit source windows. The WXT adapter captures regular windows and performs explicit local restoration.

### Snapshot and transport contract

- A snapshot contains a source name/UUID, source revision, capture time, current/closed/previous kind, ordered windows/tabs, titles/URLs, pins, active selection and group metadata. Runtime browser IDs stay local; replicated identities are UUIDs.
- The source revision is the first reserved author counter. Each fragment occupies the next contiguous counter. Authenticated envelope author/counter values must agree with the encrypted fragment metadata.
- JSON is split into at most 256 fragments of 45,000 bytes. Each encrypted envelope stays below the relay's 64 KiB ciphertext limit; existing byte/count batch bounds still apply. Limits are 100 windows, 10,000 tabs total and 500 groups per window. A rejected capture leaves the previous snapshot intact and surfaces an error.
- Only a fully assembled and validated snapshot replaces that source's current snapshot. Higher source revision wins; capture/receipt clocks do not decide freshness ordering. Incomplete assemblies remain durable across cursor pages and restarts.
- Snapshot fragments, logical projection and reserved counters commit together in IndexedDB. Encryption moves drafts into immutable operations/outbox entries transactionally. Only wholly unencrypted current drafts may coalesce; closed/saved snapshots and snapshots with any encrypted fragment remain retained.
- Incoming records, projection and cursor commit together. Invalid complete assemblies and cross-domain author-counter reuse quarantine the failed page without advancing its cursor.
- Encrypted historical current snapshots remain available as previous history until their source expires them. Explicitly saving the current snapshot creates a separate previous record with its original capture time and `previous_of` link. The opt-in [retention backend](architecture.md#retention) defaults to 30 days, 100 combined archives and 50 MiB content per source; pending/current/active restoration work stays protected. Settings controls and content-free closed-capture receipts are implemented. Live encrypted session ciphertext remains retained; expiry is not a disk-space bound.

### Browser capture

Collection is opt-in. The extension requests `tabs`, `tabGroups` and `sessions`, with incognito disabled. It does not request browsing-site host access or inject content scripts. Collection targets regular, non-private windows. Its own temporary restoration markers are excluded.

Tab/window/group listeners register synchronously. Event-provided tab details update the durable window cache before the two-second publication debounce, capped at five seconds during continuous activity. Window-closing tab-removal events do not erase that cache. Window removal archives the cached last valid contents atomically with its outgoing snapshot intent. A missed removal is recovered from cache during reconciliation. Temporary group/pin transition states preserve the previous valid cache until a full native scan settles.

Alarms, startup, network reconciliation, explicit sync and enabled event handling run full scans. A browser-incarnation marker lives in `storage.session` solely to distinguish ephemeral native-ID lifetimes; essential snapshots, queues and maps live in IndexedDB. Worker revival keeps the marker; browser/extension restart resets it. A changed incarnation saves the last good current snapshot as previous, discards stale runtime maps and allocates fresh IDs. Startup emptiness does not replace the last good snapshot while native windows are still unavailable.

The recently-closed API supplements missed closed windows, at most 25 records per scan. Opaque local session IDs and close time deduplicate repeated scans. Matching cache/API records consume matches one-to-one, so identical separately closed windows remain separate. Cache records retain their richer group metadata. API-only records show `groups_unavailable` because live group lookup cannot recover their group metadata.

Pausing preserves existing snapshots and stops event capture. Re-enabling drops the stale live cache and baselines the current recently-closed list, so closures during the pause are not retroactively imported. It then captures the currently open windows.

Abrupt termination before an event is durably captured can lose transient details; neither the cache nor recently-closed API is a complete archive. Collection/storage failures are visible and preserve the last good data. Snapshot age is displayed separately from this installation's relay connection state; it is not a peer heartbeat.

### Restoration journal

The session list links to a focused `/sessions/$snapshotId` page with open-tab, open-window and open-all controls. Its progress belongs to the selected snapshot and appears above the tab list. Type/source filters survive Back and reload. Only HTTP/HTTPS URLs without embedded credentials restore automatically. Internal/file/data/javascript/unsupported URLs remain in the source snapshot and are skipped with an explanation/count. Destination windows use browser-default geometry and state rather than source monitor coordinates.

Each request has an immutable UUID and a saved job. Repeating the same request ID/selection returns that job. Opening a single tab uses a regular local window when available; window/all actions create destination windows. Work is serial and bounded to 40 steps per pass, with a 100-step hard ceiling. Jobs resume through the next pass or an alarm after worker interruption.

Window/tab creation saves intent before calling the API. Unique packaged marker URLs identify created objects after a lost result; returned native IDs persist before navigating to the real page. A repeated pass finds the exact marker instead of blindly creating another window/tab. Missing/multiple markers pause for review. An interrupted navigation recognizes the expected target URL/pin state; a changed page or moved/closed tab pauses and preserves user activity.

After tab creation the adapter restores pins, relative ordering, groups/metadata and active selection, then removes only its exact placeholder tab. Group creation can recover from existing membership after a lost reply. Changed group membership pauses rather than regrouping user edits. One destination is focused at completion. Cancelling leaves all opened tabs intact.

Browser restart invalidates saved runtime IDs. A partially completed job then pauses instead of reusing potentially unrelated IDs. Review existing windows, cancel to preserve them and make a new explicit request if needed. Ambiguous interruption across a redirect/user navigation also requires review. Progress shows pages opened, windows ready, skipped URLs and the current failure; it does not promise a web page has finished loading.

<a id="history"></a>

## History capture, timeline and clear policy

History supports opt-in native capture, encrypted transport, indexed local search, logical removal, journal plaintext cleanup, obsolete capture-job cleanup and authenticated live ciphertext purge. Native selected-removal evidence is in the plan. General retained-copy, historical-backup and filesystem-page erasure are not promised.

### Individual visits and encryption

A visit retains its original native timestamp, source installation/name, profile incarnation, opaque native visit ID, URL, observed title and available transition/referring-visit metadata. Its identity includes source UUID, incarnation UUID, encoded native ID and original timestamp. Separate visits to a URL stay separate; repeat capture of an identity deduplicates. The original timestamp also distinguishes native ID reuse at a later time.

The earliest operation remains canonical. A newer URL-level title cannot move that visit into a different clear generation. Reusing an identity with a different URL/tag, changing an operation or reusing an author counter rejects the journal.

Capture resolves native individual visits with `getVisits`, excludes visits whose locality is false, and preserves the API timestamps. Missing locality/time retains work with a visible error. Browser titles are URL-level observations, not historical titles per visit. The native port never writes remote history into the browser. [Chrome history API](https://developer.chrome.com/docs/extensions/reference/api/history)

A separate account index key is derived using HKDF-SHA256 and retained in trusted recovery material. HMAC-SHA256 tags the exact native URL. Tags are checked during encryption and decryption; invalid tags quarantine the incoming page without advancing its cursor. Future content-key rotation must retain this index key. Replica exports exclude keys and credentials; recovery bundles carry the index key separately.

### Durable capture and import

IndexedDB v5 adds history metadata, a timeline index, capture inbox, seen identities, import/audit jobs, native lookup batches and URL incarnations. The migration retains earlier outgoing work and interrupted session restoration.

Synchronous WXT listeners start the capture transaction immediately. Raw event intent and its observed clear context persist before HMAC, native lookup or encryption, independently of reconciliation work. Native lookups persist their results/position; visits, seen identities, drafts and logical counters commit together. Restart or a failed write resumes saved work. Encryption then creates immutable outgoing envelopes through the shared transport.

Initial import accepts 0–365 days. Native URL search ranges bisect when truncated rather than advancing past tied timestamps. A job remembers discovered URL tags so split boundaries do not repeat lookups. Each URI lookup preserves individual timestamps and imports only the requested time window. Later overlap scans cover five minutes before the previous scan boundary; alarms/startup/manual sync/reconnect supplement events.

Known local URLs also receive bounded audits on browser startup, manual sync and daily reconciliation. These detect partial removals and URLs missing entirely from native search. An audit compares against a durable author-counter boundary captured before fetching native visits, so newer records published during the lookup are not falsely erased. Native expiry detected this way also removes the corresponding synchronized source records.

### Pause, exclusions and baselines

Collection is opt-in; the manifest disables incognito access. Native imported visits and private records are excluded. Hostname exclusions include subdomains and affect future collection; changing an exclusion does not erase already synchronized entries.

Pausing cancels unfetched native import/audit queries, while keeping saved event/removal intent, retrieved individual-visit batches and outgoing records. Resuming inventories existing native identities before normal collection continues. Captured batches remain publishable even if the resume baseline reaches them first. A newly backdated visit during the pause cannot be imported through a cancelled older query.

A source/global clear changes the source incarnation and pauses collection during the full inventory. A URL clear establishes a separate URL incarnation and baseline; an unknown URL is baselined when its first native item becomes available. A genuine event saved after the URL clear retains its new-generation context and is processed after that baseline. Old native records are suppressed rather than retagged. Native ID/time reuse after a clear receives a new identity.

Baseline intervals are explicit collection pauses, not complete archival coverage. Abrupt termination before intent commits, native records no longer available at lookup, unobserved visits outside import/overlap windows, or unusual native event timestamp behavior can leave capture gaps. Clock-skew and worker-lifecycle behavior require live Helium verification. Original visit timestamps never decide causal merge/clear ordering.

### Deletion and generations

Selected-record removal uses permanent identity tombstones. Clear scopes are every source, one source, or one URL tag on one source. Native clear-all affects only its source. Partial native removal compares individual ID/time pairs; complete URL removal creates a source-scoped URL barrier. Multi-URL removal progress survives interruption.

Visits carry the matching clear generations observed at capture. Visibility requires covering every applicable barrier. Stale uploads from an offline source remain hidden even if they arrive after a clear. Unrelated URL traffic cannot advance a visit generation. Every concurrent matching barrier matters; learning one clear does not override another unseen clear. V1 retains barriers and tombstones indefinitely. Future compaction requires retirement/acknowledgement frontiers and stale-source rebootstrap.

Logical removal deletes entries from the live timeline index and removes suppressed visit plaintext from the operation journal. IndexedDB schema 8 replaces that plaintext with local `erased-visit` receipts containing only the operation/revision, visit identity, source UUID, opaque URL tag and captured generation. The composite visit identity still contains native ID/time components needed for suppression; receipts are metadata, not anonymization. URLs, titles, source names, transitions and referring IDs are removed from those journal copies. Every receipt requires an applicable deletion/clear proof, and the original revision continues to detect reused counters and retagged duplicate identities.

Unencrypted erased drafts are canceled into a separate receipt store, preserving their reserved headers/counters without publishing their content. Their suppression metadata remains private to that profile, so peers need not have identical metadata for canceled visits; their visible timelines and clear barriers still converge. Later genuinely new visits can publish normally. Migration applies the same policy to v7 journals transactionally. Draft cancellation wins against encryption already in flight.

Encrypted visits retain their exact original envelopes and outgoing retries until a coordinated ciphertext-purge protocol proves it safe to remove them. Receiving/replaying the same envelope cannot persist its suppressed plaintext again. After key rotation, proven-missing encrypted work can be re-encrypted from retained ciphertext in memory without restoring the plaintext journal. Local receipts are never accepted as encrypted wire operations.

IndexedDB schema 9 removes saved inbox/lookup/scan work whose observed generation predates a matching global, source or URL clear. Cleanup commits with the clear proof, timeline/journal changes and incoming cursor, including while capture is paused. A failed cleanup write rolls back that transaction. Unrelated URLs and already observed generations remain saved. Completed native-removal URLs are dropped from the remaining intent rather than retained before a position cursor. Migration applies existing proofs to v8 saved jobs without changing pending envelope bytes or counters.

Selected deletions scrub transition/referring metadata from matching cached native records, retaining a local identity-only erased marker so cached positions and native audit comparisons remain valid. A batch needed by unrelated visits retains its shared URL, with the old optional title removed; a wholly erased batch is canceled. Fetching selected native records after their deletion proof also avoids saving the erased content. Every native query checks its saved job and current clear proofs before writing results; canceled jobs cannot be recreated by late responses. URL-tag matching of raw inbox intents uses short WebCrypto work with [Dexie's documented transaction lifetime helper](<https://dexie.org/docs/Dexie/Dexie.waitFor()>). No browser API or network request runs inside that cleanup transaction.

Authenticated client/relay ciphertext purge is implemented; full erasure remains open for general quarantine and unresolved/shared capture copies. Unfetched selected events may retain their URL/title until native resolution determines which individual visits they contain; shared jobs retain content needed by unrelated visits. New native inventory/baseline jobs may also temporarily save browser-owned content that still exists in native history. Sync removal does not delete that native browser history. Backups and exports made before removal remain separate stored copies. General capture-copy cleanup and backup-expiration/restore workflows remain follow-up work; complete retained-copy erasure is not promised. The UI continues to disclose this boundary at removal confirmation. No secure deletion of physical IndexedDB pages, filesystem snapshots or independently saved copies is claimed.

Optional [history retention](architecture.md#retention) expires acknowledged visits owned by this source using original timestamps. It creates permanent selected-deletion proofs and uses the same ciphertext-purge path; pending uploads and duplicate native-identity copies remain protected. The saved period initially shows 90 days, with expiry off until selected.

### Bounded work and scale limits

Search uses time/source compound indexes, at most 200 returned records and 2,000 examined rows. Its cursor resumes after the last examined row, including filtered-out rows and tied timestamps. Empty filtered pages can continue searching older records. Source filters and date boundaries stay local.

Each capture pass processes up to 20 inbox items, five ready URL lookups with 100 native records per lookup, and one discovery range. Removal work stages at most 800 selected IDs per item/pass. An audit discovers at most 50 distinct local URLs per range. The event/lookup queues cap at 10,000/20,000 items; discovery retains an overflowing range and errors remain visible. A native timestamp bucket exceeding 10,000 URLs pauses that import range. The unpaginated native visits API has a 100,000-record per-URL ceiling; exceeding it retains progress and reports recovery required. Retries back off, and an unavailable URL does not starve other ready URLs.

The current causal projection still replays the uncompacted history journal when staging or receiving records. Indexed reads are bounded, but no full 50,000-visit performance result is claimed. Account/local quotas and broader scale acceptance remain pending.

<a id="history-erasure"></a>

## History ciphertext erasure protocol

The schema-5 relay and schema-10 client implement atomic ciphertext replacement with authenticated deletion certificates and durable identity receipts. The extension advertises erasure capability, resumes saved purge requests and consumes redacted pages. Complete history erasure remains open for unresolved/shared native capture copies, quarantine policy and old-backup recovery/expiration.

### Atomic purge

An active installation sends `POST /v1/history/purge`, authenticated normally, with `X-Synk-History-Erasure: 1` and:

```ts
{
  expected_epoch: string;
  certificate: Envelope; // domain: "history-erasure", fresh author counter
  targets: {
    header: Omit<Envelope, 'nonce' | 'ciphertext'>; // domain: "history"
    digest: string; // lower-case SHA-256, 64 hex characters
  }
  [];
}
```

Targets contain no original nonce/ciphertext, URL/title or native visit ID. The certificate is encrypted by the client; the relay never reads the deletion proof or receives content/index keys. The encrypted certificate is itself a permanent selected-deletion proof for its target visit identities. Validation binds each minimal erased-visit receipt to its original header/digest, verifies causal observation and author/counter identity, and rejects extra content fields. Where the original is already stored, its digest and minimal receipt must match before replacement. The relay cannot distinguish opaque visits from barriers or fabricated content; authorized clients are trusted to request valid erasure. A receiving client must stop on invalid proofs rather than silently discard unrelated data.

One transaction rechecks the active credential/epoch, stores the exact certificate, binds it to a fixed public target set and replaces each encrypted target body with its original header and empty nonce/ciphertext. A receipt stores the original full-envelope digest and certificate ID. Original sequence, operation ID, author and counter stay reserved. Failed identity/quota/storage checks roll back certificate, replacements, binding, usage and capability state. Success follows commit.

A batch contains 1–100 distinct history targets. Committed target headers and digests must match. An unknown target can be reserved only by its own authenticated author, with a counter below the certificate counter and an encryption epoch no newer than the certificate. This permits canceled encrypted offline work to be reserved without uploading its ciphertext. Another installation cannot forge an unpublished counter reservation. Unencrypted canceled drafts remain private client receipts.

Certificates use bounded envelopes with domain `history-erasure`, committed through purge rather than ordinary push. New certificates require the current content epoch and an unused author counter; exact committed retries remain valid after rotation. One certificate ID cannot change its body or public target set. Target order is immaterial to binding. Concurrent certificates keep the first committed target proof.

The reply contains `server_epoch`, `certificate_sequence` and `redactions`, each with `operation_id`, original/reserved `sequence`, `digest` and retained `certificate_operation_id`. Lost replies repeat the saved request after restart. The client reserves a new author counter, content-free certificate draft and per-target claims atomically. It saves encrypted certificate bytes and the exact request before HTTP. Valid replies replace local envelopes with header/digest receipts and remove their outbox/quarantine entries and saved intent in one transaction. Failed replies/writes retain intent and ciphertext.

### Digest and retry identity

The digest is SHA-256 of UTF-8 JSON for this fixed field array:

```ts
[
  protocol_version,
  operation_id,
  account_id,
  device_id,
  counter,
  domain,
  key_epoch,
  nonce,
  ciphertext,
];
```

Rust and JavaScript share a fixed test vector independently checked using Python. JSON object member order is immaterial. Identical original retries still receive their original sequence ACK; changed ciphertext/nonce/header or reused counters conflict. Rekey checks treat matching purged identities as committed, never missing. Own-author frontier lookup includes receipt rows, preserving copied/reset-profile guards.

### Pull and compatibility

Purged sequences stay present. Pull returns the existing `{ sequence, envelope }` or:

```ts
{
  sequence: number;
  redacted: {
    header: Omit<Envelope, 'nonce' | 'ciphertext'>;
    digest: string;
    certificate: Envelope;
    certificate_sequence: number;
  }
}
```

The attached certificate lets fresh bootstrap validate an earlier erased sequence before the later certificate/clear arrives in journal order. Clients already beyond a target must apply erasure when its new certificate arrives. Both client paths authenticate the certificate before changing data. An attached certificate may be stored ahead of the current page cursor, but only actual processed page entries advance that cursor. Target replacement, projections, capture cleanup and cursor progress commit together. A redacted slot is not an ordinary decryptable envelope.

The first purge permanently requires capability version 1 for push/pull/rekey. Earlier clients receive HTTP 426 and retain work. The extension sends capability version 1 on its relay requests. A schema-5 relay without purge also remains compatible with earlier clients. Missing certificate storage fails a pull rather than skipping a sequence. Pages retain 100-record/512-KiB bounds and normal delivered/processed-ACK rules; duplicated certificate bytes count toward the page limit.

### Budgets and remaining copies

Envelope-byte usage includes retained header placeholders and encrypted certificates. Purged identities cease counting as active encrypted operations; certificates count. A full/lowered quota permits net cleanup that does not grow either exceeded resource. Growing metadata must fit the budget or the entire request returns HTTP 507. Sequence exhaustion rejects before inserting. Bytes describe envelope/header JSON, not physical SQLite/WAL or separate digest/request tables.

This removes ciphertext from the **live SQL journal**. It does not securely erase old SQLite/WAL pages, filesystem snapshots, downloaded client copies or independent backups/exports. Certified target copies in local journals/outboxes/quarantine are removed. Unresolved/shared native inventory copies, general quarantine retention, backup expiration and restoring old erasure state remain open. This API proves live journal erasure only; the broader retained-copy limits remain explicit.

Nine added Rust tests cover digest interoperability, authentication/revocation, target/request validation, schema-4 preservation, missing own reservations, restart/rekey/frontiers, rollback, quotas, bounded pages/ACKs and concurrency. A real Rust-process integration discards a committed reply, restarts, retries exactly, inspects live SQL, rejects changed original ciphertext and bootstraps from zero. Its opaque certificate fixture proves relay behavior, not extension proof validation or complete erasure.

### Client certificate and key lifecycle

`history-erasure` schema 1 contains the certificate operation ID/revision and 1–100 targets, each holding an `erased-visit` receipt, original encryption epoch and original envelope digest. At most 80 distinct native visit identities fit one certificate; larger cleanup uses multiple bounded requests. Receipts retain source UUID, opaque URL tag, generation, original operation/revision and composite native ID/time identity. They contain no original URL, title, source name, transition, referring ID, nonce or ciphertext. The selected-deletion proof is derived from these target identities and the certificate revision. It can be verified before the original clear arrives; no old visit content or full clear proof is copied into a certificate.

Original headers are derived from authenticated receipts and compared with public redacted slots. Cross-domain counter/identity checks include retained original headers and unpublished private receipts. Exact old envelope replay can validate against a retained digest but cannot restore erased local content. Public slot tampering, conflicting known digests/receipts or reused counters stop cursor progress.

Claims protect original ciphertext from concurrent outbox rekey. After a content rotation, a saved certificate is replaced at the new epoch only after an explicit relay proof that it is missing. A committed certificate keeps its exact old request for retry. Replacement updates the local operation and request together, preserving IDs/counters and original target epochs/digests. Historical content roots remain available for certificate verification. Changed restore epochs pause requests with saved work retained.

<a id="relay"></a>

## Relay protocol and durable progress

Protocol version 1 uses client-encrypted envelopes and account-scoped author identities. The relay schema is version 5, including single-use pairing, the [content-key rotation protocol](architecture.md#keys) and the [history erasure protocol](architecture.md#history-erasure); see the [pairing contract](architecture.md#pairing). `/health/ready` reports protocol, schema, package and linked SQLite versions; `/v1/status` requires the installation's bearer credential and reports account envelope usage/budgets, device counts, latest sequence, erasure capability/receipt count and that installation's processed cursor, epoch and activity time. It exposes no browsing payloads or credentials.

### Cursor acknowledgements

After each valid page, the client commits decrypted records, domain journal/projections and the incoming cursor in one IndexedDB transaction. Only then does it POST `/v1/sync/ack` with `{ "server_epoch": "…", "cursor": 123 }`. The server authenticates the installation, checks the epoch and its delivered frontier, and commits monotonically increasing processed progress before returning `{ "server_epoch": "…", "processed_cursor": 123 }`.

`cursor > acknowledged_cursor` is the client's durable retry intent. A lost server reply, worker restart or failed local ACK write repeats the same cursor. The client verifies the live epoch before retrying. Invalid ciphertext, quarantine and rolled-back transactions cannot advance processed progress. A later invalid page does not invalidate earlier committed pages. Push acknowledgements only confirm relay storage and remove matching outbox entries; they never advance the incoming cursor.

These ACKs confirm durable **journal processing**, including persisted session fragments. Native bookmark application and session restoration have independent journals and progress. An ACK does not attest to completed browser effects, complete multipart snapshots, backup deletion or physical erasure. The relay performs no compaction or retention based on ACKs in V1.

A newly issued credential must pull from zero; its supplied cursor cannot exceed its persisted delivered frontier. Migration from schema 1 preserves previously issued credentials' saved cursors by conservatively initializing their delivery upper bound to the existing journal's latest sequence, because the old relay did not track delivery. Their processed cursor starts at zero. All newly issued devices start with a zero delivery bound. Delivery is an upper bound on pages offered, not proof that a network reply arrived; only the client ACK indicates durable processing.

A changed server epoch pauses sync while retaining local and outgoing work. Neither API permits a client to manufacture a new epoch. An older backup must not be restored into production without the separate epoch/recovery procedure, which remains unfinished.

### Budgets and failure behavior

Default account limits are 1 GiB of serialized envelope/header JSON, 1,000,000 active encrypted operations, and 64 installation identities. Revoked identities still count because immutable records retain their authors. Purged identity rows retain byte usage but cease counting as active encrypted operations; certificates count. Limits apply to the personal relay's one account. Exact retries neither consume additional quota nor fail merely because the budget is full or has since been lowered. A normal batch that would cross a limit rolls back all its new operations and usage updates and returns HTTP 507 without acknowledgements. Atomic purge permits net cleanup under a lowered quota; growing metadata still must fit. Clients keep pending work and show a storage/budget error.

Change budgets on an existing database with:

```sh
./target/debug/synk-server --database work/relay.sqlite set-limits \
  --max-journal-bytes 1073741824 --max-operations 1000000 --max-devices 64
```

The running relay reads the persisted limits inside each insertion transaction. Lowering limits preserves existing records. Usage is backfilled during migration and maintained by SQLite triggers. These are **envelope bytes**, not physical SQLite/WAL disk consumption; disk monitoring remains necessary. Sequence exhaustion also rejects new operations without reusing old sequences. No journal compaction is implemented.

### Resource bounds and shutdown

The relay uses one SQLite connection, WAL, FULL synchronous commits, foreign keys and a five-second busy timeout. It admits at most 32 active HTTP handler requests and 32 notification sockets. Saturation returns HTTP 503; pull still works when only socket capacity is reached. Handlers have a 15-second timeout and a 1 MiB request-body cap. Notification authentication must arrive within five seconds; frames/messages are capped at 4 KiB, read buffering at 4 KiB and write buffering at 8 KiB. Socket sends have a five-second timeout. Notifications remain hints; reconnection always requires pull.

SIGTERM and Ctrl+C stop admission, signal notification sockets, drain handlers and close the database pool. Tests verify clean exit and reopening with unchanged epoch and an intact journal. This is automated real-process evidence, not launchd/reboot/Tailscale acceptance. The handler/socket caps do not claim to bound all TCP connections waiting to supply HTTP headers.

SQLx refuses modified checksums or unknown applied migrations. Back up before upgrading; do not edit an applied migration or downgrade a migrated database into an older-schema binary. Upgrade the relay before deploying this client, which requires `/v1/sync/ack` and the schema-4 key APIs. An older relay returns a visible upgrade-required error and clients retain pending work. A schema-5 relay without purge remains compatible with the current client. The first purge requires upgraded push/pull/rekey consumers through an explicit capability header; current clients support erasure consumption. Rotation closes fresh old-epoch insertion with HTTP 412; exact already-committed envelopes, including matching purged receipts, remain retryable. Client key adoption, safe missing-envelope re-encryption and rotation controls are implemented; native acceptance remains pending. `GET /v1/keys/state` includes the authenticated account and own highest committed/reserved author counter/operation ID, including purged receipt rows, so an empty/reset profile cannot silently register a replacement wrapping identity for an existing author. Future compaction must preserve that frontier and immutable identity evidence.

<a id="pairing"></a>

## Pairing and local key handling

The first trusted profile still starts with a private credential file issued by the relay CLI. It creates a random 256-bit content key locally, derives a separate stable history-index key, and exports recovery material separately from replica exports. Later profiles can join using a single-use private pairing bundle from the trusted profile's dashboard.

### Bundle and registration

`POST /v1/pairing/invites` authenticates the existing installation and returns a random 256-bit invitation token with a server-clock expiry 15 minutes later. The relay stores its SHA-256 hash, issuer and expiry. The dashboard creates a version-2 bundle with the account/endpoint/server epoch, current content epoch, complete historical root ring and stable history-index key. Version-1 epoch-1 bundles remain accepted. Keys never enter the invitation request or registration request. Transfer the bundle through a private channel; it grants access to account content. Delete transfer copies after use. The invitation expires, but the encryption keys inside the bundle remain sensitive after expiry. Server backups cannot replace a missing content key.

The receiving profile validates the bundle and endpoint, requests only the selected Tailscale host permission, and persists a fresh installation UUID, random 256-bit API credential and independent P-256 wrapping identity **before** registration. The request carries the invitation token, expected account/server epoch, new installation ID/name, API credential and public wrapping identity/proof/epoch. It carries no content/index root or private wrapping key. Device registration and invitation consumption commit together, and the relay stores only the API credential hash and a hash of the exact claim.

One new claim can consume an invitation. A different claim is rejected, including changed names or secrets. An exact committed claim can retry until one hour after the invitation's expiry, supporting lost replies and local storage failures. Expired unused invitations never create an installation. Revoking the issuer invalidates its outstanding invitations and claim retries; revoking the paired installation rejects its retries. Budget failure rolls back both registration and invitation consumption so the same claim can retry after limits change.

There are at most 16 unclaimed active invitations and 64 recent invitation rows per account. Creation deletes rows whose retry window has elapsed. Device identity budgets still count revoked authors. A claim never overwrites an existing installation or credential.

### Local durability and recovery

IndexedDB state preserves the schema-6 pending enrollment store and adds dedicated root/identity and rotation-proposal stores, preserving earlier replicas, capture journals, counters and queues. Registration replies must match the saved identity, account, name and server epoch. Local enrollment, the full private root/identity state and deletion of pending setup secrets commit in one transaction. Older saved schema-6 claims keep their original registration body for exact retries and register a wrapping identity during key refresh after enrollment. Failed replies/writes and worker/database restarts keep the same claim. Competing starts cannot create two local identities; simultaneous exact completions converge on the same enrolled state.

The dashboard exposes pending profile name, endpoint, expiry and installation ID, without tokens or keys. Retry resumes the saved claim. Explicit discard first explains that the relay may already have committed it; revoke the stranded installation with `revoke-device --device-id …` if abandoning it. Discard affects setup secrets in an unenrolled profile, not an enrolled replica. After the one-hour claim-retry window, request a fresh bundle and explicitly resolve/discard the older attempt rather than silently minting another identity.

Invitations are bound to their issue-time content epoch. Unclaimed older invitations reject after rotation. An exact committed claim returns its original epoch during the retry window; if it registered a wrapping identity before a later rotation, the newly enrolled profile first adopts its recipient packets and then bootstraps encrypted records. The invitation is not a backup and ordinary replica exports exclude both the root/index keys and pending invitation secrets. Recovery-key exports remain separate.

### Security boundary and evidence

This build auto-unlocks from profile-local keys and stores decrypted replicas locally. It adds no local encryption at rest. API revocation cannot erase downloaded data or invalidate knowledge of old content/index keys. The dashboard can remove an installation and rotate future accepted content keys under the [rotation protocol](architecture.md#keys). Pairing and rotation still require joint native Helium acceptance.

The relay is now SQLite schema 4. Upgrade it before using pairing. Earlier protocol-1 clients/envelopes and schema-2 cursor ACKs continue to work at epoch 1. The [rotation protocol](architecture.md#keys) adds invitation epoch binding and immutable wrapping metadata. The current UI exports version-2 bundles and refreshes historical/current roots before synchronization. SQLx migration checksums remain immutable after application. Do not downgrade a migrated database without an isolated recovery procedure.

Evidence: 9 pairing TypeScript tests cover key exclusion, lost replies/reopen, atomic local storage failures, invalid replies/epochs, conflicting setup, endpoint/key/name validation, invitation construction, explicit discard and concurrent completion. Five added Rust tests cover single use/retry/reopen, expiry/revocation, retry grace, quota rollback/concurrent claim races and validation/invitation bounds. The ninth real-process integration test drops a committed registration reply, reopens both the relay and client, retries the identical claim and verifies encrypted synchronization with no keys/plain tokens in relay storage. The actual options components were exercised using synthetic pairing responses; retry reached the enrolled view and the 390 px preview had no horizontal overflow or warning/error logs. This is not native Helium acceptance.

<a id="keys"></a>

## Content-key rotation protocol

The extension persists independent wrapping identities, historical content roots and saved rotation proposals in IndexedDB state. The dashboard can remove installations and rotate future content keys, retry a saved proposal and export versioned private pairing/recovery bundles. Automated client/relay checks and a synthetic dashboard preview pass; joint native Helium acceptance and older-backup/server-loss recovery remain open.

### Recipient keys and proofs

Each installation generates an independent P-256 ECDH pair. Its private JWK must stay in its durable private state. Deriving it from the shared root would give a removed installation the wrapping secret. Public keys use canonical base64 of the 65-byte uncompressed SEC1 point. Clients validate the curve point and actual private/public ECDH agreement.

An installation identity contains `device_id`, `public_key`, `proof_epoch` and a 256-bit HMAC-SHA-256 `proof`. HKDF-SHA-256 derives the proof key from that epoch's root; salt is UTF-8 JSON `account_id`, info is `["helium-synk:v1", "installation-key-proof"]`. The authenticated bytes are UTF-8 JSON `[1, account_id, server_epoch, device_id, public_key, proof_epoch]`. Clients verify old identity proofs using the corresponding historical root before creating recipient packets. Registered wrapping identities are immutable; loss of the private key requires fresh enrollment.

Rotation generates an independent random 256-bit root. Each retained recipient gets a packet with a fresh ephemeral ECDH pair and random 96-bit AES-GCM nonce. The 256-bit ECDH output feeds HKDF-SHA-256, deriving an AES-256-GCM wrapping key. Salt is UTF-8 JSON `[account_id, server_epoch]`; info is `["helium-synk:v1:root-wrap", ...header]`. The plaintext is exactly 32 root bytes. GCM associated data is the UTF-8 JSON header:

```text
[version, rotation_id, account_id, server_epoch, issuer_id, from_epoch,
 key_epoch, recipient_id, recipient_public_key, ephemeral_public_key]
```

A separate HMAC-SHA-256 authenticates JSON `[...header, nonce, ciphertext]`. Its HKDF key uses the prior root, JSON account salt and info `["helium-synk:v1", "content-rotation-proof"]`. Recipients check exact context and this proof before decrypting. Another installation's private key cannot unwrap the root, even with the old shared root and public packets. The new root is never wrapped with the old root. Algorithm definitions follow the primary [WebCrypto specification](https://www.w3.org/TR/webcrypto/).

The relay controls API authorization and membership transactions. These proofs resist substitution by a relay that does not know content keys. **They do not protect against a malicious relay colluding with a removed installation that supplies its old roots**, which can forge HMAC proofs. Independently pinned signing identities or a signed membership authority would be needed for that stronger threat model. Keep this boundary explicit when completing the product gate. Revocation cannot erase downloaded data, old roots, stable history-index keys or captured URLs.

### SQLite schema 4 APIs

All APIs authenticate the active bearer token and recheck revocation in the transaction. Unknown fields, including accidental plaintext/private keys, reject. Earlier protocol-1 push/pull and ACKs still work at epoch 1.

| API                                | Behavior                                                                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/keys/identity`           | `{server_epoch, public_key, proof_epoch, proof}`. New identities require the current epoch; exact old registrations remain retryable. Conflicting replacements return 409.                               |
| `GET /v1/keys/state?after_epoch=N` | Account/server/content epoch, public installation metadata, own author frontier and only this recipient's packets after N. At most 32 packets with `has_more`. A client ahead of the relay must recover. |
| `POST /v1/keys/rotate`             | `{rotation_id, server_epoch, from_epoch, key_epoch, revoke_ids, packets}`. Advances exactly one epoch. Packets must cover every retained active installation exactly, using its immutable public key.    |
| `POST /v1/sync/rekey-check`        | `{server_epoch, key_epoch, envelopes}` from this author with distinct IDs/counters and older epochs. Returns complete `committed` sequence ACKs and `missing` IDs; changes no journal data.              |

One FULL SQLite transaction stores the request hash, encrypted packets, API revocations and new epoch. Failed packet writes roll everything back. Missing wrapping keys, changed membership, unknown/extra recipients and self-revocation reject. The caller's own packet is required. An exact committed retry returns its original result after restart or later rotations; changed contents with a reused ID reject. A competing rotation winner makes a stale proposal return 412. Notifications wake clients and recheck socket credentials after commit.

Epochs are bounded to 1–255 without wraparound. At most 256 installation identities and 254 rotations bound packets to 65,024 rows. Key metadata/packets are separate from envelope quotas; physical SQLite/WAL monitoring remains necessary. No packet/journal compaction is implemented. Epoch exhaustion needs an explicit recovery path.

### Offline records and immutable retries

Fresh journal inserts require the current epoch inside the insertion transaction; stale/future epochs return 412 with queues retained. Already committed exact old envelopes keep their original sequence ACK, even at a lowered quota. Changed committed IDs return 409. Newly accepted old-epoch ciphertext is therefore impossible after rotation.

Before replacing queued old ciphertext, the client proves that exact envelope never committed, using `rekey-check` at the current server/content epoch. Committed records are acknowledged as-is. Only missing IDs may be re-encrypted with the current root/fresh nonce and the same payload, operation ID and author counter. The client swaps ciphertext, journal and queue atomically, rejecting malformed/incomplete replies or changed local epochs. Since old insertion closes monotonically, delayed old requests cannot invalidate a missing proof. Later rotations require a fresh check, never overwriting committed records.

Historical roots remain necessary for historical accepted content and identity proofs. The history-index key stays separate. Captured but uncommitted content can move to a new epoch; accepted historical content remains decryptable with old roots. This protects future accepted ciphertext and cannot undo content previously captured or downloaded by a compromised installation.

Invitations are bound to their issue-time content epoch. New claims against older invitations reject after rotation. Exact committed claims retain the normal retry window and return their original epoch; keyed claims can then retrieve later packets. Optional public-key/proof/epoch fields participate in the immutable claim/device transaction; new claims after epoch 1 require them. Schema-3 claim hashes remain retryable after migration.

### Durable client lifecycle

Before registering a wrapping identity, the client saves its independent private key and public proof in a dedicated secret store. An exact registration can retry after a lost reply or database reopen. Existing replicas migrate without resetting counters or queues. Missing private keys or conflicting public identities pause synchronization and require fresh enrollment. Ordinary replica exports and status omit private identities, root rings and pending rotation secrets.

A rotation proposal, including its generated root and exact recipient packets, commits locally before HTTP. A lost reply preserves the same proposal. Refreshing keys adopts the client's authenticated recipient packet and saves the new root/current epoch together; the client verifies its own packet agrees with its proposal before declaring completion. Normal synchronization resumes a still-current proposal. Changed membership or a competing committed rotation requires explicit review before replacing a stale proposal. Replacing a proposal cannot undo a removal that already committed.

Key refresh runs before pull/push. Historical ciphertext uses the matching historical root; metadata/packet tampering, missing or skipped roots, incomplete pagination and a rolled-back server epoch stop progress. Old queued ciphertext uses the relay's complete committed/missing proof before replacement. The journal and outbox swap in one transaction with a current-epoch guard, preserving payload, operation ID and author counter. Committed ciphertext stays unchanged. Unencrypted capture drafts use the current root when prepared; concurrent epoch/draft changes leave them retryable. The separate history-index key remains stable.

Version-2 private pairing and recovery bundles contain the complete root ring, current epoch and stable history-index key. They contain no existing installation credential, private wrapping identity or author counter. Recovery requires a fresh CLI-issued installation credential, creates a new wrapping identity and starts a distinct author at counter 1. Do not copy an enrolled installation credential to a new profile. Key-state metadata exposes that author's highest committed counter/operation ID, letting clients reject missing local author state before registering a new wrapping identity. A cloned profile with existing private secrets is not a supported independent installation.

Save a fresh private recovery bundle after a rotation. A stale bundle cannot bootstrap a newly issued installation into epochs for which it lacks roots; the relay cannot recover them. The original unversioned recovery export is accepted only for epoch-1 recovery. Reset/restore never reuses an author identity with reset counters. Fresh 96-bit random nonces and distinct installation/domain keys remain part of the encryption contract. Future journal purge/compaction must preserve author-frontier and immutable-retry evidence independently of deleted envelope rows; the current frontier query relies on the uncompacted journal.

<a id="storage"></a>

## Local storage limits

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

These limits provide admission control. Optional [history expiry](architecture.md#retention) removes eligible acknowledged visit content through permanent deletion and ciphertext purge; V1 retains causal deletion metadata and uncompacted journals. Session retention, full-scale performance, general quarantine/capture-copy policy and older-backup/server-loss recovery remain open. Increasing a limit does not create free disk space. Existing local data, browser-owned bookmarks/history and active restoration progress are not discarded to meet a lowered storage limit.

Eleven new unit/database tests cover limits/reopening/export, atomic/concurrent boundaries, retained drafts/counters, clear at capacity, current-session coalescing, unavailable estimates, byte warnings, download rollback, erasure while full and queue draining while a page is refused. A real relay integration uses a simulated full storage estimate, proves queued upload commits exactly once while the cursor stays behind the refused page, then raises the limit and receives the missing records. This does not simulate a physically full Helium disk.

<a id="interface"></a>

## Interface and source conventions

Helium Synk uses the blue, navy and mint palette of its [logo](architecture.md#branding). All current pages share one dark-only theme: the WXT options dashboard, enrollment/recovery forms and temporary restoration page. Future web pages should reuse these tokens and components.

### Shared theme

`extension/styles/theme.css` defines Tailwind CSS 4 tokens and local fonts. `extension/wxt.config.ts` loads the official Tailwind Vite plugin. Both HTML entrypoints declare `class="dark"`; there is no light theme or appearance switch.

| Token                | Value     | Purpose                         |
| -------------------- | --------- | ------------------------------- |
| Background           | `#080e20` | Dark navy canvas                |
| Card                 | `#101b33` | Panels and confirmations        |
| Foreground           | `#eef3ff` | Main text                       |
| Muted foreground     | `#9daecc` | Supporting text                 |
| Primary / focus ring | `#4ae5cc` | Mint actions and keyboard focus |
| Brand blue           | `#5274fa` | Structure and status accents    |
| Brand navy           | `#0d1b47` | Logo-related background accents |
| Border               | `#283b5e` | Square outlines and dividers    |
| Destructive          | `#ff8e9b` | Errors and removal warnings     |

All radius tokens, including `xs` through `4xl`, resolve to zero. Use square cards, controls, badges, tabs and dialogs. The recognizable source logo retains its existing artwork. Typography is Manrope for interface text and IBM Plex Mono for metadata. Font files and their OFL license notices ship inside the extension; pages make no font requests to an external service.

### Components

`extension/components/ui` contains shadcn/ui components installed through the official CLI, using Radix primitives and the New York style. The registry settings are in `extension/components.json`. Controls, Field groups/labels/descriptions/errors, Card headers/content/footers, Item rows, Empty states, alerts, badges, tabs, checkboxes, disclosures and confirmations compose this toolkit. The options layout uses Tailwind utilities and `@apply`; the restoration page uses the same theme and cards/buttons directly.

Use `@/lib/utils` for `cn` (`clsx` and `tailwind-merge`). Keep async request/error handling in the existing panels. Confirmation dialogs use accessible titles/descriptions, move initial focus to cancellation and preserve pending/error/retry behavior. Native selects use explicit labels and IDs. Disclosures use `type="button"` so opening recovery settings cannot submit enrollment.

### Spacing and composition

Use a `Field` for each label/control pair and `FieldGroup` for a form. Place helper text in `FieldDescription`, associate it through `aria-describedby`, and put field failures in `FieldError`. Use horizontal Fields for checkboxes. Do not wrap inputs inside a label or add global label/form-button margins. The shared field gap is 8 px, grouped fields use 24 px, content/action groups use 12–16 px, and standard inputs/selects/buttons are 40 px tall. Adjacent controls share a top edge; helper text stays below its own control.

Compose panels with Card headers, titles, descriptions, content and footers. Use Item content/actions for linked setup/settings/device rows and Button `asChild` for action links. Keep semantic headings and native labels. Custom Tailwind layout is appropriate for navigation, responsive grids and domain-specific timelines; avoid recreating available primitives. Check both closed and expanded disclosures, long titles/URLs and the 390 px layout.

### Page architecture

The options UI uses separate TanStack Router views for Home, Bookmarks, Sessions, History, Devices and Settings. Setup and advanced settings have focused routes; only the active page mounts. Use the shared status provider and existing background requests. Keep secrets out of route state, preserve durable pairing retry and keep secondary help in disclosures. See [the UX contract](architecture.md#navigation) for routes and verification boundaries.

### TypeScript aliases

Use `@/…` for extension source imports, for example:

```ts
import { Button } from '@/components/ui/button';
import type { Status } from '@/lib/messages';
import '@/styles/theme.css';
```

The extension TypeScript config maps `@/*` to its source root. The workspace TypeScript config and Vite+ test configs map it to `extension/`; WXT/Vite resolves `@` to that same directory. Keep those mappings aligned. Shared core imports continue to use the workspace package name `@helium-synk/core`. Relative CSS `@import`/`@source` paths follow CSS resolution rules.

Setup references: [shadcn Vite installation](https://ui.shadcn.com/docs/installation/vite), [Tailwind Vite integration](https://tailwindcss.com/docs/installation/using-vite), and [WXT Vite configuration](https://wxt.dev/guide/essentials/config/vite).

<a id="branding"></a>

## Helium Synk logo and favicon

The Helium Synk mark is derived from the official Helium icon supplied at `/Applications/Helium.app/Contents/Resources/app.icns`. It keeps the blue rounded square and white six-spoke emblem and adds two mint sync arrows. It is a project-specific derived mark. The installed application icon was read only.

### Assets and usage

| Asset                                               | Purpose                                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------------------- |
| `assets/branding/helium-synk-master.png`            | Original generated 1254 × 1254 RGBA master, with transparent outer background |
| `extension/public/icons/{16,32,48,128,256,512}.png` | Downscaled transparent PNG assets                                             |
| `extension/public/favicon.ico`                      | Multi-resolution 16/32/48 px favicon                                          |

The WXT build supplies 16/32/48/128/256/512 px installation icons and 16/32 px toolbar icons. The options dashboard uses the 128 px asset rendered at 55 px desktop/40 px narrow widths. Its adjacent wordmark names the application, so the image has an empty alt attribute. Both options and restoration pages declare PNG/ICO favicons. The high-resolution master stays outside the public directory so it is not bundled into the extension.

The built-in image generation tool produced the master using the extracted official icon as its edit target. Pillow with Lanczos resampling produced the PNG sizes and ICO container without changing the artwork. These are raster assets; no vector source is implied.

<a id="navigation"></a>

## Guided setup and page navigation

The earlier options page mounted setup, pairing, key rotation, storage, diagnostic notes and all three collections together. Its navigation only scrolled to sections. Users had to interpret credential JSON and recovery keys, distinguish first enrollment from pairing, and find the next step among unrelated controls.

The options page now uses separate TanStack Router views. Setup presents two choices: connect another device using an invitation, or set up the first device using a server-issued connection file. Recovery has its own form. File selection is the primary input; pasting file contents is an optional disclosure. Keys never enter a URL or UI persistence store. Each successfully configured profile is directed to collection choices; collection remains opt-in.

### Toolbar popup

The compact `popup.html` shares the dark square theme and shadcn primitives. It shows this profile's connection/pending state and Sync now, plus collection shortcuts and Open Helium Synk / Connect another device. Shortcuts open the corresponding options route in a tab and close the popup. Collection navigation does not enable capture. Empty installations offer Set up sync; saved pairing attempts offer Finish connecting. Worker failures preserve retry and dashboard access. The popup reuses the existing guarded status polling provider; it owns no durable sync state and adds no browser permissions.

### Routes

| Route                   | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `/`                     | Connection summary and collection shortcuts                            |
| `/bookmarks`            | Preview/enable the shared collection and resolve interrupted additions |
| `/sessions`             | Browse current, closed and previous sessions by source                 |
| `/sessions/$snapshotId` | Review one saved session and restore its tabs/windows                  |
| `/history`              | Search and remove synced visits; configure capture                     |
| `/devices`              | List linked profiles; no remote online-presence claim                  |
| `/devices/add`          | Create an invitation and show its transfer/import steps                |
| `/settings`             | Storage and retention; links to advanced tools                         |
| `/settings/recovery`    | Save encryption keys and local data separately                         |
| `/settings/security`    | Remove device access and rotate future content keys                    |
| `/settings/diagnostics` | Server/browser details and test messages                               |
| `/setup`                | First device versus another device choice                              |
| `/setup/first`          | Server-issued connection file                                          |
| `/setup/join`           | Invitation file, recognizable name, saved-attempt retry                |
| `/setup/recover`        | Fresh connection file plus private recovery file                       |
| `/setup/collections`    | Choose what to enable after configuration                              |

The packaged entrypoint remains `options.html`. [Hash history](https://tanstack.com/router/latest/docs/guide/history-types) keeps routes inside that file without server rewrites, so reloading a deep link works in the extension. A small [code-defined route tree](https://tanstack.com/router/latest/docs/routing/code-based-routing) mounts only the selected page. Old section links such as `#history` normalize to `#/history`. Navigation has an active state, a skip-to-content link, page titles and focus/scroll updates.

### Boundaries and safeguards

One shared provider polls the existing background status every two seconds. It suppresses overlapping polls and prevents an older poll result from replacing a newer action result. Changing pages does not change the database, installation identity, capture settings or synchronization coordinator. Forms discard unsent secrets on unmount; pending pairing claims remain in the existing durable background store, with retry and reviewed discard preserved.

Files are limited to 1 MiB, parsed locally, and sent through the existing validated enrollment/pairing APIs. Failed or superseded reads do not retain a previous file's contents. First enrollment creates keys locally; later devices use private invitations. Recovery still requires a fresh installation credential. The server owner's CLI instructions are optional help; running a server remains a technical prerequisite, not an automated hosting flow.

Home offers Open for any collection with saved data, including paused collections; empty disabled collections offer Set up. Opening a saved collection does not enable capture.

Saved-session details have their own route, so View places restore controls at the top of the page. Restoration progress for that snapshot appears before its tab list. Session type/source filters are URL search parameters; the Back link, browser Back and direct reload preserve them. Missing snapshots have an explicit error, retry and return link. The list unmounts while details are open, and obsolete detail responses cannot replace a newer selection.

History setup defaults to **New visits only**; importing older visits remains an explicit choice. Bookmark merging still requires a preview and saving its recovery copy. Removal warnings describe live synced-record erasure and the native/backup copies that remain. Device removal and key rotation keep their existing review/retry behavior.

### Component and spacing revision

Forms now compose official shadcn Field/FieldGroup/FieldLabel/FieldDescription/FieldError components. Labels/control gaps are 8 px, standard single-line controls are 40 px tall, and helpers follow the control instead of extending its label. This fixes the History textarea/select offset and inconsistent filter labels. Cards use headers/content/footers; setup/settings/device navigation uses Item rows and action links use Button composition. Empty views use Empty components. Conflicting global label/button margins and obsolete page styles were removed; square dark logo tokens remain shared with restoration.

<a id="retention"></a>

## Retention

History expiry is off by default and accepts 1–3,650 days (initially 90). Only a source expires its own acknowledged visits, using their original visit time and a strict cutoff. Pending uploads and duplicate pending native identities stay protected. Each pass examines at most 500 indexed candidates and selects at most 100 visits, grouped into proofs of at most 80 identities. Deletion proofs, local content cleanup and scan progress commit atomically. The existing authenticated history purge replaces matching live client/relay ciphertext with digest/header receipts; late re-import and original-envelope replay remain suppressed. Native browser history, independently retained exports, historical backups and old SQLite/WAL pages can retain copies.

Session archive expiry is off by default with 30 days, 100 archives and 50 MiB serialized snapshot content per source. Valid ranges are 1–3,650 days, 1–10,000 archives and 1–1,024 MiB. The combined pool includes closed, explicitly saved previous and superseded current snapshots. The latest complete current snapshot is excluded. Oldest eligible snapshots expire first by capture time, source revision and UUID. Age uses a strict original-time cutoff; count/size pressure can select newer archives.

Drafts, incomplete assemblies, any unacknowledged multipart fragment, the last published current snapshot while a replacement uploads, and running/blocked local restoration jobs stay protected. Protected work can exceed limits. A peer’s policy cannot expire another owner’s archives. A remote owner’s expiry leaves an already active peer restoration’s embedded data intact. New jobs atomically reject expired snapshots.

One encrypted session schema-2 expiry operation binds at most 100 source-owned snapshot identities, original counter ranges, kinds and part counts. Proof, projection, counter reservation, plaintext receipt conversion and terminal-job cleanup commit atomically. Expired native-close receipts keep only identity/time metadata and SHA-256 content fingerprints, including upgraded legacy fingerprints, preventing re-import. No ciphertext is rewritten by logical expiry. Live client/relay encrypted session copies, independent exports/backups, filesystem snapshots and old database pages remain. Session caps describe retained visible content, not physical disk or total journal size.

Policies persist per profile and appear in replica exports. The Settings page exposes both policies using square shadcn controls. Enabling session expiry requires every connected extension to be updated first: older clients reject schema-2 payloads and pause their pull page. Disabling expiry or raising limits does not undo prior expiry. Offline sources/peers retain copies until reconnect; several passes may be necessary. V1 has no journal compaction. Full journal/protection scans remain a scale limitation.
