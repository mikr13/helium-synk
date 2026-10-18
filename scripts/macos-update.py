#!/usr/bin/env python3
"""Generate a signed Sparkle feed from the final notarized DMG; verify release bindings."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
SPARKLE = "{http://www.andymatuschak.org/xml-namespaces/sparkle}"
FEED = "https://github.com/mikr13/helium-synk/releases/latest/download/appcast.xml"
ACCOUNT = "com.heliumsynk.server.updates"


def verify(feed, directory, version, source_sha, allow_dirty=False):
    item = ET.parse(feed).getroot().find("./channel/item")
    if item is None or item.findtext(SPARKLE + "version") != version:
        raise ValueError("Update feed version does not match the release")
    enclosure = item.find("enclosure")
    name = f"helium-synk-server-{version}-darwin-arm64.dmg"
    payload = directory / name
    if enclosure is None or enclosure.get("url") != f"https://github.com/mikr13/helium-synk/releases/download/v{version}/{name}":
        raise ValueError("Update feed does not point to this release's Apple silicon DMG")
    if enclosure.get("length") != str(payload.stat().st_size):
        raise ValueError("Update feed payload length does not match")
    proof = json.loads((directory / f"helium-synk-server-{version}-darwin-arm64-build.json").read_text())
    if proof["source_commit"] != source_sha or not proof["signed"] or not proof["notarized"] or (proof["uncommitted_changes"] and not allow_dirty):
        raise ValueError("Update payload is not from the signed notarized release source")
    if proof["sha256"] != hashlib.sha256(payload.read_bytes()).hexdigest():
        raise ValueError("Update payload checksum does not match")
    public_key = (ROOT / "macos/update-public-key.txt").read_text().strip()
    if len(base64.b64decode(public_key, validate=True)) != 32:
        raise ValueError("Invalid update public key")
    # Node supports Ed25519 on both release platforms; trust the key in checked source,
    # never a public key supplied alongside an untrusted payload.
    code = """import {readFileSync} from 'node:fs';
import {createPublicKey,verify} from 'node:crypto';
const [path,signature,raw,length]=process.argv.slice(1);
const key=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(raw,'base64')]),format:'der',type:'spki'});
if(!verify(null,readFileSync(path).subarray(0,Number(length)),key,Buffer.from(signature,'base64'))) process.exit(1);"""
    result = subprocess.run(["node", "--input-type=module", "-e", code, str(payload), enclosure.get(SPARKLE + "edSignature", ""), public_key, str(payload.stat().st_size)], capture_output=True)
    if result.returncode:
        raise ValueError("Update payload signature does not match the key embedded in the app")
    feed_bytes = Path(feed).read_bytes()
    marker = b"<!-- sparkle-signatures:\n"
    if marker not in feed_bytes:
        raise ValueError("Update feed is unsigned")
    content, block = feed_bytes.rsplit(marker, 1)
    signing, suffix = block.split(b"-->", 1)
    if suffix.strip():
        raise ValueError("Unexpected content after the signed feed")
    fields = dict(line.decode().split(":", 1) for line in signing.splitlines() if b":" in line)
    if int(fields.get("length", "-1").strip()) != len(content):
        raise ValueError("Signed feed content length does not match")
    result = subprocess.run(["node", "--input-type=module", "-e", code, str(feed), fields.get("edSignature", "").strip(), public_key, str(len(content))], capture_output=True)
    if result.returncode:
        raise ValueError("Update feed signature does not match the app's public key")
    print("Sparkle payload: exact release URL, source, version, checksum and Ed25519 signature verified.")


def generate(args):
    with (args.app / "Contents/Info.plist").open("rb") as source:
        info = plistlib.load(source)
    version = info["CFBundleVersion"]
    public_key = (ROOT / "macos/update-public-key.txt").read_text().strip()
    if info.get("SUPublicEDKey") != public_key or info.get("SUFeedURL") != FEED:
        raise ValueError("Built app updater configuration does not match checked source")
    if not info.get("SURequireSignedFeed") or not info.get("SUVerifyUpdateBeforeExtraction"):
        raise ValueError("Signed update verification must be enabled")
    if info.get("SUAllowsAutomaticUpdates") is not False:
        raise ValueError("Uncoordinated automatic installation must be disabled")
    tools = ROOT / "target/swift/artifacts/sparkle/Sparkle/bin"
    secret = os.environ.get("SPARKLE_ED_PRIVATE_KEY")
    if os.environ.get("GITHUB_ACTIONS") == "true" and not secret:
        raise ValueError("Configure the Helium SPARKLE_ED_PRIVATE_KEY Actions secret")
    signing = ["--ed-key-file", "-"] if secret else ["--account", ACCOUNT]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="synk-appcast-", dir=args.output.parent) as temporary:
        stage = Path(temporary)
        shutil.copyfile(args.dmg, stage / args.dmg.name)
        command = [str(tools / "generate_appcast"), *signing,
                   "--download-url-prefix", f"https://github.com/mikr13/helium-synk/releases/download/v{version}/",
                   "--full-release-notes-url", f"https://github.com/mikr13/helium-synk/releases/tag/v{version}",
                   "--maximum-deltas", "0", "--maximum-versions", "1", "--disable-signing-warning", str(stage)]
        result = subprocess.run(command, input=secret, capture_output=True, text=True, timeout=180)
        if result.returncode:
            raise ValueError("Sparkle feed signing failed. Check the Helium update key and the signed app bundle.")
        feed = stage / "appcast.xml"
        if not feed.is_file():
            raise ValueError("Sparkle did not produce appcast.xml")
        # Verify using the key embedded in this app, independently of the private signing key.
        item = ET.parse(feed).getroot().find("./channel/item")
        signature = item.find("enclosure").get(SPARKLE + "edSignature")
        subprocess.run(["xcrun", "swift", str(ROOT / "scripts/verify-update-signature.swift"), str(args.dmg), signature, public_key], check=True, timeout=60)
        shutil.copyfile(feed, args.output)
    proof = json.loads((args.dmg.parent / f"helium-synk-server-{version}-darwin-arm64-build.json").read_text())
    verify(args.output, args.dmg.parent, version, proof["source_commit"], allow_dirty=os.environ.get("GITHUB_ACTIONS") != "true")
    print("Signed update feed:", args.output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path)
    parser.add_argument("--dmg", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify", type=Path)
    parser.add_argument("--version")
    parser.add_argument("--source-sha")
    args = parser.parse_args()
    try:
        if args.verify:
            verify(args.verify / "appcast.xml", args.verify, args.version, args.source_sha)
        else:
            generate(args)
    except (OSError, ET.ParseError, ValueError, KeyError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise SystemExit(str(error))
