#!/usr/bin/env python3
"""Private per-user relay supervision, consistent backups and health reporting."""

import argparse
from contextlib import closing
import datetime as dt
import json
import logging.handlers
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import urllib.request
from urllib.parse import urlsplit

CONFIG_NAME = "deployment.json"
DEFAULT_RETENTION = {"daily": 7, "weekly": 4, "monthly": 3}


def validate_config(value):
    """Reject ambiguous endpoints, unsafe path names and accidental port sharing."""
    if not isinstance(value, dict) or set(value) - {"version", "profiles", "retention"}:
        raise ValueError("Configuration must contain version, profiles and optional retention")
    if type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError("Unsupported deployment configuration version; expected 1")
    profiles = value.get("profiles")
    if not isinstance(profiles, dict) or not profiles:
        raise ValueError("Configure at least one independent profile")
    ports, endpoints = set(), set()
    normalized = {}
    for name, profile in profiles.items():
        if not isinstance(name, str) or len(name) > 48 or not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", name):
            raise ValueError("Profile identifiers must use lowercase letters, digits and hyphens")
        if not isinstance(profile, dict) or set(profile) != {"port", "server_url", "device_name", "backup_time"}:
            raise ValueError(f"{name}: provide port, server_url, device_name and backup_time")
        port = profile["port"]
        if type(port) is not int or not 1024 <= port <= 65535 or port in ports:
            raise ValueError(f"{name}: choose a unique loopback port from 1024 to 65535")
        ports.add(port)
        device_name = profile["device_name"]
        if not isinstance(device_name, str) or not device_name.strip() or len(device_name.strip().encode("utf-8")) > 100 or any(ord(c) < 32 for c in device_name):
            raise ValueError(f"{name}: device_name must be printable and fit within 100 UTF-8 bytes")
        schedule = profile["backup_time"]
        if not isinstance(schedule, str) or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", schedule):
            raise ValueError(f"{name}: backup_time must be local HH:MM")
        server_url = profile["server_url"]
        if not isinstance(server_url, str) or any(c.isspace() for c in server_url):
            raise ValueError(f"{name}: provide an HTTPS tailnet origin or loopback HTTP origin")
        endpoint = urlsplit(server_url)
        try:
            endpoint_port = endpoint.port
        except ValueError as error:
            raise ValueError(f"{name}: invalid endpoint port") from error
        if endpoint.username or endpoint.password or endpoint.path not in ("", "/") or endpoint.query or endpoint.fragment:
            raise ValueError(f"{name}: server_url must be an origin without credentials, path, query or fragment")
        host = endpoint.hostname or ""
        if endpoint.scheme == "https" and host.endswith(".ts.net"):
            endpoint_port = 443 if endpoint_port is None else endpoint_port
        elif endpoint.scheme == "http" and host in ("127.0.0.1", "localhost"):
            endpoint_port = 80 if endpoint_port is None else endpoint_port
            if endpoint_port != port:
                raise ValueError(f"{name}: a loopback server_url must use the configured relay port")
        else:
            raise ValueError(f"{name}: use HTTPS on a .ts.net host or HTTP on loopback")
        if not 1 <= endpoint_port <= 65535:
            raise ValueError(f"{name}: invalid endpoint port")
        identity = (endpoint.scheme, host, endpoint_port)
        if identity in endpoints:
            raise ValueError(f"{name}: independent profiles must use different relay endpoints")
        endpoints.add(identity)
        normalized[name] = {**profile, "device_name": device_name.strip(), "server_url": server_url.rstrip("/")}
    retention = value.get("retention", DEFAULT_RETENTION)
    if not isinstance(retention, dict) or set(retention) != set(DEFAULT_RETENTION) or any(type(n) is not int or not 1 <= n <= 1000 for n in retention.values()):
        raise ValueError("retention must provide daily, weekly and monthly counts from 1 to 1000")
    return {"version": 1, "profiles": normalized, "retention": dict(retention)}


def load_config(root):
    path = root / CONFIG_NAME
    if not path.is_file():
        raise ValueError(f"Missing {path}; install with an explicit deployment configuration")
    return validate_config(json.loads(path.read_text()))


def configured_profile(root, account):
    config = load_config(root)
    if account not in config["profiles"]:
        raise ValueError(f"Unknown profile: {account}")
    return config, config["profiles"][account]


def save_json(path, value):
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(path)


def integrity(path):
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        result = db.execute("PRAGMA integrity_check").fetchall()
    if result != [("ok",)]:
        raise RuntimeError("Backup integrity check failed")


def rotate(directory, kind, keep):
    # Only our verified, fixed-format snapshots are eligible for rotation.
    candidates = sorted(directory.glob(f"{kind}-????-??-??.sqlite"), reverse=True)
    for path in candidates[keep:]:
        path.unlink()


def backup(root, account, today=None):
    config, _ = configured_profile(root, account)
    today = today or dt.datetime.now().astimezone().date()
    directory = root / "accounts" / account / "backups"
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    snapshot = directory / f"daily-{today.isoformat()}.sqlite"
    if not snapshot.exists():
        subprocess.run(
            [str(root / "bin" / "synk-server"), "--database",
             str(root / "accounts" / account / "relay.sqlite"), "backup", "--output", str(snapshot)],
            check=True, stdout=subprocess.DEVNULL,
        )
    integrity(snapshot)
    # One independent consistent snapshot per calendar week/month, including a missed scheduled day.
    for kind, key in [("weekly", today.isocalendar()[:2]), ("monthly", (today.year, today.month))]:
        existing = []
        for path in directory.glob(f"{kind}-????-??-??.sqlite"):
            day = dt.date.fromisoformat(path.stem.split("-", 1)[1])
            period = day.isocalendar()[:2] if kind == "weekly" else (day.year, day.month)
            if period == key:
                existing.append(path)
        if not existing:
            destination = directory / f"{kind}-{today.isoformat()}.sqlite"
            temporary = destination.with_suffix(".tmp")
            shutil.copyfile(snapshot, temporary)
            temporary.chmod(0o600)
            integrity(temporary)
            temporary.replace(destination)
    for kind, keep in config["retention"].items():
        rotate(directory, kind, keep)
    save_json(root / "accounts" / account / "backup-status.json", {
        "ok": True, "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "snapshot": snapshot.name,
        "snapshot_modified_at": dt.datetime.fromtimestamp(snapshot.stat().st_mtime, dt.timezone.utc).isoformat(),
    })


def monitor(root, account):
    _, profile = configured_profile(root, account)
    account_dir = root / "accounts" / account
    problems = []
    status = {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{profile['port']}/health/ready", timeout=5) as response:
            status["readiness"] = json.load(response)
    except Exception as error:
        problems.append(f"Readiness unavailable: {type(error).__name__}")
    status["free_bytes"] = shutil.disk_usage(root).free
    if status["free_bytes"] < 2 * 1024**3:
        problems.append("Less than 2 GiB free disk")
    status["database_bytes"] = sum(
        path.stat().st_size for path in account_dir.glob("relay.sqlite*") if path.is_file()
    )
    try:
        with closing(sqlite3.connect((account_dir / "relay.sqlite").as_uri() + "?mode=ro", uri=True)) as db:
            row = db.execute("SELECT journal_bytes, max_journal_bytes, journal_operations, max_operations FROM settings WHERE id=1").fetchone()
            status["journal_bytes"], status["journal_byte_limit"], status["operations"], status["operation_limit"] = row
            status["unprocessed_deliveries"] = db.execute(
                "SELECT COALESCE(SUM(MAX(sent_cursor-processed_cursor,0)),0) FROM devices WHERE revoked=0"
            ).fetchone()[0]
            if row[0] >= row[1] * 0.8 or row[2] >= row[3] * 0.8:
                problems.append("Relay journal exceeds 80% of its configured budget")
    except Exception as error:
        problems.append(f"Database monitoring unavailable: {type(error).__name__}")
    backup_status = account_dir / "backup-status.json"
    try:
        saved = json.loads(backup_status.read_text())
        age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(saved.get("snapshot_modified_at", saved["checked_at"]))
        status["backup_age_hours"] = round(age.total_seconds() / 3600, 2)
        if not saved["ok"] or age > dt.timedelta(hours=30):
            problems.append("Backup failed or is older than 30 hours")
    except (OSError, ValueError, KeyError):
        problems.append("No successful backup status")
    status["problems"] = problems
    status["ok"] = not problems
    save_json(account_dir / "health-status.json", status)
    return status["ok"]


def serve(root, account):
    _, profile = configured_profile(root, account)
    logger = logging.getLogger(account)
    logger.setLevel(logging.INFO)
    logger.addHandler(logging.handlers.RotatingFileHandler(
        root / "logs" / f"{account}.log", maxBytes=5 * 1024**2, backupCount=3,
    ))
    child = subprocess.Popen(
        [str(root / "bin" / "synk-server"), "--database",
         str(root / "accounts" / account / "relay.sqlite"), "serve", "--port", str(profile["port"])],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env={**os.environ, "RUST_LOG": "info"},
    )
    def stop(_signal, _frame):
        if child.poll() is None:
            child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        while chunk := child.stdout.readline(65536):
            logger.info(chunk.decode("utf-8", errors="replace").rstrip())
    finally:
        stop(None, None)
        try:
            child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
    return child.returncode


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("command", choices=["serve", "backup", "monitor"])
    parser.add_argument("account", help="Profile identifier from deployment.json")
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    try:
        configured_profile(root, args.account)
    except (ValueError, OSError) as error:
        parser.error(str(error))
    if args.command == "serve":
        return serve(root, args.account)
    if args.command == "monitor":
        return 0 if monitor(root, args.account) else 1
    try:
        backup(root, args.account)
        return 0
    except Exception as error:
        save_json(root / "accounts" / args.account / "backup-status.json", {
            "ok": False, "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "error": type(error).__name__,
        })
        print(f"{args.account}: backup failed ({type(error).__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
