# History ciphertext erasure protocol

The schema-5 relay and schema-10 client implement atomic ciphertext replacement with authenticated deletion certificates and durable identity receipts. The extension advertises erasure capability, resumes saved purge requests and consumes redacted pages. Complete history erasure remains open for unresolved/shared native capture copies, quarantine policy and old-backup recovery/expiration.

## Atomic purge

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

## Digest and retry identity

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

## Pull and compatibility

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

## Budgets and remaining copies

Envelope-byte usage includes retained header placeholders and encrypted certificates. Purged identities cease counting as active encrypted operations; certificates count. A full/lowered quota permits net cleanup that does not grow either exceeded resource. Growing metadata must fit the budget or the entire request returns HTTP 507. Sequence exhaustion rejects before inserting. Bytes describe envelope/header JSON, not physical SQLite/WAL or separate digest/request tables.

This removes ciphertext from the **live SQL journal**. It does not securely erase old SQLite/WAL pages, filesystem snapshots, downloaded client copies or independent backups/exports. Certified target copies in local journals/outboxes/quarantine are removed. Unresolved/shared native inventory copies, general quarantine retention, backup expiration and restoring old erasure state remain open. This API completes no whole history/privacy/milestone gate.

Nine added Rust tests cover digest interoperability, authentication/revocation, target/request validation, schema-4 preservation, missing own reservations, restart/rekey/frontiers, rollback, quotas, bounded pages/ACKs and concurrency. A real Rust-process integration discards a committed reply, restarts, retries exactly, inspects live SQL, rejects changed original ciphertext and bootstraps from zero. Its opaque certificate fixture proves relay behavior, not extension proof validation or complete erasure.

## Client certificate and key lifecycle

`history-erasure` schema 1 contains the certificate operation ID/revision and 1–100 targets, each holding an `erased-visit` receipt, original encryption epoch and original envelope digest. At most 80 distinct native visit identities fit one certificate; larger cleanup uses multiple bounded requests. Receipts retain source UUID, opaque URL tag, generation, original operation/revision and composite native ID/time identity. They contain no original URL, title, source name, transition, referring ID, nonce or ciphertext. The selected-deletion proof is derived from these target identities and the certificate revision. It can be verified before the original clear arrives; no old visit content or full clear proof is copied into a certificate.

Original headers are derived from authenticated receipts and compared with public redacted slots. Cross-domain counter/identity checks include retained original headers and unpublished private receipts. Exact old envelope replay can validate against a retained digest but cannot restore erased local content. Public slot tampering, conflicting known digests/receipts or reused counters stop cursor progress.

Claims protect original ciphertext from concurrent outbox rekey. After a content rotation, a saved certificate is replaced at the new epoch only after an explicit relay proof that it is missing. A committed certificate keeps its exact old request for retry. Replacement updates the local operation and request together, preserving IDs/counters and original target epochs/digests. Historical content roots remain available for certificate verification. Changed restore epochs pause requests with saved work retained.

Twenty new client model/database tests cover encrypted proof validation, fresh bootstrap, old replay, known digest conflicts, cross-domain counter reuse, atomic cleanup/cursor rollback, lost replies/reopening, concurrent claims, bounded batching, unpublished encrypted targets, rotation proofs and changed epochs. The real cross-stack history test discards a committed client purge reply, restarts both databases/process, recovers via authenticated pull, verifies local/SQL ciphertext removal and fresh-profile bootstrap, and confirms old exact retries cannot resurrect ciphertext. These tests use simulated IndexedDB/browser ports; native Helium and physical/backup deletion remain separate gates.
