---
'@helium-synk/core': minor
'@helium-synk/server': minor
'@helium-synk/extension': minor
---

Persist independent installation wrapping identities, historical roots and exact rotation proposals before network requests. Refresh/adopt keys before sync, recover lost rotation replies and re-encrypt only relay-proven missing offline records without changing operation identities or historical committed ciphertext.

Add dashboard installation removal and explicit saved-proposal retry/review. Version-2 private pairing/recovery bundles preserve all content epochs and the stable history index; recovery requires a fresh installation credential and never clones author counters or private wrapping keys. Extend schema-4 key-state metadata with account/author-frontier validation. Upgrade the relay before this client, which requires the key APIs. Epoch-1 legacy pairing/recovery remains supported; ordinary exports/status exclude private key state.

Native Helium acceptance and older-backup/server-loss reconciliation remain pending. Local automatic unlock/decrypted storage and the documented relay/membership trust boundary are unchanged.
