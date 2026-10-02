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
