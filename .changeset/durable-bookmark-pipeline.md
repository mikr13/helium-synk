---
'@helium-synk/core': minor
'@helium-synk/server': minor
'@helium-synk/extension': patch
---

Add an IndexedDB v2 bookmark journal, atomic capture drafts/replicas, startup-safe encryption, and encrypted bookmark transport through the Rust relay. Keep causal merge results and received cursors consistent, quarantine invalid records without advancing, and export replica/tombstone/pending state separately from credentials and recovery keys. Reconcile hints arriving during in-flight work and compare envelope identity independently of JSON member order. Pending counts include capture drafts. Native bookmark capture and application remain forthcoming adapters.
