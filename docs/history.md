# History model and clear policy

This checkpoint implements the reference visit/search/deletion model only. Native capture, IndexedDB history tables, encrypted transport, the history dashboard and ciphertext purge are still pending. No history permission or browser collection is enabled yet.

## Individual visits

A visit retains its original native timestamp, source installation/name, profile incarnation, opaque native visit ID, URL, observed title and available transition/referring-visit metadata. Its identity includes source UUID, incarnation UUID, encoded native ID and original timestamp. Separate visits to the same URL stay separate; repeated capture of the same identity deduplicates. The original timestamp also distinguishes native ID reuse at a later time.

The earliest captured operation remains canonical. Reconciliation can see a newer URL-level title, but it cannot move that original visit into another clear generation. Reusing an identity with a different URL/tag, changing an operation's contents or reusing an author counter rejects the journal.

The native history API supplies a URL-level title rather than the historical title of each visit. Capture must retrieve individual `getVisits` records and preserve their timestamps. Its `isLocal` flag allows imported native visits to be excluded from this source's publication. Foreign synchronized history is displayed in the extension; it must not be injected into native history with `addUrl`, which creates a current-time visit. [Chrome history API](https://developer.chrome.com/docs/extensions/reference/api/history)

## Deletion and generations

Selected-record deletion is a permanent tombstone for the stable visit identity. It does not prevent a separate future visit to that URL.

Clear barriers have three scopes: every source, one source, or one URL tag on one source. URL-clear metadata contains an opaque tag rather than a plaintext URL. Production capture must derive account-scoped tags with a stable dedicated HMAC key and include that key in trusted recovery/pairing material; the current unit fixtures use placeholder hashes and do not prove tag derivation or encryption.

A captured visit carries the matching clear generations it had observed. A visit is visible only if it covers every applicable barrier. Clear ordering is causal and does not use visit/arrival timestamps. This intentionally hides stale-generation uploads, including records from an offline source that had not received the clear. That source must receive the barriers before resuming publication in the new generation. Unrelated URL-clear traffic never advances a visit's generation.

Adapters must persist native capture intent with its observed generation before asynchronous lookup/encryption. They must retain deduplication/removal metadata and apply a clear to native reconciliation baselines before collecting in the new generation. Existing or backfilled old visits must not be retagged as fresh visits. An explicit initial-import boundary and treatment of partial native removal/clock changes still need implementation and tests.

Every concurrent matching barrier matters; learning one clear does not override an unseen concurrent clear. V1 keeps barriers/tombstones indefinitely. Any future compaction must introduce retirement/acknowledgement frontiers and require stale installations to rebootstrap before contributing old state.

## Search and erasure boundaries

The reference query searches decrypted URL/title/source text locally and filters source/time with stable ordering and pages of at most 200 visits. Search preserves original timestamps and never asks the relay to inspect URLs. The production adapter still needs indexed, bounded queries for large datasets.

Projection deletion currently hides records; it does **not** erase plaintext operation journals, queues or server ciphertext. The complete feature must coordinate local content removal, permanent deletion metadata and authenticated ciphertext purge/retention while preserving pending deletion work. Historical backups have separate expiration/deletion lag. These remain open implementation gates, not a completed privacy feature.

## Current evidence

Nine model tests verify opaque/native ID namespaces, duplicate/repeated visits, selected tombstones, source/global/URL clears, concurrent generations, prevention of retagged re-import, local search and invalid identities/clocks. A five-operation source-clear case checks all 120 arrival permutations. No native history or transport result is claimed by these tests.
