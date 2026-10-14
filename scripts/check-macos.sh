#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 scripts/verify-macos-design.py
export CLANG_MODULE_CACHE_PATH="$PWD/target/swift-module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$PWD/target/swift-module-cache"
# --disable-sandbox avoids nesting SwiftPM's sandbox inside the agent's filesystem sandbox.
exec xcrun swift test --disable-sandbox --package-path macos --scratch-path target/swift
