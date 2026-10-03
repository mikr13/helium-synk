# First disposable-profile smoke test

Allow approximately 10–15 minutes to load/pair two fresh profiles and 20–30 minutes for this first pass. Full acceptance also includes an hours-long outage and the remaining implementation/scale/recovery checks. Section 10 is production deployment after acceptance.

Use separate disposable Helium profile directories, the same stable unpacked-extension path, and an isolated localhost relay. Do not load the extension into a normal profile. Each installation gets a distinct credential through CLI enrollment or private pairing. The current prepared kit and private credential stay in ignored `work/`; `START-HERE.md` in that kit gives exact launch/load/pair steps.

Keep DevTools closed for the hands-on pass. Use harmless fixture pages, such as `http://127.0.0.1:4320/health/live?profile=A` and the equivalent `profile=B` URL. Enable only the collection feature being tested.

| Check                   | Action                                                                                         | Expected result                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Connect                 | Enroll A, pair B, send one diagnostic note from each                                           | Both show both notes; pending work reaches zero                                 |
| Bookmarks               | Create a test folder/link in A; preview/enable sync in both; rename in B                       | A receives B's rename; both show the same test collection                       |
| Current/closed sessions | Enable capture, open two fixture tabs in a separate A window, then close it                    | B shows A's current session and the closed window independently                 |
| Restore                 | In B, open one tab and then a window from A's saved/closed session                             | Real tabs/windows open with expected order/pins/groups; progress finishes       |
| History                 | Enable new-visit capture, visit the A/B fixture URLs, then search by source                    | Original visit times and the correct source appear in both dashboards           |
| Removal                 | Select a disposable visit in the extension and remove it; sync both                            | The synced visit disappears and stays absent after reconciliation               |
| Short outage            | Stop only the test relay, make a note/bookmark change and close a test window, then restart it | Local work remains visible/queued and both profiles catch up without duplicates |
| Worker/browser restart  | Close/reopen the disposable profiles with DevTools closed                                      | Saved work and source identity survive; synchronization resumes                 |

Record actual results below or in `docs/progress.md`: date, Helium/Chromium version, tested build commit, profile labels, pass/fail and the concrete observed result. Leave a row unverified until the real browser result is observed. This first pass does not establish every conflict, interrupted restore, physical disk-full, key rotation, hours-long outage or milestone exit gate.

## Native run — 2026-10-02

Build: initially frozen `abc7bea` extension/server; extension updated at `1d00114` for the closure fix, retaining its origin and saved state. Extension version 0.1.0; Helium 0.18.1.1 / Chromium 154.0.0.0. User-created profiles: **Helium Sync Test 1** and **Helium Sync Test 2**. DevTools remain closed. Fresh isolated relay: `http://127.0.0.1:4321`.

- [x] Load the approved fresh test copy in both profiles. Original copy is disabled and retained, with Test 1's local replica exported.
- [x] Enroll Test 1 with a fresh credential and pair Test 2 through the private single-use bundle; both show Connected and separate installations.
- [x] Send `Native smoke A · Test 1` and `Native smoke B · Test 2`; both dashboards show both server-acknowledged notes and zero pending work.
- [x] Create `Synk Native Smoke` and its fixture link in Test 1; Test 2 receives both; Test 2 renames the link to `Renamed from Test 2` and Test 1’s native bookmark manager shows the rename.
- [x] Verify current/closed session capture, single-tab restoration and full-window restoration, including order/pin/active selection and named group; the native closure bug was fixed and repeated successfully.
- [x] Verify real visits from both source profiles arrive with original timestamps.
- [x] Verify the approved single selected history visit stays absent after manual sync/reload in both profiles, preserving the neighboring fixture and native browser history; see the acceptance follow-up below.
- [x] Verify short relay outage: queue a note, rename a bookmark and close a fixture window while offline; both profiles catch up with no duplicate fixture entries after restarting the same relay/database.
- [x] Verify worker stop/revival with DevTools closed: after observing STOPPED and closing the manager, a native bookmark edit reaches the other profile without opening the source dashboard or manually starting the worker.
- [ ] Verify full browser restart.

The outage lasted approximately two minutes (14:36–14:38). Test 1 showed Waiting to sync, saved pending work and `Native outage note · Test 1` as QUEUED LOCALLY. Its one-tab closed snapshot retained `fixture=outage-a` at 14:36:55. After restart, both profiles showed Connected/zero pending uploads, Test 2 had the acknowledged note and exactly one new closed-window entry, and its native bookmark manager showed `Offline rename from Test 1` with the original URL and no duplicate. Saved evidence: ignored `work/native-user-profiles/outage-bookmark-pass.png`. The full-window restoration journal also reports 2/2 pages opened, 1/1 windows ready, complete.

For worker revival, replaced Test 1's only dashboard with Helium's service-worker manager. Its sole registration matched the approved test extension ID. Stop changed RUNNING to STOPPED; DevTools/start-on-debug remained off. Closed the manager and renamed the native fixture bookmark to `After worker restart · Test 1`. Test 2's native bookmark manager received that title with the original URL and one link. The source dashboard was not reopened and Start was not clicked. Saved evidence: ignored `worker-stopped.png` and `worker-revival-bookmark-pass.png` in the native kit. The specific wake trigger could be a native event or scheduled reconciliation; this establishes automatic revival/delivery, not which trigger fired first.

The first attempt with the earlier kit credential was rejected because the relay already had a registered public identity and this installation lacked its private wrapping key. No synchronized content was erased. Fresh enrollment passed without changing the identity guard. The cause of that earlier credential use is unconfirmed. Private bundles/test assets remain in ignored `work/native-user-profiles`; no native milestone exit gate is complete.

## Folder rename follow-up and UI boundary — 2026-10-02

- [x] Rename the test folder in Test 2 to `Synk folder rename · Test 2`; Test 1’s native bookmark manager shows that name with its existing `After worker restart · Test 1` link and original URL.
- [ ] Verify root-folder moves and propagated undo. A cut/paste attempt did not complete; Undo restored the folder locally in Test 1. No peer move/undo result is claimed. Native interaction stopped when the user resumed using Helium.
- [x] Load the new routed UI and repeat saved-state navigation with the packaged assets; see the native UI follow-up below.
- [ ] Repeat fresh file-based enrollment/pairing/recovery with the packaged build. Desktop/390 px setup checks used actual UI components with synthetic background replies.

The earlier selected-history review was cancelled during this work; no removal was confirmed or performed. Existing installation identities, exports and prior native results remain recorded above.

## Native routed UI follow-up — 2026-10-02

Checkpoint commit: `ae87613 fix(extension): clarify startup status and recovery guidance`.

Updated only `options.html`, `restore.html`, `chunks/` and `assets/` at the same approved native extension path after saving `extension-before-routed-ui`. Base UI commit: `1cee5fb`, followed by startup/recovery copy corrections. Manifest version/permissions/options/background configuration match the previous copy. The background SHA-256 remains `7191114df95cd00dcb851ede8d4c4b915ef88e96e360e13b7eceadd187e2a0ef`. The old extension stays disabled. The relay stays at its earlier approved frozen build on port 4321.

- [x] Reload Test 1's approved extension and options; reload Test 2's options. Both retain their distinct names/identities, two shared bookmark entries, saved sessions/history and existing capture preferences. Test 2's paused session capture remains paused.
- [x] Verify Home, Devices and Add device show focused pages; inspect Settings fields without saving new budgets/retention. Recovery survives direct reload, and the native browser Back button returns to Settings.
- [x] Reload Test 2's existing `#history` link; it normalizes to `#/history` and retains the original source/timestamp timeline.
- [x] Send `Routed UI native · Test 1` at 16:38:16 (author `ad82e4c7`) and `Routed UI native · Test 2` at 16:43:32 (author `62ef13e7`). Both new Diagnostics pages show both as Synced; both show Connected and zero waiting changes. Earlier smoke/outage messages remain visible.
- [x] Fix the enrolled startup label: the pre-transport state now says Checking connection, while failed/unavailable transport remains Offline. Fix recovery guidance to the new Settings → Recovery & backups route. Typechecks, 237 TS tests and production build pass after these wording changes; synthetic rendered checking/offline branches have no fresh warning/error logs.
- [ ] Verify fresh file-based enrollment/pairing/recovery in native Helium. Existing test profiles were preserved; no new invitation or identity was created during this pass.
- [x] Receive at-action approval and click Confirm removal for the one original Test 1 visit `fixture=session-a-1` at 13:21:43.
- [x] Verify selected history removal after recovering browser rendering; see the acceptance follow-up below. Initially the source review remained busy, Test 2's count dropped from 66 to 65, navigation left stale Home content, and reload/Extensions rendered blank. That intermediate state did not establish success. A fresh options tab subsequently rendered correctly without a whole-app restart; no cause is inferred.

Saved proof: ignored `routed-ui-test1-add-device.png`, `routed-ui-test1-settings.png`, `routed-ui-test1-diagnostics.png`, `routed-ui-test2-diagnostics.png`, `routed-ui-history-removal-review.png` and `native-extensions-blank.png` in the native kit; `routed-ui-update.json` records the reversible asset update.

The first Recovery click while expanded Settings fields placed the link offscreen had no effect; collapsing/reloading Settings exposed it and the visible link worked. The macOS Alt+Left attempt had no effect; Back was verified through the browser toolbar. Pre-existing extension Errors showed an earlier relay connection refusal before reload; that log was not cleared and DevTools were not opened. No complete console-clean native claim is made. History currently includes native extension-page visits, including our own navigation; exact URL exclusions are user-controlled. Similar displayed timestamps alone do not establish duplicate native visit identities.

## Selected history removal acceptance — 2026-10-02

The existing approved single deletion was verified without submitting it again. Test 2's fresh options tab rendered; Test 1's original review subsequently closed. Both profiles show zero matches for `fixture=session-a-1` after manual Sync now and reloading the direct History route. Their Home pages report Connected / Everything is up to date. Test 1 still shows the neighboring synced `fixture=session-a-2` visit at 13:22:00. Its native History page, filtered to `fixture=session-a-1`, finds one original browser-owned entry. That owned verification tab was closed afterwards.

A read-only query of the isolated relay finds one erasure certificate and one redacted operation marked `purged = 1`, with nonce and ciphertext lengths both zero. This verifies a live relay receipt, not deletion of physical SQLite/WAL pages or historical backups. Native browser history remains as the removal warning discloses.

Saved fixture-only proof in ignored `work/native-user-profiles`: `history-removal-test1-after-sync-reload.png`, `history-removal-test2-after-sync.png`, `history-removal-test2-after-reload.png`, `history-removal-neighbor-preserved.png` and `history-native-fixture-preserved.png`.

An all-profile clear review was opened accidentally while navigating, then cancelled immediately. No broad clear was confirmed and no duplicate single deletion was sent. Native interaction was briefly interrupted when the user changed Helium; fresh state was read before continuing. No whole-app quit, profile reset, key change or relay upgrade occurred. Full browser restart, native clear/reconnect, retained-copy policy, endurance and complete milestone acceptance remain open.

## Open saved sessions while capture is paused — 2026-10-02

Checkpoint commit: `5df642d fix(extension): open saved collections while capture is paused`.

- [x] Update only packaged UI assets at the existing approved path, preserving the named manifest, permissions, background bytes, origin and identities; save `extension-before-saved-collections` for rollback.
- [x] Reload Test 2 Home: Sessions remains Off, with 98 saved snapshots and the corrected Open sessions action.
- [x] Click Open sessions: the focused page displays the saved current-session row while Capture is paused and Enable session capture remain visible. No capture toggle or restoration was submitted.

Scoped proof: ignored `open-saved-sessions-home.png` and `open-saved-sessions-paused.png` in `work/native-user-profiles`. Typechecks, 237 TS tests and production build pass. This action-label follow-up leaves the other native/full acceptance gates open.

## Root-move interaction remains unverified — 2026-10-02

- [x] Preserve the existing fixture after an incomplete Test 2 cut/paste attempt. Paste was disabled; menu Undo showed no change, then the normal Undo shortcut restored the folder. Test 1’s native folder still shows its single fixture link.
- [x] Reload Test 2’s native bookmark manager after an intermediate two-link Undo view; it shows one original fixture link. No persistent duplicate or root cause is established.
- [ ] Establish a completed root move and propagated undo. Direct drags from the tree/main list changed focus/selection but did not establish a move.

Ignored scoped evidence: `bookmark-cut-undo-duplicate.png` (intermediate view) and `bookmark-cut-undo-peer-single.png` (peer preservation). This does not pass the cross-profile move/undo gate, and no code changes are justified by these observations alone.

## Native 24-tab restoration and focused detail page — 2026-10-02

Checkpoint commit: `f688edd fix(extension): open saved sessions on a focused page`.

- [x] Create and close one owned Test 1 window containing ordered localhost `large-restore-a-01` through `large-restore-a-24` fixture URLs. Test 2 receives one closed window with 24 tabs, original 20:38:23 capture time and the last tab active.
- [x] Submit Open window once; the destination has exactly 24 ordered tabs and tab 24 active. The journal reaches 24/24 pages, 1/1 windows, complete, zero skipped without a repeated request or manual resume. This fixture requires more than one bounded 40-step pass.
- [x] Close only the owned destination window after saving proof; retain the source snapshot/journal. Test 2 capture stays paused and DevTools remain closed.
- [ ] Verify forced interruption and multiple destination windows. The fixture does not establish the full scale matrix or internet-page loading latency.

All destination tabs were visible in the first UI observation, returned about 2.3 seconds after the click; journal completion was checked separately later. Exact peer delivery and full page loading were not timed. Saved ignored proof: `large-restore-source-24-tabs.png`, `large-restore-destination-24-tabs.png` and `large-restore-journal-complete.png`. Tested UI/background: `5df642d` / `1d00114`.

The list's old View action placed detail controls below all snapshots. The UI now opens one saved session on `/sessions/$snapshotId`, with restoration controls/progress above its tabs and filtered Back navigation. Packaged UI assets were updated at the approved path after saving `extension-before-session-detail-route`; the named manifest, origin, permissions and background SHA-256 remain unchanged.

- [x] Open the real 24-tab snapshot in Test 2 on the new route: restore controls and the existing 24/24 complete journal are visible at the top.
- [x] Reload the direct detail page; use native browser Back to return to Closed. The saved snapshot/journal persist and capture remains paused. No second restore was submitted.

Proof: `session-detail-native-24.png` in ignored `work/native-user-profiles`. Desktop/390 px synthetic preview checks cover filters, deep reload/Back, missing-snapshot recovery and blocked-job resume; no overflow, rounded controls or fresh console warning/error logs. Typechecks, all 237 TS tests and the production build pass. Full browser restart, fresh native onboarding, native permutations, endurance and implementation/scale/recovery gates remain open.

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
