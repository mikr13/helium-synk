---
'@helium-synk/core': minor
'@helium-synk/extension': minor
---

Replace suppressed history journal plaintext with local deletion receipts and cancel erased visits that have not yet been encrypted. IndexedDB schema 8 retains author counters, tombstones and original encrypted retries, including across key rotation and migration. This changes the local stored-operation payload shape; upgrading is required and downgrade is unsupported. Capture-copy cleanup, authenticated relay ciphertext purge and backup expiration remain pending, so history removal is not yet full content erasure.
