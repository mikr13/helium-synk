---
'@helium-synk/core': minor
'@helium-synk/extension': minor
---

Remove obsolete saved history capture jobs atomically with matching clear proofs, including paused capture. Scrub selected cached native metadata, retain unrelated saved visits, and prevent late native responses from recreating canceled jobs. IndexedDB schema 9 cleans existing jobs on upgrade; downgrade is unsupported. Complete history ciphertext erasure remains pending.
