# Remaining work and suggested owners

Updated 2026-10-03. This consolidates the current unchecked requirements in [plan.md](plan.md); repeated historical checkpoint notes are not additional tasks. Fresh native connection-file enrollment and invitation-file pairing now pass, including expired-invitation reload/retry and replacement. The user also completed the setup review and full restart check. Ordinary multi-window restoration and empty-folder cross-root cut/paste with two-step Undo pass; forced interruption, child preservation and the broader matrices remain open.

## Work the user can take on

- [x] **Review setup clarity.** User marked Home/Add device/Settings review complete on 2026-10-03. Setup Test A/B now have the approved build and fresh file-based enrollment/pairing evidence.
- [x] **Perform a full Helium restart.** User marked the Test 1/Test 2 restart check complete on 2026-10-03. Agent subsequently observed Setup Test A's name, connection and paused collections intact. Abrupt shutdown and restart during a controlled hours-long outage remain separate tests.
- [x] **Choose the support floor.** Mihir decided older Helium support/testing is unnecessary for V1; use the current Helium build. Browser-upgrade and extension-update preservation remain engineering checks.
- [x] **Choose retention and backup preferences.** User marked this decision complete. Continue with the proposed 30-day session policy plus count/size caps and daily/weekly/monthly backups. Exact cap/rotation values and off-Mini destination have not been recorded; document concrete defaults during implementation/deployment. History already has opt-in configurable 90-day expiry.
- [x] **Choose a compact popup.** Mihir requested it; implementation is tracked below.
- [ ] **Settle distribution and History override.** Stable extension distribution/update method and any packaged native History replacement remain release choices.
- [x] **Resolve repository push access.** User marked access resolved; the earlier failed push is historical evidence. Publishing/pushing still needs explicit authorization.
- [x] **Choose this Mac Mini as the Tailscale host.** User confirmed it; local read-only CLI verification shows Running/online, no health warnings. The plugin has no callable tools in this session. Final client access, backup destination and FileVault/reboot details remain deployment verification.
- [ ] **Perform daily-use acceptance on the intended devices** after the disposable-profile and release/deployment gates pass.

For manual checks, record profile names, browser/build version, actions, pass/fail and observed result. Use disposable fixtures for bookmark/history mutations.

## Implementation and engineering work

- [ ] **Session retention:** implement/test closed/previous age, count and size limits; protect pending essential work, latest current sessions and active restorations.
- [ ] **Retained-copy policy:** finish unresolved/shared history-capture copies, general quarantine, historical backup expiration/deletion lag and safe older-backup behavior.
- [ ] **Complete relay recovery:** replay missing acknowledged operations after an older backup or server disk loss, reconcile deletion proofs/membership/key generations, and safely resume client/browser application. Current restore guards preserve state by refusing unsafe resume; they do not complete recovery.
- [ ] **Scale and responsiveness:** measure representative large history/journal/session/restore workloads and publication/reconnect latency; optimize where measurements fail the targets.
- [ ] **Compact popup:** status, pending changes, Sync now, collection shortcuts and clear setup/connection-error states using the existing dark square shadcn/Tailwind UI.
- [ ] **Release compatibility:** dependency/protocol review on the current Helium build, actual browser upgrades and production extension updates preserving storage/origin/identity; stable distribution/update procedure. Older Helium testing is excluded by Mihir's decision.

## Browser acceptance still pending

- [x] **Fresh onboarding baseline:** native connection-file enrollment on A, invitation-file pairing on B, opt-in collection defaults and expired-file reload/retry/replacement. User clarity review is complete.
- [ ] **Onboarding recovery/interruption:** fresh-author recovery and remaining network/worker-interruption permutations.
- [ ] **Security/recovery:** native device removal/key rotation and recovery into a fresh author without cloning identity/counters.
- [ ] **Bookmarks:** folders with children, true drag/onMoved, ordering, deletion, concurrent/offline conflicts, intentional duplicates, managed/ambiguous roots and interrupted remote application. The empty-folder cut/paste pass does not establish retained node identity.
- [ ] **History:** URL/source/global clears, delayed reconnect without resurrection, native exclusions/private/permission edges, original-time/clock behavior, and retention controls.
- [ ] **Lifecycle:** abrupt shutdown, alarm recreation/timing with DevTools closed, and termination between native mutation and journal/mapping commit. Ordinary full restart is recorded above as user-tested.
- [ ] **Interrupted restoration:** worker/browser interruption and resume during large/multiple-window jobs, with count/order/pin/group/active selection and no unintended source closing or duplicates. Ordinary 24-tab and three-window restoration pass.
- [ ] **Hours-long outage:** concurrent edits in both profiles, independent bookmarks/history, locally retained closed sessions, full restart while offline, later reconnection of one peer, convergence and queue drain.
- [ ] **Storage failures:** native quota/eviction, physical client and backup disk exhaustion, and actual deployment failure/retry paths in isolated test storage.
- [ ] **Branding/UI edges:** toolbar/extension-list icon rendering and remaining native permission/storage/retention controls. Native options/tab favicon is visibly present in saved proof.

## Section 10 deployment and operational acceptance

- [ ] Native Rust release binary bound to localhost; persistent data/logs outside the checkout and cloud-synchronized directories.
- [ ] launchd service, restricted filesystem permissions, automatic restart and bounded log rotation.
- [ ] Private Tailscale Serve HTTPS/WSS, intended-client access restrictions, application authentication, endpoint/certificate behavior and Tailscale reconnection; public Funnel stays excluded.
- [ ] Sleep/power-failure behavior and measured logout/reboot/cold-start availability, preserving FileVault and documenting required unlock/login.
- [ ] Monitoring of readiness, disk space, journal growth, queue/latency and last successful backup.
- [ ] Scheduled consistent daily backups, chosen rotation counts and one encrypted off-Mini copy; encryption recovery material stored separately.
- [ ] Backup-before-upgrade and binary/database rollback procedure.
- [ ] Tested operational restore/server-disk-loss procedure with surviving clients, acknowledged-operation replay, safe reconciliation/resume and physical failure exercises.

## Deferred future work

V1 does not compact the journal. Encrypted checkpoint authority, stale-client retirement/rebootstrap and a supported compaction offline window are prerequisites for a future compaction feature, not extra V1 implementation now. Optional iCloud/CloudKit research and alternate/dual transport are outside phase one.

The whole milestone exit gates remain open until their complete criteria are evidenced. This list assigns work for coordination; it does not transfer responsibility or mark tasks complete.
