//! SFTP folder links against a local OpenSSH `sshd` (internal-sftp).
//!
//! The ignored `FARO_LIVE_SFTP` harness talks to a server the developer starts.
//! This test starts its own, on a free port, so CI covers a real folder link:
//! kind, opening the link, copying the folder, and deleting only the link.
use super::SftpFs;
use crate::remotefs::{FileKind, RemoteFs};
use crate::session::{ssh_session_for_tests, HostDecision, HostKeyVerifier, HostPromptKind};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

struct AcceptAll;

#[async_trait::async_trait]
impl HostKeyVerifier for AcceptAll {
    async fn decide(
        &self,
        _host: &str,
        _port: u16,
        _key_type: &str,
        _fingerprint: &str,
        _stored: Option<&str>,
        _kind: HostPromptKind,
    ) -> Result<HostDecision, russh::Error> {
        Ok(HostDecision::Accept)
    }
}

struct Sshd {
    child: std::process::Child,
    dir: PathBuf,
    log: Arc<Mutex<String>>,
}

impl Drop for Sshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Sshd {
    fn log(&self) -> String {
        self.log.lock().unwrap().clone()
    }
}

fn run(cmd: &mut Command) {
    let out = cmd.output().unwrap_or_else(|e| panic!("spawn {cmd:?}: {e}"));
    assert!(
        out.status.success(),
        "{cmd:?} failed: {}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}

fn sshd_bin() -> PathBuf {
    ["/usr/sbin/sshd", "/usr/bin/sshd", "/usr/local/sbin/sshd"]
        .into_iter()
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .expect("openssh sshd is required (install openssh-server)")
}

fn start_sshd() -> (Sshd, u16, String, PathBuf) {
    let dir = std::env::temp_dir().join(format!("faro-sftp-links-{}", uuid::Uuid::new_v4().simple()));
    std::fs::create_dir_all(&dir).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    let host_key = dir.join("host");
    let user_key = dir.join("user");
    run(Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-f"]).arg(&host_key).args(["-N", ""]));
    run(Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-f"]).arg(&user_key).args(["-N", ""]));
    std::fs::copy(user_key.with_extension("pub"), dir.join("authorized_keys")).unwrap();

    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let user = String::from_utf8(Command::new("whoami").output().unwrap().stdout).unwrap();
    let user = user.trim().to_string();
    let config = dir.join("sshd_config");
    std::fs::write(
        &config,
        format!(
            "\
Port {port}
ListenAddress 127.0.0.1
HostKey {host}
AuthorizedKeysFile {keys}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
UsePAM no
PermitRootLogin no
StrictModes no
PrintMotd no
PrintLastLog no
Subsystem sftp internal-sftp
AllowTcpForwarding no
X11Forwarding no
AllowUsers {user}
",
            host = host_key.display(),
            keys = dir.join("authorized_keys").display(),
        ),
    )
    .unwrap();

    let mut child = Command::new(sshd_bin())
        .args(["-D", "-e", "-f"])
        .arg(&config)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn sshd");
    let log = Arc::new(Mutex::new(String::new()));
    let log_for_reader = log.clone();
    let stderr = child.stderr.take().unwrap();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            if let Ok(line) = line {
                let mut buf = log_for_reader.lock().unwrap();
                buf.push_str(&line);
                buf.push('\n');
            }
        }
    });

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        if let Some(status) = child.try_wait().unwrap() {
            panic!("sshd exited {status}: {}", log.lock().unwrap());
        }
        if std::time::Instant::now() > deadline {
            panic!("sshd never listened on {port}: {}", log.lock().unwrap());
        }
        std::thread::sleep(Duration::from_millis(50));
    }

    let tree = dir.join("tree");
    std::fs::create_dir_all(tree.join("real")).unwrap();
    std::fs::write(tree.join("real").join("inside.txt"), b"payload").unwrap();
    std::os::unix::fs::symlink("real", tree.join("linked")).unwrap();
    std::os::unix::fs::symlink("real/inside.txt", tree.join("filelink")).unwrap();
    std::os::unix::fs::symlink("missing-target", tree.join("broken")).unwrap();

    (
        Sshd { child, dir, log },
        port,
        user_key.to_string_lossy().into_owned(),
        tree,
    )
}

#[tokio::test]
async fn sftp_folder_link_opens_copies_the_folder_and_deletes_only_the_link() {
    let (server, port, key, tree) = start_sshd();
    let user = String::from_utf8(Command::new("whoami").output().unwrap().stdout).unwrap();
    let profile: crate::profiles::ConnectionProfile = serde_json::from_value(serde_json::json!({
        "id": "sftp-links",
        "name": "sftp links",
        "protocol": "sftp",
        "host": "127.0.0.1",
        "port": port,
        "username": user.trim(),
        "auth": { "kind": "key", "path": key, "passphrase": null },
    }))
    .unwrap_or_else(|e| panic!("profile: {e}\n{}", server.log()));

    let ssh = ssh_session_for_tests(&profile, Arc::new(AcceptAll))
        .await
        .unwrap_or_else(|e| panic!("ssh connect: {e:#}\n{}", server.log()));
    let fs = SftpFs::new(ssh.clone());
    let tree_s = tree.to_string_lossy().into_owned();

    let entries = fs.list_dir(&tree_s).await.unwrap_or_else(|e| panic!("{e:#}\n{}", server.log()));
    let get = |n: &str| {
        entries.iter().find(|e| e.name == n).unwrap_or_else(|| panic!("missing {n}: {entries:?}")).clone()
    };
    let linked = get("linked");
    assert_eq!(linked.kind, FileKind::Symlink);
    assert!(linked.link_dir, "an SFTP link to a folder opens like one");
    let filelink = get("filelink");
    assert_eq!(filelink.kind, FileKind::Symlink);
    assert!(!filelink.link_dir);
    let broken = get("broken");
    assert_eq!(broken.kind, FileKind::Symlink);
    assert!(!broken.link_dir, "a broken SFTP link stays a plain link");
    assert_eq!(get("real").kind, FileKind::Directory);

    let inside = fs.list_dir(&linked.path).await.unwrap();
    assert!(inside.iter().any(|e| e.name == "inside.txt" && e.kind == FileKind::File));

    crate::commands::duplicate_ssh(&ssh, &linked.path).await.unwrap();
    crate::commands::duplicate_ssh(&ssh, &filelink.path).await.unwrap();
    crate::commands::duplicate_ssh(&ssh, &broken.path).await.unwrap();

    let after = fs.list_dir(&tree_s).await.unwrap();
    let copied = after.iter().find(|e| e.name == "linked copy").expect("folder copy");
    assert_eq!(copied.kind, FileKind::Directory, "copying a folder link copies the folder");
    assert!(!copied.link_dir);
    let copied_inside = fs.list_dir(&copied.path).await.unwrap();
    assert!(copied_inside.iter().any(|e| e.name == "inside.txt"));
    let cat = ssh
        .exec(&format!(
            "cat {}",
            crate::scp::quote_path(&format!("{}/inside.txt", copied.path))
        ))
        .await
        .unwrap();
    assert_eq!(cat.exit_code, Some(0), "{}", cat.stderr);
    assert_eq!(cat.stdout, "payload");

    let file_copy = after.iter().find(|e| e.name == "filelink copy").unwrap();
    assert_eq!(file_copy.kind, FileKind::Symlink);
    assert!(!file_copy.link_dir);
    let broken_copy = after.iter().find(|e| e.name == "broken copy").unwrap();
    assert_eq!(broken_copy.kind, FileKind::Symlink);
    assert!(!broken_copy.link_dir);

    // The originals are still links, and the folder they point at is intact.
    assert!(after.iter().any(|e| e.name == "linked" && e.kind == FileKind::Symlink && e.link_dir));
    assert!(tree.join("real").join("inside.txt").is_file());

    fs.delete(&linked.path, true).await.unwrap();
    fs.delete(&filelink.path, true).await.unwrap();
    fs.delete(&broken.path, true).await.unwrap();

    let left = fs.list_dir(&tree_s).await.unwrap();
    assert!(left.iter().all(|e| e.name != "linked" && e.name != "filelink" && e.name != "broken"));
    assert!(left.iter().any(|e| e.name == "linked copy"));
    // The link nodes are gone; the target file is not.
    assert!(std::fs::symlink_metadata(tree.join("linked")).is_err());
    assert!(std::fs::symlink_metadata(tree.join("filelink")).is_err());
    assert!(std::fs::symlink_metadata(tree.join("broken")).is_err());
    assert!(tree.join("real").join("inside.txt").is_file());
}
