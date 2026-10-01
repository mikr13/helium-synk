ALTER TABLE settings ADD COLUMN max_journal_bytes INTEGER NOT NULL DEFAULT 1073741824 CHECK (max_journal_bytes > 0 AND max_journal_bytes <= 9007199254740991);
ALTER TABLE settings ADD COLUMN max_operations INTEGER NOT NULL DEFAULT 1000000 CHECK (max_operations > 0 AND max_operations <= 9007199254740991);
ALTER TABLE settings ADD COLUMN max_devices INTEGER NOT NULL DEFAULT 64 CHECK (max_devices > 0 AND max_devices <= 256);
ALTER TABLE settings ADD COLUMN journal_bytes INTEGER NOT NULL DEFAULT 0 CHECK (journal_bytes >= 0);
ALTER TABLE settings ADD COLUMN journal_operations INTEGER NOT NULL DEFAULT 0 CHECK (journal_operations >= 0);
ALTER TABLE devices ADD COLUMN sent_cursor INTEGER NOT NULL DEFAULT 0 CHECK (sent_cursor >= 0);
ALTER TABLE devices ADD COLUMN processed_cursor INTEGER NOT NULL DEFAULT 0 CHECK (processed_cursor >= 0);
ALTER TABLE devices ADD COLUMN processed_epoch TEXT;
ALTER TABLE devices ADD COLUMN last_seen TEXT;
UPDATE settings SET journal_bytes = (SELECT COALESCE(SUM(LENGTH(CAST(envelope AS BLOB))), 0) FROM operations), journal_operations = (SELECT COUNT(*) FROM operations) WHERE id = 1;
-- V1 did not record delivery frontiers. Preserve previously issued credentials'
-- valid saved cursors; their processed frontier still starts at zero. New devices
-- start with sent_cursor = 0 and must actually bootstrap via pull.
UPDATE devices SET sent_cursor = COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'operations'), 0);
CREATE TRIGGER operations_usage_insert AFTER INSERT ON operations BEGIN
  UPDATE settings SET journal_bytes = journal_bytes + LENGTH(CAST(NEW.envelope AS BLOB)), journal_operations = journal_operations + 1 WHERE id = 1;
END;
CREATE TRIGGER operations_usage_update AFTER UPDATE OF envelope ON operations BEGIN
  UPDATE settings SET journal_bytes = journal_bytes - LENGTH(CAST(OLD.envelope AS BLOB)) + LENGTH(CAST(NEW.envelope AS BLOB)) WHERE id = 1;
END;
CREATE TRIGGER operations_usage_delete AFTER DELETE ON operations BEGIN
  UPDATE settings SET journal_bytes = journal_bytes - LENGTH(CAST(OLD.envelope AS BLOB)), journal_operations = journal_operations - 1 WHERE id = 1;
END;
