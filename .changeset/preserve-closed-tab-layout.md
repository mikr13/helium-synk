---
'@helium-synk/core': patch
'@helium-synk/extension': patch
---

Preserve cached pins, ordering and group membership during late tab updates after a window disappears, while retaining captured URL/title changes. This keeps the closed-window archive from duplicating the recently-closed browser record during teardown.
