"""Local-only FTP fixture. pip install pyftpdlib; python scripts/upload-ftp-lab.py.

Only the explicitly supplied scratch root is writable. Never point at live data.
"""
import argparse
from pathlib import Path
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer

parser = argparse.ArgumentParser()
parser.add_argument("--root", required=True)
parser.add_argument("--port", type=int, default=2121)
args = parser.parse_args()
root = Path(args.root).resolve()
root.mkdir(parents=True, exist_ok=True)
auth = DummyAuthorizer()
auth.add_user("faro", "farotest", str(root), perm="elradfmwMT")
auth.add_user("readonly", "farotest", str(root), perm="elr")
FTPHandler.authorizer = auth
FTPHandler.passive_ports = range(30000, 30100)
FTPServer(("127.0.0.1", args.port), FTPHandler).serve_forever()
