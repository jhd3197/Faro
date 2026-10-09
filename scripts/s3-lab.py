"""Disposable, loopback-only S3 lab for Faro issue #33. See docs/s3-testing.md."""

import argparse
import logging
import threading

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError
from moto.server import ThreadedMotoServer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=5009)
    parser.add_argument("--check", action="store_true", help="check API semantics and exit")
    args = parser.parse_args()
    logging.getLogger("werkzeug").setLevel(logging.WARNING)
    server = ThreadedMotoServer(ip_address="127.0.0.1", port=args.port, verbose=False)
    server.start()
    try:
        host, port = server.get_host_and_port()
        endpoint = f"http://{host}:{port}"
        client = boto3.client(
            "s3", endpoint_url=endpoint, region_name="us-east-1",
            aws_access_key_id="faro-test", aws_secret_access_key="faro-test-secret",
            config=Config(s3={"addressing_style": "path"}, proxies={}),
        )
        bucket = "faro-test"
        client.create_bucket(Bucket=bucket)
        objects = {
            "issue-33/": b"",
            "issue-33/marked/": b"",
            "issue-33/marked/hello.txt": b"hello from marked folder\n",
            "issue-33/marked/nested/": b"",
            "issue-33/marked/nested/data.txt": b"nested payload\n",
            "issue-33/marked/empty/": b"",
            "issue-33/implicit/hello.txt": b"hello from implicit folder\n",
            "issue-33/empty.txt": b"",
            "issue-33/spaces & symbols/hello world.txt": b"spaced filename\n",
            "key-encoding/café.txt": b"coffee\n",
        }
        for key, body in objects.items():
            client.put_object(Bucket=bucket, Key=key, Body=body)

        listing = client.list_objects_v2(Bucket=bucket, Prefix="issue-33/marked/", Delimiter="/")
        assert "issue-33/marked/" in [obj["Key"] for obj in listing["Contents"]]
        print("LIST marked/: contains its own trailing-slash folder marker", flush=True)
        for key in ["issue-33/marked", "issue-33/implicit", "issue-33/missing.txt"]:
            try:
                client.head_object(Bucket=bucket, Key=key)
            except ClientError as error:
                status = error.response["ResponseMetadata"]["HTTPStatusCode"]
                assert status == 404, (key, status)
                print(f"HEAD {key}: {status} (expected)", flush=True)
            else:
                raise AssertionError(f"HEAD unexpectedly succeeded: {key}")
        assert client.head_object(Bucket=bucket, Key="issue-33/marked/")["ContentLength"] == 0
        assert client.get_object(Bucket=bucket, Key="issue-33/marked/hello.txt")["Body"].read() == objects["issue-33/marked/hello.txt"]
        print("HEAD marked/: 200; GET marked/hello.txt: exact bytes verified", flush=True)
        print(f"\nFaro S3 connection:\n  Endpoint: {endpoint}\n  Bucket: {bucket}\n"
              "  Region: us-east-1\n  Access key: faro-test\n  Secret key: faro-test-secret\n"
              "  Remote path: /issue-33\n", flush=True)
        print(f"PowerShell: $env:FARO_LIVE_S3='{endpoint}:{bucket}:faro-test:faro-test-secret'", flush=True)
        if not args.check:
            print("Lab running. Ctrl+C stops it and discards all test objects.", flush=True)
            try:
                threading.Event().wait()
            except KeyboardInterrupt:
                pass
    finally:
        server.stop()


if __name__ == "__main__":
    main()
