---
'@helium-synk/server': minor
'@helium-synk/core': minor
'@helium-synk/extension': minor
---

Persist relay account quotas and delivery/processed progress, bound HTTP/WebSocket handling and drain cleanly on SIGTERM. A quota-rejected batch rolls back atomically; exact retries remain usable at the limit. Clients acknowledge only committed local journal cursors and retry lost replies after restart without confirming quarantined data or native browser effects.

Upgrade the relay before this client: the client now requires the cursor-ACK API and the relay migrates to SQLite schema 2. Envelope protocol 1 remains supported for earlier clients. Budgets count serialized envelopes rather than physical disk usage; compaction, pairing/key rotation and native Helium acceptance remain separate gates.
