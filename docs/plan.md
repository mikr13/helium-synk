# Helium Synk release checklist

Updated 2026-10-03. This is the single project checklist. Checked items have recorded evidence; unchecked work is not claimed as tested. Technical contracts are in [architecture.md](architecture.md), user instructions in [setup-guide.md](setup-guide.md), and operations in [deployment.md](deployment.md).

## Release boundary

V1 provides private, opt-in bookmark, session and history sync on current compatible Helium releases. Each independent context has its own account; additional installations join through invitations. The compact popup is included. Passwords, cookies, whole browser-profile copying and iCloud are outside this release.

Version 0.2.0 has recorded automated and native acceptance evidence. A reference macOS installation has two independent accounts with private HTTPS/WSS and local backup/monitor jobs. Those observations do not guarantee every user's hardware, tailnet or remote-device setup. Encrypted off-host backup, broader operational acceptance and publication remain pending.

## Implementation baseline: steps 1–9

- [x] **1. Scope and compatibility.** Opt-in bookmarks, current/closed/previous sessions and searchable history; source-owned sessions and explicit restoration. Manifest Chromium floor 134; native baseline Helium 0.18.2.1 / Chromium 154.0.8037.92. Older versions have not been validated.
- [x] **2. Durable offline state.** IndexedDB journal, drafts/outbox, immutable retries, atomic incoming cursor/projection and independent native application/restoration progress. Tested short outages and database/worker reopening preserve pending work. Storage limits pause capture without discarding queued work.
- [x] **3. Encryption and keys.** Authenticated AES-GCM envelopes, installation/domain keys, stable history index key, hashed relay credentials and private recovery export. Profile secrets and decrypted caches are not encrypted at rest by the extension.
- [x] **4. Relay and transport.** Rust/Axum/SQLite, bounded authenticated push/pull, idempotent ACKs, WebSocket hints, durable processed cursors, epoch guards, quotas, graceful shutdown and consistent snapshots. Protocol 1 / relay schema 5 / client schema 10.
- [x] **5. Bookmarks.** Preview and backup before opt-in, causal field/placement merges, tombstones, recovered children, capture and journaled browser effects. Native create/reverse rename and empty-folder cross-root cut/paste + Undo passed.
- [x] **6. Sessions.** Current/closed/previous snapshots, encrypted multipart transport, source revision ordering, durable capture and explicit restore jobs. Native pins/groups/closed capture, 24-tab restore and ordinary three-window restore passed.
- [x] **7. History.** Original-time capture/import/search, source filters, exclusions, logical deletion, authenticated live ciphertext purge and source-owned expiry. One selected test visit's removal converged without deleting native browser history or neighboring visits.
- [x] **8. Devices and key lifecycle.** Private expiring invitations, durable registration/retry, independent wrapping identities, device removal/future-content key rotation and safe queued rekey. Automated fresh-author recovery passes; broader native recovery remains a follow-up.
- [x] **9. Interface.** Routed dashboard, file-based onboarding, compact popup, shared dark-only navy/blue/mint Tailwind/shadcn UI, square controls and TypeScript aliases. Setup, expired-file replacement, route/reload/back and popup navigation passed.

## Release preparation and public reuse

- [x] Migrate the workspace to exact Vite+ 1.0.0, preserve WXT MV3 builds and aliases, and consolidate lint/format/unit configuration. `vp run dev` / `vp run build` invoke WXT; `vp test` invokes the built-in runner.
- [x] Finish source-owned session expiry controls with defaults of 30 days / 100 archives / 50 MiB / off. Protect current, queued and restoration work. State clearly that encrypted copies remain and these caps are not physical disk bounds.
- [x] Deliberately release core/extension/server and matching Rust versions as 0.2.0 with generated changelogs; verify packaged binary, extension entrypoints/icons, checksums and build metadata.
- [x] Consolidate project progress into this file and remove obsolete scratch/proof/preview/build debris while preserving active installations and private data.
- [x] Replace personal names, local usernames, real tailnet hosts, installed extension IDs and personal deployment narratives in public source/docs with reusable instructions and neutral evidence.
- [x] Replace fixed profile lists, ports and schedules in macOS helpers with a validated deployment config. Support arbitrary independent profiles, configurable retention/root/namespace and Python discovery across Homebrew layouts.
- [x] Provide `config/macos.example.json`, ignore local deployment configs, and document fresh installation plus `--add-profiles` without replacing existing accounts. Consolidate duplicate setup instructions into `setup-guide.md`.
- [x] Validate config failures, custom profiles, independent credentials, backup/monitor/log behavior, release checks, read-only preflight and preservation during account addition in 15 isolated deployment tests. Runtime files and launchd jobs on the reference host were not changed by these tests.
- [x] Finish public-reuse checks: `pnpm exec vp check` passes format/lint/type checks; `pnpm exec vp test` passes all 252 tests; `python3 scripts/macos-ops.test.py` passes 15 tests. The public-file audit finds zero personal-detail matches across 163 text files, all 34 local documentation links resolve, and `git diff --check` passes.

## Recorded verification

| Evidence                 | Result and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.2.0 automated baseline | 252 TypeScript tests, 44 Rust tests and 17 real Rust-process integrations; lint, original TypeScript checks and WXT production build passed. No new skips or weakened assertions.                                                                                                                                                                                                                                                                                                |
| Vite+ compatibility      | Original test runner was already v5; no generated v4 compatibility settings. No tsdown settings apply because core is an internal source workspace, not a separately packed library.                                                                                                                                                                                                                                                                                             |
| Fresh native setup       | Connection-file enrollment, invitation pairing, expired-file reload/retry/replacement, collection defaults off and two-way ACKed diagnostics.                                                                                                                                                                                                                                                                                                                                    |
| Browser restart          | Ordinary full browser restart preserved the observed device's identity/connection/settings. This does not establish abrupt shutdown or hours-long outages.                                                                                                                                                                                                                                                                                                                       |
| Bookmarks                | Native create/reverse rename, short-outage replay, empty-folder cross-root cut/paste and two-step Undo converged. Broader child/conflict/interruption cases remain open.                                                                                                                                                                                                                                                                                                         |
| Sessions                 | Ordered/pinned/grouped current and closed capture, 24-tab count/order restore and two ordinary three-window fixtures passed; five supported pages restored and three internal pages skipped in each fixture. Source windows remained intact.                                                                                                                                                                                                                                     |
| History                  | A selected test visit disappeared across peers and live relay ciphertext; native history and neighboring visits remained. Broad clear/retention/permission cases remain open.                                                                                                                                                                                                                                                                                                    |
| UI                       | Dashboard checked at desktop/390 px and popup at 360 px across setup/connection/error states. Shared field spacing, native routes, reload/back and popup status/navigation passed.                                                                                                                                                                                                                                                                                               |
| Reference deployment     | Two separate account IDs, credentials and client key sets; own authenticated HTTP status returned 200 and cross-account credentials 401. HTTPS/WSS and native Connected/empty-queue observations passed. These checks were on one physical host.                                                                                                                                                                                                                                 |
| Public-reuse checkpoint  | Configurable installer and helpers tested against real temporary relay databases. New account addition preserved all existing databases, credentials, artifacts and agent files byte for byte. No live services were restarted. All 15 deployment checks and 252 unit tests pass, along with format/lint/type checks and local documentation links. The actual installer CLI preflight accepts the public example against the verified release without creating an installation. |

## Checkpoints

- `36ec31a`: compact popup and native status/navigation.
- `5fb9842`: logical session archive expiry, protection for current/upload/restoration work, atomic receipts and lost-reply/restart/bootstrap checks.
- `837020a`: session retention controls and macOS installation scripts, with the preceding Vite+ migration/release preparation included in the checkpoint.
- Current uncommitted change: generic configurable deployment and public setup documentation. No commit, push, tag or publication is part of this change.

Build-specific hashes and private native screenshots belong in ignored `release/` metadata/evidence, rather than hardcoded deployment instructions. Host-specific operating notes are retained privately under ignored `work/` and are not release artifacts.

## 10. Deployment and publishing

Use the [runbook](deployment.md) for concrete commands. Deployment checks must be repeated for the intended installation.

- [x] Define V1 distribution: release artifacts with manual unpacked-extension updates from a stable directory. Native History stays unchanged; a browser store/updater is later work.
- [x] Produce a verified 0.2.0 candidate and record the automated baseline.
- [x] Verify two independent reference accounts, permanent extension installation, opt-in collection enrollment and separate current recovery/replica exports.
- [x] Verify reference private filesystem permissions, patched SQLite linkage, per-user launchd jobs, bounded logs, readiness/usage monitoring and consistent local backups with default 7 daily / 4 weekly / 3 monthly retention.
- [x] Verify reference private Tailscale HTTPS/WSS routes, application credential isolation and public Funnel disabled.
- [ ] Verify a second physical client, intended tailnet access and reconnect/queue drain after relay/Tailscale restart on the target hardware.
- [ ] Verify server sleep/display-sleep behavior, FileVault unlock/login, logout, reboot, cold start and power restoration. Per-user jobs do not promise pre-login availability.
- [ ] Choose encrypted off-host backup storage, test copy/rotation/failure reporting/integrity, and store current private content-key recovery separately. Same-host exports do not satisfy this item.
- [ ] Review the final clean worktree, package versions, candidate source metadata and tagged artifacts, then push/tag/publish with explicit release authorization. Remote CI and actual publication have not run.

## Deferred improvements and acceptance gaps

These remain unverified or unimplemented. They are follow-ups, not passed release claims.

- [ ] Authenticated session ciphertext purge, total disk/journal bounds, general quarantine/unresolved/shared history-copy cleanup and deletion propagation into historical backups.
- [ ] Older-backup/server-disk-loss acknowledged-operation replay and safe reconciliation of deletions, membership and key generations. Existing guards retain client state but do not reconstruct a lost relay.
- [ ] Native fresh-author recovery/removal/key rotation and additional onboarding interruptions.
- [ ] Native bookmark child preservation, true drag/order/delete, concurrent/offline conflicts, duplicates, managed/ambiguous roots and interrupted remote application.
- [ ] Native history source/global/URL clears, delayed replay, exclusions/private/permission/clock edges and enabled expiry.
- [ ] Forced interruption of large restores, abrupt browser shutdown, DevTools-closed alarms, termination between native mutation and journal commit, and hours-long concurrent outages/reconnects.
- [ ] Large-journal/history/session performance, quota/eviction/physical disk-full and backup-failure exercises.
- [ ] Automatic/store updates, actual browser-upgrade preservation, older-browser validation and supported journal compaction/stale-client rebootstrap.
- [ ] Optional iCloud/CloudKit/alternate transport research, outside phase one.

Update this checklist at each checkpoint with commands, results and material limits. Record a future requested commit's hash after its checks pass. Keep unknowns unchecked and use this single progress checklist.
