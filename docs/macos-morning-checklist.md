# Mac server: morning handoff

Implementation and the prepared 0.3.0 package versions are ready for release PR review. At the maintainer's request, the installed notarized 0.3.0 app now supervises the three existing accounts in their original data folder. Credentials, databases, endpoints, backup times and retention were preserved. The nine legacy account jobs are disabled/unloaded; their definitions and the separate TLS/renewal jobs remain. No release was published.

## Needed from the maintainer

- [x] **Notarization authentication.** The supplied Team API key validated and was saved as the local `helium-synk` Keychain profile. The app and DMG were accepted by Apple, stapled and validated; Gatekeeper reports `Notarized Developer ID`.
- [x] **GitHub signing identity.** With separate explicit user approvals for notarization and signing credentials, all six Apple Actions secrets were configured in `mikr13/helium-synk` and their names read back. Export only the fingerprint-matched Developer ID Application identity to a password-protected P12, validate its identity with an in-memory import, send the P12 and generated password through stdin, and remove the temporary export. Remote signing/notarization with those secrets remains part of release acceptance.
- [x] **Protect existing data.** A full cold browser backup was verified file by file, and three existing relay accounts were backed up online with integrity-checked snapshots and matching credentials. Helium was reopened. The private backup manifest records its exact location and hashes; production jobs and routes were not replaced.
- [x] **Set up the installed app with existing data.** The maintainer requested a production handover instead of a separate test installation. Add native configuration in the existing data folder with all accounts initially paused; register the native helper through the app, stop the nine legacy account jobs, take verified final snapshots, then resume the same accounts. Native 0.3.0 processes, unchanged epochs/credentials/device counts, authenticated status, existing HTTPS readiness, native health and backups were read back. Existing browser enrollment remains valid; no connection-file reimport was needed. Private handover records and rollback notes are in the backup folder.
- [ ] **Two-device acceptance — skipped at the maintainer's request.** Separate live-test accounts, invitation flows, reboot/logout and clean-Mac testing were not performed. The production handover's readiness/identity/backup checks do not establish these broader results.
- [ ] **Release review.** Aligned 0.3.0 versions/changelogs, local source review and automated gates pass. The branding-corrected ARM64 app/DMG are signed, notarized, stapled and Gatekeeper accepted; final checksums and bundled-helper smoke pass. The private local review report is in ignored `release/native-release-review.md`. PR approval/merge, publication, remote signing on both architectures and clean-download acceptance remain pending.

## Optional later work

- A reusable, user-facing legacy migration wizard. First launch still detects legacy data and preserves it; this maintainer's handover was explicitly requested and performed with private migration records.
- Automatic app updates, a pre-login daemon, and encrypted off-host backups. These require their own lifecycle and acceptance work.

## Local evidence

Evidence and screenshots are in ignored `release/`, with final artifact hashes and signing/notarization flags in the matching `helium-synk-server-*-build.json`. The single [project checklist](plan.md#native-macos-server-app) records the completed checks and remaining acceptance boundaries.
