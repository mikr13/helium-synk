---
'@helium-synk/core': patch
'@helium-synk/server': patch
---

Bound encrypted upload and download batches by bytes as well as record count so large records can drain below the relay body limit without skipped cursors. Report SQLite storage exhaustion with an explicit retryable response; retain client pending work until space is available and a retry commits successfully.
