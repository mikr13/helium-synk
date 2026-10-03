# Architecture

WXT/React client, durable IndexedDB, private Rust/Axum/SQLite relay. Protocol 1; client schema 10; relay schema 5.

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

HTTP 507 preserves queued work; exact committed retries still succeed. Graceful SIGTERM/Ctrl+C drains work. No journal compaction.

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
- Session expiry removes visible/plaintext archive content; encrypted client/relay copies remain. Protected work can exceed caps.
- Update every client before session expiry. Disabling expiry or raising limits does not restore expired data.

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
