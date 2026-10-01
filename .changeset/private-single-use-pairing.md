---
'@helium-synk/server': minor
'@helium-synk/core': minor
'@helium-synk/extension': minor
---

Connect additional browser profiles with private single-use pairing bundles. Encryption keys remain client-local; registration uses an expiring hashed invitation and a distinct hashed API credential. Persist the new claim before contacting the relay, retry identical claims across lost replies and restarts, and commit local enrollment atomically. The dashboard provides private bundle export, saved-claim retry and explicit discard review.

Pairing requires SQLite relay schema 3 and migrates clients to IndexedDB schema 6. Upgrade the relay first. Local keys/decrypted data still auto-unlock from the profile; future-data key rotation and native Helium acceptance remain unfinished.
