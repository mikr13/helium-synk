# Mac Mini hosting preparation

This is a deployment checklist. No service, Tailscale policy, power setting, or backup schedule has been installed or changed by the development checkpoint. Production use depends on the open [M1/M6 gates](plan.md).

## Files and process

- [ ] Keep source at `/Users/mihirpandey/Work/fun/helium-synk`.
- [ ] Choose a dedicated persistent data directory outside the checkout, Documents, Desktop, iCloud Drive, and other sync folders; for example `/Users/mihirpandey/Library/Application Support/Helium Synk`.
- [ ] Create that directory with mode 0700 and restrict the database/credential/backup files to their owner.
- [ ] Build using `./scripts/cargo.sh build --release --locked`; install the binary to a stable explicit path outside build output.
- [ ] Record the dynamic SQLite library dependency before deployment. Package/use a patched library and test the actual deployed binary after Homebrew upgrades.
- [ ] Use the CLI's absolute `--database` path and the default localhost-only listener; never bind directly to all interfaces.
- [ ] Implement and test bounded graceful SIGTERM shutdown before launchd installation. The current binary handles Ctrl+C; SIGTERM persistence is exercised as process termination, not graceful shutdown.
- [ ] Decide between a per-user LaunchAgent (login required) and a properly restricted LaunchDaemon, based on the installed Tailscale variant and desired startup behavior.
- [ ] Create a launchd plist with absolute ProgramArguments, WorkingDirectory, RunAtLoad/KeepAlive policy, a restart throttle, restrictive Umask, and explicit standard-output/error log paths. Verify it before installing.
- [ ] Rotate/bound logs, monitor readiness and disk space, and test migration/upgrade rollback compatibility.

## Private network

[Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) shares the localhost service inside the tailnet and terminates HTTPS. Its background mode retains configuration across restarts. After confirming the machine's Tailscale setup, the intended proxy command is:

```sh
tailscale serve --bg http://127.0.0.1:4318
tailscale serve status
```

- [ ] Verify MagicDNS/HTTPS prerequisites and record the actual stable `.ts.net` origin reported by Serve.
- [ ] Limit access using the tailnet policy for intended devices/users; retain application credentials as an independent check.
- [ ] Issue new per-profile credentials using `--server-url https://YOUR-MINI.YOUR-TAILNET.ts.net`.
- [ ] Request only that origin in the extension and verify HTTPS pull/push plus authenticated WSS notifications.
- [ ] Verify reconnection with Tailscale down/up and server restart.
- [ ] Keep public Funnel exposure out of this deployment.

## Availability

- [ ] Prevent system sleep while permitting display sleep, using supported settings appropriate to the Mac Mini.
- [ ] Verify power-loss startup behavior and actual cold-boot/network recovery.
- [ ] Keep FileVault enabled; document the human unlock/login step if it is required after reboot.
- [ ] Test logout as well as reboot. A login-bound service and Tailscale client cannot be assumed to run before login.
- [ ] Show clients' last successful sync and pending work when the Mini is unavailable. Do not infer remote freshness from connectivity alone.

## Backups and recovery

Use [SQLite's online backup facilities](https://sqlite.org/backup.html) or a tested coordinated snapshot. Copying only an active WAL-mode main database file can omit committed data.

- [ ] Generate consistent daily backups with failure reporting and a tested rotation policy.
- [ ] Keep at least one encrypted backup off the Mini; store root-key recovery separately and protect both.
- [ ] Test integrity and restore into a completely isolated instance before accepting a backup procedure.
- [ ] Implement explicit restore-epoch rotation and client reconciliation before restoring an older database into the live service.
- [ ] Recover missing acknowledged operations from surviving clients/exports, rather than relying on an empty upload queue.
- [ ] Exercise disk-full, migration failure, stale backup, and server-disk-loss scenarios.

The current checkpoint has no production backup automation, restore-epoch CLI, or data-loss recovery workflow. iCloud fallback remains research for a later phase.
