#!/usr/bin/env python3
"""Private per-user relay supervision, consistent backups and health reporting."""

import argparse
from contextlib import closing
import datetime as dt
import json
import logging.handlers
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import urllib.request

ACCOUNTS = {"abi": 4318, "syngenta": 4319}
KEEP = {"daily": 7, "weekly": 4, "monthly": 3}


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


def rotate(directory, kind):
    # Only our verified, fixed-format snapshots are eligible for rotation.
    candidates = sorted(directory.glob(f"{kind}-????-??-??.sqlite"), reverse=True)
    for path in candidates[KEEP[kind]:]:
        path.unlink()


def backup(root, account, today=None):
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
    for kind in KEEP:
        rotate(directory, kind)
    save_json(root / "accounts" / account / "backup-status.json", {
        "ok": True, "checked_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "snapshot": snapshot.name,
        "snapshot_modified_at": dt.datetime.fromtimestamp(snapshot.stat().st_mtime, dt.timezone.utc).isoformat(),
    })


def monitor(root, account):
    account_dir = root / "accounts" / account
    problems = []
    status = {"checked_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{ACCOUNTS[account]}/health/ready", timeout=5) as response:
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
    logger = logging.getLogger(account)
    logger.setLevel(logging.INFO)
    logger.addHandler(logging.handlers.RotatingFileHandler(
        root / "logs" / f"{account}.log", maxBytes=5 * 1024**2, backupCount=3,
    ))
    child = subprocess.Popen(
        [str(root / "bin" / "synk-server"), "--database",
         str(root / "accounts" / account / "relay.sqlite"), "serve", "--port", str(ACCOUNTS[account])],
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
    parser.add_argument("account", choices=list(ACCOUNTS))
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
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
