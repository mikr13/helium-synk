# Setup guide

One account per context, such as Personal or Work. Same context across computers joins one account. Matching names alone do not connect profiles.

## 1. Prepare the server

Follow [deployment.md](deployment.md#install-on-macos). Configure your accounts, install relays and enable private Tailscale HTTPS.

Default files: `~/Library/Application Support/Helium Synk`. Each account gets `accounts/PROFILE/connection.json` for one first installation.

New independent context: use [add-profile setup](deployment.md#add-an-independent-profile). Another installation of an existing account: use an invitation.

## 2. Install the extension

1. Install Helium and [Tailscale](https://tailscale.com/docs/install/mac). Connect server/client to the same permitted tailnet.
2. Verify the compatible extension ZIP against `SHA256SUMS`. Extract to a permanent folder containing `manifest.json`.
3. In each target profile, open **chrome://extensions**, enable **Developer mode**, then **Load unpacked**.
4. Select the extracted folder and pin Helium Synk. Profiles may share files; their enrollment/storage remain separate.

Clients need no relay or development tools. Synk does not copy extensions, settings, passwords, cookies or website logins.

## 3. Connect the first device of a new account

Choose **Set up my first device**, select that account's unused `connection.json`, then **Connect this device**. Allow the expected private host.

Wait for **Connected**. Save recovery keys and local data separately under **Settings → Recovery & backups**.

Never reuse an enrolled credential or clone its browser database/counters.

## 4. Connect another computer or profile

1. In the matching connected context, open **Devices → Add device → Save invitation file**.
2. Transfer it privately. Valid 15 minutes, one new installation; embedded keys remain sensitive after expiry.
3. On the destination, choose **Connect another device**, select the invitation and enter a distinct device name.
4. Connect, allow the expected host and wait for **Connected**. Delete used invitation copies.

Create a fresh invitation for each installation and context.

## 5. Enable collections

- **Bookmarks:** Preview merge, save bookmark backup, then enable. Existing bookmarks merge into this account.
- **Sessions:** Enable capture. Restore tabs/windows explicitly; source windows stay intact.
- **History:** Enable capture with **New visits only**. Older import is optional; shared visits appear only in Synk's History.

Collections and expiry start off. Update every client before enabling session expiry. Check Home/popup, then verify one bookmark syncs both ways.

## 6. Keep and fix

Keep recovery keys private, separate from relay snapshots. Save recovery again after rotation. Use an encrypted off-host backup.

- Expired invitation: create another.
- Pending setup: **Retry connection**; preserve its saved identity.
- Offline: check Tailscale, server awake/login and `/health/ready`; choose **Sync now**.
- Missing collection: enable it and check filters.
- Wrong account or epoch: pause capture and preserve data/queues. Renaming or resetting does not fix enrollment.
- No connected device: current recovery file plus a freshly issued connection file; see [recovery](deployment.md#backup-and-recovery).

[Update](deployment.md#updates-and-publishing) in the same extension folder with **Reload**. Never remove/reinstall or clear enrolled storage to update.
