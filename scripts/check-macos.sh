#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
python3 scripts/verify-macos-design.py
python3 scripts/build-macos-app.test.py
python3 scripts/macos-update.test.py
if [ -z "${SYNK_TEST_RELAY:-}" ]; then
  ./scripts/cargo.sh build --locked
  export SYNK_TEST_RELAY="$PWD/target/debug/synk-server"
fi
export CLANG_MODULE_CACHE_PATH="$PWD/target/swift-module-cache"
export SWIFTPM_MODULECACHE_OVERRIDE="$PWD/target/swift-module-cache"
# --disable-sandbox avoids nesting SwiftPM's sandbox inside the agent's filesystem sandbox.
exec xcrun swift test --disable-sandbox --package-path macos --scratch-path target/swift
