# Relay protocol and durable progress

Protocol version 1 uses client-encrypted envelopes and account-scoped author identities. The relay schema is version 4, including single-use pairing and the [content-key rotation protocol](key-rotation.md); see the [pairing contract](pairing.md). `/health/ready` reports protocol, schema, package and linked SQLite versions; `/v1/status` requires the installation's bearer credential and reports account envelope usage/budgets, device counts, latest sequence and that installation's processed cursor, epoch and activity time. It exposes no browsing payloads or credentials.

## Cursor acknowledgements

After each valid page, the client commits decrypted records, domain journal/projections and the incoming cursor in one IndexedDB transaction. Only then does it POST `/v1/sync/ack` with `{ "server_epoch": "…", "cursor": 123 }`. The server authenticates the installation, checks the epoch and its delivered frontier, and commits monotonically increasing processed progress before returning `{ "server_epoch": "…", "processed_cursor": 123 }`.

`cursor > acknowledged_cursor` is the client's durable retry intent. A lost server reply, worker restart or failed local ACK write repeats the same cursor. The client verifies the live epoch before retrying. Invalid ciphertext, quarantine and rolled-back transactions cannot advance processed progress. A later invalid page does not invalidate earlier committed pages. Push acknowledgements only confirm relay storage and remove matching outbox entries; they never advance the incoming cursor.

These ACKs confirm durable **journal processing**, including persisted session fragments. Native bookmark application and session restoration have independent journals and progress. An ACK does not attest to completed browser effects, complete multipart snapshots, backup deletion or physical erasure. The relay performs no compaction or retention based on ACKs in V1.

A newly issued credential must pull from zero; its supplied cursor cannot exceed its persisted delivered frontier. Migration from schema 1 preserves previously issued credentials' saved cursors by conservatively initializing their delivery upper bound to the existing journal's latest sequence, because the old relay did not track delivery. Their processed cursor starts at zero. All newly issued devices start with a zero delivery bound. Delivery is an upper bound on pages offered, not proof that a network reply arrived; only the client ACK indicates durable processing.

A changed server epoch pauses sync while retaining local and outgoing work. Neither API permits a client to manufacture a new epoch. An older backup must not be restored into production without the separate epoch/recovery procedure, which remains unfinished.

## Budgets and failure behavior

Default account limits are 1 GiB of serialized envelope JSON, 1,000,000 operations, and 64 installation identities. Revoked identities still count because immutable records retain their authors. Limits apply to the personal relay's one account. Exact retries neither consume additional quota nor fail merely because the budget is full or has since been lowered. A batch that would cross a limit rolls back all its new operations and usage updates and returns HTTP 507 without acknowledgements. Clients keep pending work and show a storage/budget error.

Change budgets on an existing database with:

```sh
./target/debug/synk-server --database work/relay.sqlite set-limits \
  --max-journal-bytes 1073741824 --max-operations 1000000 --max-devices 64
```

The running relay reads the persisted limits inside each insertion transaction. Lowering limits preserves existing records. Usage is backfilled during migration and maintained by SQLite triggers. These are **envelope bytes**, not physical SQLite/WAL disk consumption; disk monitoring remains necessary. Sequence exhaustion also rejects new operations without reusing old sequences. No journal compaction is implemented.

## Resource bounds and shutdown

The relay uses one SQLite connection, WAL, FULL synchronous commits, foreign keys and a five-second busy timeout. It admits at most 32 active HTTP handler requests and 32 notification sockets. Saturation returns HTTP 503; pull still works when only socket capacity is reached. Handlers have a 15-second timeout and a 1 MiB request-body cap. Notification authentication must arrive within five seconds; frames/messages are capped at 4 KiB, read buffering at 4 KiB and write buffering at 8 KiB. Socket sends have a five-second timeout. Notifications remain hints; reconnection always requires pull.

SIGTERM and Ctrl+C stop admission, signal notification sockets, drain handlers and close the database pool. Tests verify clean exit and reopening with unchanged epoch and an intact journal. This is automated real-process evidence, not launchd/reboot/Tailscale acceptance. The handler/socket caps do not claim to bound all TCP connections waiting to supply HTTP headers.

SQLx refuses modified checksums or unknown applied migrations. Back up before upgrading; do not edit an applied migration or downgrade a migrated database into an older-schema binary. Upgrade the relay before deploying this client, which requires `/v1/sync/ack` and the schema-4 key APIs. An older relay returns a visible upgrade-required error and clients retain pending work. Earlier clients can still push/pull protocol-1 envelopes against the schema-4 relay at epoch 1. Rotation closes fresh old-epoch insertion with HTTP 412; exact already-committed envelopes remain retryable. Client key adoption, safe missing-envelope re-encryption and rotation controls are implemented; native acceptance remains pending. `GET /v1/keys/state` includes the authenticated account and own highest committed author counter/operation ID, so an empty/reset profile cannot silently register a replacement wrapping identity for an existing author. This frontier currently comes from uncompacted envelope rows: future purge/compaction must preserve it and immutable operation evidence separately.
