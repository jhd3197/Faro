"""Exercise FTP/SFTP operations on disposable local servers (pyftpdlib, asyncssh)."""
import asyncio
import functools
import json
import logging
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading

import asyncssh
from pyftpdlib.authorizers import DummyAuthorizer
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer
from pyftpdlib.log import config_logging


async def main():
    sys.stdout.reconfigure(encoding="utf-8")
    config_logging(level=logging.ERROR)
    root = Path(__file__).resolve().parents[1]
    cli = root / "src-tauri/target/debug" / ("faro-cli.exe" if os.name == "nt" else "faro-cli")
    results = []
    with tempfile.TemporaryDirectory(prefix="faro-protocols-") as scratch:
        work = Path(scratch)
        ftp_root, ssh_root = work / "ftp", work / "ssh"
        ftp_root.mkdir()
        ssh_root.mkdir()

        class FTP(FTPHandler):
            def ftp_MLSD(self, path):
                if "blocked" in path:
                    return self.respond("550 Permission denied")
                return super().ftp_MLSD(path)

            def ftp_LIST(self, path):
                if "blocked" in path:
                    return self.respond("550 Permission denied")
                return super().ftp_LIST(path)

        auth = DummyAuthorizer()
        auth.add_user("faro", "test", str(ftp_root), perm="elradfmwMT")
        FTP.authorizer = auth
        ftp = FTPServer(("127.0.0.1", 0), FTP)
        ftp_port = ftp.socket.getsockname()[1]
        thread = threading.Thread(target=ftp.serve_forever, kwargs=dict(timeout=0.1, blocking=True, handle_exit=False), daemon=True)
        thread.start()

        class SSH(asyncssh.SSHServer):
            def begin_auth(self, username): return True
            def password_auth_supported(self): return True
            def validate_password(self, username, password): return username == "faro" and password == "test"

        state = dict(link=True)

        class SFTP(asyncssh.SFTPServer):
            def map_path(self, path):
                if path == b"/dangling": raise asyncssh.SFTPNoSuchFile("missing link target")
                # Model a real symlink without requiring Windows symlink privileges.
                if path == b"/link" or path.startswith(b"/link/"):
                    if not state["link"]:
                        raise asyncssh.SFTPNoSuchFile("link removed")
                    path = b"/target" + path[5:]
                return super().map_path(path)

            def lstat(self, path):
                if b"/blocked/" in path: raise asyncssh.SFTPPermissionDenied("denied")
                if path == b"/dangling": return asyncssh.SFTPAttrs(permissions=stat.S_IFLNK | 0o777, size=7)
                if path == b"/link" and state["link"]:
                    return asyncssh.SFTPAttrs(permissions=stat.S_IFLNK | 0o777, size=7)
                return super().lstat(path)

            def remove(self, path):
                if path == b"/link":
                    state["link"] = False
                    return
                return super().remove(path)

            def rmdir(self, path):
                if path == b"/link": raise asyncssh.SFTPFailure("not a directory")
                return super().rmdir(path)

        ssh = await asyncssh.create_server(SSH,"127.0.0.1",0,server_host_keys=[asyncssh.generate_private_key("ssh-ed25519")],
                                          sftp_factory=functools.partial(SFTP,chroot=os.fsencode(ssh_root)))
        try:
            profiles = [dict(id=p,name=p,protocol=p,host="127.0.0.1",port=port,username="faro",auth=dict(kind="password",password="test"))
                        for p,port in [("ftp",ftp_port),("sftp",ssh.get_port())]]
            (work / "profiles.json").write_text(json.dumps(profiles),encoding="utf-8")
            env = dict(os.environ,FARO_DATA_DIR=str(work))
            env["FARO_LIVE_FTP"] = f"127.0.0.1:{ftp_port}:faro:test"
            env["FARO_LIVE_SFTP"] = f"127.0.0.1:{ssh.get_port()}:faro:test"

            async def check(name,args,verify,code=0):
                try:
                    p = await asyncio.to_thread(subprocess.run,[str(cli),*map(str,args)],env=env,cwd=work,input="a\n",
                                                capture_output=True,encoding="utf-8",errors="replace",timeout=40)
                    ok = p.returncode == code and verify()
                    result = dict(name=name,passed=bool(ok),code=p.returncode,stderr=p.stderr)
                except Exception as e:
                    result = dict(name=name,passed=False,error=str(e))
                results.append(result)
                print(f"{'PASS' if result['passed'] else 'FAIL'} {name}",flush=True)
                if not result["passed"]: print(result.get("stderr",result.get("error",""))[:1000],flush=True)

            for protocol, storage in [("ftp",ftp_root),("sftp",ssh_root)]:
                source = work / "source.bin"
                source.write_bytes(bytes(range(256))*8192)
                await check(f"{protocol}: upload exact bytes",["cp",source,f"{protocol}:/café %.bin"],lambda: (storage / "café %.bin").read_bytes()==source.read_bytes())
                target = work / "download.bin"
                await check(f"{protocol}: download exact bytes",["cp",f"{protocol}:/café %.bin",target],lambda: target.read_bytes()==source.read_bytes())
                await check(f"{protocol}: failed download preserves existing file",["cp",f"{protocol}:/absent",target],lambda: target.read_bytes()==source.read_bytes(),1)
                (storage / "tree/empty").mkdir(parents=True)
                (storage / "tree/.hidden").write_bytes(b"hidden")
                local = work / f"{protocol}-tree"
                await check(f"{protocol}: sync hidden files and empty folders",["sync",local,f"{protocol}:/tree","--direction","pull"],
                            lambda: (local / ".hidden").read_bytes()==b"hidden" and (local / "empty").is_dir())
                await check(f"{protocol}: recursive delete includes dotfiles",["rm",f"{protocol}:/tree","-r"],lambda: not (storage / "tree").exists())
            (ftp_root / "guard/blocked").mkdir(parents=True)
            (ftp_root / "guard/blocked/secret").write_bytes(b"secret")
            (ftp_root / "guard/z-keep.txt").write_bytes(b"keep")
            await check("ftp: incomplete traversal preserves every sibling",["rm","ftp:/guard","-r"],lambda: (ftp_root / "guard/z-keep.txt").read_bytes()==b"keep",1)
            (ssh_root / "target").mkdir()
            (ssh_root / "target/keep.txt").write_bytes(b"keep")
            await check("sftp: deleting symlink preserves target contents",["rm","sftp:/link","-r"],lambda: not state["link"] and (ssh_root / "target/keep.txt").read_bytes()==b"keep")
            if "--live" in sys.argv:
                p = await asyncio.to_thread(subprocess.run,["cargo","test","--manifest-path",str(root / "src-tauri/Cargo.toml"),"-p","faro","--lib","live_ftp_sftp_overwrite_safety","--","--ignored","--nocapture"],env=env,timeout=300)
                results.append(dict(name="app overwrite safety",passed=p.returncode==0))
        finally:
            ssh.close()
            await ssh.wait_closed()
            ftp.close_all()
            thread.join(timeout=3)
    report = root / "src-tauri/target/ftp-sftp-audit.json"
    report.write_text(json.dumps(results,indent=2),encoding="utf-8")
    failed = sum(not r["passed"] for r in results)
    print(f"{len(results)-failed} passed, {failed} failed")
    return bool(failed)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
