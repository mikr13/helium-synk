# Relay snapshots and restore guards

The relay can create a consistent private SQLite snapshot while serving. Restore marking changes the server epoch before a stopped database is served again. Surviving clients retain their replicas, queues and keys when an older or missing server rejects synchronization. Recovering missing acknowledged operations and resuming those clients remains unfinished; these commands do not reconstruct a lost relay.

## Create a snapshot

Use the same compatible relay version as the running service. Choose a private destination directory outside the checkout and synchronized folders. The destination must be a new filename; the command never replaces an existing backup.

```sh
/absolute/path/synk-server --database /private/data/relay.sqlite backup --output /private/backups/relay-2026-10-02.sqlite
sqlite3 /private/backups/relay-2026-10-02.sqlite 'PRAGMA integrity_check;'
```

Accept the artifact only when the command succeeds and the integrity result is `ok`. `VACUUM INTO` includes committed WAL content in an independent snapshot; the relay syncs the resulting file and parent directory before reporting success. Ordinary errors remove only the newly created output. Process interruption can leave an incomplete artifact, so check integrity before using it. Never copy just the main database file of a running WAL database. See [SQLite VACUUM INTO](https://sqlite.org/lang_vacuum.html#vacuuminto).

On Unix, the output is created with mode 0600. It contains encrypted records, credential hashes and operational metadata, including historical records that might since have been removed. It does not contain client content keys. Protect backup storage and separate private client recovery bundles. Daily scheduling, failure reporting, rotation, off-host storage and the final deletion-retention policy remain deployment work.

## Review an isolated restore

1. Preserve surviving client replicas and their current private recovery bundles. Keep pending work and deletion proofs intact.
2. Stop the relay that owns the target database. Restore into a separate private directory with a fresh filename and no leftover WAL/SHM files. Verify integrity before opening it.
3. Inspect the snapshot's recorded epoch, then mark that isolated database using the exact expected UUID:

   ```sh
   sqlite3 /private/restore/relay.sqlite 'SELECT server_epoch FROM settings WHERE id=1;'
   /absolute/path/synk-server --database /private/restore/relay.sqlite mark-restored --expected-epoch UUID-FROM-SNAPSHOT
   /absolute/path/synk-server --database /private/restore/relay.sqlite serve --port 4399
   ```

4. Use a separate loopback port for review. Do not reconnect daily-use profiles or replace the live service until missing operations, deletion proofs, membership and key generations have been reconciled through a verified recovery workflow.

Restore marking atomically generates a new epoch, resets sent/processed delivery progress and invalidates pending pairing invitations. It preserves account identity, credential hashes, operations, sequences, author counters and stored key-rotation records. A mismatched expected epoch or failed transaction leaves recovery state unchanged. Restart serving after marking so the process reads the new epoch.

The Unix CLI holds a process lease while serving or marking a database; competing current-version processes using its canonical path are refused. Older binaries do not honor this lease. Stop them explicitly before marking their database. The lease is an operational guard, not a replacement for private filesystem permissions or exclusive control of database copies/aliases.

## What surviving clients currently do

A changed epoch stops ordinary synchronization. An older snapshot can reject a newer key generation or cursor with HTTP 409 before returning an epoch page. A newly created relay after disk loss has another account and rejects old credentials. Those failures retain local content, pending drafts/envelopes, counters, keys and deletion proofs; they do not reset the client or authorize replay into an unrelated account.

The isolated real-process tests cover live WAL snapshots, integrity, private/no-overwrite output, stopped-database marking, an older backup followed by history erasure and key rotation, and server disk loss. Exact surviving exports and keys remain unchanged after rejected synchronization. Missing acknowledged journal replay, safe restore reconciliation/resume, physical power-loss/disk-full backup tests and native-browser recovery remain open gates.
