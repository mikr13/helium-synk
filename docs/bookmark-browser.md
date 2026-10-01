# Native bookmark adapter

Bookmark sync is opt-in through the options page: preview, save the recovery copy, then confirm. The implementation is compiled and tested against a browser port with fake IndexedDB. Real Helium API, permission and worker-lifecycle acceptance remains pending; use disposable profiles for that session.

## Identity and joining

Native IDs belong to one profile. IndexedDB v3 maps them to logical UUIDs; a separate random incarnation marker in `storage.local` detects lost mapping metadata or a changed profile. Missing markers/mappings or unavailable selected roots pause application instead of inferring mass deletion.

Roots are discovered using Chromium's `folderType`, `syncing` and `unmodifiable` capabilities. Local roots are preferred when unique; ambiguous choices require explicit selection. Root names and numeric IDs are not assumptions. The manifest now requires Chromium 134 because the [root-role properties arrived in 134](https://developer.chrome.com/docs/extensions/reference/api/bookmarks#type-BookmarkTreeNode). Actual Helium compatibility is not established by that version floor alone. Managed nodes and unselected roots remain outside the merge. Moving a mapped entry into an excluded root pauses application rather than moving it back silently.

The first profile imports its existing hierarchy. Later profiles match only unique exact entries under the same logical parent. Folder matching also requires an exact child-content signature. Ambiguous duplicates and unmatched entries receive separate UUIDs. Preview confirmation revalidates both the native tree and shared replica; changed data requires a fresh preview. The original tree and replica backup persist locally before import actions/mappings commit together. The UI also offers a separate backup download. Ordinary replica exports include pending drafts/events, bindings and application effects, and exclude credentials/root keys.

## Capture and causality

WXT registers native creation/change/move/removal/reorder listeners synchronously. Each event and its reserved author counter/logical revision/context enter the durable inbox in the same transaction. Encryption and network transfer happen later. Echo events can leave unused counters; counters need to be unique and increasing at reservation, not contiguous on the relay. A delayed event retains its original reserved revision even if a peer download or newer local operation completes before it is processed.

Changed events retain their prior observed fields so an unchanged title carried with a URL change does not overwrite a concurrent title edit. Full-tree reconciliation also emits only fields that differ from the native baseline. Startup, alarms, manual synchronization, imports and notifications reconcile missed events. For missed changes whose exact event time is unavailable, the adapter uses the last completed application frontier conservatively rather than assuming every newer downloaded record was visible natively.

A captured event is removed only in the transaction that commits its logical draft and updated bindings. Local storage failure aborts that transaction and leaves the event available for retry. A browser termination before the event transaction commits can still lose a transient create/delete or intermediate edit; the surviving full tree is reconciled after restart.

## Applying changes and recovery

Every create/update/move/remove intent commits before the browser API is called. Its observed result and mapping commit afterward. Expected events match the specific effect, native ID and resulting fields; they are consumed once. There is no global ignore-events flag. Genuine events before/during/after application remain captured, including a rename that the in-flight API call temporarily overwrites.

Interrupted updates/moves/removals reconcile actual state before replanning. An unbound interrupted create with possible matching new entries pauses for explicit review: associate a validated existing candidate, or preserve all candidates and create a separate copy. It never blindly retries an ambiguous creation.

Application orders ancestry changes to avoid moving a folder into its current descendant. It removes only leaves/empty folders; surviving or unseen children move out before a deleted parent is removed. Logical recovery folders and unavailable bar/mobile roles have local proxy folders when needed. Managed entries and unexpected identity/type changes pause application.

Work is bounded to 200 inbox events and 100 browser effects per reconciliation pass. Remaining work stays durable and continues on a later alarm/sync. Large imports stage actions in one batch and replay the logical journal once. V1 logical journals and application evidence are retained; growth monitoring and quotas remain subsequent work.

## Current evidence

22 adapter tests cover conservative onboarding, stale previews, role selection, duplicate preservation, field/move/order/removal capture, echo suppression, local storage failure, interruption recovery, ambiguous-create review, profile/root loss, ancestry changes, unseen-child recovery, delayed causal capture, and two native replicas converging after an offline rename/move and database reopen. These use a simulated browser port, not live Helium.

The actual options components were exercised in a disposable localhost preview with synthetic responses: import details opened, confirmation was disabled before the backup action, confirmation changed the display to enabled, and the 390 px layout had no horizontal overflow or console warnings/errors. This is UI evidence only. The preview tab and server were closed; no user profile was inspected or changed.
