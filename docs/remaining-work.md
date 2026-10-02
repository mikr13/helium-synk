# Remaining work and suggested owners

Updated 2026-10-02. This consolidates the current unchecked requirements in [plan.md](plan.md); repeated historical checkpoint notes are not additional tasks. Ordinary native multi-window restoration and empty-folder cross-root cut/paste with two-step Undo now pass. Forced interruption, child preservation and the broader matrices remain open.

## Work the user can take on

- [ ] **Review setup clarity.** Try Home, Add device and Settings in the test profiles. Identify any unclear next action, label, spacing or file-transfer step. Review fresh setup once Setup Test A/B are prepared; their creation/build access is approved, not yet performed.
- [ ] **Perform a full Helium restart when personal work is saved.** Quit the app completely, reopen Test 1 and Test 2, and record whether names, saved collections, pending work and sync survive. Coordinate with the native test run before restarting. Closing one window alone does not test full browser restart.
- [ ] **Choose the intended daily-use devices and support floor.** Decide whether older Helium versions must be supported. Older-version testing and browser-upgrade preservation still need evidence.
- [ ] **Choose retention and backup preferences.** The proposed session policy is 30 days plus count/size caps; choose desired caps and daily/weekly/monthly backup counts, destination and off-Mini copy. History already has opt-in configurable 90-day expiry.
- [ ] **Settle release choices.** Choose a stable extension distribution/update method, whether a compact popup is wanted, and whether to replace the native History page. Popup/history override are product choices, not unfinished core sync.
- [ ] **Resolve repository push access.** The last recorded push failed; check the intended GitHub account/repository access without switching global authentication implicitly. Publishing/pushing remains a separate authorized action.
- [ ] **Prepare deployment information.** Identify the installed Tailscale variant, intended tailnet clients, backup destination and FileVault startup/unlock constraints. Production configuration is deferred until acceptance.
- [ ] **Perform daily-use acceptance on the intended devices** after the disposable-profile and release/deployment gates pass.

For manual checks, record profile names, browser/build version, actions, pass/fail and observed result. Use disposable fixtures for bookmark/history mutations.

## Implementation and engineering work

- [ ] **Session retention:** implement/test closed/previous age, count and size limits; protect pending essential work, latest current sessions and active restorations.
- [ ] **Retained-copy policy:** finish unresolved/shared history-capture copies, general quarantine, historical backup expiration/deletion lag and safe older-backup behavior.
- [ ] **Complete relay recovery:** replay missing acknowledged operations after an older backup or server disk loss, reconcile deletion proofs/membership/key generations, and safely resume client/browser application. Current restore guards preserve state by refusing unsafe resume; they do not complete recovery.
- [ ] **Scale and responsiveness:** measure representative large history/journal/session/restore workloads and publication/reconnect latency; optimize where measurements fail the targets.
- [ ] **Release compatibility:** dependency/protocol review, minimum Helium verification, actual browser upgrades and production extension updates preserving storage/origin/identity; stable distribution/update procedure.

## Browser acceptance still pending

- [ ] **Fresh onboarding:** native connection-file enrollment, invitation-file pairing, interrupted/retry handling and recovery in the approved empty Setup Test A/B profiles. Human clarity feedback remains separate.
- [ ] **Security/recovery:** native device removal/key rotation and recovery into a fresh author without cloning identity/counters.
- [ ] **Bookmarks:** folders with children, true drag/onMoved, ordering, deletion, concurrent/offline conflicts, intentional duplicates, managed/ambiguous roots and interrupted remote application. The empty-folder cut/paste pass does not establish retained node identity.
- [ ] **History:** URL/source/global clears, delayed reconnect without resurrection, native exclusions/private/permission edges, original-time/clock behavior, and retention controls.
- [ ] **Lifecycle:** full browser restart/abrupt shutdown, alarm recreation/timing with DevTools closed, and termination between native mutation and journal/mapping commit.
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
