"""Check the downloaded relay's SQLite, readiness, SIGTERM and database reopening."""

import json
import platform
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

binary = Path(sys.argv[1]).resolve()
expected_version = json.loads(
    (Path(__file__).resolve().parent.parent / "server/package.json").read_text()
)["version"]
link_command = ["otool", "-L"] if platform.system() == "Darwin" else ["ldd"]
links = subprocess.check_output([*link_command, str(binary)], text=True)
if "libsqlite3" in links.lower():
    raise SystemExit("Release relay still depends on a host SQLite library")

with tempfile.TemporaryDirectory(prefix="synk-release-smoke-") as directory:
    database = Path(directory) / "relay.sqlite"
    original_epoch = None
    for attempt in range(2):
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        with (Path(directory) / "relay.log").open("w+") as log:
            process = subprocess.Popen(
                [str(binary), "--database", str(database), "serve", "--port", str(port)],
                stdout=log, stderr=log,
            )
            try:
                deadline = time.monotonic() + 15
                while True:
                    if process.poll() is not None:
                        log.seek(0)
                        raise RuntimeError("Relay exited before readiness: " + log.read())
                    try:
                        with urllib.request.urlopen(
                            f"http://127.0.0.1:{port}/health/ready", timeout=1
                        ) as response:
                            ready = json.load(response)
                        break
                    except (OSError, urllib.error.URLError):
                        if time.monotonic() >= deadline:
                            raise RuntimeError("Relay readiness timed out")
                        time.sleep(0.1)
                if (ready["sqlite_version"] != "3.53.4" or ready["status"] != "ready"
                        or ready["package_version"] != expected_version):
                    raise RuntimeError("Unexpected release SQLite/readiness: " + repr(ready))
                if original_epoch is not None and ready["server_epoch"] != original_epoch:
                    raise RuntimeError("Relay epoch changed after ordinary reopening")
                original_epoch = ready["server_epoch"]
            finally:
                process.terminate()
                try:
                    result = process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
                    raise RuntimeError("Relay did not stop after SIGTERM")
                if result != 0:
                    raise RuntimeError(f"Relay shutdown returned {result}")
print("Release relay: static SQLite 3.53.4, readiness, SIGTERM and reopen passed.")
