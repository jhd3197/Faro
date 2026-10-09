"""Run Azure CLI regressions against a disposable local Azurite instance.

Install azurite under src-tauri/target/azure-lab and azure-storage-blob in the
test Python environment. Build faro-cli first. No cloud credentials are used.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time

from azure.storage.blob import BlobServiceClient

ACCOUNT = "devstoreaccount1"
KEY = "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw=="


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, default=root / "src-tauri/target/debug" / ("faro-cli.exe" if os.name == "nt" else "faro-cli"))
    parser.add_argument("--azurite", type=Path, default=root / "src-tauri/target/azure-lab/node_modules/azurite/dist/src/blob/main.js")
    parser.add_argument("--live", action="store_true", help="Also run the app's 200 MiB upload/download/resume test")
    args = parser.parse_args()
    if not args.cli.is_file() or not args.azurite.is_file():
        parser.error("build faro-cli and install the local Azurite dependency first")
    results = []
    with tempfile.TemporaryDirectory(prefix="faro-azure-") as scratch:
        work = Path(scratch)
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        endpoint = f"http://127.0.0.1:{port}/{ACCOUNT}"
        with (work / "azurite.log").open("w") as log:
            proc = subprocess.Popen([shutil.which("node"), str(args.azurite.resolve()), "--silent", "--skipApiVersionCheck", "--blobHost", "127.0.0.1", "--blobPort", str(port), "--location", str(work / "blobs")],
                                    stdout=log, stderr=log, creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                client = BlobServiceClient(endpoint, credential=KEY, api_version="2023-11-03", retry_total=0, connection_timeout=2)
                for _ in range(80):
                    if proc.poll() is not None:
                        raise RuntimeError("Azurite exited during startup")
                    try:
                        container = client.create_container("faro-test")
                        break
                    except Exception:
                        time.sleep(0.25)
                else:
                    raise RuntimeError("Azurite did not start")
                profile = dict(id="lab", name="lab", protocol="azure", host="127.0.0.1", port=port,
                               username=ACCOUNT, account=ACCOUNT, auth=dict(kind="password", password=KEY),
                               bucket="faro-test", endpoint=endpoint)
                (work / "profiles.json").write_text(json.dumps([profile]), encoding="utf-8")
                env = dict(os.environ, FARO_DATA_DIR=str(work), NO_PROXY="127.0.0.1,localhost")

                def put(key, content=b"data"):
                    container.upload_blob(key, content, overwrite=True)

                def keys(prefix=""):
                    return sorted(b.name for b in container.list_blobs(name_starts_with=prefix))

                def body(key):
                    return container.download_blob(key).readall()

                def check(name, argv, verify, code=0):
                    try:
                        p = subprocess.run([str(args.cli.resolve()), *map(str, argv)], env=env, cwd=work,
                                           capture_output=True, encoding="utf-8", errors="replace", timeout=90)
                        ok = p.returncode == code and verify(p)
                        record = dict(name=name, passed=bool(ok), code=p.returncode, stdout=p.stdout, stderr=p.stderr)
                    except Exception as e:
                        record = dict(name=name, passed=False, error=str(e))
                    results.append(record)
                    print(f"{'PASS' if record['passed'] else 'FAIL'} {name}", flush=True)
                    if not record['passed']:
                        print(record.get('stderr', record.get('error', 'postcondition failed'))[:1500], flush=True)

                put("browse/")
                put("browse/empty.txt", b"")
                put("browse/nested/a.txt")
                check("list marker directory", ["ls", "lab:/browse"], lambda p: len(p.stdout.splitlines()) == 2)
                check("missing prefix errors", ["ls", "lab:/absent"], lambda p: True, 1)
                check("mkdir creates empty folder", ["mkdir", "lab:/new-empty"], lambda p: "new-empty/" in keys())
                for name in ["café.txt", "100%.txt", "a # b.txt", "trailing .txt "]:
                    source = work / "source.txt"
                    source.write_bytes(name.encode())
                    check(f"upload {name!r}", ["cp", source, f"lab:/exact/{name}"], lambda p, n=name: body(f"exact/{n}") == n.encode())
                    target = work / "download.txt"
                    check(f"download {name!r}", ["cp", f"lab:/exact/{name}", target], lambda p, n=name: target.read_bytes() == n.encode())
                put("rename/")
                put("rename/empty/", b"")
                put("rename/café.txt", b"unicode")
                put("rename", b"same-name-file")
                check("rename directory preserves markers and same-name file", ["mv", "lab:/rename/", "lab:/moved/"],
                      lambda p: keys("moved/") == ["moved/", "moved/café.txt", "moved/empty/"] and not keys("rename/") and body("rename") == b"same-name-file")
                check("reject overlapping rename", ["mv", "lab:/moved/", "lab:/moved/child/"], lambda p: body("moved/café.txt") == b"unicode", 1)
                check("delete directory preserves same-name file", ["rm", "lab:/moved/", "-r"], lambda p: not keys("moved/") and body("rename") == b"same-name-file")
                put("delete/")
                put("delete/empty/", b"")
                put("delete/a.txt")
                put("delete-neighbor.txt", b"keep")
                check("recursive delete removes markers without sibling prefix", ["rm", "lab:/delete/", "-r"], lambda p: not keys("delete/") and body("delete-neighbor.txt") == b"keep")
                source = work / "sync-source"
                (source / "empty").mkdir(parents=True)
                (source / "a.txt").write_bytes(b"sync")
                check("sync upload retains empty folder", ["sync", source, "lab:/sync", "--direction", "push"],
                      lambda p: body("sync/a.txt") == b"sync" and "sync/empty/" in keys())
                target = work / "sync-destination"
                check("sync download retains empty folder", ["sync", target, "lab:/sync", "--direction", "pull"],
                      lambda p: (target / "a.txt").read_bytes() == b"sync" and (target / "empty").is_dir())
                protected = work / "protected"
                protected.mkdir()
                (protected / "keep.txt").write_bytes(b"keep")
                check("missing source cannot delete mirror destination", ["sync", protected, "lab:/missing-source", "--direction", "pull", "--mirror"],
                      lambda p: (protected / "keep.txt").read_bytes() == b"keep", 1)
                for n in range(1005):
                    put(f"pages/{n:04}.txt", b"x")
                check("all 1005 objects across pages", ["ls", "lab:/pages"], lambda p: len(p.stdout.splitlines()) == 1005)
                if args.live:
                    env["FARO_LIVE_AZURE"] = f"{endpoint}:faro-test"
                    p = subprocess.run(["cargo", "test", "--manifest-path", str(root / "src-tauri/Cargo.toml"), "-p", "faro", "--lib", "live_azure_parallel_round_trip", "--", "--ignored", "--nocapture"], env=env, timeout=600)
                    results.append(dict(name="app multipart and changed-source resume", passed=p.returncode == 0))
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
    report = root / "src-tauri/target/azure-cli-audit.json"
    report.write_text(json.dumps(results, indent=2), encoding="utf-8")
    failed = sum(not r["passed"] for r in results)
    print(f"{len(results)-failed} passed, {failed} failed. Evidence: {report}")
    return bool(failed)


if __name__ == "__main__":
    raise SystemExit(main())
