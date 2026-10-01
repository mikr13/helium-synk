# Verification record

Updated 2026-10-01. This checkpoint handles encrypted diagnostic notes only. The [main checklist](plan.md) keeps all milestone exit gates open.

## Completed automated checks

| Check                            | Evidence                                                                                                                                                                         | Boundary                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Move outside iCloud Documents    | Checkout, Git history, dependencies, and builds verified at `/Users/mihirpandey/Work/fun/helium-synk`; old checkout removed                                                      | The original planning document remains in Documents; it contains no credentials             |
| TypeScript core                  | 12 tests in `sync-core/src/core.test.ts`                                                                                                                                         | Uses fake IndexedDB; not a browser lifecycle test                                           |
| Rust/SQLite relay                | 7 tests in `server/tests/relay.rs`; rustfmt and clippy with warnings denied                                                                                                      | Real temporary SQLite files; no production deployment                                       |
| Cross-stack transport            | 2 tests in `tests/relay.integration.test.ts`                                                                                                                                     | Real Rust process, HTTP and authenticated WebSocket; client IndexedDB simulated             |
| WXT production extension         | `pnpm check` builds Chromium MV3 options page/background worker                                                                                                                  | Browser rendering, permissions, alarms and worker revival still require manual verification |
| Version alignment and changesets | `pnpm check:versions`; full `pnpm version-packages` smoke test in an ignored disposable copy generated all three changelogs and aligned Cargo/package/lockfile versions at 0.2.0 | Changelogs generated at an intentional release, not this unreleased checkpoint              |

Core coverage includes reopening durable queued work, a lost acknowledgement followed by a deduplicated retry, two-author decryption, concurrent counter reservation, one sync coordinator, rejected acknowledgement retention, non-skipping cursors, wrong-key failure, server-epoch changes, authenticated metadata, fresh nonces, and invalid enrollment/endpoint rejection.

Relay coverage includes credential hashes/revocation, committed idempotent results, conflicting operation IDs/counters, atomic failed-batch rollback, disk reopen preserving account/epoch/sequences/tokens, author/domain/nonce/epoch validation, bounded pagination, and WAL/FULL durability.

The cross-stack outage test stops the relay, queues independent notes on both clients, reopens one local database, restarts the relay, and proves equal decrypted records plus empty outgoing queues. It also inspects persisted envelopes for absence of the note text and root key. The WebSocket test verifies initial-message authentication and a notification after a real commit. This is a short deterministic outage, not an hours-long endurance test.

## Pending native and operational gates

- [ ] Render and use the extension in two disposable Helium profiles; verify accessibility and narrow-window layout.
- [ ] Verify enrollment, exact-host optional permissions, shared-key backup, and peer note arrival in the real browser.
- [ ] Force worker termination, revive through alarms/startup, and reconcile with DevTools closed.
- [ ] Run an hours-long outage including browser restarts, then verify convergence and measured latency.
- [ ] Verify bookmark/history/window/tab/group APIs and restoration without touching the user's normal profile.
- [ ] Verify Tailscale HTTPS/WSS, access rules, service restart, logout, reboot, and FileVault recovery.
- [ ] Implement quotas/backpressure, pairing invitations, local replica export, and older-backup/server-loss recovery.
- [ ] Implement browser-content adapters and their conflict/deletion/restoration acceptance tests.

The installed Helium app is 0.18.1.1 with Chromium framework 154.0.8037.57. The manifest floor of 120 is provisional and has not been verified against an older Helium release. WXT development mode built successfully but requested manual unpacked loading. Native inspection selected an existing unrelated profile; it was left untouched, so no native compatibility result is claimed.

The current SQLite library selected by the macOS Cargo helper is Homebrew 3.53.3. A runtime guard rejects versions affected by the [SQLite WAL-reset issue](https://sqlite.org/wal.html#wal_reset_bug). Keep this guard when upgrading dependencies.

## Scope and recovery limits

The client stores its root key, API credential, and decrypted notes in its local profile for automatic unlock. The server cannot decrypt contents, but this build adds no local-at-rest encryption. Save recovery-key material separately from relay backups.

API revocation rejects HTTP requests immediately; open sockets recheck authorization on messages/heartbeats. A CLI invocation runs separately from the relay, so it does not directly broadcast to that process. Revocation does not rotate the shared content key or erase downloaded data.

The server epoch persists across ordinary restarts. Clients refuse a changed epoch, but there is no older-backup epoch-rotation/recovery CLI yet. Restoring a stale database with its old epoch can hide lost acknowledged records; do not use that as a production recovery path. Keep backups isolated until the recovery gate passes.
