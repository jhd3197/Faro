"""Run provider mocks and HTTP/WebDAV fixtures without cloud accounts.

Requires wsgidav and cheroot in the invoking Python environment, plus cargo.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time

root = Path(__file__).resolve().parents[1]
cases = [
    ("dropbox", "FARO_DROPBOX_MOCK_URL", ["live_dropbox_roundtrip"]),
    ("onedrive", "FARO_ONEDRIVE_MOCK_URL", ["live_onedrive_roundtrip"]),
    ("box", "FARO_BOX_MOCK_URL", ["live_box_roundtrip"]),
    ("shopify", "FARO_SHOPIFY_MOCK_URL", ["live_shopify_roundtrip"]),
    ("hubspot", "FARO_HUBSPOT_MOCK_URL", ["live_hubspot_roundtrip", "hubspot_missing_scope_degrades"]),
    ("dynamics", "FARO_DYNAMICS_MOCK_URL", ["live_dynamics_roundtrip"]),
    ("http", "FARO_HTTP_URL", ["live_http_source"]),
    ("webdav", "FARO_WEBDAV_URL", ["live_webdav_roundtrip"]),
]
results = []
with tempfile.TemporaryDirectory(prefix="faro-cloud-mocks-") as scratch:
    for provider, variable, tests in cases:
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = dict(os.environ, FARO_DATA_DIR=scratch)
        env[variable] = f"http://127.0.0.1:{port}"
        fixture = Path(scratch) / provider
        fixture.mkdir()
        if provider == "http":
            (fixture / "hello.txt").write_text("Faro HTTP fixture", encoding="utf-8")
            command = [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1", "--directory", str(fixture)]
        elif provider == "webdav":
            executable = Path(sys.executable).with_name("wsgidav.exe" if os.name == "nt" else "wsgidav")
            command = [str(executable), "--port", str(port), "--host", "127.0.0.1", "--root", str(fixture),
                       "--auth", "anonymous", "--server", "cheroot", "--no-config", "--quiet"]
            env.pop("FARO_WEBDAV_USER", None)
            env.pop("FARO_WEBDAV_PASS", None)
        else:
            command = [sys.executable, str(root / f"src-tauri/tests/{provider}_mock.py"), str(port)]
        process = subprocess.Popen(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                   creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            for _ in range(80):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        break
                except OSError:
                    if process.poll() is not None:
                        raise RuntimeError(f"{provider} mock exited")
                    time.sleep(0.1)
            else:
                raise RuntimeError(f"{provider} mock startup timed out")
            for test in tests:
                p = subprocess.run(["cargo", "test", "--manifest-path", str(root / "src-tauri/Cargo.toml"), "-p", "faro", "--lib",
                                    test, "--", "--ignored", "--nocapture"], env=env, capture_output=True, encoding="utf-8", errors="replace", timeout=300)
                ok = p.returncode == 0 and "1 passed; 0 failed" in p.stdout and "skip:" not in p.stderr
                results.append(dict(test=test, passed=ok, stdout=p.stdout, stderr=p.stderr))
                print(f"{'PASS' if ok else 'FAIL'} {test}", flush=True)
                if not ok:
                    print((p.stdout + p.stderr)[-4000:], flush=True)
        finally:
            process.terminate()
            process.wait(timeout=10)
report = root / "src-tauri/target/cloud-mock-audit.json"
report.write_text(json.dumps(results, indent=2), encoding="utf-8")
failed = sum(not r["passed"] for r in results)
print(f"{len(results)-failed} passed, {failed} failed")
raise SystemExit(bool(failed))
