---
'@helium-synk/core': minor
'@helium-synk/server': minor
'@helium-synk/extension': patch
---

Add independent installation ECDH key wrapping and authenticated content-epoch packets. Relay schema 4 commits exact recipient packets, API revocation and content-key epoch advancement atomically, preserves exact rotation retries and committed old envelopes, and proves uncommitted offline work before ciphertext replacement.

Bind pairing invitations to content epochs and include optional immutable installation wrapping metadata in registration. The extension retains pending work on a changed content epoch; durable client key adoption, rotation controls and versioned private recovery/pairing bundles remain the next checkpoint. No rotation is exposed in ordinary profile use yet.
