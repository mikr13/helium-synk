# @helium-synk/extension

## 0.2.0

### Minor Changes

- 3a6bedd: Authenticate content-free history deletion certificates, persist purge drafts/claims and exact encrypted requests in IndexedDB schema 10, and consume redacted relay pages. Remove certified local ciphertext/outbox/quarantine copies atomically with cursor and projection changes. Preserve target digests during key rotation and replace missing certificates only after an explicit relay proof. Verify retries, fresh bootstrap, failures and original-body non-resurrection. Native capture/backup erasure and storage/scale/recovery acceptance remain open.
- 3d1e9f3: Persist independent installation wrapping identities, historical roots and exact rotation proposals before network requests. Refresh/adopt keys before sync, recover lost rotation replies and re-encrypt only relay-proven missing offline records without changing operation identities or historical committed ciphertext.

  Add dashboard installation removal and explicit saved-proposal retry/review. Version-2 private pairing/recovery bundles preserve all content epochs and the stable history index; recovery requires a fresh installation credential and never clones author counters or private wrapping keys. Extend schema-4 key-state metadata with account/author-frontier validation. Upgrade the relay before this client, which requires the key APIs. Epoch-1 legacy pairing/recovery remains supported; ordinary exports/status exclude private key state.

  Native Helium acceptance and older-backup/server-loss reconciliation remain pending. Local automatic unlock/decrypted storage and the documented relay/membership trust boundary are unchanged.

- a0429bd: Add opt-in individual history capture with durable native-event context, bounded import/overlap/audit jobs, original timestamps, domain exclusions and pause/resume baselines. Extend encrypted push/pull and the SQLite relay with the history domain, retaining an independent account URL-index key in recovery material and validating HMAC tags. Add IndexedDB v5 timeline indexes and migration coverage that preserves pending work. Expose local text/source/date search, pagination and logical selected/source/global removal controls. Permanent content/ciphertext purge and real Helium acceptance remain pending.
- cf2d1e7: Add encrypted source-owned current, closed and previous session snapshots with durable multipart transport and conservative offline coalescing. Capture regular browser windows into a persistent cache, preserve closed windows during outages, and expose profile filters, saved snapshots and capture age. Restore selected tabs/windows through a durable marker-based journal with pins, order, groups, active selection, bounded progress and interruption recovery. Preserve existing v3 profile data in the IndexedDB v4 upgrade. The Rust relay accepts encrypted session envelopes; live Helium acceptance remains pending.
- 4cca83f: Add a WXT options dashboard for enrolling separate browser profiles, backing up the shared recovery key, and exchanging encrypted diagnostic notes with a durable offline queue. WebSocket hints and periodic reconciliation resume pending work after reconnect. Browser bookmarks, sessions, and history adapters are not included in this foundation build.
- abe48a9: Remove obsolete saved history capture jobs atomically with matching clear proofs, including paused capture. Scrub selected cached native metadata, retain unrelated saved visits, and prevent late native responses from recreating canceled jobs. IndexedDB schema 9 cleans existing jobs on upgrade; downgrade is unsupported. Complete history ciphertext erasure remains pending.
- 884a2a3: Replace suppressed history journal plaintext with local deletion receipts and cancel erased visits that have not yet been encrypted. IndexedDB schema 8 retains author counters, tombstones and original encrypted retries, including across key rotation and migration. This changes the local stored-operation payload shape; upgrading is required and downgrade is unsupported. Capture-copy cleanup, authenticated relay ciphertext purge and backup expiration remain pending, so history removal is not yet full content erasure.
- abc7bea: Add opt-in owner-driven history expiry with configurable original-visit age, durable bounded scan progress and pending/duplicate protection. Reuse permanent selected deletion and authenticated ciphertext purge, preserving pending uploads and causal receipts. Add square dark retention controls, restart/rollback/concurrency tests and real-relay expiry/bootstrap coverage. Session and backup retention remain open.
- a28c1b1: Persist per-profile storage limits and expose estimated usage, pending work, journal counts and warnings in the square dark shadcn dashboard. Gate new capture/download content transactionally while preserving retries, deletion, saved work and cursor progress. Allow queued uploads to drain when incoming content is refused at local capacity. Add boundary/restart/concurrency tests and a real-relay capacity recovery check. Retention, physical disk/full-scale and native acceptance remain open.
- 495a5d9: Add opt-in native bookmark synchronization with profile-local UUID mappings, conservative import previews and recovery backups. Persist captured events and their author revisions before asynchronous processing, apply browser changes through a durable effect journal, suppress matching echoes while retaining genuine edits, and pause ambiguous interrupted additions for explicit recovery. Expose local replica export and bookmark recovery controls. Require Chromium 134 for bookmark root capabilities; live Helium acceptance remains pending.
- 4d34eed: Connect additional browser profiles with private single-use pairing bundles. Encryption keys remain client-local; registration uses an expiring hashed invitation and a distinct hashed API credential. Persist the new claim before contacting the relay, retry identical claims across lost replies and restarts, and commit local enrollment atomically. The dashboard provides private bundle export, saved-claim retry and explicit discard review.

  Pairing requires SQLite relay schema 3 and migrates clients to IndexedDB schema 6. Upgrade the relay first. Local keys/decrypted data still auto-unlock from the profile; future-data key rotation and native Helium acceptance remain unfinished.

- 890bad2: Persist relay account quotas and delivery/processed progress, bound HTTP/WebSocket handling and drain cleanly on SIGTERM. A quota-rejected batch rolls back atomically; exact retries remain usable at the limit. Clients acknowledge only committed local journal cursors and retry lost replies after restart without confirming quarantined data or native browser effects.

  Upgrade the relay before this client: the client now requires the cursor-ACK API and the relay migrates to SQLite schema 2. Envelope protocol 1 remains supported for earlier clients. Budgets count serialized envelopes rather than physical disk usage; compaction, pairing/key rotation and native Helium acceptance remain separate gates.

- 5fb9842: Add opt-in source-owned session archive age/count/content-size expiry with durable encrypted proofs and current, pending-upload and restoration protection. Remove expired journal plaintext and guard restore creation against concurrent expiry. Ciphertext purge, settings controls and native retention acceptance remain pending; enable only after all clients support session expiry payloads.

### Patch Changes

- ae87613: Show a connection check while an enrolled profile starts, and direct post-rotation recovery to Settings → Recovery & backups.
- 36ec31a: Add a compact toolbar popup with sync status, pending changes, manual sync and shortcuts to the collection and setup pages.
- 93bea2c: Use a shared dark navy, blue and mint theme drawn from the Helium Synk logo, with square Tailwind/shadcn controls across enrollment, the dashboard and session restoration. Add accessible confirmation dialogs, keyboard tabs, packaged local fonts and consistent extension source aliases. Native Helium acceptance remains pending.
- 45f895d: Add an IndexedDB v2 bookmark journal, atomic capture drafts/replicas, startup-safe encryption, and encrypted bookmark transport through the Rust relay. Keep causal merge results and received cursors consistent, quarantine invalid records without advancing, and export replica/tombstone/pending state separately from credentials and recovery keys. Reconcile hints arriving during in-flight work and compare envelope identity independently of JSON member order. Pending counts include capture drafts. Native bookmark capture and application remain forthcoming adapters.
- f688edd: Open saved sessions on a focused page with visible restore controls and preserve list filters when returning.
- 1cee5fb: Replace the long options dashboard with separate TanStack Router pages for Home, Bookmarks, Sessions, History, Devices and Settings. Guide first-device setup, invitation pairing and recovery through focused file-based forms. Move recovery, device access and diagnostics to dedicated settings pages, preserve interrupted pairing retries, and default history setup to new visits only.

  Use shared shadcn Field, Item and Empty components, consistent Card sections and Button links. Correct label/control spacing, align history fields and storage rows, and keep narrow layouts usable with square dark controls.

- 9b2e6da: Add a Helium-derived logo with mint sync arrows to the dashboard and extension toolbar/installation icons. Include transparent PNG sizes and multi-resolution favicons for the options and restoration pages.
- 5df642d: Keep saved collections easy to open when collection capture is turned off.
- 1d00114: Preserve cached pins, ordering and group membership during late tab updates after a window disappears, while retaining captured URL/title changes. This keeps the closed-window archive from duplicating the recently-closed browser record during teardown.
- a437f25: Add independent installation ECDH key wrapping and authenticated content-epoch packets. Relay schema 4 commits exact recipient packets, API revocation and content-key epoch advancement atomically, preserves exact rotation retries and committed old envelopes, and proves uncommitted offline work before ciphertext replacement.

  Bind pairing invitations to content epochs and include optional immutable installation wrapping metadata in registration. The extension retains pending work on a changed content epoch; durable client key adoption, rotation controls and versioned private recovery/pairing bundles remain the next checkpoint. No rotation is exposed in ordinary profile use yet.

- Expose opt-in source-owned session archive retention in Settings, with current/pending/active restoration protection and explicit retained-ciphertext limits. Replace closed-session duplicate-detection URL/title copies with hashed receipts, including expired legacy records, preserving deduplication across restart. All connected clients must be updated before session expiry is enabled.
- Updated dependencies [f7d7fe5]
- Updated dependencies [0a26f8d]
- Updated dependencies [3a6bedd]
- Updated dependencies [45f895d]
- Updated dependencies [3d1e9f3]
- Updated dependencies [ba0497b]
- Updated dependencies [a0429bd]
- Updated dependencies [cf2d1e7]
- Updated dependencies [abe48a9]
- Updated dependencies [884a2a3]
- Updated dependencies [a4c17a0]
- Updated dependencies [abc7bea]
- Updated dependencies [89d1ef8]
- Updated dependencies [a28c1b1]
- Updated dependencies [495a5d9]
- Updated dependencies [1d00114]
- Updated dependencies [4d34eed]
- Updated dependencies [a437f25]
- Updated dependencies [890bad2]
- Updated dependencies
- Updated dependencies [5fb9842]
  - @helium-synk/core@0.2.0
