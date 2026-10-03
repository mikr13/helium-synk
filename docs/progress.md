# Verification record

Updated 2026-10-01. The dashboard supports diagnostic notes, opt-in bookmarks and opt-in current/closed/previous sessions with restoration progress, and opt-in history capture/search with logical removal. Durable client key rotation, installation removal and versioned private pairing/recovery are implemented. The native adapter is implemented and tested through a browser port; real Helium acceptance is pending. The [main checklist](plan.md) keeps all milestone exit gates open.

## Completed automated checks

| Check                            | Evidence                                                                                                                                                                         | Boundary                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Move outside iCloud Documents    | Checkout, Git history, dependencies, and builds verified at `/Users/mihirpandey/Work/fun/helium-synk`; old checkout removed                                                      | The original planning document remains in Documents; it contains no credentials             |
| TypeScript core                  | 176 tests across diagnostic/core, bookmarks, sessions, history, pairing and key lifecycle suites                                                                                 | Uses fake IndexedDB; not a browser lifecycle test                                           |
| Rust/SQLite relay                | 31 tests across `server/tests/relay.rs` and the request-guard unit test; rustfmt and clippy with warnings denied                                                                 | Real temporary SQLite files; no production deployment                                       |
| Cross-stack transport            | 11 tests across `tests/relay.integration.test.ts`, `tests/keys.integration.test.ts` and `tests/key-lifecycle.integration.test.ts`                                                | Real Rust process, HTTP and authenticated WebSocket; client IndexedDB simulated             |
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
- [ ] Verify native key rotation/recovery and complete older-backup/server-loss recovery; account quotas, pairing and client key lifecycle are implemented below.
- [ ] Complete history content/ciphertext erasure and scale gates; verify all native adapters in disposable Helium profiles.

The installed Helium app is 0.18.1.1 with Chromium framework 154.0.8037.57. The manifest floor is now 134 for root-role capabilities; an older Helium release has not been verified. WXT development mode built successfully but requested manual unpacked loading. Native inspection selected an existing unrelated profile; it was left untouched, so no native compatibility result is claimed.

The current SQLite library selected by the macOS Cargo helper is Homebrew 3.53.3. A runtime guard rejects versions affected by the [SQLite WAL-reset issue](https://sqlite.org/wal.html#wal_reset_bug). Keep this guard when upgrading dependencies.

## Scope and recovery limits

The client stores its root key, API credential, and decrypted notes in its local profile for automatic unlock. The server cannot decrypt contents, but this build adds no local-at-rest encryption. Save recovery-key material separately from relay backups.

API revocation rejects HTTP requests immediately; open sockets recheck authorization on messages/heartbeats. A CLI invocation runs separately from the relay, so it does not directly broadcast to that process. The CLI revokes API access only. Dashboard installation removal also advances content keys and atomically excludes removed recipients. Neither path erases downloaded data or knowledge of old roots.

The server epoch persists across ordinary restarts. Clients refuse a changed epoch, but there is no older-backup epoch-rotation/recovery CLI yet. Restoring a stale database with its old epoch can hide lost acknowledged records; do not use that as a production recovery path. Keep backups isolated until the recovery gate passes.

## Bookmark model and durable transport checkpoint

`feat(core): implement causal bookmark merge and recovery` implements the section 5 merge policies. The six-operation concurrent reorder/insert/move case checks all 720 delivery permutations. Other permutations cover independent fields, delete/edit recovery, folder cycles and observed deletion sets. Previous values remain recoverable from the uncompacted journal after an explicit conflict resolution.

The IndexedDB v2 migration preserves earlier notes/outbox/counters. Capture drafts, logical replicas and revisions commit before async encryption; a subsequent transaction creates immutable ciphertext plus the outbox entry. Worker/database reopen resumes unfinished drafts. Incoming ciphertext validation and causal merge complete before the page cursor commits. Bad ciphertext and impossible causal clocks enter quarantine with the cursor unchanged. Replica exports include pending drafts/operations/tombstones but exclude API credentials and root keys.

The third real Rust-process test bootstraps a bookmark on two clients, stops the relay, persists an unencrypted capture draft for a rename, reopens that client's database, captures an offline move on the other client, restarts the relay, and proves equal replicas with empty queues. It inspects the actual SQLite envelopes for absence of bookmark title/URL/root key. This is transport/model evidence; it does not prove native browser application.

Sections 1–9 remain the active goal. History erasure/scale, remaining security/storage/recovery and setup work still precede the joint Helium session. Live adapter, pairing and key lifecycle acceptance are deferred to that session. No whole milestone exit gate is complete.

## Transfer-size and disk-full checkpoint

Uploads and cursor pages are bounded by bytes as well as record count. A large-record client test verifies upload sizes and author order across multiple batches; the relay test verifies every sequence survives byte-bounded pagination. SQLite storage exhaustion returns HTTP 507 without acknowledging or committing a failed batch. Clients retain local state and outgoing work; the identical retry commits after storage becomes available. These checks simulate exhaustion with SQLite page limits, rather than filling the Mac Mini disk. Account quotas are implemented in the relay hardening checkpoint below.

## Native bookmark implementation checkpoint

The [native adapter contract](bookmark-browser.md) records IndexedDB v3 mappings, event-time clock reservations, import/recovery and effect-journal behavior. 22 adapter tests cover the browser/database boundary with a simulated port, including two-tree offline convergence, genuine edits during application, delayed capture context, local-storage failure, and interrupted-addition review. The production WXT build includes synchronous bookmark listeners and opt-in controls. The actual options components passed a synthetic UI preview at desktop and 390 px width; no live Helium profile was touched. Milestone exit gates remain open.

## Session implementation checkpoint

The [session contract](sessions.md) describes IndexedDB v4 capture caches, multipart assembly, current/closed/previous projection and restoration journaling. 32 new TypeScript tests cover source revision ordering, offline persistence/fragment delivery, v3 migration/export, native capture boundaries and interrupted restoration. The fourth Rust-process integration test proves encrypted session convergence after relay/client restart. WXT builds with tabs/groups/sessions permissions and incognito disabled. The real dashboard components passed a synthetic desktop/390 px preview including partial restoration and recovery controls.

Real Helium capture/restoration and lifecycle acceptance is deferred to the joint disposable-profile test. Browser restarts or changed pages during an ambiguous restore pause safely and keep opened tabs; they do not claim automatic recovery in every case. Recently-closed API-only records disclose missing group metadata. At that checkpoint, quotas, retention and key lifecycle remained pending. Relay quotas and client key lifecycle are implemented below; local budgets/retention and native gates remain open.

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

Verification at that checkpoint: `pnpm check` passed 151 TypeScript tests, typechecks and production WXT build; `pnpm check:server` passes 23 Rust tests, rustfmt and clippy with warnings denied; `pnpm test:integration` passes 9 real-process tests. Formatting/version/Changeset checks pass. The earlier relay hardening checkpoint is commit `890bad2`. The checklist front table tracks completed checkpoints and pending work; both copies record checkpoint/commit evidence. Remaining work includes future-data content-key rotation, history content/ciphertext erasure, local budgets/retention, full-scale journal performance, recovery and joint native acceptance. No whole milestone exit gate is complete.

## Key-rotation protocol checkpoint

`a437f25 feat(security): add recipient key rotation protocol` adds SQLite schema 4 with immutable installation wrapping identities and bounded epoch/recipient-packet storage. Independent P-256 ECDH keys plus HKDF/AES-GCM wrapping keep a replacement root separate from the old shared root. Clients authenticate public identities and packets with keyed proofs. One relay transaction stores packets, revokes removed credentials and advances the epoch; failed writes roll it all back. Exact lost-reply retries survive process restart and later rotations. Fresh stale-epoch inserts reject, while exact historical committed envelopes keep their sequence ACKs. `rekey-check` proves missing offline envelopes only after their old epoch has closed.

Seven crypto tests and eight added relay tests cover authentication/tampering, mismatched private scalars, historical identity proofs, immutable registration, atomic failure, exact membership, concurrent rotations, old retries/rekey eligibility, invitation binding, schema-3 migration, 32-packet pages and all 254 possible rotations. An isolated real Rust-process test drops a committed rotation reply, restarts, unwraps the retained offline installation's packet, rejects removed credentials and accepts only the newly encrypted offline record with unchanged logical identity/counter. SQLite contains no content roots, private scalars, plaintext tokens or tested note text.

Verification at that checkpoint: `pnpm check` passed 158 TypeScript tests, typechecks and WXT production build; `pnpm check:server` passes 31 Rust tests, rustfmt and clippy with warnings denied; `pnpm test:integration` passes 10 real-process tests. Formatting/version/Changeset checks pass. [The protocol contract](key-rotation.md) records key metadata bounds and the relay/membership trust boundary, including the limit of HMAC proofs if a malicious relay colludes with a holder of old content keys.

At that protocol checkpoint the client lifecycle and controls were pending and ordinary profiles stayed at epoch 1. The following client checkpoint completes those implementation items. Native acceptance, the stronger malicious-relay/colluding-removed-member threat model and every whole milestone gate remain outside this evidence.

## Client key lifecycle checkpoint

`3d1e9f3 feat(security): persist client key lifecycle and recovery` completes this implementation checkpoint.

IndexedDB schema 7 adds dedicated root/identity and rotation-proposal stores. Independent private wrapping identity/proof state commits before registration; the exact random root/recipient proposal commits before rotation HTTP. Refresh runs before pull/push, validates account/server/author metadata, adopts authenticated roots/current epoch atomically and decrypts historical ciphertext using its original root. Missing local author state or a lost/conflicting private identity pauses safely rather than cloning counters. Normal sync resumes a still-current proposal; superseded proposals require explicit review/replacement.

For old queued ciphertext, complete relay proofs separate immutable committed envelopes from proven missing records. Only missing records are re-encrypted with the current root/fresh nonce; journal/outbox replacement commits together with epoch/record guards and unchanged logical identity/counter/payload. Capture drafts use the current epoch at preparation. The history-index key remains stable. Version-2 private pairing/recovery bundles retain the complete historical root ring; fresh recovery requires a new CLI credential/wrapping identity and starts a separate author at counter 1. Ordinary exports/status exclude private roots, wrapping identities, proposal secrets and pending pairing material.

Eighteen added TypeScript tests exercise migration, identity/proposal durability, lost replies/reopen, malformed/partial proofs, tampering, skipped/rolled-back epochs, paginated adoption, local transaction rollback, concurrent identity/adoption/proposals, changed membership, copied-author rejection and fresh recovery. The eleventh real Rust-process test removes one installation, loses the committed rotation reply, reopens relay/client state and retries exactly. A retained offline profile reconciles notes/bookmarks/sessions/history while keeping historical committed ciphertext unchanged and original visit timestamps intact. A pending keyed pair at epoch 3 survives a rotation to epoch 4, retries its original claim and adopts its recipient packet. A fresh CLI-issued author recovers roots 1–4 and historical/current content without copying another author's credential, private key or counter. SQLite/ordinary exports and outbound rotation bodies contain none of the tested private roots/keys/plaintext credentials/browsing content.

The actual options components passed a synthetic device-removal, lost-reply and saved-proposal retry flow; the final view shows generation 2 and removed access. At 390 px, viewport/scroll/body widths were 390 and console warning/error logs were empty. The [saved preview](../work/ui-preview/key-rotation-mobile.png) is ignored local evidence. The preview tab and localhost server were closed after verification. No native Helium profile was touched.

Current verification: `pnpm check` passes 176 TypeScript tests, typechecks and WXT production build; `pnpm check:server` passes 31 Rust tests, rustfmt and clippy with warnings denied; `pnpm test:integration` passes 11 real-process tests. Formatting/version/Changeset checks pass. Both plan copies track this checkpoint and its commit. Remaining goal work: history plaintext/ciphertext erasure, local budgets/retention, full-scale journal performance, older-backup/server-loss recovery and joint native acceptance. Save fresh private recovery material after rotation; the relay cannot reconstruct absent roots. Local auto-unlock/decrypted storage and the documented relay/membership trust boundary remain. No whole milestone exit gate is complete.

## Branding checkpoint

`9b2e6da feat(extension): add Helium sync logo and favicon` records this checkpoint.

The supplied official Helium application icon was extracted without changing the installed app. Built-in image generation created a Helium Synk derivative with the recognizable six-spoke white emblem/blue tile and two mint sync arrows. The repository retains the transparent RGBA master and PNG sizes 16/32/48/128/256/512, plus an ICO with 16/32/48 px frames. The dashboard, extension installation/toolbar icons and options/restoration favicons use the new assets. [The branding record](branding.md) contains the exact prompt and asset map.

`pnpm typecheck` and the production WXT build pass. The packaged manifest and page HTML point to existing assets with the expected dimensions. The actual options page loaded the 128 px logo at desktop 55 px and mobile 40 px in synthetic previews. Viewport/document widths matched at 1089 and 390 px; console warnings/errors were empty. Saved local screenshots are `work/branding/dashboard-logo-desktop.png` and `work/branding/dashboard-logo-mobile.png`. Preview tab/server were closed after verification. Native toolbar/tab favicon rendering remains pending joint Helium acceptance. No sync behavior changed and the 176 TypeScript/31 Rust/11 integration suite results from the preceding checkpoint remain current. Both checklist copies record this checkpoint/commit; no whole milestone is complete.

## Dark interface and TypeScript aliases checkpoint

`93bea2c feat(extension): adopt dark Tailwind and shadcn UI` records this checkpoint.

All current UI uses a shared logo-derived navy/blue/mint Tailwind theme with dark mode only and zero-radius tokens. The actual shadcn CLI installed the local Radix-based components; dashboard panels, setup/recovery, disclosures, confirmations, tabs, checkboxes and the React restoration page compose that toolkit. Manrope and IBM Plex Mono assets and OFL notices are packaged locally. Existing sync request handlers, retry state and bookmark backup gates remain in their panels. Select labels now explicitly associate with their controls; recovery disclosure buttons cannot submit enrollment.

Extension source imports use `@/…`, with matching TypeScript, WXT/Vite, normal/integration Vitest and shadcn mappings. Shared core imports retain `@helium-synk/core`. The [design-system record](design-system.md) documents the shared tokens/components/fonts and future-page conventions.

`pnpm check` passes 176 TypeScript tests, both package typechecks and the production WXT build. `pnpm test:integration` passes all 11 real-process tests with the new alias configuration. The packaged HTML is dark and references existing local scripts/styles/icons; local font files and license notices are included. The production package is approximately 1.24 MB. Formatting, version consistency and Changeset status checks pass; no release/version bump was performed. No server runtime changed in this checkpoint; the preceding 31 Rust/rustfmt/clippy result remains the server evidence.

Actual UI components were exercised through an ignored localhost preview with synthetic browser replies. Checks covered rotation review/cancellation and a lost committed reply followed by saved retry; bookmark preview counts, disclosure and disabled enable action before backup; current/closed session filtering, detail and blocked/resumed restoration progress; history search, checkbox selection, source filtering and scoped removal review. Dialog cancellation received initial focus, Escape closed review, and ArrowLeft selected the previous session tab. Explicit source labels selected the intended controls. Desktop and 390 px dashboard/setup/restoration layouts had no horizontal page overflow; all inspected controls/cards/badges and the mobile confirmation dialog had zero-radius corners. The theme used `color-scheme: dark`, local fonts loaded, and warning/error logs were empty. These fixtures establish UI behavior, not native browser API acceptance.

Saved local evidence: `work/branding/dark-dashboard-desktop.png`, `dark-dashboard-mobile.png`, `dark-setup-mobile.png`, `dark-history-dialog-mobile.png` and `dark-restore-mobile.png`. Preview tabs and the viewport override were cleaned up after verification. Both checklist copies record this checkpoint; native Helium acceptance, history erasure, local budgets/retention, scale and older-backup/server-loss recovery remain pending. No whole milestone exit gate is complete.

## History journal plaintext cleanup checkpoint

`884a2a3 feat(history): erase suppressed journal plaintext` records this checkpoint.

Suppressed history visit payloads now become local `erased-visit` receipts with original identity/revision, source UUID, opaque URL tag and generation. Plaintext URLs/titles/source names/transitions/referring IDs are removed from those journal rows. The composite identity still retains the native ID/time components needed to suppress recapture; this is not anonymization. Receipts require a corresponding deletion/clear proof and retain author-counter validation. The ordinary wire validator rejects local receipt actions.

IndexedDB schema 8 separately retains receipts for canceled unencrypted drafts; no content from those drafts is uploaded. Counters are never rewound. A clear received while a visit is only a draft now leaves private suppression metadata on its source, rather than sending the canceled visit to peers. The cross-stack test explicitly verifies common visible timelines/barriers, local canceled identity retention, unchanged existing envelopes and absence of journal plaintext in both exports. Peer receipt/frontier metadata need not match for operations never published.

Already encrypted visits keep their immutable envelopes/outgoing retries. Old ciphertext can be replayed or proven missing and re-encrypted after rotation without restoring suppressed plaintext to the journal. This intentionally leaves decryptable ciphertext pending the next purge protocol. Migration removes v7 suppressed journal payloads transactionally while preserving keys, counters and pending envelope bytes. A failed receipt write rolls back index, journal, drafts, metadata and counter state; deletion during async encryption cannot resurrect its canceled draft.

Nine added unit/database tests cover receipts and clear proofs, retagging/revision rejection, wire rejection, two-client deletion/replay, canceled drafts and reopening, failed-write rollback, cross-domain counter reuse, v7 migration, key rotation and the encryption/deletion race. `pnpm check` passes 185 TypeScript tests, both package typechecks and the production build. The 11 real-process integrations pass with the updated erasure assertions. Formatting, version consistency and Changeset status pass; no release/version bump was performed. Server code is unchanged; the preceding 31 Rust/rustfmt/clippy result remains its evidence.

The [history policy](history.md) identifies what is still retained: capture/inbox/lookup copies, local envelopes/quarantine, relay ciphertext and independent older backups/exports. Physical secure deletion is not claimed. Complete history erasure, storage/retention/scale and recovery remain open; joint disposable-profile Helium tests precede section 10 production hosting. Both checklist copies track this checkpoint. No whole milestone exit gate is complete.

## History capture-copy cleanup checkpoint

`abe48a9 feat(history): clean obsolete capture jobs atomically` records this checkpoint.

IndexedDB schema 9 applies existing deletion/clear proofs to saved capture jobs during upgrade. Observed global/source/URL clears remove obsolete raw inbox intents, lookup batches and canceled scans in the same transaction as history projection/journal updates and an incoming cursor. This also works while capture is paused. Unrelated URL work and already observed generations remain saved. Completed native-removal URLs are removed from the remaining intent; cleanup cannot put an older multi-URL list back after a clear changed it.

Selected cached native records become local identity-only erased markers without transition/referring metadata. Shared batches retain their URL for unrelated saved visits, discard the old optional title and preserve their position/identity comparisons. Wholly erased batches are canceled. Native I/O saves only to a still-current job, checks current clear/deletion proofs before persisting records, and cannot recreate canceled work. Discovery rechecks its scan and each URL generation before enqueueing; canceled baseline completion cannot alter newer inventory state.

Nine added tests cover paused cleanup, URL/source isolation, new-generation intent preservation, cached selected records and unrelated batch continuation, native lookup/selected deletion races, native discovery races, local failure rollback, v8 upgrade and remote clear/cursor rollback. The migration test preserves pending envelope bytes and counters; the failed pull test retains the previous cursor and all surviving intent before a successful retry.

`pnpm check` passes 194 TypeScript tests in 14 files, both typechecks and the production WXT package (approximately 1.25 MB). All 11 real Rust-process integration tests pass. Formatting, version consistency and Changeset status pass; no release/version bump was performed. No server runtime changed; the preceding 31 Rust/rustfmt/clippy result remains its evidence. No native Helium profile or production hosting was changed.

The [history policy](history.md) records remaining capture copies: unfetched selected events may retain a URL/title until individual native visits resolve, unrelated shared jobs need their URL, and new baseline/inventory jobs can temporarily copy content still owned by the native browser. Sync removal does not delete native browser history. Authenticated relay/local ciphertext purge, quarantine policy and backup expiration/restore behavior remain pending. Full erasure, storage/retention/scale, older-backup/server-loss recovery and every native/milestone gate remain open.

Basic two-disposable-profile smoke testing can begin now. Full joint acceptance follows the remaining implementation gates; numbered section 10 is subsequent Mac Mini deployment/availability/backups. Both checklist copies include this readiness distinction and checkpoint.

## History relay purge protocol checkpoint

`a4c17a0 feat(server): add atomic history ciphertext purge protocol` records this checkpoint.

SQLite schema 5 retains original history headers/digests and a fixed encrypted certificate/request binding while replacing live-journal ciphertext. Certificate insertion, all replacements/reservations, usage and minimum capability commit atomically. Original sequences, IDs and author counters remain reserved. Exact historical retries ACK without reinserting their bodies; rekey checks classify matching receipts as committed. Only the original author may reserve an unknown encrypted target, at an earlier own counter than the new certificate, without uploading its content.

Pull supplies certified redacted slots with their original sequence/header/digest and encrypted certificate. Pages include duplicate certificate bytes in their 512-KiB bound and never skip erased sequences. The first purge requires explicit capability on push/pull/rekey, so older clients stop with HTTP 426. The current extension does not advertise that capability or invoke purge; client proof validation/consumption is the next checkpoint. A schema-5 database with no purge remains compatible with current clients.

A certificate ID binds one exact body and public target set across retries; target order is immaterial. Concurrent certificates preserve the first committed target proof. Usage includes placeholder/certificate bytes; purged identities no longer count as active encrypted operations. Net cleanup can proceed under a lowered/full quota, while growing metadata returns HTTP 507 and rolls back. Schema-4 upgrade preserves envelope bytes, root/restore epochs, account usage and processed progress without activating erasure.

Nine Rust tests cover those invariants, authentication/revocation, wrong targets/bounds, negative reservations, failed writes, restarted exact retries/rekey, frontiers, quotas, concurrency and bounded pages/ACKs. A JavaScript digest test matches the Rust/Python fixture. The twelfth real-process test discards a committed purge reply, restarts the relay, repeats exactly, inspects live SQL, rejects altered original ciphertext and bootstraps the fresh author from zero. Its opaque certificate fixture proves the relay contract, not client proof validation or end-to-end erasure.

`pnpm check` passes 195 TypeScript tests in 15 files, both typechecks and the production extension. `pnpm check:server` passes 40 Rust tests, rustfmt and clippy with warnings denied. All 12 real Rust-process integrations pass. Format/version/Changeset checks pass; no release/version bump was performed. No native profile or production service changed. Both checklist copies record the checkpoint and remaining client work.

[The erasure protocol](history-erasure-protocol.md) states the remaining trust and copy boundaries: the relay cannot interpret encrypted deletion proofs, live SQL replacement is not secure deletion of old SQLite/WAL pages or backups, and current client local envelopes/quarantine plus unresolved/shared/native-inventory copies remain. Client certificate validation/durable erasure, backup policy, budgets/retention/scale/recovery and every native/milestone gate remain open.

## Client history ciphertext erasure checkpoint — 2026-10-02

`3a6bedd feat(history): authenticate and persist client ciphertext erasure` records this checkpoint.

Encrypted schema-1 `history-erasure` certificates now authorize permanent selected deletion for their target native visit identities. They carry original minimal receipts, encryption epochs and canonical envelope digests; no URL/title/source-name/transition/referring ID or old ciphertext is copied into the proof. Strict payload validation binds outer author/counter/operation ID, causal observation and original metadata, with at most 100 operation targets/80 distinct visit identities per bounded certificate.

IndexedDB schema 10 adds per-target claims and exact pending requests. Counter reservation, certificate draft, claims and history projection commit before encryption; certificate bytes and request commit before HTTP. Successful validated replies remove target ciphertext/outbox/quarantine entries, intent and claims transactionally. Failures retain exact work. Concurrent claims cannot reserve the same target twice. Original outbox rekey respects claims; pending certificates replace encryption only after an explicit missing proof, preserving target digests/epochs and IDs/counters. Committed certificates retry exactly after rotation.

The HTTP client now advertises capability version 1. Pull authenticates attached proofs for fresh bootstrap, binds public slots to encrypted targets and stores ahead-of-cursor certificates without advancing over unprocessed slots. New certificates erase targets already behind a peer's cursor. Target identity/digest/receipt verification, projection, capture cleanup and cursor commit together; original-body replay cannot recreate erased local content. Cross-domain counter checks include certified original headers and private canceled drafts. Changed restore epochs retain intent and stop synchronization.

Twenty new model/database tests cover authenticated/content-free proofs, payload tampering, causal bounds, fresh paginated bootstrap, exact/altered old replay, conflicting known digests, author counter reuse, lost replies/reopening, failed local writes, quarantine cleanup, concurrent claims, 85-identity batching, unpublished encrypted own targets, rotation proofs and epoch changes. The actual real-relay history test discards a committed purge reply, restarts the Rust process/client database, recovers saved intent through authenticated pull, verifies fresh-profile bootstrap and live local/SQL ciphertext removal, and retries original envelopes through their own credentials without resurrection. Never-encrypted outage visits stay private suppression receipts. Certificates add permanent selected proofs alongside original clear/delete operations; older stale-count assertions were replaced with checks for that explicit behavior.

`pnpm check` passes 215 TypeScript tests in 17 files, both package typechecks and the production extension (1.26 MB). All 12 real-process integrations pass. `pnpm check:server` passes all 40 Rust tests, rustfmt and clippy with warnings denied. Formatting/version/Changeset checks pass; no release/version bump is performed. Both checklist copies record this checkpoint. Native profiles and production services were untouched.

Full history erasure is still open for unresolved/shared native capture copies, general quarantine retention, physical SQLite/WAL pages, historical exports/backups and old-backup restore policy. Local budgets/retention/full-scale performance, recovery and joint native acceptance remain before section 10 deployment.

## Local storage admission checkpoint — 2026-10-02

`a28c1b1 feat(storage): preserve local work with bounded admission` records this checkpoint.

Validated per-profile limits now persist in local state and exports, with defaults of 512 MiB estimated origin bytes, 100,000 pending operations/tasks, 500,000 journal/draft/private receipt records and 30,000 capture tasks. Counts are admitted in the capture/journal transaction, so concurrent workers cannot both take the final slot. Native history intent/discovery, bookmark capture/import and session/note publication use shared checks; session collection retains its last good cached windows when paused by capacity. Explicit deletion, authenticated purge and immutable retries remain possible. Existing domain queue bounds still apply.

New incoming content receives journal/byte admission before writes. Capacity failures retain the cursor and avoid quarantine. An authenticated/checked epoch can be saved without processing that page, allowing outgoing retries to commit and release outbox copies. Invalid records, authentication and changed epochs still stop the pass. Certified deletion and known record retries can commit while full. Releasing capacity or increasing a limit resumes the same unprocessed page.

The dashboard shows origin-byte estimates, pending work, journal records and 80-percent warnings, with editable byte/pending limits. Actual estimates use the browser storage API and a five-second sample cache; payload charges are conservative. This is not exact physical accounting or a disk reservation, and count limits remain active when estimates fail. Actual write failures continue to surface and roll back. The [local storage contract](local-storage.md) records these boundaries.

Eleven new unit/database tests cover persistent/exported settings, invalid policy, exact/concurrent pending boundaries, retained state/counters, clear at capacity, unsent current coalescing, browser estimate warnings/unavailability, refused-download rollback, certified deletion at capacity and draining uploads behind a refused page. A thirteenth real-process integration simulates a full local estimate while using the actual relay, verifies one committed pending upload with the original cursor retained, then increases the local limit and receives missing records. It does not establish physical disk-full or native Helium behavior.

`pnpm check` passes 226 TypeScript tests in 18 files, both typechecks and a 1.27-MB production build. All 13 real-process integrations pass. Rust code is unchanged from the verified 40-test checkpoint. Formatting/version/Changeset checks pass; no version/release bump is performed. Actual UI components were exercised with synthetic replies: save changed limits, show the paused-collection warning, and verify zero-radius dark controls/card at desktop and 390 px with no page overflow/error overlay or warning/error logs. The agent-browser CLI was unavailable, so the in-app browser performed those checks. Saved preview evidence is `work/ui-preview/storage-mobile.png`; the tab, viewport override and preview server were cleaned up.

Both checklists record this checkpoint. History/session expiry, full-scale performance, general quarantine/unresolved/shared capture-copy policy, older-backup/server-loss recovery and joint native/milestone acceptance remain open before section 10. No production service or native Helium profile changed.

## History retention checkpoint — 2026-10-02

`abc7bea feat(history): expire acknowledged source-owned visits` records this checkpoint.

Automatic history expiry now persists as an opt-in profile policy, initially 90 days, configurable from 1 to 3,650 days. Only the source author expires its own acknowledged visits. Age uses the original visit timestamp with a strict cutoff; pending drafts, encrypted uploads and duplicate copies sharing the same native identity remain protected. A pending old visit uploads first and can expire on the next reconciliation. Disabling expiry or lengthening the window cannot undo permanent selected deletion.

Each pass selects at most 100 visits from up to 500 indexed candidates, saving deletion proofs, projection/content cleanup, counters and scan progress in one transaction. It advances past protected entries, revisits them after exhaustion and resumes across database reopening. Failed writes roll back; concurrent workers cannot independently expire the same visible visit. Empty ranges avoid a journal scan. Duplicate protection and causal projection still scan retained history state; this does not claim bounded full-scale latency.

Sync runs expiry after the initial authenticated/epoch-checked pull and before the existing history purge. The real Rust-process test proves a pending old visit's original ciphertext commits before expiry, reopens the owner policy, propagates removal to a peer, bootstraps a fresh profile without resurrection and confirms live relay/local ciphertext removal. Another source's old history and the owner's recent visits keep their original timestamps. Existing pending work, native history, causal receipts and historical exports/backups are preserved according to the [retention contract](retention.md).

Ten new unit/database cases cover policy validation/reopening/export, opt-in boundaries, pending/duplicate protection, source ownership, rollback, bounded restart progress, non-starvation, competing workers, late re-import and clock rollback. `pnpm check` passes 236 TypeScript tests in 19 files, both typechecks and the 1.27-MB production build. All 14 real-process integrations pass; the retention integration also passes after the empty-range guard. Rust is unchanged from the verified 40-test checkpoint. Formatting/version/Changeset checks pass; no release bump is performed.

Actual settings components save the enabled 180-day fixture and display the saved policy, with zero-radius dark controls and no horizontal overflow at desktop/390 px. Synthetic browser replies are UI evidence only; warning/error logs were empty. Preview evidence is `work/ui-preview/history-retention-mobile.png`; the tab, viewport override and preview server were cleaned up. Both checklist copies record the checkpoint; session expiry, general retained-copy policy, full-scale latency, older-backup/server-loss recovery and joint native acceptance remain open.

## Disposable native smoke setup checkpoint — 2026-10-02

Prepared ignored `work/native-smoke-ab7daa_o` with a frozen tested extension/server build, two separate empty profile directories, launchers and `START-HERE.md`. A fresh test account has one initial credential (mode 0600); B will get its own author through the private pairing UI. Installed Helium reports 0.18.1.1. No normal profile was accessed or launched for this preparation.

The separate test relay listens on `127.0.0.1:4320`. Readiness returns schema 5 / protocol 1 / SQLite 3.53.3, and a private authenticated status request confirms zero journal operations. No token was printed. The [first smoke checklist](native-smoke.md) covers enrollment, native bookmarks, current/closed sessions, restoration, source/timestamp history, removal and a short outage/restart. Expected setup/first-pass times are approximate planning estimates, not measured native completion times.

No browser profile has been loaded/paired and no native test result is claimed. The joint pass needs the user's participation; independent session retention, retained-copy policy, full-scale/recovery work and hours-long outage/native gates remain open. Production deployment remains deferred.

## Native Helium enrollment and notes — 2026-10-02

Computer use verified the user's Helium Sync Test 1 and Helium Sync Test 2 profiles. The first earlier-kit credential hit the registered-identity/private-key guard; an empty local replica was exported. With explicit approval, loaded a fresh copy of the frozen abc7bea build from ignored work/native-user-profiles/extension (manifest display name only changed), disabled/retained the old copy, and used a fresh account at localhost:4321. Test 1 enrolled and exported recovery/pairing bundles; Test 2 completed private pairing with a distinct author. Both real dashboards show both Native smoke A/B notes, server acknowledgement, Connected and zero pending work. DevTools were closed throughout. Bookmark/domain/lifecycle and whole milestone gates remain open; see native-smoke.md.

## Native Helium bidirectional bookmarks — 2026-10-02

With the same frozen test build, saved each original bookmark tree before enabling its merge. Test 1’s empty collection became enabled, then its native bookmark manager created Synk Native Smoke and the localhost Relay fixture A link. Test 2’s preview found two existing shared entries; its enabled merge created the folder and nested link in the real browser. Renaming the link to Renamed from Test 2 in Test 2 appeared in Test 1’s native bookmark manager with the original URL and no duplicate. Both dashboards report two shared entries, zero conflicts/captured work, and Connected. Evidence screenshot is ignored work/native-user-profiles/bookmark-pass.png. This verifies the basic create/application/reverse-edit flow; conflict permutations and interrupted native application remain acceptance work.

## Native sessions and history; closure fix — 2026-10-02

Test 1 captured a two-tab localhost fixture window with its first tab pinned and second tab active in a green named group. Test 2 received the correct current snapshot and restored a single pinned tab. Closing the source window initially produced two archive entries: teardown tab updates changed the cached pin/order while the recently-closed API preserved the original layout. Added a narrow guard: when a cached tab's window has disappeared, retain its cached layout and captured navigation/title changes. A regression verifies pin/order/group retention, one archive entry, and database reopening.

After typechecks, 237 TS tests, a production WXT build and all 16 real-relay cases passed, updated/reloaded only the approved native test copy in both profiles. The repeated closure produced exactly one new archive entry with the original pin and named group. Restoring its full window in Test 2 opened two ordered real tabs, first pinned and second active in Synk fixed smoke. The two original failed-run entries remain for comparison. Evidence: ignored work/native-user-profiles/session-window-restored.png.

Native history visits from Test 1 (13:21:43/13:22:00) and Test 2 (13:32:23) arrived in both dashboards with their original source labels/times. New-only capture was used. Selected removal, short outage, full worker/browser lifecycle and hours-long outage gates remain open. Extension reload retained enrollment, shared data and collection settings; it is not a full browser restart.

## Native short relay outage — 2026-10-02

Stopped only the isolated port-4321 relay, keeping its existing database. With DevTools closed, Test 1 closed a loaded one-tab `fixture=outage-a` window, saved `Native outage note · Test 1` (14:37:09), and renamed the native test bookmark to `Offline rename from Test 1`. Its dashboard showed Waiting to sync, queued local work and the intact closed snapshot (14:36:55). Existing notes/history remained available.

Restarted the same frozen server/database after approximately two minutes. Test 1 returned to Connected and the note became server-acknowledged; Test 2 automatically received it and exactly one new closed-window entry containing the original fixture URL. Both showed zero pending uploads. Test 2’s native bookmark manager displayed the offline rename with the original URL and no duplicate. Evidence is ignored `work/native-user-profiles/outage-bookmark-pass.png`. Also inspected Test 2’s full-window restoration journal: 2/2 pages opened, 1/1 windows ready, complete; both single-page attempts are complete.

The single selected history fixture visit has been filtered and its review dialog prepared, awaiting at-action permanent-deletion confirmation. Full browser/worker restart and hours-long native outage remain unverified. No production service or normal profile changed. Both checklist copies record this checkpoint.

## Relay snapshots and restore guards — 2026-10-02

`09bf1bd feat(server): snapshot backups and guard restore epochs` records this checkpoint.

Added `backup --output` for consistent SQLite `VACUUM INTO` snapshots including committed WAL content. Outputs use exclusive creation/mode 0600, never overwrite an existing file, sync the file and parent before success and remove only their own failed ordinary-error output. Interrupted artifacts require integrity checking. `backup` and `mark-restored` require an existing database, preventing a typo from creating a fresh account.

`mark-restored --expected-epoch` requires a stopped database, checked through a Unix process lease shared with `serve`. The lease canonicalizes ordinary paths and lasts for the process; older binaries do not honor it and must be stopped explicitly. Marking generates a new epoch, resets delivery/processed progress and removes stale pairing invitations in one transaction. It preserves account/credential hashes, records, sequence/counter identities and key-rotation registry. Wrong epochs and forced transaction failures leave the old state intact.

Four added Rust cases verify WAL contents/integrity/private token-hash-only snapshots, exact retry after reopening, no-overwrite/failure cleanup, epoch/reset rollback and process-lease exclusion/release. Two real-process cases exercise live backup and isolated older restore after acknowledged history erasure/key rotation, plus a completely lost relay database. Newer clients reject the older key/cursor frontier (HTTP 409); disk-loss credentials are rejected (401). Exact ordinary exports, keys, pending envelopes/domain drafts, later acknowledged local notes and deletion proofs remain intact. No missing operation replay or client resume is claimed.

All 237 TS tests, 44 Rust tests and 16 real-process integrations pass, along with typechecks, production WXT build, rustfmt/clippy and formatting/version/Changeset checks. The server Changeset is recorded without a release bump. [relay-recovery.md](relay-recovery.md) documents the commands and remaining replay/resume, retained-backup deletion, physical interruption/disk-full and deployment gates. No native profile or running pilot relay was upgraded for this checkpoint. Both checklist copies are updated.

## Native worker termination and revival — 2026-10-02

Navigated Test 1’s only extension dashboard to Helium’s service-worker manager. The sole registration matched approved extension `icjnepaninedejemijejhdoofomipbgm`. With DevTools/debug-on-start disabled, Stop changed its visible Running Status from RUNNING to STOPPED (renderer process 0). Saved `work/native-user-profiles/worker-stopped.png`, then closed that internal manager.

Edited the existing fixture bookmark in Test 1’s native manager to `After worker restart · Test 1`. Without opening the source dashboard or clicking Start, Test 2’s native manager received the title with the original URL and one link. Saved `work/native-user-profiles/worker-revival-bookmark-pass.png`. This proves automatic revival and resumed bookmark delivery after verified worker termination; it does not distinguish native-event waking from an intervening alarm or verify full browser restart. Removal confirmation, hours-long outage and remaining native acceptance permutations remain open. Both checklist copies are updated; no normal profile or production setting changed.

## Comprehensive checklist audit — 2026-10-02

Reconciled [plan.md](plan.md) throughout its numbered sections, milestone tasks and verification matrix against the implementation, commit history and recorded automated/native evidence through `47567e4`. Completed tasks now have `[x]`; mixed tasks are split into the completed scope and remaining work. Updated the relay schema description to the actual migrated tables, the current native testing status, and the outstanding acceptance list. Historical checkpoints retain their original test counts and are distinguished from later results.

The latest recorded verification remains 237 TypeScript tests, 44 Rust tests and 16 real-process integrations, with the previously recorded typechecks/build/tooling checks. This is a documentation-only audit; no test suite or browser action was rerun. All seven whole milestone exit gates remain open. Session retention, general retained-copy policy, scale, complete recovery/replay/resume, remaining native acceptance and production deployment remain unfinished. Both checklist copies are synchronized for this checkpoint.

## Guided routes and consistent shadcn layout — 2026-10-02

Checkpoint commit: `1cee5fb feat(extension): guide setup with routed shadcn pages`.

Replaced the scroll-only options page with 15 TanStack Router views and a shared status provider. Setup separates the first connection, invitation pairing and fresh-credential recovery, accepts private files with optional paste fallback and generates initial keys locally. Successful setup leads to opt-in collection choices. Recovery/security/diagnostics have their own settings routes; History defaults to new visits. Existing APIs, identities, saved pairing retry/discard, bookmark preview/backup gates and removal/key-rotation reviews remain in use. No backend protocol changed.

Added official shadcn Field, Item and Empty source components. Forms use explicit label/control/helper/error composition; cards use headers/content/footers and action links use Button composition. Removed conflicting label/form margins and stale layout rules. Desktop History’s textarea/select now start at the same Y position, and all four filters share label/control baselines. Standard inputs/selects/buttons are 40 px tall with 8 px label gaps; storage metrics and narrow connection actions align.

Rendered actual components using the ignored localhost preview and synthetic background replies: first setup, invalid JSON, invitation-file input, interrupted registration/retry, direct route reload/back, all 15 options views and the restoration page at 390 px. No horizontal page overflow; fresh preview route/pairing console had no warnings/errors. Evidence is ignored `work/ui-preview/aligned-history-desktop.png`, `aligned-settings-expanded.png` and `aligned-home-mobile.png`. This establishes UI behavior, not native enrollment. TypeScript checks, 237 TS tests and production WXT build pass; all 16 real-relay cases passed during this work. The preceding 44 Rust test result was not rerun for UI-only changes. Patch Changeset recorded, no release bump.

Also verified Test 2’s native folder rename appears in Test 1 with the existing nested link. The attempted root move was undone locally; no cross-profile move/undo pass is claimed. Native interaction stopped when the user resumed Helium. The earlier history-removal review was cancelled; no permanent removal occurred.

Both checklist copies record completed UI work and the remaining packaged native/user-feedback checks. The approved native test copy/relay were not upgraded. Full native acceptance, retention/scale/recovery and production deployment gates remain open.

## Native routed UI, startup wording and removal attempt — 2026-10-02

Checkpoint commit: `ae87613 fix(extension): clarify startup status and recovery guidance`.

Snapshot the previous native copy in ignored `work/native-user-profiles/extension-before-routed-ui`, then update only options/restoration pages, chunks and styles at the same stable approved path. Base UI: `1cee5fb`, followed by startup/recovery wording corrections. The manifest permissions/version, background SHA-256 (`7191114df95cd00dcb851ede8d4c4b915ef88e96e360e13b7eceadd187e2a0ef`), extension origin, saved installation identities and isolated port-4321 relay/database remain unchanged. The old copy stays disabled.

Both named profiles retain their names, two shared bookmark entries, saved sessions/history and capture preferences; Test 2 remains paused for session capture. Native Home/Devices/Add device/Settings/Recovery navigation passes. Recovery survives direct reload; the native Back button returns to Settings. Test 2's old `#history` normalizes to `#/history`. The first offscreen Recovery click and macOS Alt+Left had no effect; the visible link and actual toolbar Back were used successfully.

`Routed UI native · Test 1` at 16:38:16 and `Routed UI native · Test 2` at 16:43:32 appear as Synced in both new Diagnostics pages, under their distinct authors `ad82e4c7` and `62ef13e7`, with Connected/zero waiting changes. Earlier smoke/outage messages remain. Saved native proof includes `routed-ui-test1-diagnostics.png` and `routed-ui-test2-diagnostics.png` in the ignored kit. This verifies native saved-state UI/transport, not fresh file-based enrollment/pairing/recovery.

An enrolled startup initially displayed Offline before transport attempted reconciliation. Home/header now say Checking connection for that state, retaining Offline for unavailable/failed transport. Post-rotation guidance now points to Settings → Recovery & backups. Typechecks, 237 TS tests and the production WXT build pass after these three UI wording changes. Rendered synthetic checking/offline branches report no fresh warning/error logs. Patch Changeset recorded without a release bump. The preceding 16 real-process integrations/44 Rust results are not rerun for these copy-only changes.

The user approved the one original Test 1 `fixture=session-a-1` visit at 13:21:43. After rechecking the one-visit review, Confirm removal was clicked once. The source review remained busy. Test 2's count fell from 66 to 65, but route navigation left stale Home content, reload removed page content, and Helium's own Extensions manager also rendered blank. The relay remains live/ready with its original epoch, and native UI resource references exist. This is insufficient evidence of a durable deletion pass or its cause. No repeated delete, history clear, extension reset or browser quit was performed. Whole-app restart approval is pending because it affects all Helium windows. Saved `routed-ui-history-removal-review.png` and `native-extensions-blank.png`; keep the removal/restart check open.

Both plan copies are updated for the native results, submitted deletion and unresolved rendering. Full native onboarding/restart/endurance, retention/scale/recovery and production gates remain open.

## Selected native history removal verified — 2026-10-02

The earlier rendering interruption was recovered by opening a fresh options tab in Test 2, without quitting Helium. Test 1's original one-visit review subsequently closed. The approved `fixture=session-a-1` visit at 13:21:43 stays absent in both exact filtered synced timelines after each profile completes manual Sync now and a direct page reload. Both Home pages show Connected / Everything is up to date. Test 1's neighboring synced `fixture=session-a-2` visit at 13:22:00 remains, and its native browser History search finds one original `fixture=session-a-1` entry. The native-history tab created for this check was closed.

The isolated relay was inspected read-only: one erasure certificate, one redaction, `purged = 1`, and both nonce/ciphertext lengths zero. This is live synced-timeline/relay erasure evidence; physical database pages, native history, old exports/backups and unresolved/shared capture copies remain separate retained-copy boundaries. No repeated deletion, native-history deletion, profile reset, key change, browser quit or relay upgrade occurred. An accidentally opened all-profile review was cancelled before confirmation. The earlier blank-page cause remains unconfirmed; restarting the app was unnecessary for this specific verification.

Saved scoped proof in ignored `work/native-user-profiles`: `history-removal-test1-after-sync-reload.png`, `history-removal-test2-after-reload.png`, `history-removal-neighbor-preserved.png` and `history-native-fixture-preserved.png`. Both plan copies mark this single-visit acceptance as passed and keep native clears/reconnect, fresh file-based onboarding, full restart/endurance, retained-copy/scale/recovery and all whole milestone gates open. This is a documentation/native-verification checkpoint against existing UI commit `ae87613` and approved background `1d00114`; no source or test suite changed.

## Saved collection action follow-up — 2026-10-02

Commit `5df642d fix(extension): open saved collections while capture is paused` follows documentation checkpoint `a97063c`. Disabled collections with saved data now offer Open, while empty disabled collections retain Set up. The same focused routes and opt-in capture controls remain. Rendered saved/off and empty/off branches pass for bookmarks, sessions and history with no fresh preview warning/error logs.

Update only the approved native UI assets after saving `extension-before-saved-collections`; the named manifest, permissions/origin, identities, existing relay and background SHA-256 remain unchanged. Test 2 Home shows Sessions Off, 98 saved snapshots and Open sessions after reload. Clicking it displays the saved current session while Capture is paused and Enable session capture remain visible. No capture setting was changed or restore started. Scoped proof: `open-saved-sessions-home.png` and `open-saved-sessions-paused.png` in ignored `work/native-user-profiles`.

Both typechecks, 237 TS tests and the production WXT build pass. Extension patch Changeset recorded; no release bump. This UI-only patch does not rerun the preceding 44 Rust/16 integration results. Both checklist copies record this checkpoint and leave full native onboarding/clear/reconnect/restart/endurance, retained-copy/scale/recovery and milestone gates open.

## Native bookmark interaction follow-up — 2026-10-02

A second scoped root-move attempt in Test 2 did not establish a move. After Cut, the native manager stopped listing the test folder and Paste was disabled at Other Bookmarks. Menu Undo showed no visible restoration; the normal Undo shortcut restored the folder. The immediate folder view briefly showed two copies of the existing `After worker restart · Test 1` fixture link. Reloading that manager shows one link; Test 1’s native folder also shows one. No persistent duplicate or implementation cause is established. Direct drags from the tree/main list changed focus/selection without establishing movement, so root move and propagated undo remain unchecked.

Saved ignored evidence: `bookmark-cut-undo-duplicate.png` records the intermediate view and `bookmark-cut-undo-peer-single.png` the peer’s one-link view. The fixture is preserved; no new code, identities, permissions or relay changes follow this interaction. Both checklist copies record the limitation and the `5df642d` action-label checkpoint.

## Native 24-tab restoration and focused session route — 2026-10-02

Checkpoint commit: `f688edd fix(extension): open saved sessions on a focused page`.

A single native Test 1 fixture window with 24 ordered localhost tabs was captured and closed. Test 2 restored it through one Open window request: exactly 24 destination tabs in order, tab 24 active, journal 24/24 pages and 1/1 windows complete with zero skipped. Automatic bounded passes completed without manual resume; forced interruption and multiple windows remain unverified. The first observation returned about 2.3 seconds after the click; exact delivery and full page loading were not measured. Only owned fixture windows were closed; the saved snapshot/journal remain and Test 2 capture stays paused.

Native use exposed that View placed restore controls below the entire snapshot list. `/sessions/$snapshotId` now mounts one focused detail page, showing controls and snapshot-specific progress before tabs. Type/source search parameters preserve filters through return links, browser Back and direct reload. Missing snapshots have an error/retry/return path; obsolete unmounted requests are ignored. Existing restoration/background contracts are unchanged.

Desktop and 390 px synthetic checks pass for filters, Back/reload, missing snapshots and blocked-job resume, with no horizontal overflow, rounded controls or fresh warning/error logs. Native Test 2 opens the real 24-tab snapshot on the new packaged route, displays its existing complete journal, survives reload and returns to Closed with capture paused. No repeated native restoration was submitted. UI-only asset update retains origin, named manifest, permissions and background hash; rollback is `extension-before-session-detail-route`.

Both typechecks, 237 TS tests and production WXT build pass; extension patch Changeset recorded without a release bump. The preceding 44 Rust/16 integration results remain recorded; this UI-only change does not rerun them. Scoped ignored proof: `large-restore-source-24-tabs.png`, `large-restore-destination-24-tabs.png`, `large-restore-journal-complete.png`, `session-detail-preview-desktop.png`, `session-detail-preview-mobile.png` and `session-detail-native-24.png`. Both plan copies mark these specific passes and leave full native acceptance, session/retained-copy policy, scale/recovery and section 10 open.

## Native cross-root cut/paste and Undo checkpoint — 2026-10-02

- [x] Create the separate empty disposable `Synk root move fixture · Test 2` on Bookmarks Bar, leaving the earlier folder/link intact.
- [x] Cut that fixture, explicitly activate Other Bookmarks with Return, then paste with the normal shortcut. Test 2 shows one folder in Other Bookmarks; Test 1 shows one there and no extra copy on Bookmarks Bar.
- [x] Undo Paste, then Undo Cut in Test 2. Both profiles show one restored folder on Bookmarks Bar and no destination copy. Test 1's placement/count survive bookmark-manager reload.
- [ ] Verify drag/onMoved behavior, child preservation and the remaining conflict/interruption matrix. This empty-folder cut/paste test establishes visible placement and propagated native Undo, not preservation of a replicated node identity through Cut.

UI/background checkpoint: `f688edd` / `1d00114`; the approved relay, profile identities and capture settings remain unchanged. Native tree AX clicks require activation with Return for this flow; the earlier incomplete attempts did not establish a destination. No browser code fix follows. Retain the disposable folder for follow-up checks. Scoped ignored proof: `root-move-test2-other.png`, `root-move-test1-other.png`, `root-undo-test2-bar.png`, `root-undo-test1-bar-after-reload.png` and `root-undo-test1-other-empty.png`.

## Native multi-window restoration checkpoint — 2026-10-02

- [x] Create two owned Test 1 windows with ordered `multi-window-a-01/a-02` and `multi-window-b-01/b-02` localhost pages, each with its second tab active.
- [x] Review the received three-window/eight-tab current snapshot before Open all. The pre-existing source window contains one public Helium GitHub issue and three internal pages; no private URL is selected.
- [x] Submit Open all once in Test 2. Both fixture destinations retain their two-tab order and second active tab; the reviewed public page opens in a third destination, and three internal pages are skipped.
- [x] Verify the journal reaches 5/5 supported pages and 3/3 windows, complete, three skipped, without manual resume or a second request.
- [x] Verify both original fixture windows remain intact; close only the three owned destination windows and the two owned source fixture windows after verification. The pre-existing source window remains untouched and Test 2 capture stays paused.
- [ ] Verify forced interruption and resume during large/multi-window restoration; this normal completion does not pass the interruption or full-scale gate.

UI/background checkpoint: `f688edd` / `1d00114`; approved origin, permissions and isolated relay remain unchanged. Scoped ignored proof: `multi-window-source-review.png`, `multi-window-destination-a.png`, `multi-window-destination-b.png` and `multi-window-journal-complete.png`. Exact delivery/full-page loading latency was not measured.

## Fresh native file onboarding and user decisions — 2026-10-03

- [x] Load the approved `f688edd` UI / `1d00114` background into the approved empty Setup Test A/B profiles, retaining extension ID and permissions. Use a separate ready localhost relay on port 4322 (`abc7bea` frozen test binary, epoch `d6eb303d-96ee-43c8-a788-be70bbeb716b`). Test 1/Test 2's origin/data and relay remain separate.
- [x] Enroll A through the native connection-file chooser; arrive at Choose what to sync / Connected, with bookmarks, sessions and history off and zero saved domain records.
- [x] Load an expired invitation in B; reject it, retain the pending device/name across reload, retry with the same expiry error, and replace only that unsuccessful setup attempt.
- [x] Save a new invitation from A and pair B through the native file chooser. B lists A as Linked and itself as You; both collections screens retain opt-in defaults.
- [x] Send `Fresh file onboarding · Setup A/B` from independent authors `0044ac4d` and `e4bdf698`. Both Diagnostics pages show both messages Synced / Connected with zero changes waiting; A's direct reload preserves this result.
- [x] Record Mihir's setup clarity and ordinary full Helium restart checks as user-tested. Agent subsequently observes A's saved identity, Connected state and all collections off; abrupt/offline restart is not inferred.
- [x] Record decisions: current Helium only for V1, compact popup wanted, proposed session/backup policy accepted, GitHub access resolved, and this Mac Mini chosen for Tailscale hosting. Local read-only Tailscale status is Running/online with no health warnings; production service configuration is not performed.
- [ ] Complete fresh-author recovery, remaining connection interruptions, abrupt lifecycle/endurance, domain matrices, retained-copy/session policy and scale/full relay recovery.

Ignored fixture proof: `setup-a-welcome.png`, `setup-a-collections.png`, `setup-b-expired-retry.png`, `setup-b-collections.png`, `setup-a-diagnostics-synced.png`, `setup-b-diagnostics-synced.png` under `work/native-setup-profiles`. Private file contents are excluded from screenshots/docs. This checkpoint changes documentation only and does not rerun code suites or pass a whole milestone.

## Compact toolbar popup checkpoint — 2026-10-03

- [x] Add the requested dark square popup using shared logo tokens and shadcn Button/Badge/Alert components. Show profile/connection state, queued changes, Sync now, collection shortcuts and Open Helium Synk / Connect another device.
- [x] Keep setup, saved connection retry, storage, retention and recovery on their focused options routes. An empty popup offers Set up sync; a durable pairing attempt offers Finish connecting; unavailable worker status offers retry and dashboard access.
- [x] Verify rendered online/offline/checking/empty/pending/worker-error and long-name states, manual sync feedback, 360 px width, no overflow, zero rounded controls and no fresh preview warning/error logs. Long-name height is about 440 px.
- [x] Load UI assets and popup manifest action at the approved stable extension path with a complete rollback copy. Background SHA-256, permissions, optional hosts, identity and stored data are unchanged.
- [x] Reload only Setup Test B's extension; verify its native popup shows the saved profile and Connected / Everything is up to date. Sync now returns normally. Sessions, Add device and Open Helium Synk open the correct full-page routes and close the popup. Collections remain off; only owned shortcut verification tabs are closed.
- [x] Pass both TypeScript checks, all 237 existing tests, production WXT build, changed-file formatting and version consistency; record an extension patch Changeset without a release bump.

The native popup pass is on Setup Test B. Other installed test profiles receive the same UI on their next extension reload. Existing background/relay behavior is unchanged, so this UI checkpoint does not rerun the preceding 44 Rust/16 integration results or pass the remaining recovery/endurance/scale/production gates. Ignored proof: `popup-native-connected.png` and `popup-preview-online.png` under `work/native-setup-profiles`; rollback: `work/native-user-profiles/extension-before-compact-popup`.
