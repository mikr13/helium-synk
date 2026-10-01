# Content-key rotation protocol

This checkpoint verifies the cryptographic primitives and SQLite relay boundary. **The extension does not yet persist wrapping keys, adopt packets, rekey its outbox or expose rotation controls.** Ordinary accounts remain at epoch 1. Do not invoke the internal rotation API on an account used by the current extension. Client durability, private pairing/recovery bundles and dashboard verification are next; section 8's rotation gate remains open.

## Recipient keys and proofs

Each installation generates an independent P-256 ECDH pair. Its private JWK must stay in its durable private state. Deriving it from the shared root would give a removed installation the wrapping secret. Public keys use canonical base64 of the 65-byte uncompressed SEC1 point. Clients validate the curve point and actual private/public ECDH agreement.

An installation identity contains `device_id`, `public_key`, `proof_epoch` and a 256-bit HMAC-SHA-256 `proof`. HKDF-SHA-256 derives the proof key from that epoch's root; salt is UTF-8 JSON `account_id`, info is `["helium-synk:v1", "installation-key-proof"]`. The authenticated bytes are UTF-8 JSON `[1, account_id, server_epoch, device_id, public_key, proof_epoch]`. Clients verify old identity proofs using the corresponding historical root before creating recipient packets. Registered wrapping identities are immutable; loss of the private key requires fresh enrollment.

Rotation generates an independent random 256-bit root. Each retained recipient gets a packet with a fresh ephemeral ECDH pair and random 96-bit AES-GCM nonce. The 256-bit ECDH output feeds HKDF-SHA-256, deriving an AES-256-GCM wrapping key. Salt is UTF-8 JSON `[account_id, server_epoch]`; info is `["helium-synk:v1:root-wrap", ...header]`. The plaintext is exactly 32 root bytes. GCM associated data is the UTF-8 JSON header:

```text
[version, rotation_id, account_id, server_epoch, issuer_id, from_epoch,
 key_epoch, recipient_id, recipient_public_key, ephemeral_public_key]
```

A separate HMAC-SHA-256 authenticates JSON `[...header, nonce, ciphertext]`. Its HKDF key uses the prior root, JSON account salt and info `["helium-synk:v1", "content-rotation-proof"]`. Recipients check exact context and this proof before decrypting. Another installation's private key cannot unwrap the root, even with the old shared root and public packets. The new root is never wrapped with the old root. Algorithm definitions follow the primary [WebCrypto specification](https://www.w3.org/TR/webcrypto/).

The relay controls API authorization and membership transactions. These proofs resist substitution by a relay that does not know content keys. **They do not protect against a malicious relay colluding with a removed installation that supplies its old roots**, which can forge HMAC proofs. Independently pinned signing identities or a signed membership authority would be needed for that stronger threat model. Keep this boundary explicit when completing the product gate. Revocation cannot erase downloaded data, old roots, stable history-index keys or captured URLs.

## SQLite schema 4 APIs

All APIs authenticate the active bearer token and recheck revocation in the transaction. Unknown fields, including accidental plaintext/private keys, reject. Earlier protocol-1 push/pull and ACKs still work at epoch 1.

| API                                | Behavior                                                                                                                                                                                              |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/keys/identity`           | `{server_epoch, public_key, proof_epoch, proof}`. New identities require the current epoch; exact old registrations remain retryable. Conflicting replacements return 409.                            |
| `GET /v1/keys/state?after_epoch=N` | Current server/content epoch, public installation metadata and only this recipient's packets after N. At most 32 packets with `has_more`. A client ahead of the relay must recover.                   |
| `POST /v1/keys/rotate`             | `{rotation_id, server_epoch, from_epoch, key_epoch, revoke_ids, packets}`. Advances exactly one epoch. Packets must cover every retained active installation exactly, using its immutable public key. |
| `POST /v1/sync/rekey-check`        | `{server_epoch, key_epoch, envelopes}` from this author with distinct IDs/counters and older epochs. Returns complete `committed` sequence ACKs and `missing` IDs; changes no journal data.           |

One FULL SQLite transaction stores the request hash, encrypted packets, API revocations and new epoch. Failed packet writes roll everything back. Missing wrapping keys, changed membership, unknown/extra recipients and self-revocation reject. The caller's own packet is required. An exact committed retry returns its original result after restart or later rotations; changed contents with a reused ID reject. A competing rotation winner makes a stale proposal return 412. Notifications wake clients and recheck socket credentials after commit.

Epochs are bounded to 1–255 without wraparound. At most 256 installation identities and 254 rotations bound packets to 65,024 rows. Key metadata/packets are separate from envelope quotas; physical SQLite/WAL monitoring remains necessary. No packet/journal compaction is implemented. Epoch exhaustion needs an explicit recovery path.

## Offline records and immutable retries

Fresh journal inserts require the current epoch inside the insertion transaction; stale/future epochs return 412 with queues retained. Already committed exact old envelopes keep their original sequence ACK, even at a lowered quota. Changed committed IDs return 409. Newly accepted old-epoch ciphertext is therefore impossible after rotation.

Before replacing queued old ciphertext, the client must prove that exact envelope never committed, using `rekey-check` at the current server/content epoch. Committed records are acknowledged as-is. Only missing IDs may be re-encrypted with the current root/fresh nonce and the same payload, operation ID and author counter. The client must swap ciphertext, journal and queue atomically, rejecting malformed/incomplete replies or changed local epochs. Since old insertion closes monotonically, delayed old requests cannot invalidate a missing proof. Later rotations require a fresh check, never overwriting committed records.

Historical roots remain necessary for historical accepted content and identity proofs. The history-index key stays separate. Captured but uncommitted content can move to a new epoch; accepted historical content remains decryptable with old roots. This protects future accepted ciphertext and cannot undo content previously captured or downloaded by a compromised installation.

Invitations are bound to their issue-time content epoch. New claims against older invitations reject after rotation. Exact committed claims retain the normal retry window and return their original epoch; keyed claims can then retrieve later packets. Optional public-key/proof/epoch fields participate in the immutable claim/device transaction; new claims after epoch 1 require them. Schema-3 claim hashes remain retryable after migration.

## Remaining client checkpoint and evidence

Persist wrapping identity and all roots outside ordinary exports/status. Save an immutable proposal before HTTP; recover lost replies through exact retry/own packet; retain old roots; export versioned private pairing/recovery bundles; safely rekey proven-missing queues and drafts; expose explicit device-removal/retry controls. A reset/restore must never clone an author identity with reused counters. Native lifecycle and recovery acceptance remain separate.

Seven crypto tests, eight new relay tests and one isolated real-process test cover substitution/tampering, private-scalar agreement, multiple epochs, fresh keys/nonces, atomic write failure, exact membership/concurrent rotations, old committed retries, rekey eligibility, invitation/claim retry, schema-3 migration, 32-packet pagination and all 254 rotations. The process test drops a committed reply, restarts, unwraps an offline retained recipient's key, rejects removed credentials, proves committed/missing work, accepts only re-encrypted offline content and confirms no roots/private scalars/plain tokens/plaintext in SQLite. Full checks: 158 TypeScript, 31 Rust and 10 real-process tests, typechecks/WXT, rustfmt/clippy and format/version checks.
