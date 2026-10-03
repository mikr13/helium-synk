# Helium Synk — release checklist

Updated 2026-10-03. This is the single checklist, replacing the earlier implementation plan, progress log and remaining-work list. Checked items have recorded evidence; unchecked follow-ups are not claimed as tested. Technical contracts live in [architecture.md](architecture.md), operating procedures in [deployment.md](deployment.md).

## Current release boundary

Mihir requested that development testing end after crucial fixes, completion of current work and cleanup, then proceed to deployment/publishing. V1 targets the current Helium release on the intended personal devices. The broader failure/recovery/scale matrix remains follow-up work. No public hosting, passwords/cookies, native profile-file sync or iCloud is included. Local production services are now installed; profile enrollment, private HTTPS and publishing remain in progress.

Release preparation is complete for the accepted V1 boundary. Deployment is now authorized for this Mini and the real ABI and Syngenta profiles, using independent accounts, databases and content keys. No commits, pushes or publication are requested for this pass.

## Implementation baseline: steps 1–9

- [x] **1. Scope and compatibility.** Opt-in bookmarks, current/closed/previous sessions and searchable cross-device history; source-owned sessions and explicit restoration. Chromium minimum 134; native baseline on Helium 0.18.2.1 / Chromium 154.0.8037.92. Older Helium support excluded by Mihir.
- [x] **2. Durable offline state.** IndexedDB journal, drafts/outbox, immutable retries, atomic incoming cursor/projection and independent native application/restoration progress. Pending work survives database/worker reopen and tested short outages. Local storage limits pause new capture without discarding queued work.
- [x] **3. Encryption and private keys.** AES-GCM authenticated envelopes, separate installation/domain keys and stable history index key; relay has encrypted content and token hashes. Private recovery export, fresh-author enrollment and explicit permission handling. Profile secrets/decrypted caches are stored locally: the extension does not encrypt the profile at rest.
- [x] **4. Relay and transport.** Rust/Axum/SQLite, authenticated bounded push/pull, idempotent ACKs, WebSocket hints, durable processed cursors, epoch guards, quota/resource bounds, graceful shutdown and consistent snapshots. Protocol 1 / relay schema 5 / client schema 10.
- [x] **5. Bookmarks.** Conservative preview + backup before enabling, logical IDs, causal field/placement merges, permanent tombstones, recovered children, event capture and journaled browser effects. Native create/reverse rename and empty-folder cross-root cut/paste + Undo pass. Broader native cases remain below.
- [x] **6. Sessions.** Current/closed/previous snapshots, encrypted multipart transport, source revision ordering, durable capture caches and explicit restore jobs. Native pins/groups/closed captures, 24-tab restore and ordinary three-window restore pass. Source windows remain intact.
- [x] **7. History.** Opt-in original-time capture/import/search, profile filters, exclusions, selected/URL/source/global logical deletion, authenticated live ciphertext purge and source-owned expiry. One specifically approved native visit deletion converged while native history/neighbouring visits remained intact.
- [x] **8. Devices and key lifecycle.** Private expiring invitations, durable registration/retry, independent wrapping identities, removal/future-content key rotation, old committed retry and safe queued rekey. Automated fresh-author recovery passes; native rotation/recovery remains a follow-up.
- [x] **9. Interface and product setup.** Focused routed pages, guided connection/invitation file setup, compact toolbar popup, shared dark-only logo navy/blue/mint Tailwind/shadcn UI with square controls and TypeScript aliases. Native setup, expired-file retry/replacement, route/reload/back and popup navigation pass.

## Final release preparation — current pass

- [x] Migrate existing workspace to exact Vite+ 1.0.0 using the target migrator after verifying Vite 8 / Vitest 5 prerequisites and supported Node 24.21.0.
- [x] Preserve WXT MV3 dev/build behavior, workspace core imports and `@/` aliases. Use `vp run dev` / `vp run build` for WXT, `vp test` for the built-in runner.
- [x] Consolidate format, lint and unit test configuration in `vite.config.ts`; keep the separate real-process suite in `vite.integration.config.ts`. Remove Prettier configuration/dependency and fix lint/type findings without disabling rules or weakening assertions.
- [x] Complete source-owned session age/count/content-size expiry controls with 30 days / 100 archives / 50 MiB defaults, initially off. Latest/pending/incomplete/active-restore protections remain intact.
- [x] Replace new and expired legacy closed-capture URL/title fingerprints with SHA-256 receipts, preserving native identities to prevent re-import. Add atomic failure/reopen/no-resurrection regression checks.
- [x] State the session expiry limitation in settings and contracts: visible/journal plaintext expires, but encrypted client/relay copies remain. This is not a physical disk-space or complete-erasure guarantee. Update all clients before activation.
- [x] Consolidate documentation into this checklist plus architecture and deployment references; remove duplicated history and repair links.
- [x] Remove obsolete preview/proof/status/build debris while preserving active native installations, private credentials and test relay databases.
- [x] Finish current Vite+ checks, existing TypeScript checks, Rust fmt/clippy/tests and all real-process integrations: 252 TypeScript, 44 Rust and 17 real-process tests pass; no new skips or weakened assertions.
- [x] Prepare inspectable extension ZIP, Rust release binary, SHA-256 checksums and version/build metadata; verify the release binary and packaged extension entrypoints/icons.
- [x] Verify the fresh production build at the existing native test extension origin, retention controls (off by default), saved settings/identity and popup/sync. Do not broadly delete fixtures or enable destructive expiry during smoke.
- [x] Record final evidence here and hand off to step 10. Keep this pass uncommitted and unpublished.

## Verification

The recorded native test baseline used **Helium Sync Test 1**, **Helium Sync Test 2**, **Helium Synk Setup Test A** and **Helium Synk Setup Test B**. These disposable profiles have now been removed; live native inventory shows only ABI and Syngenta. Historical test databases/credentials remain privately under ignored `work/`; they are not release artifacts.

| Evidence                                  | Result and limit                                                                                                                                                                                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing automated baseline, before Vite+ | 250 TypeScript tests and 17 real Rust-process integration tests passed at `5fb9842`; 44 Rust tests passed at the preceding server checkpoint.                                                                                                                                                              |
| Current Vite+ unit checks                 | 252 tests pass across the same 20 files, including two new closed-capture expiry regressions; no new skips. No v4 compatibility settings were generated because the original runner was already v5. No tsdown compatibility settings apply: core is an internal source workspace, with no `vp pack` build. |
| Current lint/type/production build        | Vite+ check passes without warnings/errors; WXT production MV3 builds on the migrated Vite core. Both original TypeScript workspace checks pass; Rust fmt/clippy pass with warnings denied; 44 Rust and 17 real-process tests pass. The production package and native smoke details are below.             |
| Fresh native setup                        | Setup A connection-file enrollment; B invitation-file pairing; expired file → reload/retry → replacement; collection defaults off and two-way ACKed diagnostics. User reviewed setup clarity.                                                                                                              |
| Browser restart                           | User completed ordinary full Helium restart; subsequent observation preserved Setup A name/connection/paused collections. This does not establish abrupt shutdown or hours-long outage behavior.                                                                                                           |
| Bookmark native baseline                  | Create/reverse rename, offline short-outage replay, empty-folder cross-root cut/paste and two-step Undo converged. Children, real drag/onMoved and conflict/interruption matrices are not established by these results.                                                                                    |
| Session native baseline                   | Ordered/pinned/grouped current and closed captures, 24-tab exact-count/order restore, and two ordinary three-window fixtures: five supported pages restored, three internal pages skipped. Source windows untouched. Forced interruption is separate.                                                      |
| History native baseline                   | Exact authorized test visit removed across peers/live relay ciphertext; source browser history and neighbour preserved. Broader clear/retention/permission matrices remain follow-up.                                                                                                                      |
| UI                                        | Routed views checked at desktop/390 px; popup checked at 360 px across connection/setup/error states. Shared field spacing/alignment and square controls checked. Native Home/Devices/Settings/History/session detail, reload/back and popup status/navigation passed.                                     |

### Current checkpoint record

- `36ec31a`: compact popup completed; native Setup Test B status/sync/navigation passed.
- `5fb9842`: logical session archive expiry backend, protected current/upload/restoration work, atomic receipts and real-relay lost-reply/restart/bootstrap checks.
- Current uncommitted pass: Vite+ migration, retention controls and closed-capture cleanup, consolidated docs, cleanup and release preparation. Final validation: 252 TypeScript / 44 Rust / 17 real-process tests pass. Source remains uncommitted, based on `5fb9842`; no new commit ID exists.

### Release artifact and cleanup evidence

- Initial 0.1.0 release-preparation candidate passed archive integrity, isolated loopback readiness and clean SIGTERM. It is superseded by the deliberate 0.2.0 release below.
- Native Setup Test B reloaded at `icjnepaninedejemijejhdoofomipbgm`, with identical permission sets and stable path. It retained its name, two journal records, paused collections, Connected status and zero pending work. Popup Home navigation works. Session retention defaults 30/100/50/off saved successfully and persisted through direct page reload; no expiry or fixture deletion was enabled. Other profiles can reload the shared test path when used; the current smoke does not claim all profiles were reloaded.
- Removed 71 obsolete scratch/proof/preview/old-build entries, stopped the project-owned preview server and removed regenerable Rust incremental cache. Retained the current native extension, running test relay binary, all private test databases/credentials and the final smoke screenshot. Two stale localhost preview tabs remain: browser security blocked their closure; no workaround was attempted.
- Final packaged/native background SHA-256: `e91da42d62993996d512616d2e9ad613e07365a1c4bcd5080ea6910ac882df59`. Extension ZIP SHA-256: `4070dfaf369fe8e890639aac71dd0942670cc52389d0e48b9ee7ca5925e44536`. Server binary SHA-256: `8d9ac60be3d524f734d24f19698e19b97690cc93e47c006bf9581d3b4226539a`. Final native reload reconnected with the same profile/defaults and zero pending work.
- Final native test settings screenshot: `release/native-retention-smoke.jpg`. That smoke predates production installation; artifacts remain unpublished.

## 10. Deployment and publish — in progress

Use [deployment.md](deployment.md) for the concrete commands and safeguards. Keep progress in this file.

- [x] Host chosen: this Tailscale-connected Mac Mini. Prior read-only check showed Running/online with no health warnings; recheck actual endpoint/configuration during deployment.
- [x] Distribution chosen for V1 preparation: GitHub release in the existing repository with manual unpacked extension updates from a permanent path. Keep native History unchanged; store/automatic updater is later work.
- [x] Backup defaults selected for preparation: 7 daily, 4 weekly, 3 monthly consistent snapshots plus one encrypted off-Mini copy; its destination still needs confirmation during deployment.
- [x] Review/release Changesets, deliberately bump core/extension/server and matching Rust versions to 0.2.0, generate three changelogs and rerun packaging/checks. `vp run release:prepare`: 252 TypeScript / 44 Rust / 17 real-process tests, lint/types/build and packaged checksums pass. Historical Changeset entries describe their original checkpoints; this checklist records current behavior.
- [x] Remove the four disposable Helium test profiles, preserving ABI and Syngenta. Test 1 was removed earlier; Mihir removed the remaining Test 2 and Setup A/B profiles. Fresh native profile-manager inventory confirms only ABI and Syngenta remain.
- [x] Install and pin verified Helium Synk 0.2.0 in both real profiles after explicit installation/permission approval. Both use the permanent private `extension/` directory and extension ID `pikiooiaammpflcchkojkjghgofhphjf`.
- [x] Enroll ABI and Syngenta independently using their own connection files and locally generated encryption keys; neither was paired with the other. Both reached the device-set-up collection screen. Connections await private HTTPS activation; collections are still off.
- [ ] Back up each profile’s original bookmarks and private recovery keys, then enable its own collections. Preserve native data; capture new history only, without historical import or automatic expiry.
- [x] Install release binary/data/logs outside checkout/cloud sync with private filesystem permissions and patched SQLite dependency verification. Root: `~/Library/Application Support/Helium Synk`, 0700; files 0600, executable 0700. Both ready endpoints report 0.2.0 / protocol 1 / schema 5 / SQLite 3.53.3, linked to `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`.
- [x] Install and verify per-user launchd services, graceful restart, bounded logs and relay readiness/disk/journal/delivery/backup monitoring. Six private agents: both relay restarts retain their epochs, both scheduled backup jobs and hourly monitor jobs execute with exit 0. Local status files provide failure reporting; unsent browser queues still require the popup/Home view. Login is required.
- [ ] Configure private Tailscale Serve HTTPS/WSS and intended-client tailnet access; retain app credentials and exclude public Funnel.
  - Mihir explicitly approved access for all devices in his private tailnet, with separate application credentials and public Funnel disabled. Mini online with no health warnings and no other enrolled devices. The approved 443 Serve command is waiting for administrator sign-in/Serve enablement; that page is open for Mihir. Routes will use HTTPS 443 (ABI) and 8443 (Syngenta), loopback relays 4318/4319. HTTPS/WSS acceptance is not yet recorded.
- [ ] Verify FileVault/unlock/login, sleep/display sleep, logout/reboot/cold start and power restoration behavior on this actual Mini.
  - Current readback: FileVault on; system sleep 1 minute, display sleep 10 minutes, automatic power restart enabled. Actual logout/reboot/cold-start and power-loss behavior require coordinated observation and human FileVault unlock.
- [ ] Schedule consistent backups, test rotation/failure reporting/integrity and the encrypted off-Mini copy. Store current private content-key recovery separately.
  - Local portion complete: daily 03:10/03:20 schedules, verified 0600 snapshots and 7 daily / 4 weekly / 3 monthly rotation. Four isolated deployment tests pass: integrity/private modes/idempotence/rotation, preserved prior snapshot + reported creation failure, readiness/backup warning reporting, and bounded rotation after large service output. Off-Mini destination/encryption and native content-key export remain pending.
- [ ] Back up before upgrade; verify same-origin extension update preserving identity/settings/collections/pending work on intended daily-use devices.
- [ ] Perform short intended-device acceptance over the deployed HTTPS relay: both directions, brief offline queue/reconnect, collection viewing/restoration, popup and queue drain.
- [ ] Approve/publish release artifacts and repository changes explicitly. Local services above are installed; repository changes and artifacts remain uncommitted, unpushed, untagged and unpublished.

### Deployment checkpoint — 2026-10-03

Version 0.2.0 extension ZIP SHA-256: `0789f149b4b74fbe139ab2bf3b0c21cab8caccc73023b695df29a61b777b26c0`; ARM relay binary SHA-256: `5906ddac0e61221f5fe576bb9a4bff8dbc91c46803a4fd67be1c6c9192515a48`. Both packaged hashes verified. Separate credential files are prepared under `accounts/abi/connection.json` and `accounts/syngenta/connection.json`, mode 0600, and imported into their respective real profiles. Own loopback relay status requests return 200; the other domain’s credentials return 401. Both real profiles have independent persistent enrollment and private Mini host permission, with collection opt-ins still pending. Changesets status passes with no further package bumps; a non-bumping tooling entry records deployment helpers after runtime notes were consumed into 0.2.0. Four deployment checks are included in the release command and CI configuration; remote CI has not run.

The obsolete localhost test relay on 4322 was stopped, preserving its databases. Native test-profile cleanup is complete. Real ABI/Syngenta tabs, history and bookmarks remain intact. Earlier automatic-review restrictions on deletion/install and private Serve scope were resolved through explicit approval; Mihir performed the remaining profile deletion. Sleep changes still require the requested preference/approval. Tailscale administrator sign-in/Serve activation remains a human handoff. Reboot/logout/power-loss tests are not performed.

## Follow-up improvements and known limits

These are retained transparently and are no longer an expanding pre-deployment test matrix under Mihir’s 2026-10-03 instruction. They must not be described as passed.

- [ ] Authenticated session ciphertext purge, total disk/journal bounds, general quarantine/unresolved/shared history-copy cleanup, and deletion propagation into historical backups. Current policy describes its retained copies explicitly.
- [ ] Older-backup/server-disk-loss acknowledged-operation replay and safe reconciliation of deletions, membership and key generations. Current epoch/account guards fail closed and retain client state; they do not reconstruct the lost relay. Restore only into an isolated instance for review; do not reset clients to bypass a guard.
- [ ] Native fresh-author recovery/removal/key rotation and additional onboarding interruption permutations.
- [ ] Native bookmark child preservation, true drag/order/delete, concurrent/offline conflicts, intentional duplicates, managed/ambiguous roots and interrupted remote application.
- [ ] Native history source/global/URL clears, delayed replay, private/exclusion/permission/clock edges and enabled retention.
- [ ] Forced worker/browser interruption of large restores, abrupt shutdown, DevTools-closed alarms, termination between native mutation and journal commit, and hours-long concurrent outage/reconnect.
- [ ] Representative large-journal/history/session responsiveness and latency measurements; quota/eviction/physical disk-full and backup failure exercises.
- [ ] Automatic extension updates/store distribution, actual browser-upgrade preservation, and supported journal compaction with checkpoint authority/stale-client rebootstrap.
- [ ] Optional iCloud/CloudKit/alternate transport research; outside phase one.

## Decisions and progress rules

Mihir completed setup review, ordinary browser restart, current-browser support choice, retention/backup preferences and repository access resolution. The old failed push is historical, not a new blocker. Compact popup is included. Passwords/cookies and iCloud remain excluded. Tailscale hosting is private. Recovery uses fresh installation authors; never clone credentials or reset author counters.

Update this checklist at each checkpoint with commands/results and material limits. For any future requested commit, record its hash and coherent scope after checks pass. Keep unknowns unchecked; deployment choices and optional improvements do not imply additional implementation was verified. Do not create a second remaining-work/progress checklist.
