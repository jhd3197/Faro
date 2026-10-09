"""Black-box S3 CLI audit. Uses only an ephemeral Moto server and dummy profiles.

Run with the Python environment from docs/s3-testing.md, after building faro-cli.
Exit 1 means at least one desired behavior failed; JSON preserves the evidence.
"""

import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
import os
from pathlib import Path
import subprocess
import tempfile
import threading
from urllib.parse import urlsplit, parse_qs

import boto3
from botocore.config import Config
from moto.server import ThreadedMotoServer


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli", type=Path, default=root / "src-tauri/target/debug" / ("faro-cli.exe" if os.name == "nt" else "faro-cli"))
    parser.add_argument("--report", type=Path, default=root / "src-tauri/target/s3-cli-audit.json")
    args = parser.parse_args()
    cli = args.cli.resolve()
    if not cli.is_file():
        parser.error(f"build faro-cli first: {cli}")
    logging.getLogger("werkzeug").setLevel(logging.ERROR)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=0, verbose=False)
    server.start()
    results = []
    try:
        host, port = server.get_host_and_port()
        endpoint = f"http://{host}:{port}"
        s3 = boto3.client("s3", endpoint_url=endpoint, region_name="us-east-1",
                          aws_access_key_id="test", aws_secret_access_key="test",
                          config=Config(s3={"addressing_style": "path"}, proxies={}))
        bucket = "faro-cli-audit"
        s3.create_bucket(Bucket=bucket)

        def put(key, body=b"payload\n"):
            s3.put_object(Bucket=bucket, Key=key, Body=body)

        def keys(prefix=""):
            return sorted(obj["Key"] for page in s3.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=prefix) for obj in page.get("Contents", []))

        def body(key):
            return s3.get_object(Bucket=bucket, Key=key)["Body"].read()

        with tempfile.TemporaryDirectory(prefix="faro-s3-cli-") as scratch:
            work = Path(scratch)
            profile = dict(id="lab", name="lab", protocol="s3", host=host, port=port,
                           username="test", auth=dict(kind="password", password="test"),
                           bucket=bucket, region="us-east-1", endpoint=endpoint)
            (work / "profiles.json").write_text(json.dumps([profile]), encoding="utf-8")
            env = dict(os.environ, FARO_DATA_DIR=str(work), NO_PROXY="127.0.0.1,localhost")

            def run(*argv):
                p = subprocess.run([str(cli), *map(str, argv)], env=env, cwd=work,
                                   capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60)
                return dict(command=list(map(str, argv)), code=p.returncode, stdout=p.stdout, stderr=p.stderr)

            def check(name, argv, verify, expected_code=0):
                result = {}
                try:
                    result = run(*argv)
                    ok = result["code"] == expected_code and verify(result)
                    record = dict(name=name, passed=bool(ok), **result)
                except Exception as error:
                    record = dict(name=name, passed=False, error=str(error), **result)
                results.append(record)
                print(f"{'PASS' if record['passed'] else 'FAIL'} {name}", flush=True)
                return record

            def local(name, data=b"payload\n"):
                path = work / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)
                return path

            check("profiles: isolated S3 profile loads", ["profiles", "list"], lambda r: "lab" in r["stdout"])
            put("browse/", b"")
            put("browse/nested/", b"")
            put("browse/nested/hello.txt")
            put("browse/empty.txt", b"")
            check("ls: markers excluded, empty file retained", ["ls", "lab:/browse", "--bytes"],
                  lambda r: len(r["stdout"].splitlines()) == 2 and "nested" in r["stdout"] and "empty.txt" in r["stdout"])
            for n in range(1005):
                put(f"pagination/{n:04}.txt", b"x")
            check("ls: all 1005 objects across pages", ["ls", "lab:/pagination"], lambda r: len(r["stdout"].splitlines()) == 1005)

            small = local("small.txt")
            check("cp: ordinary upload", ["cp", small, "lab:/copy/small.txt"], lambda r: body("copy/small.txt") == small.read_bytes())
            down = work / "download"
            down.mkdir()
            check("cp: ordinary download to directory", ["cp", "lab:/copy/small.txt", down], lambda r: (down / "small.txt").read_bytes() == small.read_bytes())
            empty = local("empty.txt", b"")
            check("cp: zero-byte upload", ["cp", empty, "lab:/copy/empty.txt"], lambda r: body("copy/empty.txt") == b"")
            check("cp: zero-byte download", ["cp", "lab:/copy/empty.txt", down], lambda r: (down / "empty.txt").read_bytes() == b"")
            spaced = local("hello world.txt")
            check("cp: spaces and ampersand", ["cp", spaced, "lab:/spaces & symbols/hello world.txt"], lambda r: body("spaces & symbols/hello world.txt") == spaced.read_bytes())
            big = local("large.bin", bytes(range(256)) * (17 * 4096))
            check("cp: 17 MiB multipart upload", ["cp", big, "lab:/copy/large.bin"], lambda r: hashlib.sha256(body("copy/large.bin")).digest() == hashlib.sha256(big.read_bytes()).digest())
            check("cp: 17 MiB download", ["cp", "lab:/copy/large.bin", down], lambda r: (down / "large.bin").read_bytes() == big.read_bytes())
            check("cp: explicit remote destination filename", ["cp", small, "lab:/rename-copy/different.txt"], lambda r: keys("rename-copy/") == ["rename-copy/different.txt"])
            exact = work / "download-renamed.txt"
            check("cp: explicit local destination filename", ["cp", "lab:/copy/small.txt", exact], lambda r: exact.is_file() and exact.read_bytes() == small.read_bytes())
            check("cp: missing object is an error", ["cp", "lab:/copy/missing.txt", down], lambda r: "404" in r["stderr"], expected_code=1)
            check("cp: remote-to-remote explicitly unsupported", ["cp", "lab:/copy/small.txt", "lab:/other.txt"], lambda r: "not yet supported" in r["stderr"], expected_code=1)
            check("cp: recursive option explicitly unavailable", ["cp", "--recursive", "lab:/browse", down], lambda r: "unexpected argument" in r["stderr"], expected_code=2)

            for name in ["café.txt", "100%.txt", "hash#.txt"]:
                put(f"special/{name}")
                check(f"cp: download exact key {name}", ["cp", f"lab:/special/{name}", down], lambda r, n=name: (down / n).read_bytes() == b"payload\n")
            unicode_file = local("café.txt")
            check("cp: upload preserves Unicode key", ["cp", unicode_file, "lab:/unicode-upload/café.txt"], lambda r: keys("unicode-upload/") == ["unicode-upload/café.txt"])
            put("café/child.txt")
            check("ls: Unicode prefix", ["ls", "lab:/café"], lambda r: "child.txt" in r["stdout"])

            check("mv: ordinary file", ["mv", "lab:/copy/small.txt", "lab:/copy/moved.txt"], lambda r: "copy/small.txt" not in keys("copy/") and body("copy/moved.txt") == b"payload\n")
            check("rm: ordinary file", ["rm", "lab:/copy/moved.txt"], lambda r: "copy/moved.txt" not in keys("copy/"))
            put("move-dir/child.txt")
            check("mv: directory prefix", ["mv", "lab:/move-dir", "lab:/moved-dir"], lambda r: keys("move-dir/") == [] and body("moved-dir/child.txt") == b"payload\n")
            put("rename-marked", b"separate file")
            put("rename-marked/", b"")
            put("rename-marked/empty/", b"")
            put("rename-marked/café%.txt")
            check("mv: marked directory preserves Unicode and empty folders", ["mv", "lab:/rename-marked/", "lab:/rename-result/"],
                  lambda r: keys("rename-marked/") == [] and body("rename-marked") == b"separate file" and keys("rename-result/") == ["rename-result/", "rename-result/café%.txt", "rename-result/empty/"])
            check("mv: overlapping directory rename is rejected", ["mv", "lab:/rename-result/", "lab:/rename-result/inside/"],
                  lambda r: len(keys("rename-result/")) == 3, expected_code=1)
            put("delete/child.txt")
            put("delete-other/keep.txt")
            check("rm: recursive implicit prefix and sibling boundary", ["rm", "lab:/delete", "--recursive"], lambda r: keys("delete/") == [] and keys("delete-other/") == ["delete-other/keep.txt"])
            put("delete-marked/", b"")
            put("delete-marked/empty/", b"")
            put("delete-marked/child.txt")
            check("rm: recursive marker directory fully removed", ["rm", "lab:/delete-marked", "--recursive"], lambda r: keys("delete-marked/") == [])
            put("collision", b"keep me")
            put("collision/child.txt")
            check("rm: trailing-slash directory preserves same-named object", ["rm", "lab:/collision/", "--recursive"], lambda r: keys("collision") == ["collision"] and body("collision") == b"keep me")
            put("whitespace/report.txt ", b"remove me")
            put("whitespace/report.txt", b"keep me")
            check("rm: exact trailing-space key preserves neighboring object", ["rm", "lab:/whitespace/report.txt "], lambda r: keys("whitespace/") == ["whitespace/report.txt"] and body("whitespace/report.txt") == b"keep me")
            check("mkdir: actually creates an empty directory", ["mkdir", "lab:/created-empty"], lambda r: keys("created-empty") == ["created-empty/"])

            push = local("push/a.txt", b"one\n").parent
            local("push/nested/b.txt", b"two\n")
            local("push/empty.txt", b"")
            check("sync: dry run leaves bucket unchanged", ["sync", push, "lab:/sync", "--dry-run"], lambda r: keys("sync/") == [])
            check("sync: nested push", ["sync", push, "lab:/sync"], lambda r: [k for k in keys("sync/") if not k.endswith('/')] == ["sync/a.txt", "sync/empty.txt", "sync/nested/b.txt"] and body("sync/nested/b.txt") == b"two\n")
            pull = work / "pull"
            pull.mkdir()
            check("sync: nested pull", ["sync", pull, "lab:/sync", "--direction", "pull"], lambda r: all((pull / p.relative_to(push)).read_bytes() == p.read_bytes() for p in push.rglob("*") if p.is_file()))
            put("sync/extra.txt")
            check("sync: mirror push removes destination-only file", ["sync", push, "lab:/sync", "--mirror"], lambda r: "sync/extra.txt" not in keys("sync/"))
            local("pull/extra.txt")
            check("sync: mirror pull removes destination-only file", ["sync", pull, "lab:/sync", "--mirror", "--direction", "pull"], lambda r: not (pull / "extra.txt").exists())
            marked = work / "marked-pull"
            marked.mkdir()
            put("browse/empty-dir/", b"")
            check("sync: pull marked directory files", ["sync", marked, "lab:/browse", "--direction", "pull"], lambda r: (marked / "nested/hello.txt").read_bytes() == b"payload\n" and (marked / "empty.txt").read_bytes() == b"")
            check("sync: pull preserves empty marker folders", ["sync", marked, "lab:/browse", "--direction", "pull"], lambda r: (marked / "empty-dir").is_dir())
            check("diff: identical trees with hashes", ["diff", push, "lab:/sync", "--hash", "--json"], lambda r: '"hashError"' not in r["stdout"])
            put("sync/a.txt", b"TWO\n")
            check("diff: detects equal-size content changes", ["diff", push, "lab:/sync", "--hash", "--json"], lambda r: '"different"' in r["stdout"], expected_code=1)
            uni_diff = local("unicode-diff/café.txt", b"AAA").parent
            put("unicode-diff/café.txt", b"BBB")
            check("diff: Unicode hash comparison fails closed", ["diff", uni_diff, "lab:/unicode-diff", "--hash", "--json"], lambda r: True, expected_code=1)
            check("search: name matches", ["search", "lab:/sync", "*.txt", "--json"], lambda r: len(json.loads(r["stdout"])["hits"]) == 3)
            check("search: content with opt-in", ["search", "lab:/sync", "two", "--content", "--content-remote", "--json"], lambda r: len(json.loads(r["stdout"])["hits"]) >= 1)
            check("search: folder markers classified as directories", ["search", "lab:/browse", "nested", "--json"], lambda r: all(h["isDir"] for h in json.loads(r["stdout"])["hits"]))
            put("dedupe/a.txt", b"same")
            put("dedupe/b.txt", b"same")
            check("dedupe: hashes find identical files", ["dedupe", "lab:/dedupe", "--hash", "--json"], lambda r: "a.txt" in r["stdout"] and "b.txt" in r["stdout"])
            check("exec: S3 clearly rejected", ["exec", "lab", "echo hello"], lambda r: "SSH/SFTP" in r["stderr"], expected_code=1)

            # Resource-policy denies are checked by Moto. Verify denial directly
            # first so a missing emulator permission feature cannot look like a
            # successful negative-path check.
            put("denied/stale.txt")
            s3.put_bucket_policy(Bucket=bucket, Policy=json.dumps({
                "Version": "2012-10-17", "Statement": [{
                    "Effect": "Deny", "Principal": "*", "Action": "s3:DeleteObject",
                    "Resource": f"arn:aws:s3:::{bucket}/denied/*",
                }],
            }))
            try:
                s3.delete_object(Bucket=bucket, Key="denied/stale.txt")
            except s3.exceptions.ClientError as error:
                if error.response["ResponseMetadata"]["HTTPStatusCode"] != 403:
                    raise
            else:
                raise AssertionError("Moto did not enforce the test's DeleteObject deny")
            check("rm: access denial is reported", ["rm", "lab:/denied/stale.txt"], lambda r: "403" in r["stderr"] and keys("denied/") == ["denied/stale.txt"], expected_code=1)
            empty_source = work / "empty-source"
            empty_source.mkdir()
            check("sync: mirror deletion failure returns nonzero", ["sync", empty_source, "lab:/denied", "--mirror"], lambda r: keys("denied/") == ["denied/stale.txt"], expected_code=1)
            s3.delete_bucket_policy(Bucket=bucket)

            put("missing-local-source/keep.txt", b"must survive")
            check("sync: missing local source cannot mirror-delete remote files",
                  ["sync", work / "does-not-exist", "lab:/missing-local-source", "--mirror"],
                  lambda r: keys("missing-local-source/") == ["missing-local-source/keep.txt"], expected_code=1)

            # A deterministic S3 HTTP 403 fixture exercises read failures
            # independently of Moto's coverage of IAM ListBucket conditions.
            class DeniedListing(BaseHTTPRequestHandler):
                def do_GET(self):
                    xml = b"<Error><Code>AccessDenied</Code><Message>Listing denied by audit fixture</Message></Error>"
                    self.send_response(403)
                    self.send_header("Content-Type", "application/xml")
                    self.send_header("Content-Length", str(len(xml)))
                    self.end_headers()
                    self.wfile.write(xml)

                def log_message(self, *_args):
                    pass

            denied_server = ThreadingHTTPServer(("127.0.0.1", 0), DeniedListing)
            denied_thread = threading.Thread(target=denied_server.serve_forever, daemon=True)
            denied_thread.start()
            protected = local("protected-pull/keep.txt", b"must survive")
            try:
                blocked = dict(profile, id="blocked", name="blocked", endpoint=f"http://127.0.0.1:{denied_server.server_port}")
                (work / "profiles.json").write_text(json.dumps([profile, blocked]), encoding="utf-8")
                check("ls: explicit 403 listing is reported", ["ls", "blocked:/"], lambda r: "403" in r["stderr"], expected_code=1)
                check("sync: unreadable S3 source cannot mirror-delete local files",
                      ["sync", protected.parent, "blocked:/", "--direction", "pull", "--mirror"],
                      lambda r: protected.is_file() and protected.read_bytes() == b"must survive", expected_code=1)
            finally:
                denied_server.shutdown()
                denied_server.server_close()
                denied_thread.join()

            class TransferFaults(BaseHTTPRequestHandler):
                aborted = False

                def respond(self, status, data=b"", **headers):
                    self.send_response(status)
                    self.send_header("Content-Length", str(len(data)))
                    for name, value in headers.items():
                        self.send_header(name.replace('_', '-'), value)
                    self.end_headers()
                    self.wfile.write(data)

                def do_GET(self):
                    parsed = urlsplit(self.path)
                    if "list-type" in parse_qs(parsed.query):
                        prefix = parse_qs(parsed.query).get("prefix", [""])[0]
                        if prefix == "hash/":
                            self.respond(200, b'<ListBucketResult><Contents><Key>hash/a.txt</Key><Size>3</Size><LastModified>2026-10-08T00:00:00Z</LastModified><ETag>test</ETag></Contents></ListBucketResult>')
                        elif prefix == "tree/":
                            self.respond(200, b'<ListBucketResult><CommonPrefixes><Prefix>tree/unreadable/</Prefix></CommonPrefixes></ListBucketResult>')
                        else:
                            self.respond(403, b'<Error><Code>AccessDenied</Code></Error>')
                    elif parsed.path.endswith("partial.txt"):
                        self.send_response(200)
                        self.send_header("Content-Length", "100")
                        self.send_header("Last-Modified", "Thu, 08 Oct 2026 00:00:00 GMT")
                        self.send_header("ETag", '"test"')
                        self.send_header("Connection", "close")
                        self.end_headers()
                        self.wfile.write(b"partial")
                        self.close_connection = True
                    else:
                        self.respond(403, b'<Error><Code>AccessDenied</Code></Error>')

                def do_POST(self):
                    self.respond(200, b'<InitiateMultipartUploadResult><Bucket>faro-cli-audit</Bucket><Key>large.bin</Key><UploadId>audit-upload</UploadId></InitiateMultipartUploadResult>')

                def do_PUT(self):
                    self.close_connection = True
                    self.respond(403, b'<Error><Code>AccessDenied</Code></Error>', Connection="close")

                def do_DELETE(self):
                    type(self).aborted = "uploadId=audit-upload" in self.path
                    self.respond(204)

                def log_message(self, *_args):
                    pass

            fault_server = ThreadingHTTPServer(("127.0.0.1", 0), TransferFaults)
            fault_thread = threading.Thread(target=fault_server.serve_forever, daemon=True)
            fault_thread.start()
            try:
                fault = dict(profile, id="fault", name="fault", endpoint=f"http://127.0.0.1:{fault_server.server_port}")
                (work / "profiles.json").write_text(json.dumps([profile, fault]), encoding="utf-8")
                original = local("fault-download/partial.txt", b"original contents")
                check("cp: truncated download preserves existing destination", ["cp", "fault:/partial.txt", original],
                      lambda r: original.read_bytes() == b"original contents" and not list(original.parent.glob("*.faro-part")), expected_code=1)
                new_target = original.parent / "new.txt"
                check("cp: truncated download leaves no partial destination", ["cp", "fault:/partial.txt", new_target],
                      lambda r: not new_target.exists() and not list(original.parent.glob("*.faro-part")), expected_code=1)
                check("cp: failed multipart upload is aborted", ["cp", big, "fault:/large.bin"],
                      lambda r: TransferFaults.aborted, expected_code=1)
                hash_root = local("fault-hash/a.txt", b"AAA").parent
                check("diff: denied hash read returns nonzero", ["diff", hash_root, "fault:/hash", "--hash", "--json"],
                      lambda r: "hashError" in r["stdout"], expected_code=1)
                nested_keep = local("fault-tree/keep.txt", b"must survive")
                check("sync: unreadable child cannot produce a partial mirror plan", ["sync", nested_keep.parent, "fault:/tree", "--direction", "pull", "--mirror"],
                      lambda r: nested_keep.read_bytes() == b"must survive", expected_code=1)
            finally:
                fault_server.shutdown()
                fault_server.server_close()
                fault_thread.join()

            # Preserve postconditions for false-success findings after the
            # disposable server and local work directory are cleaned up.
            results.append(dict(name="evidence: resulting keys and paths", passed=True,
                                observation_only=True,
                                keys={p: keys(p) for p in ["rename-copy/", "unicode-upload/", "delete-marked/", "collision", "whitespace/", "denied/", "created-empty", "missing-local-source/"]},
                                unreadable_source_local_file_preserved=protected.exists(),
                                explicit_local_destination_is_directory=exact.is_dir(),
                                explicit_local_destination_children=[p.name for p in exact.iterdir()] if exact.is_dir() else []))
    finally:
        server.stop()
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(dict(cli=str(cli), results=results), indent=2, ensure_ascii=False), encoding="utf-8")
    checks = [r for r in results if not r.get("observation_only")]
    failures = sum(not r["passed"] for r in checks)
    print(f"\n{len(checks) - failures} passed, {failures} failed. Evidence: {args.report}")
    return bool(failures)


if __name__ == "__main__":
    raise SystemExit(main())
