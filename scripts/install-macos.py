#!/usr/bin/env python3
"""Install configurable private relays for the current macOS login session."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import shutil
import subprocess
import sys
import zipfile

spec = importlib.util.spec_from_file_location("synk_ops", Path(__file__).with_name("macos-ops.py"))
ops = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ops)

REPOSITORY = Path(__file__).resolve().parent.parent


def release_artifacts(release):
    metadata = json.loads((release / "build.json").read_text())
    architecture = {"arm64": "arm64", "aarch64": "arm64", "x86_64": "x64"}.get(platform.machine())
    if metadata.get("target") != f"darwin-{architecture}" or architecture is None:
        raise ValueError("Use a macOS release built for this Mac's architecture")
    binary_item = next(item for item in metadata["artifacts"] if item["name"].startswith("synk-server-"))
    extension_item = next(item for item in metadata["artifacts"] if item["name"].endswith(".zip"))
    for item in (binary_item, extension_item):
        if Path(item["name"]).name != item["name"]:
            raise ValueError("Release artifact names must not contain paths")
        if hashlib.sha256((release / item["name"]).read_bytes()).hexdigest() != item["sha256"]:
            raise ValueError(f"Release checksum mismatch: {item['name']}")
    with zipfile.ZipFile(release / extension_item["name"]) as archive:
        if json.loads(archive.read("manifest.json"))["version"] != metadata["versions"]["extension"]:
            raise ValueError("Extension release version mismatch")
        for member in archive.infolist():
            if member.filename.startswith("/") or ".." in Path(member.filename).parts or (member.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("Unsafe archive member")
    return release / binary_item["name"], release / extension_item["name"]


def python_runtime(value):
    # Keep a stable symlink path, including either Homebrew prefix, rather than a versioned Cellar path.
    path = Path(value or shutil.which("python3") or sys.executable).expanduser().absolute()
    if not path.is_file() or not os.access(path, os.X_OK):
        raise ValueError("Provide an executable Python runtime using --python")
    subprocess.run([str(path), "-c", "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"], check=True)
    return str(path)


def agent_plists(root, config, settings, agents):
    result = {}
    for name, profile in config["profiles"].items():
        for action in ("serve", "backup", "monitor"):
            label = f"{settings['label_prefix']}.{name}.{action}"
            value = {
                "Label": label,
                "ProgramArguments": [settings["python"], str(root / "bin/macos-ops.py"), "--root", str(root), action, name],
                "WorkingDirectory": str(root), "Umask": 0o077,
                "StandardOutPath": "/dev/null", "StandardErrorPath": "/dev/null",
                "EnvironmentVariables": {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "PYTHONDONTWRITEBYTECODE": "1"},
            }
            if action == "serve":
                value.update(RunAtLoad=True, KeepAlive=True, ThrottleInterval=10, ExitTimeOut=20)
            elif action == "backup":
                hour, minute = map(int, profile["backup_time"].split(":"))
                value.update(StartCalendarInterval={"Hour": hour, "Minute": minute})
            else:
                value.update(RunAtLoad=True, StartInterval=3600)
            result[agents / f"{label}.plist"] = value
    return result


def install(config, root, release, agents, *, add_profiles=False, python=None, label_prefix=None, start=True, check=False):
    """Preflight all configuration/collisions before creating accounts or agents."""
    config = ops.validate_config(config)
    root = root.expanduser().absolute()
    if root.is_symlink():
        raise ValueError("Installation directory must not be a symlink")
    if add_profiles:
        existing = ops.load_config(root)
        settings = json.loads((root / "installation.json").read_text())
        if python is not None or label_prefix is not None:
            raise ValueError("Adding profiles keeps the installed Python runtime and agent prefix")
        if config["retention"] != existing["retention"]:
            raise ValueError("Adding profiles must preserve the installed backup retention settings")
        if set(config["profiles"]) & set(existing["profiles"]):
            raise ValueError("--add-profiles accepts only new profile identifiers")
        combined = ops.validate_config({**existing, "profiles": {**existing["profiles"], **config["profiles"]}})
        if (root / "bin/macos-ops.py").read_bytes() != (REPOSITORY / "scripts/macos-ops.py").read_bytes():
            raise ValueError("Installed helper differs; review its upgrade before adding profiles")
        binary, extension = root / "bin/synk-server", None
        python_runtime(settings["python"])
    else:
        if root.exists() and (not root.is_dir() or any(root.iterdir())):
            raise ValueError("Existing installation detected; use --add-profiles for new accounts or review the upgrade procedure")
        settings = {"python": python_runtime(python), "label_prefix": label_prefix or "local.helium-synk"}
        binary, extension = release_artifacts(release)
        combined = config
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9.-]{2,99}", settings["label_prefix"]):
        raise ValueError("Choose an agent prefix using letters, digits, dots and hyphens")
    plists = agent_plists(root, config, settings, agents)
    for path in plists:
        if path.exists() or path.is_symlink():
            raise ValueError(f"Refusing to replace an existing agent: {path.name}")
    for name in config["profiles"]:
        for path in (root / "accounts" / name, root / "recovery" / name):
            if path.exists() or path.is_symlink():
                raise ValueError(f"Refusing to replace existing profile data: {name}")
    if check:
        return root

    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    root.chmod(0o700)
    for directory in ("bin", "logs", "accounts", "recovery"):
        (root / directory).mkdir(mode=0o700, exist_ok=True)
    if not add_profiles:
        shutil.copyfile(binary, root / "bin/synk-server")
        (root / "bin/synk-server").chmod(0o700)
        shutil.copyfile(REPOSITORY / "scripts/macos-ops.py", root / "bin/macos-ops.py")
        (root / "bin/macos-ops.py").chmod(0o600)
        (root / "extension").mkdir(mode=0o700)
        with zipfile.ZipFile(extension) as archive:
            archive.extractall(root / "extension")
        for path in (root / "extension").rglob("*"):
            path.chmod(0o700 if path.is_dir() else 0o600)
        shutil.copyfile(release / "build.json", root / "build.json")
        (root / "build.json").chmod(0o600)
        ops.save_json(root / "installation.json", settings)
    for name, profile in config["profiles"].items():
        account = root / "accounts" / name
        (account / "backups").mkdir(mode=0o700, parents=True)
        (root / "recovery" / name).mkdir(mode=0o700)
        subprocess.run([
            str(root / "bin/synk-server"), "--database", str(account / "relay.sqlite"),
            "issue-device", "--name", profile["device_name"], "--server-url", profile["server_url"],
            "--output", str(account / "connection.json"),
        ], check=True, stdout=subprocess.DEVNULL)
    ops.save_json(root / ops.CONFIG_NAME, combined)
    for name in config["profiles"]:
        ops.backup(root, name)
    agents.mkdir(parents=True, exist_ok=True)
    for path, plist in plists.items():
        # Exclusive creation protects against a collision since preflight.
        with path.open("xb") as output:
            output.write(plistlib.dumps(plist))
        path.chmod(0o600)
    if start:
        domain = f"gui/{os.getuid()}"
        # All profile files and agents exist before starting the first service.
        for path in plists:
            subprocess.run(["/bin/launchctl", "bootstrap", domain, str(path)], check=True)
    return root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path, help="JSON deployment configuration")
    parser.add_argument("--root", type=Path, default=Path.home() / "Library/Application Support/Helium Synk")
    parser.add_argument("--release-dir", type=Path, default=REPOSITORY / "release")
    parser.add_argument("--python", help="Stable absolute Python 3.9+ executable path; defaults to python3 on PATH")
    parser.add_argument("--label-prefix", help="LaunchAgent namespace; defaults to local.helium-synk")
    parser.add_argument("--add-profiles", action="store_true", help="Add only new accounts without replacing existing ones")
    parser.add_argument("--no-start", action="store_true", help="Write agents without loading them into this login session")
    parser.add_argument("--check", action="store_true", help="Validate configuration, release and destination without writing files")
    args = parser.parse_args()
    if sys.platform != "darwin":
        parser.error("This installer supports macOS only")
    os.umask(0o077)
    try:
        root = install(json.loads(args.config.read_text()), args.root, args.release_dir,
                       Path.home() / "Library/LaunchAgents", add_profiles=args.add_profiles,
                       python=args.python, label_prefix=args.label_prefix, start=not args.no_start, check=args.check)
    except (ValueError, OSError, KeyError, StopIteration, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Installation failed: {error}\nReview any partially created files before retrying; existing data is never replaced.\n")
    action = "Validated" if args.check else "Installed"
    print(f"{action} configured profiles in {root}")
    if not args.check:
        print("Configure private Tailscale Serve, then import each account's connection.json into its first browser installation.")


if __name__ == "__main__":
    main()
