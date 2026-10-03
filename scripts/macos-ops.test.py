"""Deployment checks against a real relay snapshot, without touching installed services."""
import datetime as dt
import importlib.util
import copy
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("ops", Path(__file__).with_name("macos-ops.py"))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)

spec = importlib.util.spec_from_file_location("installer", Path(__file__).with_name("install-macos.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


def configuration(names=("research-team",), retention=None):
    value = {"version": 1, "profiles": {
        name: {"port": 5200 + index, "server_url": f"https://sync.example.ts.net:{9400 + index}",
               "device_name": f"Desktop · {name}", "backup_time": f"04:{15 + index:02d}"}
        for index, name in enumerate(names)
    }}
    if retention is not None:
        value["retention"] = retention
    return value


class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "bin").mkdir()
        ops.save_json(self.root / "deployment.json", configuration())
        (self.root / "accounts/research-team").mkdir(parents=True)
        binary = Path(__file__).resolve().parent.parent / "target/debug/synk-server"
        shutil.copyfile(binary, self.root / "bin/synk-server")
        (self.root / "bin/synk-server").chmod(0o700)
        subprocess.run([str(binary), "--database", str(self.root / "accounts/research-team/relay.sqlite"),
                        "issue-device", "--name", "Disposable ops test", "--output", str(self.root / "credential.json")],
                       check=True, stdout=subprocess.DEVNULL)
        self.previous_umask = os.umask(0o077)

    def tearDown(self):
        os.umask(self.previous_umask)
        self.temporary.cleanup()

    def test_verified_snapshots_retention_and_same_day_retry(self):
        for date in [dt.date(2026, month, 1) for month in range(1, 6)]:
            ops.backup(self.root, "research-team", date)
        for day in range(1, 10):
            ops.backup(self.root, "research-team", dt.date(2026, 6, day))
        directory = self.root / "accounts/research-team/backups"
        self.assertEqual(len(list(directory.glob("daily-*.sqlite"))), 7)
        self.assertEqual(len(list(directory.glob("weekly-*.sqlite"))), 4)
        self.assertEqual(len(list(directory.glob("monthly-*.sqlite"))), 3)
        before = {p.name: p.read_bytes() for p in directory.iterdir()}
        ops.backup(self.root, "research-team", dt.date(2026, 6, 9))
        self.assertEqual(before, {p.name: p.read_bytes() for p in directory.iterdir()})
        for path in directory.iterdir():
            ops.integrity(path)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_failed_backup_preserves_prior_snapshot_and_reports_failure(self):
        ops.backup(self.root, "research-team", dt.date(2026, 1, 1))
        prior = (self.root / "accounts/research-team/backups/daily-2026-01-01.sqlite").read_bytes()
        (self.root / "bin/synk-server").unlink()
        with patch.object(sys, "argv", ["ops", "--root", str(self.root), "backup", "research-team"]):
            self.assertEqual(ops.main(), 1)
        self.assertFalse(json.loads((self.root / "accounts/research-team/backup-status.json").read_text())["ok"])
        self.assertEqual(prior, (self.root / "accounts/research-team/backups/daily-2026-01-01.sqlite").read_bytes())

    def test_custom_retention_controls_actual_snapshot_rotation(self):
        ops.save_json(self.root / "deployment.json", configuration(retention={"daily": 2, "weekly": 1, "monthly": 1}))
        for day in (dt.date(2026, 1, 1), dt.date(2026, 2, 1), dt.date(2026, 2, 9), dt.date(2026, 2, 10)):
            ops.backup(self.root, "research-team", day)
        directory = self.root / "accounts/research-team/backups"
        self.assertEqual(sorted(path.name for path in directory.glob("daily-*.sqlite")),
                         ["daily-2026-02-09.sqlite", "daily-2026-02-10.sqlite"])
        self.assertEqual(len(list(directory.glob("weekly-*.sqlite"))), 1)
        self.assertEqual(len(list(directory.glob("monthly-*.sqlite"))), 1)

    def test_unavailable_readiness_and_failed_backup_are_visible(self):
        ops.backup(self.root, "research-team")
        ops.save_json(self.root / "accounts/research-team/backup-status.json", {
            "ok": False, "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        })
        with patch.object(ops.urllib.request, "urlopen", side_effect=OSError("Unavailable")) as request:
            self.assertFalse(ops.monitor(self.root, "research-team"))
        request.assert_called_once_with("http://127.0.0.1:5200/health/ready", timeout=5)
        status = json.loads((self.root / "accounts/research-team/health-status.json").read_text())
        self.assertIn("Readiness unavailable: OSError", status["problems"])
        self.assertIn("Backup failed or is older than 30 hours", status["problems"])
        self.assertEqual(status["unprocessed_deliveries"], 0)

    def test_large_service_output_rotates_with_bounded_files(self):
        (self.root / "logs").mkdir()
        binary = self.root / "bin/synk-server"
        binary.write_text("#!" + sys.executable + "\nimport sys\nassert sys.argv[-2:] == ['--port', '5200']\nfor _ in range(110):\n sys.stdout.write('x' * 65535 + '\\n')\n")
        binary.chmod(0o700)
        self.assertEqual(ops.serve(self.root, "research-team"), 0)
        logs = list((self.root / "logs").glob("research-team.log*"))
        self.assertEqual(len(logs), 2)
        self.assertTrue(all(path.stat().st_size <= 5 * 1024**2 for path in logs))
        for handler in ops.logging.getLogger("research-team").handlers:
            handler.close()
        ops.logging.getLogger("research-team").handlers.clear()


class ConfigurationTests(unittest.TestCase):
    def test_any_number_of_named_profiles_and_custom_retention(self):
        config = configuration(("research-team", "studio", "home"), {"daily": 2, "weekly": 2, "monthly": 1})
        self.assertEqual(ops.validate_config(config), config)

    def test_rejects_unsafe_or_ambiguous_configuration(self):
        changes = [
            ("port", True), ("port", 0), ("port", 65536),
            ("server_url", "https://sync.example.ts.net:0"),
            ("server_url", "https://public.example.com"),
            ("server_url", "https://user:password@sync.example.ts.net"),
            ("server_url", "https://sync.example.ts.net/path"),
            ("server_url", "https://sync.example.ts.net?token=example"),
            ("server_url", "http://127.0.0.1:5201"),
            ("backup_time", "24:00"), ("device_name", ""), ("device_name", "界" * 34),
        ]
        for field, value in changes:
            config = configuration()
            config["profiles"]["research-team"][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                ops.validate_config(config)
        for name in ("../escape", "Work", "a/b", "-team"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                ops.validate_config(configuration((name,)))
        for value in (0, True, -1, 1001):
            with self.subTest(retention=value), self.assertRaises(ValueError):
                ops.validate_config(configuration(retention={"daily": value, "weekly": 4, "monthly": 3}))

    def test_rejects_shared_ports_and_canonical_endpoint_collisions(self):
        config = configuration(("home", "studio"))
        config["profiles"]["studio"]["port"] = config["profiles"]["home"]["port"]
        with self.assertRaises(ValueError):
            ops.validate_config(config)
        config = configuration(("home", "studio"))
        config["profiles"]["home"]["server_url"] = "https://sync.example.ts.net"
        config["profiles"]["studio"]["server_url"] = "https://sync.example.ts.net:443/"
        with self.assertRaises(ValueError):
            ops.validate_config(config)

    def test_normalizes_names_and_allows_matching_loopback_development_origin(self):
        config = configuration()
        config["profiles"]["research-team"].update(device_name=" Desktop ", server_url="http://127.0.0.1:5200/")
        profile = ops.validate_config(config)["profiles"]["research-team"]
        self.assertEqual(profile["device_name"], "Desktop")
        self.assertEqual(profile["server_url"], "http://127.0.0.1:5200")


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.base = Path(self.temporary.name)
        self.root, self.agents, self.release = (self.base / name for name in ("private install", "agents", "release"))
        self.release.mkdir()
        self.config = configuration(("research-team", "studio"))
        binary = Path(__file__).resolve().parent.parent / "target/debug/synk-server"
        shutil.copyfile(binary, self.release / "synk-server-test")
        self.extension = self.release / "extension-test.zip"
        with zipfile.ZipFile(self.extension, "w") as archive:
            archive.writestr("manifest.json", json.dumps({"version": "0.2.0"}))
            archive.writestr("options.html", "test fixture")
        architecture = "arm64" if platform.machine() in ("arm64", "aarch64") else "x64"
        self.metadata = {"target": f"darwin-{architecture}", "versions": {"extension": "0.2.0"},
                         "artifacts": [{"name": path.name, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
                                       for path in (self.release / "synk-server-test", self.extension)]}
        self.save_metadata()
        self.previous_umask = os.umask(0o077)

    def tearDown(self):
        os.umask(self.previous_umask)
        self.temporary.cleanup()

    def save_metadata(self):
        (self.release / "build.json").write_text(json.dumps(self.metadata))

    def install(self, config=None, **kwargs):
        return installer.install(config or self.config, self.root, self.release, self.agents, start=False, **kwargs)

    def new_profile(self):
        config = configuration(("travel",))
        config["profiles"]["travel"].update(port=5202, server_url="https://sync.example.ts.net:9402")
        return config

    def test_fresh_install_issues_independent_credentials_and_configured_agents(self):
        self.install(python=sys.executable, label_prefix="org.example.synk")
        credentials = [json.loads((self.root / "accounts" / name / "connection.json").read_text())
                       for name in self.config["profiles"]]
        self.assertNotEqual(credentials[0]["account_id"], credentials[1]["account_id"])
        self.assertNotEqual(credentials[0]["device_id"], credentials[1]["device_id"])
        for (name, profile), credential in zip(self.config["profiles"].items(), credentials):
            self.assertEqual(credential["server_url"], profile["server_url"])
            self.assertEqual(credential["name"], profile["device_name"])
            account = self.root / "accounts" / name
            self.assertEqual((account / "connection.json").stat().st_mode & 0o777, 0o600)
            self.assertEqual(account.stat().st_mode & 0o777, 0o700)
            ops.integrity(account / "relay.sqlite")
            self.assertTrue(json.loads((account / "backup-status.json").read_text())["ok"])
            plist = plistlib.loads((self.agents / f"org.example.synk.{name}.backup.plist").read_bytes())
            hour, minute = map(int, profile["backup_time"].split(":"))
            self.assertEqual(plist["StartCalendarInterval"], {"Hour": hour, "Minute": minute})
            self.assertEqual(plist["ProgramArguments"][0], str(Path(sys.executable).absolute()))
            self.assertEqual(plist["ProgramArguments"][-2:], ["backup", name])
        self.assertEqual(len(list(self.agents.glob("*.plist"))), 6)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.assertEqual(ops.load_config(self.root), ops.validate_config(self.config))

    def test_add_profile_preserves_existing_data_credentials_agents_and_release(self):
        self.install()
        before = {path.relative_to(self.root): path.read_bytes() for path in self.root.rglob("*")
                  if path.is_file() and path.name != "deployment.json"}
        before_agents = {path.name: path.read_bytes() for path in self.agents.iterdir()}
        self.install(self.new_profile(), add_profiles=True)
        self.assertEqual(list(ops.load_config(self.root)["profiles"]), ["research-team", "studio", "travel"])
        for relative, value in before.items():
            self.assertEqual((self.root / relative).read_bytes(), value, str(relative))
        for name, value in before_agents.items():
            self.assertEqual((self.agents / name).read_bytes(), value)
        self.assertEqual(len(list(self.agents.glob("*.plist"))), 9)
        new = json.loads((self.root / "accounts/travel/connection.json").read_text())
        prior = json.loads((self.root / "accounts/studio/connection.json").read_text())
        self.assertNotEqual(new["account_id"], prior["account_id"])

    def test_add_collisions_or_retention_changes_fail_without_changing_install(self):
        self.install()
        before = {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()}
        duplicate_port = self.new_profile()
        duplicate_port["profiles"]["travel"]["port"] = 5200
        retention = self.new_profile()
        retention["retention"] = {"daily": 2, "weekly": 2, "monthly": 1}
        for config in (self.config, duplicate_port, retention):
            with self.subTest(config=config), self.assertRaises(ValueError):
                self.install(config, add_profiles=True)
            self.assertEqual(before, {path: path.read_bytes() for path in self.root.rglob("*") if path.is_file()})
        with self.assertRaises(ValueError):
            self.install()

    def test_check_has_no_filesystem_effects(self):
        self.install(check=True)
        self.assertFalse(self.root.exists())
        self.assertFalse(self.agents.exists())

    def test_checksum_or_wrong_architecture_fails_before_install(self):
        good = copy.deepcopy(self.metadata)
        for field, value in (("target", "darwin-unsupported"), ("artifacts", [{**good["artifacts"][0], "sha256": "0" * 64}, good["artifacts"][1]])):
            self.metadata = {**good, field: value}
            self.save_metadata()
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.install()
            self.assertFalse(self.root.exists())

    def test_archive_traversal_and_agent_collision_fail_before_install(self):
        self.agents.mkdir()
        existing = self.agents / "local.helium-synk.studio.serve.plist"
        existing.write_text("existing agent")
        with self.assertRaises(ValueError):
            self.install()
        self.assertFalse(self.root.exists())
        self.assertEqual(existing.read_text(), "existing agent")
        existing.unlink()
        with zipfile.ZipFile(self.extension, "a") as archive:
            archive.writestr("../escape.txt", "must not extract")
        self.metadata["artifacts"][1]["sha256"] = hashlib.sha256(self.extension.read_bytes()).hexdigest()
        self.save_metadata()
        with self.assertRaises(ValueError):
            self.install()
        self.assertFalse(self.root.exists())


if __name__ == "__main__":
    unittest.main()
