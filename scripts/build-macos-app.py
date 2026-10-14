#!/usr/bin/env python3
"""Build a self-contained native app. Signing/notarization are explicit release gates."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parent.parent
APP_NAME = "Helium Synk Server"
BUNDLE_ID = "com.heliumsynk.server"


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def sign(path, identity, keychain=None):
    args = ["/usr/bin/codesign", "--force", "--timestamp", "--options", "runtime", "--sign", identity]
    if keychain:
        args += ["--keychain", keychain]
    run(*args, path, timeout=45)
    run("/usr/bin/codesign", "--verify", "--strict", "--verbose=2", path)


def build(args):
    if platform.system() != "Darwin":
        raise SystemExit("Build the Mac app on macOS.")
    if args.notarize and (not args.identity or args.identity == "-" or not args.notary_profile):
        raise SystemExit("Notarization needs Developer ID signing and --notary-profile.")
    version = json.loads((ROOT / "server/package.json").read_text())["version"]
    architecture = {"arm64": "arm64", "x86_64": "x64"}[platform.machine()]
    relay = Path(args.relay).resolve()
    if not relay.is_file():
        raise SystemExit("Build the release relay first: sh scripts/build-release-relay.sh")
    libraries = subprocess.check_output(["otool", "-L", str(relay)], text=True)
    if any("/opt/" in line or "/usr/local/" in line or "libsqlite" in line for line in libraries.splitlines()[1:]):
        raise SystemExit("The distributed relay must contain static SQLite and no Homebrew libraries.")
    actual_arch = subprocess.check_output(["lipo", "-archs", str(relay)], text=True).strip()
    if actual_arch != platform.machine():
        raise SystemExit("Relay architecture must match the native app build.")
    env = {**os.environ, "CLANG_MODULE_CACHE_PATH": str(ROOT / "target/swift-module-cache"), "SWIFTPM_MODULECACHE_OVERRIDE": str(ROOT / "target/swift-module-cache")}
    swift = ["xcrun", "swift", "build", "--disable-sandbox", "--package-path", str(ROOT / "macos"), "--scratch-path", str(ROOT / "target/swift"), "--configuration", "release"]
    run(*swift, env=env)
    binaries = Path(subprocess.check_output(swift + ["--show-bin-path"], env=env, text=True).strip())
    output = ROOT / "release" / f"macos-{architecture}"
    output.mkdir(parents=True, exist_ok=True)
    app = output / f"{APP_NAME}.app"
    if app.exists():
        shutil.rmtree(app)
    contents = app / "Contents"
    macos = contents / "MacOS"
    resources = contents / "Resources"
    agents = contents / "Library/LaunchAgents"
    for directory in (macos, resources, agents):
        directory.mkdir(parents=True)
    # Sign the raw relay before existing packaging computes its metadata/checksums.
    if args.identity:
        sign(relay, args.identity, args.keychain)
    for name, source in [("HeliumSynkServer", binaries / "HeliumSynkServer"), ("synk-agent", binaries / "synk-agent"), ("synk-server", relay)]:
        shutil.copyfile(source, macos / name)
        (macos / name).chmod(0o755)
    for source in (ROOT / "macos/Resources").iterdir():
        shutil.copyfile(source, resources / source.name)
    # Start every app-icon representation from the original artwork, never an upscaled toolbar PNG.
    shutil.copyfile(ROOT / "assets/branding/helium-synk-master.png", resources / "Synk.png")
    iconset = output / "Synk.iconset"
    iconset.mkdir(exist_ok=True)
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            run("sips", "-z", size * scale, size * scale, resources / "Synk.png", "--out", iconset / f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png", stdout=subprocess.DEVNULL)
    run("iconutil", "-c", "icns", iconset, "-o", resources / "Synk.icns")
    shutil.rmtree(iconset)
    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": BUNDLE_ID, "CFBundleName": APP_NAME, "CFBundleDisplayName": APP_NAME,
        "CFBundleExecutable": "HeliumSynkServer", "CFBundlePackageType": "APPL", "CFBundleIconFile": "Synk.icns",
        "CFBundleShortVersionString": version, "CFBundleVersion": version, "LSMinimumSystemVersion": "13.0",
        "NSHighResolutionCapable": True, "NSHumanReadableCopyright": "Helium Synk contributors",
    }))
    (agents / f"{BUNDLE_ID}.agent.plist").write_bytes(plistlib.dumps({
        "Label": f"{BUNDLE_ID}.agent", "BundleProgram": "Contents/MacOS/synk-agent",
        "ProgramArguments": ["synk-agent"], "RunAtLoad": True, "KeepAlive": True,
        "ThrottleInterval": 15, "ExitTimeOut": 30, "Umask": 0o077,
        "StandardOutPath": "/dev/null", "StandardErrorPath": "/dev/null",
        "AssociatedBundleIdentifiers": [BUNDLE_ID],
    }))
    if args.identity:
        for name in ("HeliumSynkServer", "synk-agent"):
            sign(macos / name, args.identity, args.keychain)
        sign(app, args.identity, args.keychain)
        run("codesign", "--verify", "--deep", "--strict", app)
    if args.notarize:
        archive = output / "notarization.zip"
        run("ditto", "-c", "-k", "--keepParent", app, archive)
        notarize(archive, args, output / "app-notary-result.json")
        run("xcrun", "stapler", "staple", app)
        run("xcrun", "stapler", "validate", app)
        archive.unlink()
    dmg = ROOT / "release" / f"helium-synk-server-{version}-darwin-{architecture}.dmg"
    dmg.unlink(missing_ok=True)
    with tempfile.TemporaryDirectory(prefix="synk-dmg-", dir=output) as stage:
        shutil.copytree(app, Path(stage) / app.name)
        (Path(stage) / "Applications").symlink_to("/Applications")
        run("hdiutil", "create", "-volname", APP_NAME, "-srcfolder", stage, "-format", "UDZO", dmg, stdout=subprocess.DEVNULL)
    if args.identity:
        sign(dmg, args.identity, args.keychain)
    if args.notarize:
        notarize(dmg, args, output / "dmg-notary-result.json")
        run("xcrun", "stapler", "staple", dmg)
        run("xcrun", "stapler", "validate", dmg)
        run("spctl", "--assess", "--type", "execute", "--verbose=2", app)
    # Digests always describe the final signed/stapled bytes.
    metadata = {
        "version": version, "target": f"darwin-{architecture}",
        "source_commit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "uncommitted_changes": bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=ROOT, text=True).strip()),
        "signed": bool(args.identity and args.identity != "-"), "notarized": args.notarize,
        "artifact": dmg.name, "sha256": hashlib.sha256(dmg.read_bytes()).hexdigest(),
    }
    (ROOT / "release" / f"helium-synk-server-{version}-darwin-{architecture}-build.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"App: {app}\nDMG: {dmg}\nSigned: {metadata['signed']}; notarized: {metadata['notarized']}")


def notarize(path, args, result_path):
    command = ["xcrun", "notarytool", "submit", str(path), "--keychain-profile", args.notary_profile, "--wait", "--timeout", "20m", "--output-format", "json"]
    if args.keychain:
        command += ["--keychain", args.keychain]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode:
        raise SystemExit("Notarization failed. Check the configured credential profile and Apple service status.")
    value = json.loads(result.stdout)
    result_path.write_text(json.dumps(value, indent=2) + "\n")
    if value.get("status") != "Accepted":
        raise SystemExit(f"Notarization was not accepted. Review submission {value.get('id', '')}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--relay", default=ROOT / "target/release/synk-server")
    parser.add_argument("--identity", default=os.environ.get("SYNK_SIGNING_IDENTITY"))
    parser.add_argument("--keychain", default=os.environ.get("SYNK_SIGNING_KEYCHAIN"))
    parser.add_argument("--notary-profile", default=os.environ.get("SYNK_NOTARY_PROFILE"))
    parser.add_argument("--notarize", action="store_true")
    build(parser.parse_args())
