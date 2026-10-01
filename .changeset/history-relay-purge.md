---
'@helium-synk/server': minor
'@helium-synk/core': minor
---

Add the schema-5 atomic history purge API with durable header/digest receipts, immutable certificate request bindings, exact original retries, preserved author counters and byte-bounded redacted pull slots. Purged identities retain byte usage but no longer count as active encrypted operations. Add the shared canonical envelope digest helper. Client certificate validation, purge scheduling and redacted-record consumption remain pending; the current extension does not activate this API.
