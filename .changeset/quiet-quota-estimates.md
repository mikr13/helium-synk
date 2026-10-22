---
'@helium-synk/core': patch
'@helium-synk/extension': patch
'@helium-synk/server': patch
---

Avoid keeping IndexedDB write transactions busy while waiting for a browser storage estimate. Sample initial usage before database readiness, coalesce later estimates outside transactions, and keep atomic admission checks using the cached estimate and current record counts. This removes dummy-read CPU work when quota estimation is slow. No database schema, wire protocol, enrollment, or relay behavior changes.
