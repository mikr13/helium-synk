ALTER TABLE settings ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch BETWEEN 1 AND 255);
ALTER TABLE devices ADD COLUMN wrapping_public_key TEXT;
ALTER TABLE devices ADD COLUMN wrapping_proof TEXT;
ALTER TABLE devices ADD COLUMN wrapping_proof_epoch INTEGER CHECK (wrapping_proof_epoch BETWEEN 1 AND 255);
ALTER TABLE pairing_invites ADD COLUMN key_epoch INTEGER NOT NULL DEFAULT 1 CHECK (key_epoch BETWEEN 1 AND 255);

-- Installation public keys are immutable. Private keys and content roots never reach the relay.
CREATE TABLE key_rotations (
    key_epoch INTEGER PRIMARY KEY CHECK (key_epoch BETWEEN 2 AND 255),
    rotation_id TEXT NOT NULL UNIQUE,
    issuer_id TEXT NOT NULL REFERENCES devices(id),
    request_hash TEXT NOT NULL
);
CREATE TABLE key_packets (
    key_epoch INTEGER NOT NULL REFERENCES key_rotations(key_epoch),
    recipient_id TEXT NOT NULL REFERENCES devices(id),
    packet TEXT NOT NULL,
    PRIMARY KEY (recipient_id, key_epoch)
);
