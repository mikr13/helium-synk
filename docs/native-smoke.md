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
- [ ] Verify selected history removal.
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

Updated only `options.html`, `restore.html`, `chunks/` and `assets/` at the same approved native extension path after saving `extension-before-routed-ui`. Base UI commit: `1cee5fb`, followed by startup/recovery copy corrections. Manifest version/permissions/options/background configuration match the previous copy. The background SHA-256 remains `7191114df95cd00dcb851ede8d4c4b915ef88e96e360e13b7eceadd187e2a0ef`. The old extension stays disabled. The relay stays at its earlier approved frozen build on port 4321.

- [x] Reload Test 1's approved extension and options; reload Test 2's options. Both retain their distinct names/identities, two shared bookmark entries, saved sessions/history and existing capture preferences. Test 2's paused session capture remains paused.
- [x] Verify Home, Devices and Add device show focused pages; inspect Settings fields without saving new budgets/retention. Recovery survives direct reload, and the native browser Back button returns to Settings.
- [x] Reload Test 2's existing `#history` link; it normalizes to `#/history` and retains the original source/timestamp timeline.
- [x] Send `Routed UI native · Test 1` at 16:38:16 (author `ad82e4c7`) and `Routed UI native · Test 2` at 16:43:32 (author `62ef13e7`). Both new Diagnostics pages show both as Synced; both show Connected and zero waiting changes. Earlier smoke/outage messages remain visible.
- [x] Fix the enrolled startup label: the pre-transport state now says Checking connection, while failed/unavailable transport remains Offline. Fix recovery guidance to the new Settings → Recovery & backups route. Typechecks, 237 TS tests and production build pass after these wording changes; synthetic rendered checking/offline branches have no fresh warning/error logs.
- [ ] Verify fresh file-based enrollment/pairing/recovery in native Helium. Existing test profiles were preserved; no new invitation or identity was created during this pass.
- [x] Receive at-action approval and click Confirm removal for the one original Test 1 visit `fixture=session-a-1` at 13:21:43.
- [ ] Verify selected history removal after recovering browser rendering. The source review remained busy; Test 2's count dropped from 66 to 65, but navigating to History left Home content visible and reloading removed the page content. Helium's own Extensions manager also renders blank. The healthy relay/process and existing asset references were verified; no cause or durable deletion outcome is inferred from the count alone. No duplicate removal request was sent. Whole-app restart approval is pending.

Saved proof: ignored `routed-ui-test1-add-device.png`, `routed-ui-test1-settings.png`, `routed-ui-test1-diagnostics.png`, `routed-ui-test2-diagnostics.png`, `routed-ui-history-removal-review.png` and `native-extensions-blank.png` in the native kit; `routed-ui-update.json` records the reversible asset update.

The first Recovery click while expanded Settings fields placed the link offscreen had no effect; collapsing/reloading Settings exposed it and the visible link worked. The macOS Alt+Left attempt had no effect; Back was verified through the browser toolbar. Pre-existing extension Errors showed an earlier relay connection refusal before reload; that log was not cleared and DevTools were not opened. No complete console-clean native claim is made. History currently includes native extension-page visits, including our own navigation; exact URL exclusions are user-controlled. Similar displayed timestamps alone do not establish duplicate native visit identities.
