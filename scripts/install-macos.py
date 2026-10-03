#!/usr/bin/env python3
"""Install two independent private relays for the current macOS login session."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import zipfile

spec = importlib.util.spec_from_file_location("synk_ops", Path(__file__).with_name("macos-ops.py"))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)


def main():
    if sys.platform != "darwin":
        raise RuntimeError("This installer supports macOS only")
    os.umask(0o077)
    repository = Path(__file__).resolve().parent.parent
    release = repository / "release"
    metadata = json.loads((release / "build.json").read_text())
    artifact = next(item for item in metadata["artifacts"] if item["name"].startswith("synk-server-"))
    binary = release / artifact["name"]
    if hashlib.sha256(binary.read_bytes()).hexdigest() != artifact["sha256"]:
        raise RuntimeError("Release binary checksum mismatch")
    extension_artifact = next(item for item in metadata["artifacts"] if item["name"].endswith(".zip"))
    extension_zip = release / extension_artifact["name"]
    if hashlib.sha256(extension_zip.read_bytes()).hexdigest() != extension_artifact["sha256"]:
        raise RuntimeError("Extension release checksum mismatch")
    with zipfile.ZipFile(extension_zip) as archive:
        if json.loads(archive.read("manifest.json"))["version"] != metadata["versions"]["extension"]:
            raise RuntimeError("Extension release version mismatch")
        for name in archive.namelist():
            if name.startswith("/") or ".." in Path(name).parts:
                raise RuntimeError("Unsafe archive member")
    root = Path.home() / "Library" / "Application Support" / "Helium Synk"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root.is_symlink():
        raise RuntimeError("Installation directory must not be a symlink")
    root.chmod(0o700)
    # This installation is deliberately fresh. Upgrades need a consistent backup first.
    if (root / "bin" / "synk-server").exists():
        raise RuntimeError("Existing installation detected; use the documented backup/update procedure")
    for directory in ["bin", "logs", "extension", "accounts/abi/backups", "accounts/syngenta/backups", "recovery/abi", "recovery/syngenta"]:
        (root / directory).mkdir(mode=0o700, parents=True, exist_ok=True)
    shutil.copyfile(binary, root / "bin" / "synk-server")
    (root / "bin" / "synk-server").chmod(0o700)
    shutil.copyfile(repository / "scripts" / "macos-ops.py", root / "bin" / "macos-ops.py")
    with zipfile.ZipFile(extension_zip) as archive:
        archive.extractall(root / "extension")
    shutil.copyfile(release / "build.json", root / "build.json")
    for path in (root / "extension").rglob("*"):
        path.chmod(0o700 if path.is_dir() else 0o600)
    python = Path("/opt/homebrew/bin/python3")
    if not python.is_file():
        raise RuntimeError("Install the supported Homebrew Python runtime first")
    agents = Path.home() / "Library" / "LaunchAgents"
    agents.mkdir(parents=True, exist_ok=True)
    domain = f"gui/{os.getuid()}"
    for account in ops.ACCOUNTS:
        for action in ["serve", "backup", "monitor"]:
            label = f"net.imput.helium-synk.{account}.{action}"
            plist = {
                "Label": label,
                "ProgramArguments": [str(python), str(root / "bin" / "macos-ops.py"), "--root", str(root), action, account],
                "WorkingDirectory": str(root), "Umask": 0o077,
                "StandardOutPath": "/dev/null", "StandardErrorPath": "/dev/null",
                "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONDONTWRITEBYTECODE": "1"},
            }
            if action == "serve":
                plist.update(RunAtLoad=True, KeepAlive=True, ThrottleInterval=10, ExitTimeOut=20)
            elif action == "backup":
                plist.update(StartCalendarInterval={"Hour": 3, "Minute": 10 if account == "abi" else 20})
            else:
                plist.update(RunAtLoad=True, StartInterval=3600)
            path = agents / f"{label}.plist"
            if path.exists():
                raise RuntimeError(f"Refusing to replace an existing agent: {label}")
            path.write_bytes(plistlib.dumps(plist))
            path.chmod(0o600)
            subprocess.run(["/bin/launchctl", "bootstrap", domain, str(path)], check=True)
    print(f"Installed private ABI and Syngenta services in {root}")


if __name__ == "__main__":
    main()
