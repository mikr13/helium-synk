---
'@helium-synk/core': minor
'@helium-synk/extension': minor
---

Persist per-profile storage limits and expose estimated usage, pending work, journal counts and warnings in the square dark shadcn dashboard. Gate new capture/download content transactionally while preserving retries, deletion, saved work and cursor progress. Allow queued uploads to drain when incoming content is refused at local capacity. Add boundary/restart/concurrency tests and a real-relay capacity recovery check. Retention, physical disk/full-scale and native acceptance remain open.
