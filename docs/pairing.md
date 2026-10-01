# Pairing and local key handling

The first trusted profile still starts with a private credential file issued by the relay CLI. It creates a random 256-bit content key locally, derives a separate stable history-index key, and exports recovery material separately from replica exports. Later profiles can join using a single-use private pairing bundle from the trusted profile's dashboard.

## Bundle and registration

`POST /v1/pairing/invites` authenticates the existing installation and returns a random 256-bit invitation token with a server-clock expiry 15 minutes later. The relay stores its SHA-256 hash, issuer and expiry. The dashboard adds the account/endpoint/server epoch and local content/history-index keys to the downloaded bundle. Keys never enter the invitation request or registration request. Transfer the bundle through a private channel; it grants access to account content. Delete transfer copies after use. The invitation expires, but the encryption keys inside the bundle remain sensitive after expiry. Server backups cannot replace a missing content key.

The receiving profile validates the bundle and endpoint, requests only the selected Tailscale host permission, and persists a fresh installation UUID and a random 256-bit API credential **before** registration. The request carries the invitation token, expected account/epoch, new installation ID/name and API credential. It does not carry either encryption key. Device registration and invitation consumption commit together, and the relay stores only the API credential hash and a hash of the exact claim.

One new claim can consume an invitation. A different claim is rejected, including changed names or secrets. An exact committed claim can retry until one hour after the invitation's expiry, supporting lost replies and local storage failures. Expired unused invitations never create an installation. Revoking the issuer invalidates its outstanding invitations and claim retries; revoking the paired installation rejects its retries. Budget failure rolls back both registration and invitation consumption so the same claim can retry after limits change.

There are at most 16 unclaimed active invitations and 64 recent invitation rows per account. Creation deletes rows whose retry window has elapsed. Device identity budgets still count revoked authors. A claim never overwrites an existing installation or credential.

## Local durability and recovery

IndexedDB schema 6 adds a dedicated pending enrollment store, preserving earlier replicas, capture journals, counters and queues. Registration replies must match the saved identity, account, name and server epoch. Local enrollment and deletion of pending setup secrets commit in one transaction. Failed replies/writes and worker/database restarts keep the same claim. Competing starts cannot create two local identities; simultaneous exact completions converge on the same enrolled state.

The dashboard exposes pending profile name, endpoint, expiry and installation ID, without tokens or keys. Retry resumes the saved claim. Explicit discard first explains that the relay may already have committed it; revoke the stranded installation with `revoke-device --device-id …` if abandoning it. Discard affects setup secrets in an unenrolled profile, not an enrolled replica. After the one-hour claim-retry window, request a fresh bundle and explicitly resolve/discard the older attempt rather than silently minting another identity.

After successful pairing the normal pull-before-push bootstrap obtains existing encrypted records. The invitation is not a backup and ordinary replica exports exclude both the root/index keys and pending invitation secrets. Recovery-key exports remain separate.

## Security boundary and evidence

This build auto-unlocks from profile-local keys and stores decrypted replicas locally. It adds no local encryption at rest. API revocation cannot erase downloaded data or invalidate knowledge of old content/index keys. Future-data content-key rotation remains unfinished; pairing does not satisfy that gate.

The relay is now SQLite schema 4. Upgrade it before using pairing. Earlier protocol-1 clients/envelopes and schema-2 cursor ACKs continue to work at epoch 1. The [rotation protocol](key-rotation.md) adds invitation epoch binding and optional immutable wrapping metadata; the ordinary pairing UI still uses the epoch-1 bundle until the next client checkpoint. SQLx migration checksums remain immutable after application. Do not downgrade a migrated database without an isolated recovery procedure.

Evidence: 9 pairing TypeScript tests cover key exclusion, lost replies/reopen, atomic local storage failures, invalid replies/epochs, conflicting setup, endpoint/key/name validation, invitation construction, explicit discard and concurrent completion. Five added Rust tests cover single use/retry/reopen, expiry/revocation, retry grace, quota rollback/concurrent claim races and validation/invitation bounds. The ninth real-process integration test drops a committed registration reply, reopens both the relay and client, retries the identical claim and verifies encrypted synchronization with no keys/plain tokens in relay storage. The actual options components were exercised using synthetic pairing responses; retry reached the enrolled view and the 390 px preview had no horizontal overflow or warning/error logs. This is not native Helium acceptance.
