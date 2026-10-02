# Guided setup and page navigation

The earlier options page mounted setup, pairing, key rotation, storage, diagnostic notes and all three collections together. Its navigation only scrolled to sections. Users had to interpret credential JSON and recovery keys, distinguish first enrollment from pairing, and find the next step among unrelated controls.

The options page now uses separate TanStack Router views. Setup presents two choices: connect another device using an invitation, or set up the first device using a server-issued connection file. Recovery has its own form. File selection is the primary input; pasting file contents is an optional disclosure. Keys never enter a URL or UI persistence store. Each successfully configured profile is directed to collection choices; collection remains opt-in.

## Routes

| Route                   | Purpose                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `/`                     | Connection summary and collection shortcuts                            |
| `/bookmarks`            | Preview/enable the shared collection and resolve interrupted additions |
| `/sessions`             | Browse current, closed and previous sessions by source                 |
| `/sessions/$snapshotId` | Review one saved session and restore its tabs/windows                  |
| `/history`              | Search and remove synced visits; configure capture                     |
| `/devices`              | List linked profiles; no remote online-presence claim                  |
| `/devices/add`          | Create an invitation and show its transfer/import steps                |
| `/settings`             | Storage and retention; links to advanced tools                         |
| `/settings/recovery`    | Save encryption keys and local data separately                         |
| `/settings/security`    | Remove device access and rotate future content keys                    |
| `/settings/diagnostics` | Server/browser details and test messages                               |
| `/setup`                | First device versus another device choice                              |
| `/setup/first`          | Server-issued connection file                                          |
| `/setup/join`           | Invitation file, recognizable name, saved-attempt retry                |
| `/setup/recover`        | Fresh connection file plus private recovery file                       |
| `/setup/collections`    | Choose what to enable after configuration                              |

The packaged entrypoint remains `options.html`. [Hash history](https://tanstack.com/router/latest/docs/guide/history-types) keeps routes inside that file without server rewrites, so reloading a deep link works in the extension. A small [code-defined route tree](https://tanstack.com/router/latest/docs/routing/code-based-routing) mounts only the selected page. Old section links such as `#history` normalize to `#/history`. Navigation has an active state, a skip-to-content link, page titles and focus/scroll updates.

## Boundaries and safeguards

One shared provider polls the existing background status every two seconds. It suppresses overlapping polls and prevents an older poll result from replacing a newer action result. Changing pages does not change the database, installation identity, capture settings or synchronization coordinator. Forms discard unsent secrets on unmount; pending pairing claims remain in the existing durable background store, with retry and reviewed discard preserved.

Files are limited to 1 MiB, parsed locally, and sent through the existing validated enrollment/pairing APIs. Failed or superseded reads do not retain a previous file's contents. First enrollment creates keys locally; later devices use private invitations. Recovery still requires a fresh installation credential. The server owner's CLI instructions are optional help; running a server remains a technical prerequisite, not an automated hosting flow.

Home offers Open for any collection with saved data, including paused collections; empty disabled collections offer Set up. Opening a saved collection does not enable capture.

Saved-session details have their own route, so View places restore controls at the top of the page. Restoration progress for that snapshot appears before its tab list. Session type/source filters are URL search parameters; the Back link, browser Back and direct reload preserve them. Missing snapshots have an explicit error, retry and return link. The list unmounts while details are open, and obsolete detail responses cannot replace a newer selection.

History setup defaults to **New visits only**; importing older visits remains an explicit choice. Bookmark merging still requires a preview and saving its recovery copy. Removal warnings describe live synced-record erasure and the native/backup copies that remain. Device removal and key rotation keep their existing review/retry behavior.

## Component and spacing revision

Forms now compose official shadcn Field/FieldGroup/FieldLabel/FieldDescription/FieldError components. Labels/control gaps are 8 px, standard single-line controls are 40 px tall, and helpers follow the control instead of extending its label. This fixes the History textarea/select offset and inconsistent filter labels. Cards use headers/content/footers; setup/settings/device navigation uses Item rows and action links use Button composition. Empty views use Empty components. Conflicting global label/button margins and obsolete page styles were removed; square dark logo tokens remain shared with restoration.

## Verification

The current checkpoint records rendered preview evidence for first-device setup, invalid file handling, invitation-file selection, an interrupted registration and its retry, separate collection/device/settings pages, direct links and responsive navigation. The preview uses synthetic background replies; it establishes UI behavior, not actual native enrollment. Existing core and real-relay checks exercise the underlying persistence and pairing contracts. All 15 options views and the restoration page were checked at 390 px without horizontal page overflow. Desktop History’s paired select/textarea tops and all filter rows align; expanded storage/retention controls retain 8 px label gaps and 40 px heights. Fresh preview route/pairing and checking/offline branches reported no console warnings/errors.

The added saved-session route brings the current options total to 16 views. Desktop and 390 px checks pass for its controls, blocked-job/resume display, invalid snapshot, deep reload and filtered Back behavior; no horizontal overflow or rounded controls, and no fresh warning/error logs. Synthetic replies establish those UI branches. Native Test 2 opens the real 24-tab saved snapshot on this route, shows its existing 24/24 complete journal above the tab list, survives direct reload, and returns to Closed through browser Back. Capture stays paused. No second restore request was submitted during the route check.

Both named Helium test profiles now use the revised packaged UI assets at their existing extension origin, with identical background bytes and permissions. Native Home/Devices/Settings/Recovery/History navigation, direct reload/back, legacy hash migration, retained settings/collections and two-way diagnostic messages pass. Initial enrolled startup now says Checking connection until transport has attempted reconciliation; unavailable transport still says Offline. Post-rotation guidance points to Settings → Recovery & backups. Fresh file-based native onboarding and human feedback on clarity remain open. [native-smoke.md](native-smoke.md) records the concrete results and limits; full acceptance gates remain in [plan.md](plan.md).
