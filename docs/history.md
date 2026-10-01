# History capture, timeline and clear policy

The development build implements opt-in native capture, encrypted history transport, indexed local search and logical removal. It is tested through simulated browser ports and a real Rust relay. Permanent plaintext/ciphertext erasure and live Helium acceptance remain open gates; removal is not yet a complete privacy feature.

## Individual visits and encryption

A visit retains its original native timestamp, source installation/name, profile incarnation, opaque native visit ID, URL, observed title and available transition/referring-visit metadata. Its identity includes source UUID, incarnation UUID, encoded native ID and original timestamp. Separate visits to a URL stay separate; repeat capture of an identity deduplicates. The original timestamp also distinguishes native ID reuse at a later time.

The earliest operation remains canonical. A newer URL-level title cannot move that visit into a different clear generation. Reusing an identity with a different URL/tag, changing an operation or reusing an author counter rejects the journal.

Capture resolves native individual visits with `getVisits`, excludes visits whose locality is false, and preserves the API timestamps. Missing locality/time retains work with a visible error. Browser titles are URL-level observations, not historical titles per visit. The native port never writes remote history into the browser. [Chrome history API](https://developer.chrome.com/docs/extensions/reference/api/history)

A separate account index key is derived using HKDF-SHA256 and retained in trusted recovery material. HMAC-SHA256 tags the exact native URL. Tags are checked during encryption and decryption; invalid tags quarantine the incoming page without advancing its cursor. Future content-key rotation must retain this index key. Replica exports exclude keys and credentials; recovery bundles carry the index key separately.

## Durable capture and import

IndexedDB v5 adds history metadata, a timeline index, capture inbox, seen identities, import/audit jobs, native lookup batches and URL incarnations. The migration retains earlier outgoing work and interrupted session restoration.

Synchronous WXT listeners start the capture transaction immediately. Raw event intent and its observed clear context persist before HMAC, native lookup or encryption, independently of reconciliation work. Native lookups persist their results/position; visits, seen identities, drafts and logical counters commit together. Restart or a failed write resumes saved work. Encryption then creates immutable outgoing envelopes through the shared transport.

Initial import accepts 0–365 days. Native URL search ranges bisect when truncated rather than advancing past tied timestamps. A job remembers discovered URL tags so split boundaries do not repeat lookups. Each URI lookup preserves individual timestamps and imports only the requested time window. Later overlap scans cover five minutes before the previous scan boundary; alarms/startup/manual sync/reconnect supplement events.

Known local URLs also receive bounded audits on browser startup, manual sync and daily reconciliation. These detect partial removals and URLs missing entirely from native search. An audit compares against a durable author-counter boundary captured before fetching native visits, so newer records published during the lookup are not falsely erased. Native expiry detected this way also removes the corresponding synchronized source records.

## Pause, exclusions and baselines

Collection is opt-in; the manifest disables incognito access. Native imported visits and private records are excluded. Hostname exclusions include subdomains and affect future collection; changing an exclusion does not erase already synchronized entries.

Pausing cancels unfetched native import/audit queries, while keeping saved event/removal intent, retrieved individual-visit batches and outgoing records. Resuming inventories existing native identities before normal collection continues. Captured batches remain publishable even if the resume baseline reaches them first. A newly backdated visit during the pause cannot be imported through a cancelled older query.

A source/global clear changes the source incarnation and pauses collection during the full inventory. A URL clear establishes a separate URL incarnation and baseline; an unknown URL is baselined when its first native item becomes available. A genuine event saved after the URL clear retains its new-generation context and is processed after that baseline. Old native records are suppressed rather than retagged. Native ID/time reuse after a clear receives a new identity.

Baseline intervals are explicit collection pauses, not complete archival coverage. Abrupt termination before intent commits, native records no longer available at lookup, unobserved visits outside import/overlap windows, or unusual native event timestamp behavior can leave capture gaps. Clock-skew and worker-lifecycle behavior require live Helium verification. Original visit timestamps never decide causal merge/clear ordering.

## Deletion and generations

Selected-record removal uses permanent identity tombstones. Clear scopes are every source, one source, or one URL tag on one source. Native clear-all affects only its source. Partial native removal compares individual ID/time pairs; complete URL removal creates a source-scoped URL barrier. Multi-URL removal progress survives interruption.

Visits carry the matching clear generations observed at capture. Visibility requires covering every applicable barrier. Stale uploads from an offline source remain hidden even if they arrive after a clear. Unrelated URL traffic cannot advance a visit generation. Every concurrent matching barrier matters; learning one clear does not override another unseen clear. V1 retains barriers and tombstones indefinitely. Future compaction requires retirement/acknowledgement frontiers and stale-source rebootstrap.

Logical removal deletes entries from the live timeline index. It does **not** yet erase operation plaintext, capture/lookup copies, outgoing envelopes, quarantine or relay ciphertext. Coordinated content purge, authenticated relay redaction and separate backup-expiration behavior remain required before the erasure gate can pass. The UI discloses this boundary at removal confirmation.

## Bounded work and remaining scale gate

Search uses time/source compound indexes, at most 200 returned records and 2,000 examined rows. Its cursor resumes after the last examined row, including filtered-out rows and tied timestamps. Empty filtered pages can continue searching older records. Source filters and date boundaries stay local.

Each capture pass processes up to 20 inbox items, five ready URL lookups with 100 native records per lookup, and one discovery range. Removal work stages at most 800 selected IDs per item/pass. An audit discovers at most 50 distinct local URLs per range. The event/lookup queues cap at 10,000/20,000 items; discovery retains an overflowing range and errors remain visible. A native timestamp bucket exceeding 10,000 URLs pauses that import range. The unpaginated native visits API has a 100,000-record per-URL ceiling; exceeding it retains progress and reports recovery required. Retries back off, and an unavailable URL does not starve other ready URLs.

The current causal projection still replays the uncompacted history journal when staging or receiving records. Indexed reads are bounded, but no full 50,000-visit performance result is claimed. Account/local quotas and broader scale acceptance remain pending.

## Evidence

Nine model tests cover stable IDs, source/global/URL and concurrent clears, selected deletion, prevention of retagged imports, and all 120 delivery orders of an offline-source clear case. Eight pipeline tests cover encrypted offline delivery/reopen/lost acknowledgement, HMAC validation and quarantine, atomic index failure, bounded tied-time search, and v4 migration. Twenty-one native-port tests cover durable event/lookup progress, initial import, locality/private filtering, clear baselines, pause/clock boundaries, exclusions, storage failures, bounded lookup/audit progress and native-removal races.

The fifth real Rust-process integration test preserves fractional original timestamps across client/relay restarts, uploads a clear before an offline source returns, verifies stale uploads stay hidden, and checks logical selected deletion plus absence of URLs/titles/keys in SQLite envelopes. This is a short outage, not an hours-long endurance result.

The actual dashboard components were exercised with synthetic localhost responses: opt-in, text search, selection/removal refresh, exact source-clear preview and narrow-window wrapping. The 390 px layout has no horizontal overflow and produced no warning/error logs. The preview was closed; no actual Helium profile was read or changed.
