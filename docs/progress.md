# Verification record

Updated 2026-10-01. The dashboard supports diagnostic notes, opt-in bookmarks and opt-in current/closed/previous sessions with restoration progress, and opt-in history capture/search with logical removal. The native adapter is implemented and tested through a browser port; real Helium acceptance is pending. The [main checklist](plan.md) keeps all milestone exit gates open.

## Completed automated checks

| Check                            | Evidence                                                                                                                                                                         | Boundary                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Move outside iCloud Documents    | Checkout, Git history, dependencies, and builds verified at `/Users/mihirpandey/Work/fun/helium-synk`; old checkout removed                                                      | The original planning document remains in Documents; it contains no credentials             |
| TypeScript core                  | 151 tests across diagnostic/core, bookmarks, sessions, native capture/restoration and history model/pipeline/native-adapter suites                                               | Uses fake IndexedDB; not a browser lifecycle test                                           |
| Rust/SQLite relay                | 23 tests across `server/tests/relay.rs` and the request-guard unit test; rustfmt and clippy with warnings denied                                                                 | Real temporary SQLite files; no production deployment                                       |
| Cross-stack transport            | 9 tests in `tests/relay.integration.test.ts`                                                                                                                                     | Real Rust process, HTTP and authenticated WebSocket; client IndexedDB simulated             |
| WXT production extension         | `pnpm check` builds Chromium MV3 options page/background worker                                                                                                                  | Browser rendering, permissions, alarms and worker revival still require manual verification |
| Version alignment and changesets | `pnpm check:versions`; full `pnpm version-packages` smoke test in an ignored disposable copy generated all three changelogs and aligned Cargo/package/lockfile versions at 0.2.0 | Changelogs generated at an intentional release, not this unreleased checkpoint              |

Core coverage includes reopening durable queued work, a lost acknowledgement followed by a deduplicated retry, two-author decryption, concurrent counter reservation, one sync coordinator, rejected acknowledgement retention, non-skipping cursors, wrong-key failure, server-epoch changes, authenticated metadata, fresh nonces, and invalid enrollment/endpoint rejection.

Relay coverage includes credential hashes/revocation, committed idempotent results, conflicting operation IDs/counters, atomic failed-batch rollback, disk reopen preserving account/epoch/sequences/tokens, author/domain/nonce/epoch validation, byte-bounded pagination, WAL/FULL durability, and forced SQLite disk-full rollback followed by an identical successful retry.

The cross-stack outage test stops the relay, queues independent notes on both clients, reopens one local database, restarts the relay, and proves equal decrypted records plus empty outgoing queues. It also inspects persisted envelopes for absence of the note text and root key. The WebSocket test verifies initial-message authentication and a notification after a real commit. This is a short deterministic outage, not an hours-long endurance test.

## Pending native and operational gates

- [ ] Render and use the extension in two disposable Helium profiles; verify accessibility and narrow-window layout.
- [ ] Verify enrollment, exact-host optional permissions, shared-key backup, and peer note arrival in the real browser.
- [ ] Force worker termination, revive through alarms/startup, and reconcile with DevTools closed.
- [ ] Run an hours-long outage including browser restarts, then verify convergence and measured latency.
- [ ] Verify bookmark/history/window/tab/group APIs and restoration without touching the user's normal profile.
- [ ] Verify Tailscale HTTPS/WSS, access rules, service restart, logout, reboot, and FileVault recovery.
- [ ] Complete future-data key rotation and older-backup/server-loss recovery; account quotas and pairing invitations are implemented below.
- [ ] Complete history content/ciphertext erasure and scale gates; verify all native adapters in disposable Helium profiles.

The installed Helium app is 0.18.1.1 with Chromium framework 154.0.8037.57. The manifest floor is now 134 for root-role capabilities; an older Helium release has not been verified. WXT development mode built successfully but requested manual unpacked loading. Native inspection selected an existing unrelated profile; it was left untouched, so no native compatibility result is claimed.

The current SQLite library selected by the macOS Cargo helper is Homebrew 3.53.3. A runtime guard rejects versions affected by the [SQLite WAL-reset issue](https://sqlite.org/wal.html#wal_reset_bug). Keep this guard when upgrading dependencies.

## Scope and recovery limits

The client stores its root key, API credential, and decrypted notes in its local profile for automatic unlock. The server cannot decrypt contents, but this build adds no local-at-rest encryption. Save recovery-key material separately from relay backups.

API revocation rejects HTTP requests immediately; open sockets recheck authorization on messages/heartbeats. A CLI invocation runs separately from the relay, so it does not directly broadcast to that process. Revocation does not rotate the shared content key or erase downloaded data.

The server epoch persists across ordinary restarts. Clients refuse a changed epoch, but there is no older-backup epoch-rotation/recovery CLI yet. Restoring a stale database with its old epoch can hide lost acknowledged records; do not use that as a production recovery path. Keep backups isolated until the recovery gate passes.

## Bookmark model and durable transport checkpoint

`feat(core): implement causal bookmark merge and recovery` implements the section 5 merge policies. The six-operation concurrent reorder/insert/move case checks all 720 delivery permutations. Other permutations cover independent fields, delete/edit recovery, folder cycles and observed deletion sets. Previous values remain recoverable from the uncompacted journal after an explicit conflict resolution.

The IndexedDB v2 migration preserves earlier notes/outbox/counters. Capture drafts, logical replicas and revisions commit before async encryption; a subsequent transaction creates immutable ciphertext plus the outbox entry. Worker/database reopen resumes unfinished drafts. Incoming ciphertext validation and causal merge complete before the page cursor commits. Bad ciphertext and impossible causal clocks enter quarantine with the cursor unchanged. Replica exports include pending drafts/operations/tombstones but exclude API credentials and root keys.

The third real Rust-process test bootstraps a bookmark on two clients, stops the relay, persists an unencrypted capture draft for a rename, reopens that client's database, captures an offline move on the other client, restarts the relay, and proves equal replicas with empty queues. It inspects the actual SQLite envelopes for absence of bookmark title/URL/root key. This is transport/model evidence; it does not prove native browser application.

Sections 1–9 remain the active goal. Live adapter acceptance, history erasure/scale, pairing/key lifecycle, remaining security/storage/recovery and setup checks are still required before the joint Helium session; live bookmark acceptance is deferred to that session. No whole milestone exit gate is complete.

## Transfer-size and disk-full checkpoint

Uploads and cursor pages are bounded by bytes as well as record count. A large-record client test verifies upload sizes and author order across multiple batches; the relay test verifies every sequence survives byte-bounded pagination. SQLite storage exhaustion returns HTTP 507 without acknowledging or committing a failed batch. Clients retain local state and outgoing work; the identical retry commits after storage becomes available. These checks simulate exhaustion with SQLite page limits, rather than filling the Mac Mini disk. Account quotas are implemented in the relay hardening checkpoint below.

## Native bookmark implementation checkpoint

The [native adapter contract](bookmark-browser.md) records IndexedDB v3 mappings, event-time clock reservations, import/recovery and effect-journal behavior. 22 adapter tests cover the browser/database boundary with a simulated port, including two-tree offline convergence, genuine edits during application, delayed capture context, local-storage failure, and interrupted-addition review. The production WXT build includes synchronous bookmark listeners and opt-in controls. The actual options components passed a synthetic UI preview at desktop and 390 px width; no live Helium profile was touched. Milestone exit gates remain open.

## Session implementation checkpoint

The [session contract](sessions.md) describes IndexedDB v4 capture caches, multipart assembly, current/closed/previous projection and restoration journaling. 32 new TypeScript tests cover source revision ordering, offline persistence/fragment delivery, v3 migration/export, native capture boundaries and interrupted restoration. The fourth Rust-process integration test proves encrypted session convergence after relay/client restart. WXT builds with tabs/groups/sessions permissions and incognito disabled. The real dashboard components passed a synthetic desktop/390 px preview including partial restoration and recovery controls.

Real Helium capture/restoration and lifecycle acceptance is deferred to the joint disposable-profile test. Browser restarts or changed pages during an ambiguous restore pause safely and keep opened tabs; they do not claim automatic recovery in every case. Recently-closed API-only records disclose missing group metadata. Local/relay quotas, retention and key lifecycle remain pending; no whole milestone is complete.

## History model and capture checkpoint

The [history contract](history.md) records the nine model tests plus eight transport/index/migration tests and 21 native capture/audit tests. IndexedDB v5 preserves older pending work and restoration jobs. The WXT build includes synchronous history listeners, opt-in settings, exclusions/pause, text/source/date search, bounded pagination and scoped logical-removal controls. The fifth real relay integration test verifies original fractional timestamps, delayed offline uploads after a clear, logical selected deletion and ciphertext storage.

The actual history components passed a synthetic localhost preview including removal refresh and exact source scope. The 390 px view had no horizontal overflow or warning/error logs. The preview and server were closed; no native Helium profile was touched. Permanent plaintext/ciphertext erasure, full-scale journal performance, real native lifecycle/API/clock behavior and hours-long outage acceptance remain open. Sections 1–9 remain the active goal; no whole milestone exit gate is complete.

## Relay hardening and durable progress checkpoint

The preserved draft is complete: SQLite schema 2 persists account limits, trigger-maintained envelope usage, delivered cursors, processed epochs/cursors and activity timestamps. `/v1/status` exposes authenticated budget/progress metadata. The `set-limits` CLI changes a running relay's budgets without deleting records. Requests and notification sockets are capped independently; socket buffering/sends and HTTP handler execution are bounded. SIGTERM/Ctrl+C drains handlers, notifies sockets and closes the database pool.

Eight added Rust checks cover exact byte/operation limits, identical retries at or below a lowered budget, atomic quota rollback, concurrent insert bounds, revoked identity limits, sequence exhaustion, cursor authorization/epoch/monotonicity, schema-1 usage/delivery backfill and checksum/unknown-migration refusal, plus request capacity/timeouts/shutdown. Seven added TypeScript tests prove committed-only ACKs, lost replies/reopen, local rollback, quarantine, malformed/changed-epoch replies, failed ACK persistence and states without the new optional ACK field. The real-process suite adds three checks for lost cursor-ACK replies across clean SIGTERM/reopen, live budget changes and 32-socket saturation/release/shutdown. An intentionally dropped first-page ACK is retried before processing remaining byte-bounded pages.

Evidence: `pnpm check` passes 142 TypeScript tests, typechecks and WXT production build; `pnpm check:server` passes 18 Rust tests, rustfmt and clippy with warnings denied; `pnpm test:integration` passes 8 real-process tests. Formatting, version alignment and Changeset status pass. Localhost integration required the execution sandbox's networking permission; tests bind only loopback and remove their disposable relay databases. No native Helium profile or production service was changed.

[Protocol and progress contract](relay-protocol.md) distinguishes journal ACKs from native application/restoration, physical disk usage and erasure. Deploy the schema-2 relay before this client, which now requires the ACK API. Legacy credentials retain valid saved cursors through conservative migration backfill; new credentials must bootstrap from zero. No compaction is implemented. Pairing/key rotation, history erasure/scale, local budgets/retention and native gates remain open. All whole milestone exit gates remain open.

## Single-use pairing checkpoint

`4d34eed feat(security): add single-use durable profile pairing` adds authenticated 15-minute invitation issuance, atomic single-use registration, exact committed-claim retry for one hour after expiry, issuer/installation revocation checks, invitation/account bounds and schema-3 migration. The receiving profile saves its fresh identity/API credential before registration in IndexedDB schema 6; local enrollment and pending-claim removal commit together. The downloaded bundle carries encryption keys out of band; the relay receives no content/index key during either API request. Ordinary exports/status omit setup secrets.

The [pairing contract](pairing.md) records expiry, retry/discard recovery and local auto-unlock limits. Nine client tests and five relay tests exercise single use, rollback, durability, races, malformed replies, expiry/revocation, bounds and key exclusion. A real Rust-process test drops a committed enrollment reply, reopens relay/client state and repeats the identical claim before encrypted convergence. The actual dashboard components passed a synthetic lost-reply/retry flow and bundle-save confirmation; the 390 px view had width/scrollWidth 390 and no warning/error logs. Preview tab and localhost server were closed after verification. No actual Helium profile was used.

Current checks: `pnpm check` passes 151 TypeScript tests, typechecks and production WXT build; `pnpm check:server` passes 23 Rust tests, rustfmt and clippy with warnings denied; `pnpm test:integration` passes 9 real-process tests. Formatting/version/Changeset checks pass. The earlier relay hardening checkpoint is commit `890bad2`. The checklist front table tracks completed checkpoints and pending work; both copies record checkpoint/commit evidence. Remaining work includes future-data content-key rotation, history content/ciphertext erasure, local budgets/retention, full-scale journal performance, recovery and joint native acceptance. No whole milestone exit gate is complete.
