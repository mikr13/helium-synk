---
'@helium-synk/core': minor
'@helium-synk/extension': minor
'@helium-synk/server': minor
---

Add encrypted source-owned current, closed and previous session snapshots with durable multipart transport and conservative offline coalescing. Capture regular browser windows into a persistent cache, preserve closed windows during outages, and expose profile filters, saved snapshots and capture age. Restore selected tabs/windows through a durable marker-based journal with pins, order, groups, active selection, bounded progress and interruption recovery. Preserve existing v3 profile data in the IndexedDB v4 upgrade. The Rust relay accepts encrypted session envelopes; live Helium acceptance remains pending.
