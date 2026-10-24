---
'@helium-synk/core': patch
'@helium-synk/extension': patch
'@helium-synk/server': patch
---

Reduce history audit CPU use by indexing lookup readiness and retained errors instead of repeatedly reading the entire queued history payload. Upgrade existing queues without dropping pending work or deletion barriers, and preserve delayed retries. Installed-profile performance still requires release acceptance testing.
