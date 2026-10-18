#!/usr/bin/env python3
"""Exercise the actual bundled signed helper and relay in an isolated data folder."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import urllib.request

app = Path(sys.argv[1]).resolve()
import plistlib
info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
assert info["SURequireSignedFeed"] and info["SUVerifyUpdateBeforeExtraction"]
assert info["SUAllowsAutomaticUpdates"] is False, "Updates must use the coordinated explicit-install flow"
assert (app / "Contents/Resources/Sparkle-LICENSE.txt").is_file(), "Sparkle's distribution notices must ship with the app"
relay = app / "Contents/MacOS/synk-server"
agent = app / "Contents/MacOS/synk-agent"
os.umask(0o077)
with tempfile.TemporaryDirectory(prefix="synk-native-smoke-") as temporary:
    root = Path(temporary).resolve()
    (root / "accounts/personal/backups").mkdir(parents=True)
    (root / "logs").mkdir()
    with socket.socket() as reservation:
        reservation.bind(("127.0.0.1", 0))
        port = reservation.getsockname()[1]
    database = root / "accounts/personal/relay.sqlite"
    connection = root / "accounts/personal/connection.json"
    subprocess.run([str(relay), "--database", str(database), "issue-device", "--name", "Smoke browser", "--server-url", f"http://127.0.0.1:{port}", "--output", str(connection)], check=True, stdout=subprocess.DEVNULL)
    credential = connection.read_bytes()
    (root / "deployment.json").write_text(json.dumps({"version": 1, "profiles": {"personal": {"port": port, "server_url": f"http://127.0.0.1:{port}", "device_name": "Smoke browser", "backup_time": "03:10"}}, "retention": {"daily": 7, "weekly": 4, "monthly": 3}}))
    (root / "native-installation.json").write_text(json.dumps({"format": 1, "createdAt": "2026-10-14T00:00:00Z", "serviceLabel": "com.heliumsynk.server.agent"}))
    # No --relay argument: prove executable discovery works in the shipped bundle.
    subprocess.run([str(agent), "--root", str(root), "--once"], check=True, timeout=40)
    health = json.loads((root / "accounts/personal/health-status.json").read_text())
    assert health["ok"], health["problems"]
    backup = json.loads((root / "accounts/personal/backup-status.json").read_text())
    assert backup["ok"]
    subprocess.run([str(relay), "verify-backup", "--path", str(root / "accounts/personal/backups" / backup["snapshot"])], check=True, stdout=subprocess.DEVNULL)
    assert connection.read_bytes() == credential
    try:
        urllib.request.urlopen(f"http://127.0.0.1:{port}/health/ready", timeout=1)
        raise AssertionError("Bundled relay was not shut down")
    except OSError:
        pass
    assert connection.stat().st_mode & 0o777 == 0o600
print("Bundled signed helper: real relay, verified backups, health, credential preservation and clean shutdown passed.")
