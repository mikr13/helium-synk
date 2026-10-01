#!/bin/sh
set -eu
# SQLx 0.8's bundled SQLite predates the WAL-reset fix. Prefer patched Homebrew SQLite on macOS.
if [ "$(uname -s)" = Darwin ] && [ -z "${SQLITE3_LIB_DIR:-}" ]; then
  synk_sqlite_prefix=$(brew --prefix sqlite)
  export SQLITE3_LIB_DIR="$synk_sqlite_prefix/lib"
  export SQLITE3_INCLUDE_DIR="$synk_sqlite_prefix/include"
fi
exec cargo "$@"
