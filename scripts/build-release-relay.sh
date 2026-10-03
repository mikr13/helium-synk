#!/bin/sh
# Ship a patched SQLite inside the relay instead of relying on the host's SQLite.
set -eu
cd "$(dirname "$0")/.."
synk_sqlite_dir="$PWD/target/release-deps/sqlite-3.53.4"
mkdir -p "$synk_sqlite_dir"
if [ "$(uname -s)" = Darwin ]; then
  export MACOSX_DEPLOYMENT_TARGET=13.0
fi
curl --fail --location --retry 3 --proto '=https' --tlsv1.2 \
  https://sqlite.org/2026/sqlite-amalgamation-3530400.zip \
  --output "$synk_sqlite_dir/source.zip"
python3 - "$synk_sqlite_dir" <<'PY'
import hashlib
import sys
import zipfile
from pathlib import Path

directory = Path(sys.argv[1])
archive = directory / "source.zip"
expected = "628a44cfe82c66aed1ccbbe85a562d2e33ebe64b3288981ed76285612227934e"
if hashlib.sha3_256(archive.read_bytes()).hexdigest() != expected:
    raise SystemExit("SQLite source checksum mismatch")
with zipfile.ZipFile(archive) as source:
    for name in ("sqlite3.c", "sqlite3.h"):
        (directory / name).write_bytes(source.read("sqlite-amalgamation-3530400/" + name))
PY
cc -O2 -fPIC -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_COLUMN_METADATA \
  -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_RTREE -DSQLITE_ENABLE_UNLOCK_NOTIFY \
  -c "$synk_sqlite_dir/sqlite3.c" -o "$synk_sqlite_dir/sqlite3.o"
ar rcs "$synk_sqlite_dir/libsqlite3.a" "$synk_sqlite_dir/sqlite3.o"
export SQLITE3_LIB_DIR="$synk_sqlite_dir"
export SQLITE3_INCLUDE_DIR="$synk_sqlite_dir"
export SQLITE3_STATIC=1
# libsqlite3-sys otherwise probes the system pkg-config even with an explicit library directory.
export SQLITE3_NO_PKG_CONFIG=1
./scripts/cargo.sh build --release --locked
./scripts/cargo.sh test --release --locked --workspace
python3 scripts/smoke-release-relay.py target/release/synk-server
