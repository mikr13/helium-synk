# @helium-synk/server

## 0.2.0

### Minor Changes

- c040c5a: Add a localhost-only Rust/Axum relay with hashed per-profile credentials, SQLite WAL/FULL durability, atomic idempotent upload batches, cursor-based downloads, authenticated WebSocket notifications, and credential revocation. Require SQLite with the WAL-reset fix. Initial enrollment uses a local administrative credential file; automated pairing, backup recovery, quotas, and browser-content domains remain future milestones.
- 45f895d: Add an IndexedDB v2 bookmark journal, atomic capture drafts/replicas, startup-safe encryption, and encrypted bookmark transport through the Rust relay. Keep causal merge results and received cursors consistent, quarantine invalid records without advancing, and export replica/tombstone/pending state separately from credentials and recovery keys. Reconcile hints arriving during in-flight work and compare envelope identity independently of JSON member order. Pending counts include capture drafts. Native bookmark capture and application remain forthcoming adapters.
- 3d1e9f3: Persist independent installation wrapping identities, historical roots and exact rotation proposals before network requests. Refresh/adopt keys before sync, recover lost rotation replies and re-encrypt only relay-proven missing offline records without changing operation identities or historical committed ciphertext.

  Add dashboard installation removal and explicit saved-proposal retry/review. Version-2 private pairing/recovery bundles preserve all content epochs and the stable history index; recovery requires a fresh installation credential and never clones author counters or private wrapping keys. Extend schema-4 key-state metadata with account/author-frontier validation. Upgrade the relay before this client, which requires the key APIs. Epoch-1 legacy pairing/recovery remains supported; ordinary exports/status exclude private key state.

  Native Helium acceptance and older-backup/server-loss reconciliation remain pending. Local automatic unlock/decrypted storage and the documented relay/membership trust boundary are unchanged.

- a0429bd: Add opt-in individual history capture with durable native-event context, bounded import/overlap/audit jobs, original timestamps, domain exclusions and pause/resume baselines. Extend encrypted push/pull and the SQLite relay with the history domain, retaining an independent account URL-index key in recovery material and validating HMAC tags. Add IndexedDB v5 timeline indexes and migration coverage that preserves pending work. Expose local text/source/date search, pagination and logical selected/source/global removal controls. Permanent content/ciphertext purge and real Helium acceptance remain pending.
- cf2d1e7: Add encrypted source-owned current, closed and previous session snapshots with durable multipart transport and conservative offline coalescing. Capture regular browser windows into a persistent cache, preserve closed windows during outages, and expose profile filters, saved snapshots and capture age. Restore selected tabs/windows through a durable marker-based journal with pins, order, groups, active selection, bounded progress and interruption recovery. Preserve existing v3 profile data in the IndexedDB v4 upgrade. The Rust relay accepts encrypted session envelopes; live Helium acceptance remains pending.
- a4c17a0: Add the schema-5 atomic history purge API with durable header/digest receipts, immutable certificate request bindings, exact original retries, preserved author counters and byte-bounded redacted pull slots. Purged identities retain byte usage but no longer count as active encrypted operations. Add the shared canonical envelope digest helper. Client certificate validation, purge scheduling and redacted-record consumption remain pending; the current extension does not activate this API.
- 4d34eed: Connect additional browser profiles with private single-use pairing bundles. Encryption keys remain client-local; registration uses an expiring hashed invitation and a distinct hashed API credential. Persist the new claim before contacting the relay, retry identical claims across lost replies and restarts, and commit local enrollment atomically. The dashboard provides private bundle export, saved-claim retry and explicit discard review.

  Pairing requires SQLite relay schema 3 and migrates clients to IndexedDB schema 6. Upgrade the relay first. Local keys/decrypted data still auto-unlock from the profile; future-data key rotation and native Helium acceptance remain unfinished.

- a437f25: Add independent installation ECDH key wrapping and authenticated content-epoch packets. Relay schema 4 commits exact recipient packets, API revocation and content-key epoch advancement atomically, preserves exact rotation retries and committed old envelopes, and proves uncommitted offline work before ciphertext replacement.

  Bind pairing invitations to content epochs and include optional immutable installation wrapping metadata in registration. The extension retains pending work on a changed content epoch; durable client key adoption, rotation controls and versioned private recovery/pairing bundles remain the next checkpoint. No rotation is exposed in ordinary profile use yet.

- 890bad2: Persist relay account quotas and delivery/processed progress, bound HTTP/WebSocket handling and drain cleanly on SIGTERM. A quota-rejected batch rolls back atomically; exact retries remain usable at the limit. Clients acknowledge only committed local journal cursors and retry lost replies after restart without confirming quarantined data or native browser effects.

  Upgrade the relay before this client: the client now requires the cursor-ACK API and the relay migrates to SQLite schema 2. Envelope protocol 1 remains supported for earlier clients. Budgets count serialized envelopes rather than physical disk usage; compaction, pairing/key rotation and native Helium acceptance remain separate gates.

- 09bf1bd: Add consistent private SQLite snapshots and stopped-database restore marking with an expected epoch and Unix process lease. Preserve account records and counters while invalidating stale delivery progress and pairing invitations. Document the remaining client replay and server-loss recovery work.

### Patch Changes

- f7d7fe5: Bound encrypted upload and download batches by bytes as well as record count so large records can drain below the relay body limit without skipped cursors. Report SQLite storage exhaustion with an explicit retryable response; retain client pending work until space is available and a retry commits successfully.
