# Architecture

WXT/React client, durable IndexedDB, private Rust/Axum/SQLite relay. Protocol 1; client schema 12; relay schema 6.

Progress and gaps: [plan.md](plan.md). Setup: [setup-guide.md](setup-guide.md). Hosting: [deployment.md](deployment.md).

## Sync rules

- Collections start off. No passwords, cookies, native profile copying or iCloud.
- Independent contexts use separate accounts. Each installation has its own credential and author counters.
- Capture, queues and incoming cursor commits are durable. Retry immutable operations after outages.
- Pull before push. ACK only after local commits. WebSocket messages are hints; reconnect pulls missed records.
- Invalid records stop cursor progress. Account/epoch mismatch preserves data and queues; never reset counters to bypass it.

<a id="bookmark-merge"></a>

## Bookmarks

Logical UUIDs identify entries; native IDs stay local. Causal title/URL/placement merges converge and retain conflicts for recovery.

Deletion is permanent. Restore creates a new identity. Unseen children survive folder deletion; invalid parents use Recovered bookmarks.

<a id="bookmark-adapter"></a>

Preview and save a backup before opt-in. Match only unambiguous entries. Journal browser effects before execution; pause ambiguous recovery.

Root roles use Chromium capabilities, not names/IDs. Manifest floor: Chromium 134; actual tested versions are in the plan.

<a id="sessions"></a>

## Sessions

Source owns current, closed and previous snapshots. Only complete validated snapshots replace current data. Pending fragments survive restarts.

Restoration is explicit and local. Preserve source windows. Restore HTTP/HTTPS URLs without embedded credentials; skip unsupported URLs.

Restore jobs journal browser changes. Ambiguous interruption pauses for review. Cancel preserves opened tabs; browser restart invalidates native IDs.

Capture can miss transient activity before a durable commit. It is not a complete browser archive.

<a id="history"></a>

## History

Capture original visit timestamps and source identities. Default: new visits only; optional import: 0–365 days. Remote visits stay in Synk, not native History.

Pause/exclusions affect collection, not already shared records. Private visits are excluded. Durable deletion barriers suppress stale uploads/re-import.

<a id="history-erasure"></a>

Authenticated certificates remove matching live client/relay ciphertext and retain digest/header receipts. Exact retries remain valid.

No secure erasure guarantee for old SQLite/WAL pages, shared capture copies, exports, backups or offline downloaded copies.

<a id="relay"></a>

## Relay

Loopback only; authenticated account APIs; encrypted payloads and hashed credentials. SQLite WAL/FULL commits precede ACKs.

Defaults: 1 GiB envelope JSON, 1,000,000 active encrypted operations, 64 installation identities, including revoked identities. These are not disk limits.

HTTP 507 preserves queued work; exact committed retries still succeed. Graceful SIGTERM/Ctrl+C drains work. Content compaction retains sequence, digest and author/counter receipts; it never discards causal tombstones. Offline SQLite compaction requires a verified pre-compaction backup and the process lease.

Upgrade relay before clients. Never edit applied migrations or downgrade a migrated DB into an incompatible binary.

<a id="pairing"></a>

## Pairing

First installation uses a fresh CLI connection file. Additional installations use one-use invitations, valid 15 minutes.

Save enrollment identity before registration; retry the same claim after failure. Never clone credentials, private wrapping identities or counters.

Invitation files contain keys; transfer privately and delete used copies. Recovery needs current keys plus a fresh installation credential.

<a id="keys"></a>

## Keys

AES-256-GCM with fresh nonces and HKDF-derived keys. Stable HMAC history-index key. Independent P-256 wrapping identities distribute rotated content roots.

Removal blocks API access and rotates future content. It cannot erase downloaded content or old keys. Authorized malicious members remain a trust boundary.

Keep historical roots and save recovery again after rotation. Relay backups contain no client content keys. Local keys/decrypted caches are not encrypted at rest.

<a id="storage"></a>

## Storage

Defaults: estimated local bytes 512 MiB; pending work 100,000; journal records 500,000; capture tasks 30,000. Warn at 80%.

Capacity pauses new content, not saved retries/deletion. Lowering limits never deletes saved work. Browser estimates and `unlimitedStorage` do not guarantee disk space.

<a id="retention"></a>

## Retention

Expiry starts off and applies only to acknowledged source-owned records. Pending uploads, current snapshots and active restores stay protected.

- History: initially 90 days; range 1–3,650 days. Uses authenticated live ciphertext purge.
- Sessions: 30 days / 100 archives / 50 MiB per source. Ranges: 1–3,650 days / 1–10,000 archives / 1–1,024 MiB.
- Session expiry removes visible/plaintext archive content, then source-authenticated compaction proofs replace live client/relay ciphertext with content-free receipts. Protected work can exceed caps.
- Update the relay, then every client before session expiry or bookmark compaction. Disabling expiry or raising limits does not restore expired data.

<a id="interface"></a>

## UI

Dark only; square Tailwind/shadcn controls. Shared theme, local fonts and accessible Field/Card/Item components. Align labels, controls and helpers.

Use `@/…` for extension imports; `@helium-synk/core` for shared core. Keep WXT, TypeScript and test aliases aligned.

<a id="branding"></a>

Helium-derived mark with mint sync arrows. Master: `assets/branding/helium-synk-master.png`; packaged icons/favicon: `extension/public/`. Theme: `extension/styles/theme.css`.

<a id="navigation"></a>

Hash-routed dashboard: Home, Bookmarks, Sessions, History, Devices, Settings. Popup shows status and opens the dashboard. Keep secrets out of routes.

## Detailed contracts

Source/tests are authoritative: [shared core](../sync-core/src/), [native adapters](../extension/), [relay](../server/src/) and [immutable migrations](../server/migrations/).

## Compaction contracts

Session schema 3 certificates bind each erased fragment’s identity, metadata, content epoch and original envelope digest. Only the source can compact its expired fragments. Bookmark schema 2 certificates bind revision-only receipts for acknowledged, causally superseded edits/moves/reorders. Selection preserves births, removals, current field winners and every concurrent alternative, including deleted-node recovery state. Queued/draft/quarantined work is protected. Bookmark compaction is an explicit user action because superseded recovery versions are removed; each action processes bounded batches (at most 2,000 targets; repeat for larger journals).

The existing purge-intent/claim tables and relay redaction/target-set tables serve all three content domains. Certificates and receipt updates commit atomically. Lost replies retry the same cipher/target set; old original envelopes match digest receipts without restoring ciphertext. Late and fresh clients validate encrypted certificates before accepting redactions or advancing cursors. Capability headers gate incompatible readers once compaction is used. Old receipt sequences and causal metadata are retained, so no offline-age cutoff or forced stale-client reset is introduced. Quarantined target copies are removed only with an authenticated matching certificate; unresolved unrelated records stay available for review.

Metadata still consumes storage and counts toward byte/journal budgets; compaction is not a physical disk-space guarantee, secure erasure, or general deletion of old backups. Ciphertext removal makes SQLite pages reusable; stopped-server `compact` runs VACUUM after a verified backup to reclaim free pages. Filesystem snapshots, external exports and historical backups remain independent copies.

## Relay reconstruction

A surviving profile prepares a durable private proposal containing a new server epoch, independent future root and proof for its wrapping identity. Its exported replay includes encrypted records, certified receipts and immutable public purge request sets, but no content roots. Optional peer rebuild files are authenticated/decrypted locally with the existing historical keys before their operation sets are merged; conflicting identities/counters fail closed. The manifest covers the sorted replay and purge target sets. Re-exporting an unchanged proposal is idempotent; changed data refreshes the proposal and preserves previously merged peer data.

The offline `rebuild` command validates the account/manifest, reconstructs a private staging database, retains operation IDs/counters/digests and revokes every historical author except the exporting source. It verifies SQLite integrity before atomically creating a new destination. Existing databases/backups are never overwritten. A future key epoch replaces stale membership/key packets; the original client retains every historical content key. The relay has no plaintext content roots.

Only explicit adoption of the matching authenticated recovery receipt resets delivery cursors/sequences and adopts the saved future root. Author counters, native mappings and pending work remain. New acknowledged data after export blocks adoption until the replay is refreshed; in-flight old-epoch pulls/pushes cannot overwrite the adopted epoch. Other survivors keep their original data, but must join again with fresh invitations/credentials. Records missing from every supplied survivor remain unrecoverable; key files alone do not reconstruct lost content. The old relay must stay stopped after cutover to avoid independent histories.
