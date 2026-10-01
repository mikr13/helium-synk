---
'@helium-synk/core': minor
---

Add an IndexedDB-backed encrypted diagnostic queue with per-installation counters, authenticated AES-GCM envelopes, idempotent retry handling, and durable pull cursors. Preserve pending records across offline periods and restarts; pause synchronization when the server epoch changes or decryption fails. Browser-content adapters are not enabled in this foundation.
