---
'@helium-synk/server': minor
---

Add a localhost-only Rust/Axum relay with hashed per-profile credentials, SQLite WAL/FULL durability, atomic idempotent upload batches, cursor-based downloads, authenticated WebSocket notifications, and credential revocation. Require SQLite with the WAL-reset fix. Initial enrollment uses a local administrative credential file; automated pairing, backup recovery, quotas, and browser-content domains remain future milestones.
