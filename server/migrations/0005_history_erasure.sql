ALTER TABLE operations ADD COLUMN purged INTEGER NOT NULL DEFAULT 0 CHECK (purged IN (0, 1));
ALTER TABLE settings ADD COLUMN history_erasure_version INTEGER NOT NULL DEFAULT 0 CHECK (history_erasure_version IN (0, 1));
CREATE TABLE history_redactions (
  operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
  original_digest TEXT NOT NULL CHECK (LENGTH(original_digest) = 64),
  certificate_operation_id TEXT NOT NULL REFERENCES operations(operation_id)
);
CREATE TABLE history_erasures (
  certificate_operation_id TEXT PRIMARY KEY REFERENCES operations(operation_id),
  request_digest TEXT NOT NULL CHECK (LENGTH(request_digest) = 64)
);
-- Identity receipts retain sequence/author-counter uniqueness. Active encrypted
-- operations count toward the operation budget; receipt headers still count as bytes.
DROP TRIGGER operations_usage_insert;
DROP TRIGGER operations_usage_update;
DROP TRIGGER operations_usage_delete;
CREATE TRIGGER operations_usage_insert AFTER INSERT ON operations BEGIN
  UPDATE settings SET journal_bytes = journal_bytes + LENGTH(CAST(NEW.envelope AS BLOB)), journal_operations = journal_operations + 1 - NEW.purged WHERE id = 1;
END;
CREATE TRIGGER operations_usage_update AFTER UPDATE OF envelope, purged ON operations BEGIN
  UPDATE settings SET journal_bytes = journal_bytes - LENGTH(CAST(OLD.envelope AS BLOB)) + LENGTH(CAST(NEW.envelope AS BLOB)), journal_operations = journal_operations + OLD.purged - NEW.purged WHERE id = 1;
END;
CREATE TRIGGER operations_usage_delete AFTER DELETE ON operations BEGIN
  UPDATE settings SET journal_bytes = journal_bytes - LENGTH(CAST(OLD.envelope AS BLOB)), journal_operations = journal_operations - 1 + OLD.purged WHERE id = 1;
END;
