-- Reuse immutable redaction/target receipts for authenticated session compaction.
-- Older clients must stop before receiving a session compaction proof.
ALTER TABLE settings ADD COLUMN session_erasure_version INTEGER NOT NULL DEFAULT 0 CHECK (session_erasure_version IN (0, 1));
CREATE TABLE relay_recovery (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  recovery_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES devices(id),
  manifest_digest TEXT NOT NULL
);

ALTER TABLE settings ADD COLUMN bookmark_compaction_version INTEGER NOT NULL DEFAULT 0 CHECK (bookmark_compaction_version IN (0, 1));
