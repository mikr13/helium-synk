# Synk CPU investigation — 22 October 2026

## Evidence

A system investigation mapped Helium Synk 0.4.0 to three persistently busy extension workers in independent browser profiles. Installed profile metadata independently confirmed version 0.4.0 in all three profiles. A live process snapshot still showed heavy CPU in those processes. The relay server processes were comparatively idle.

A short native sample showed sustained JavaScript work on a service-worker thread. A separate live DevTools pause caught `projectSessions` decoding historical session fragments with **2,897 snapshots** in its input. DevTools reported approximately **139 MB** of extension-origin storage. The worker was resumed after inspection.

Pre-reboot evidence also showed memory pressure from another application and active swapping. Synk's persistent post-reboot CPU load is a separate confirmed contributor; these findings do not establish that Synk alone caused the system freeze.

## Mechanism and fix

- Every pull, including an empty response, previously loaded and rebuilt all three domain projections. A normal sync pulls twice, so three idle sync calls reproduced six full journal reads/rebuilds per domain.
- History-only and diagnostic downloads also decoded every historical session snapshot.
- Only the HTTP coordinator was coalesced. The surrounding native capture and reconciliation work could accumulate behind startup, alarm, browser-event and relay-notification calls. Startup and debounced session/bookmark events also explicitly repeated reconciliation already performed inside sync.

Empty pages now validate the epoch/cursor and finish without reading domain journals. Nonempty pages rebuild only affected domains, including certified erasure/compaction receipts. Cross-domain counter validation, durable cursor/ACK ordering, capacity checks and recovery epoch guards remain enforced.

The whole background capture/network/application cycle now shares one active promise and permits at most one immediate follow-up. Durable work arriving during that follow-up remains available for the next event/alarm. Duplicate reconciliation in startup and event callbacks has been removed. Completed/cancelled restore cleanup runs separately, so it no longer depends on a full session replay on an empty pull.

Release review also caught a regression in the pending compaction work: display-only compacted-record totals enumerated every operation during each capture/download capacity check. Admission now uses indexed counts and the existing size estimate; the full compaction count remains available when explicitly requesting storage status. A regression test verifies that capture/download admission never enumerates journal payloads for that statistic.

## Verification

- The idle-work regression failed before the fix: six unexpected journal reads for three idle sync calls. It passes after the fix with zero domain journal reads/rebuilds.
- Scheduler tests cover 1,000 requests during an active pass, forced retries, failure recovery, and self-generated notifications. They verify a maximum of one active pass and two immediate passes.
- All **266 client tests** passed, including retention, erasure, recovery, and cursor/ACK failure cases.
- All **18 real-relay integration tests** passed against isolated temporary localhost servers.
- Type checking, formatting/lint, and the production extension build passed.

A temporary synthetic benchmark compared the original checked-in coordinator with the fixed coordinator using the same fake IndexedDB database, 2,897 saved snapshots of 20 tabs each, no outgoing work, retention disabled, and a transport returning empty pages. One idle sync took **3,128 ms before** and approximately **2 ms after**. This measures the removed replay work, not installed-browser CPU or end-to-end production performance. It omits network/key API/erasure transport work and native capture. The temporary benchmark source/database were removed after measurement; no real browser records were exported or changed.

## Acceptance boundary

The automated checks and synthetic benchmark do not establish live browser CPU acceptance. Verify idle CPU and browsing/catch-up behavior after installing the corrected extension. Real session changes still validate/replay the session journal; incremental projection and history retention are separate performance/storage decisions. Preserve enrolled profiles and verify backups before upgrades.

## Live 0.5.0 follow-up

A verified Store 0.5.0 installation still showed substantial idle worker CPU. Its shipped code matched the published ZIP. A live pause caught IndexedDB cursor work; the deletion transport performed full session-content scans in `HistoryPurger.prepare()` and repeated whole-journal scans in `remaining()`, even without any erased records. The earlier benchmark explicitly omitted this transport and therefore missed the cost.

Version 0.5.1 introduces a sparse `purge_state` index in IndexedDB schema 12. It backfills derived metadata from existing records and keeps it current through operation create/update hooks. Deletion candidate queries touch only suppression receipts; completed-redaction counts also use the index. Payloads, envelopes, keys, credentials and relay schema 6 remain unchanged.

The full idle coordinator regression enables deletion transport and measures journal value reads: it failed with eight ordinary-record reads in a small fixture and passes with zero. Migration tests preserve every pre-existing operation field and cover erasure, ACK, redaction, replacement and the existing compaction/recovery scenarios. A temporary fake-IndexedDB benchmark with 2,897 session records and empty pull plus deletion transport measured **2,666 ms before** and **2.7 ms after**. It excludes HTTP, native capture and key APIs, and is not a live browser CPU result. Live acceptance must be repeated after Store 0.5.1 installation.
