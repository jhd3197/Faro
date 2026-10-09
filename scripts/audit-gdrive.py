"""Run Drive transfer and CLI tests using the local HTTP mock and synthetic tokens."""
from pathlib import Path
import os
import socket
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[1]
with socket.socket() as s:
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
server = subprocess.Popen([sys.executable, str(root / "src-tauri/tests/gdrive_mock.py"), str(port)],
                          creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
try:
    for _ in range(80):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                break
        except OSError:
            if server.poll() is not None:
                raise RuntimeError("Drive mock exited")
            time.sleep(0.1)
    else:
        raise RuntimeError("Drive mock did not start")
    endpoint = f"http://127.0.0.1:{port}"
    env = dict(os.environ, FARO_GDRIVE_MOCK_URL=endpoint, FARO_GDRIVE_API_BASE=endpoint, FARO_GDRIVE_UPLOAD_BASE=endpoint)
    result = subprocess.run(["cargo", "test", "--manifest-path", str(root / "src-tauri/Cargo.toml"), "-p", "faro", "--lib",
                             "live_gdrive_", "--", "--ignored", "--nocapture", "--test-threads", "1"], env=env, timeout=600)
finally:
    server.terminate()
    server.wait(timeout=10)
raise SystemExit(result.returncode)
