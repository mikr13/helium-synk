"""Deployment checks against a real relay snapshot, without touching installed services."""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ops", Path(__file__).with_name("macos-ops.py"))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "bin").mkdir()
        (self.root / "accounts/abi").mkdir(parents=True)
        binary = Path(__file__).resolve().parent.parent / "target/debug/synk-server"
        shutil.copyfile(binary, self.root / "bin/synk-server")
        (self.root / "bin/synk-server").chmod(0o700)
        subprocess.run([str(binary), "--database", str(self.root / "accounts/abi/relay.sqlite"),
                        "issue-device", "--name", "Disposable ops test", "--output", str(self.root / "credential.json")],
                       check=True, stdout=subprocess.DEVNULL)
        self.previous_umask = os.umask(0o077)

    def tearDown(self):
        os.umask(self.previous_umask)
        self.temporary.cleanup()

    def test_verified_snapshots_retention_and_same_day_retry(self):
        for date in [dt.date(2026, month, 1) for month in range(1, 6)]:
            ops.backup(self.root, "abi", date)
        for day in range(1, 10):
            ops.backup(self.root, "abi", dt.date(2026, 6, day))
        directory = self.root / "accounts/abi/backups"
        self.assertEqual(len(list(directory.glob("daily-*.sqlite"))), 7)
        self.assertEqual(len(list(directory.glob("weekly-*.sqlite"))), 4)
        self.assertEqual(len(list(directory.glob("monthly-*.sqlite"))), 3)
        before = {p.name: p.read_bytes() for p in directory.iterdir()}
        ops.backup(self.root, "abi", dt.date(2026, 6, 9))
        self.assertEqual(before, {p.name: p.read_bytes() for p in directory.iterdir()})
        for path in directory.iterdir():
            ops.integrity(path)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_failed_backup_preserves_prior_snapshot_and_reports_failure(self):
        ops.backup(self.root, "abi", dt.date(2026, 1, 1))
        prior = (self.root / "accounts/abi/backups/daily-2026-01-01.sqlite").read_bytes()
        (self.root / "bin/synk-server").unlink()
        with patch.object(sys, "argv", ["ops", "--root", str(self.root), "backup", "abi"]):
            self.assertEqual(ops.main(), 1)
        self.assertFalse(json.loads((self.root / "accounts/abi/backup-status.json").read_text())["ok"])
        self.assertEqual(prior, (self.root / "accounts/abi/backups/daily-2026-01-01.sqlite").read_bytes())

    def test_unavailable_readiness_and_failed_backup_are_visible(self):
        ops.backup(self.root, "abi")
        ops.save_json(self.root / "accounts/abi/backup-status.json", {
            "ok": False, "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        })
        with patch.object(ops.urllib.request, "urlopen", side_effect=OSError("Unavailable")):
            self.assertFalse(ops.monitor(self.root, "abi"))
        status = json.loads((self.root / "accounts/abi/health-status.json").read_text())
        self.assertIn("Readiness unavailable: OSError", status["problems"])
        self.assertIn("Backup failed or is older than 30 hours", status["problems"])
        self.assertEqual(status["unprocessed_deliveries"], 0)

    def test_large_service_output_rotates_with_bounded_files(self):
        (self.root / "logs").mkdir()
        binary = self.root / "bin/synk-server"
        binary.write_text("#!" + sys.executable + "\nimport sys\nfor _ in range(110):\n sys.stdout.write('x' * 65535 + '\\n')\n")
        binary.chmod(0o700)
        self.assertEqual(ops.serve(self.root, "abi"), 0)
        logs = list((self.root / "logs").glob("abi.log*"))
        self.assertEqual(len(logs), 2)
        self.assertTrue(all(path.stat().st_size <= 5 * 1024**2 for path in logs))
        for handler in ops.logging.getLogger("abi").handlers:
            handler.close()
        ops.logging.getLogger("abi").handlers.clear()


if __name__ == "__main__":
    unittest.main()
