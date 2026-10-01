CREATE TABLE pairing_invites (
    invitation_hash TEXT PRIMARY KEY,
    issuer_id TEXT NOT NULL REFERENCES devices(id),
    expires_at INTEGER NOT NULL,
    claimed_device_id TEXT REFERENCES devices(id),
    claim_hash TEXT,
    CHECK ((claimed_device_id IS NULL AND claim_hash IS NULL) OR (claimed_device_id IS NOT NULL AND claim_hash IS NOT NULL))
);
CREATE INDEX pairing_invites_expiry ON pairing_invites(expires_at);
