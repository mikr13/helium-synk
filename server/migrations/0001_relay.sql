CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    account_id TEXT NOT NULL,
    server_epoch TEXT NOT NULL
);
CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1))
);
CREATE TABLE operations (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    operation_id TEXT NOT NULL UNIQUE,
    device_id TEXT NOT NULL REFERENCES devices(id),
    counter INTEGER NOT NULL CHECK (counter > 0),
    envelope TEXT NOT NULL,
    UNIQUE (device_id, counter)
);
