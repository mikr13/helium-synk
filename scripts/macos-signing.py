#!/usr/bin/env python3
"""Provision an ephemeral CI signing keychain; never print or commit credential material."""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys


def run(*args):
    result = subprocess.run(args, capture_output=True)
    if result.returncode:
        raise SystemExit(f"Signing setup failed at {args[0]}. Check the release secrets.")
    return result.stdout.decode().strip()


root = Path(os.environ["RUNNER_TEMP"]) / "helium-synk-signing"
keychain = root / "release.keychain-db"
if sys.argv[1:] == ["cleanup"]:
    if (root / "original-keychains.json").exists():
        original = json.loads((root / "original-keychains.json").read_text())
        subprocess.run(["security", "list-keychains", "-d", "user", "-s", *original], capture_output=True)
    if keychain.exists():
        subprocess.run(["security", "delete-keychain", str(keychain)], capture_output=True)
    import shutil
    shutil.rmtree(root, ignore_errors=True)
    sys.exit(0)
required = ["APPLE_SIGNING_CERTIFICATE", "APPLE_SIGNING_PASSWORD", "APPLE_TEAM_ID", "APPLE_NOTARY_KEY_ID", "APPLE_NOTARY_ISSUER_ID", "APPLE_NOTARY_PRIVATE_KEY"]
missing = [name for name in required if not os.environ.get(name)]
if missing:
    raise SystemExit("Configure macOS release secrets: " + ", ".join(missing))
os.umask(0o077)
root.mkdir(mode=0o700, exist_ok=False)
certificate = root / "certificate.p12"
certificate.write_bytes(base64.b64decode(os.environ["APPLE_SIGNING_CERTIFICATE"], validate=True))
password = secrets.token_hex(24)
run("security", "create-keychain", "-p", password, str(keychain))
run("security", "set-keychain-settings", "-lut", "21600", str(keychain))
run("security", "unlock-keychain", "-p", password, str(keychain))
run("security", "import", str(certificate), "-k", str(keychain), "-P", os.environ["APPLE_SIGNING_PASSWORD"], "-T", "/usr/bin/codesign")
run("security", "set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, str(keychain))
# Preserve the runner's existing search list, adding only this ephemeral keychain.
import shlex
original = shlex.split(run("security", "list-keychains", "-d", "user"))
(root / "original-keychains.json").write_text(json.dumps(original))
run("security", "list-keychains", "-d", "user", "-s", str(keychain), *original)
identities = run("security", "find-identity", "-v", "-p", "codesigning", str(keychain))
import re
matches = re.findall(r'([A-Fa-f0-9]{40}) "Developer ID Application: [^"\n]+ \(' + re.escape(os.environ["APPLE_TEAM_ID"]) + r'\)"', identities)
if len(matches) != 1:
    raise SystemExit("Import exactly one valid Developer ID Application identity for APPLE_TEAM_ID.")
key = root / "notary.p8"
key.write_text(os.environ["APPLE_NOTARY_PRIVATE_KEY"])
run("xcrun", "notarytool", "store-credentials", "synk-release", "--key", str(key), "--key-id", os.environ["APPLE_NOTARY_KEY_ID"], "--issuer", os.environ["APPLE_NOTARY_ISSUER_ID"], "--keychain", str(keychain))
certificate.unlink(); key.unlink()
with open(os.environ["GITHUB_ENV"], "a") as environment:
    environment.write(f"SYNK_SIGNING_IDENTITY={matches[0]}\nSYNK_SIGNING_KEYCHAIN={keychain}\nSYNK_NOTARY_PROFILE=synk-release\n")
print("Temporary signing identity and notarization profile ready.")
