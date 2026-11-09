"""Disposable loopback FTP/SFTP servers for the ignored sync recovery tests.

Requires pyftpdlib and paramiko in an isolated Python environment. Prints the
FARO_LIVE_* settings; press Ctrl+C to stop. No existing directory is served.
"""
import errno
import json
import os
from pathlib import Path
import secrets
import socket
import tempfile
import threading
import time

import paramiko
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer


def main():
    with tempfile.TemporaryDirectory(prefix="faro-sync-servers-") as directory:
        root = Path(directory).resolve()
        password = secrets.token_hex(16)
        stopped = threading.Event()
        transports = []

        class Auth(paramiko.ServerInterface):
            def check_auth_password(self, username, supplied):
                return paramiko.AUTH_SUCCESSFUL if username == "faro" and supplied == password else paramiko.AUTH_FAILED

            def get_allowed_auths(self, username):
                return "password"

            def check_channel_request(self, kind, channel_id):
                return paramiko.OPEN_SUCCEEDED if kind == "session" else paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

        class Files(paramiko.SFTPServerInterface):
            def resolve(self, value):
                path = (root / value.lstrip("/")).resolve()
                if path != root and root not in path.parents:
                    raise PermissionError(errno.EACCES, "outside test root")
                return path

            def list_folder(self, path):
                try:
                    result = []
                    for child in self.resolve(path).iterdir():
                        attrs = paramiko.SFTPAttributes.from_stat(child.stat())
                        attrs.filename = child.name
                        result.append(attrs)
                    return result
                except OSError as error:
                    return paramiko.SFTPServer.convert_errno(error.errno)

            def stat(self, path):
                try:
                    return paramiko.SFTPAttributes.from_stat(self.resolve(path).stat())
                except OSError as error:
                    return paramiko.SFTPServer.convert_errno(error.errno)

            lstat = stat

            def open(self, path, flags, attrs):
                try:
                    descriptor = os.open(self.resolve(path), flags | getattr(os, "O_BINARY", 0), 0o600)
                    mode = "r+b" if flags & os.O_RDWR else "wb" if flags & os.O_WRONLY else "rb"
                    stream = os.fdopen(descriptor, mode, buffering=0)
                    handle = paramiko.SFTPHandle(flags)
                    if mode != "wb":
                        handle.readfile = stream
                    if mode != "rb":
                        handle.writefile = stream
                    return handle
                except OSError as error:
                    return paramiko.SFTPServer.convert_errno(error.errno)

            def mutation(self, fn, *paths):
                try:
                    fn(*(self.resolve(path) for path in paths))
                    return paramiko.SFTP_OK
                except OSError as error:
                    return paramiko.SFTPServer.convert_errno(error.errno)

            def mkdir(self, path, attrs):
                return self.mutation(os.mkdir, path)

            def rmdir(self, path):
                return self.mutation(os.rmdir, path)

            def remove(self, path):
                return self.mutation(os.remove, path)

            def rename(self, old, new):
                def move(source, destination):
                    if destination.exists():
                        raise FileExistsError(errno.EEXIST, "destination exists")
                    os.rename(source, destination)
                return self.mutation(move, old, new)

            def chattr(self, path, attrs):
                try:
                    paramiko.SFTPServer.set_file_attr(str(self.resolve(path)), attrs)
                    return paramiko.SFTP_OK
                except OSError as error:
                    return paramiko.SFTPServer.convert_errno(error.errno)

        key = paramiko.RSAKey.generate(2048)
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen()
        listener.settimeout(0.5)

        def serve_connection(client):
            transport = paramiko.Transport(client)
            transports.append(transport)
            transport.add_server_key(key)
            transport.set_subsystem_handler("sftp", paramiko.SFTPServer, Files)
            try:
                transport.start_server(server=Auth())
                while transport.is_active() and not stopped.wait(0.1):
                    pass
            finally:
                transport.close()

        def accept():
            while not stopped.is_set():
                try:
                    client, _ = listener.accept()
                    threading.Thread(target=serve_connection, args=(client,), daemon=True).start()
                except socket.timeout:
                    pass
                except OSError:
                    break

        authorizer = DummyAuthorizer()
        authorizer.add_user("faro", password, directory, perm="elradfmwMT")
        FTPHandler.authorizer = authorizer
        ftp = FTPServer(("127.0.0.1", 0), FTPHandler)
        threading.Thread(target=accept, daemon=True).start()
        threading.Thread(target=ftp.serve_forever, kwargs={"timeout": 0.2}, daemon=True).start()
        print(json.dumps({"FARO_LIVE_FTP": f"127.0.0.1:{ftp.socket.getsockname()[1]}:faro:{password}",
                          "FARO_LIVE_SFTP": f"127.0.0.1:{listener.getsockname()[1]}:faro:{password}"}), flush=True)
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            stopped.set()
            listener.close()
            ftp.close_all()
            for transport in transports:
                transport.close()
            time.sleep(0.3)


if __name__ == "__main__":
    main()
