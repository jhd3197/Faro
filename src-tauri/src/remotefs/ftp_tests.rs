//! Real FtpSession/FtpFs calls against a loopback FTP fixture. No credentials,
//! external service or ignored-test flag needed; both MLSD and LIST are covered.
use super::*;
use std::io::{BufRead, BufReader, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::Mutex;
use std::time::Duration;

struct Server {
    port: u16,
    commands: Arc<Mutex<Vec<String>>>,
    stop: TcpStream,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.stop.shutdown(Shutdown::Both);
        if let Some(thread) = self.thread.take() { thread.join().unwrap(); }
    }
}

struct NoTlsPrompt;
#[async_trait]
impl crate::session::HostKeyVerifier for NoTlsPrompt {
    async fn decide(&self, _: &str, _: u16, _: &str, _: &str, _: Option<&str>,
        _: crate::session::HostPromptKind) -> std::result::Result<crate::session::HostDecision, russh::Error> {
        panic!("plain loopback FTP must not ask for TLS trust")
    }
}

async fn connect(mlsd: bool) -> (Server, FtpFs) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let commands = Arc::new(Mutex::new(Vec::new()));
    let seen = commands.clone();
    let (send, receive) = std::sync::mpsc::channel();
    let thread = std::thread::spawn(move || {
        let (mut control, _) = listener.accept().unwrap();
        control.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        control.set_write_timeout(Some(Duration::from_secs(10))).unwrap();
        send.send(control.try_clone().unwrap()).unwrap();
        let mut reader = BufReader::new(control.try_clone().unwrap());
        write!(control, "220 Faro listing regression fixture\r\n").unwrap();
        let mut passive = None;
        loop {
            let mut line = String::new();
            if !matches!(reader.read_line(&mut line), Ok(n) if n > 0) { break; }
            let line = line.trim_end().to_string();
            seen.lock().unwrap().push(line.clone());
            let (command, arg) = line.split_once(' ').unwrap_or((&line, ""));
            let response = match command {
                "USER" => "331 Password required\r\n".to_string(),
                "PASS" => "230 Logged in\r\n".to_string(),
                "TYPE" | "OPTS" => "200 OK\r\n".to_string(),
                "FEAT" if mlsd => "211-Features\r\n MLST type*;size*;modify*;\r\n UTF8\r\n211 End\r\n".to_string(),
                "FEAT" => "211-Features\r\n UTF8\r\n211 End\r\n".to_string(),
                "PASV" => {
                    let data = TcpListener::bind("127.0.0.1:0").unwrap();
                    let port = data.local_addr().unwrap().port();
                    passive = Some(data);
                    format!("227 Entering Passive Mode (127,0,0,1,{},{})\r\n", port / 256, port % 256)
                }
                "MLSD" | "LIST" => {
                    let directory = arg.strip_prefix("-a ").unwrap_or(arg);
                    let mut items = vec![("keep.txt", false)];
                    match directory {
                        "/mixed" => items.extend([(r"report\2026.txt", false), ("sub", true)]),
                        "/all-skipped" => items = vec![(r"report\2026.txt", false)],
                        "/tree" => items.push(("sub", true)),
                        "/tree/sub" => items.push((r"report\2026.txt", false)),
                        _ => {}
                    }
                    write!(control, "150 Opening data connection\r\n").unwrap();
                    let (mut data, _) = passive.take().unwrap().accept().unwrap();
                    for (name, dir) in items {
                        let entry = if command == "MLSD" {
                            format!("type={};size=4; {name}\r\n", if dir { "dir" } else { "file" })
                        } else {
                            format!("{}rwxr-xr-x 1 user group 4 Jan  1  2024 {name}\r\n", if dir { "d" } else { "-" })
                        };
                        data.write_all(entry.as_bytes()).unwrap();
                    }
                    drop(data);
                    "226 Listing complete\r\n".to_string()
                }
                // Accept mutations so the test fails on the recorded command,
                // rather than accidentally passing because deletion was denied.
                "DELE" | "RMD" => "250 Deleted\r\n".to_string(),
                "QUIT" => break,
                _ => panic!("unexpected FTP command: {line}"),
            };
            if control.write_all(response.as_bytes()).is_err() { break; }
        }
    });
    let profile = serde_json::from_value(serde_json::json!({
        "id": "listing-test", "name": "listing-test", "protocol": "ftp",
        "host": "127.0.0.1", "port": port, "username": "fixture",
        "auth": { "kind": "password", "password": "fixture" }
    })).unwrap();
    let session = crate::session::ftp::ftp_connect(&profile, Arc::new(NoTlsPrompt)).await.unwrap();
    let server = Server { port, commands, stop: receive.recv().unwrap(), thread: Some(thread) };
    (server, FtpFs::new(Arc::new(session)))
}

async fn exercise(mlsd: bool) {
    let (server, fs) = connect(mlsd).await;
    let listing = fs.browse_dir("/mixed").await.unwrap();
    assert_eq!(listing.skipped_entries, 1);
    assert_eq!(listing.entries.iter().map(|e| e.path.as_str()).collect::<Vec<_>>(), ["/mixed/keep.txt", "/mixed/sub"]);
    let empty = fs.browse_dir("/all-skipped").await.unwrap();
    assert!(empty.entries.is_empty());
    assert_eq!(empty.skipped_entries, 1);
    assert!(fs.list_dir("/mixed").await.unwrap_err().to_string().contains("Incomplete directory listing"));
    assert!(fs.list_dir("/all-skipped").await.is_err());
    assert!(crate::scan::walk_tree(&fs, "/tree").await.is_err());

    let local = std::env::temp_dir().join(format!("faro-listing-test-{}", server.port));
    std::fs::create_dir_all(&local).unwrap();
    std::fs::write(local.join("keep.txt"), b"keep").unwrap();
    // Both source and destination must be complete, for additive and mirror.
    // In particular, no deletion plan may be returned for a hidden source file.
    for direction in [crate::sync::SyncDirection::RemoteToLocal, crate::sync::SyncDirection::LocalToRemote] {
        for strategy in [crate::sync::SyncStrategy::Mirror, crate::sync::SyncStrategy::Additive] {
            let result = crate::sync::plan(&crate::remotefs::local::LocalFs, &fs,
                local.to_str().unwrap(), "/tree", direction, strategy).await;
            assert!(result.is_err(), "partial tree must never produce a sync plan");
        }
    }
    assert_eq!(std::fs::read(local.join("keep.txt")).unwrap(), b"keep");
    // Discovery must finish before the first mutation, including when the
    // unsupported entry is in a child directory rather than the selected root.
    assert!(fs.delete("/tree", true).await.is_err());
    assert!(!server.commands.lock().unwrap().iter().any(|c| c.starts_with("DELE ") || c.starts_with("RMD ")));
    // A strict failure must not poison the session or the next complete listing.
    assert_eq!(fs.list_dir("/clean").await.unwrap()[0].path, "/clean/keep.txt");
    assert_eq!(fs.browse_dir("/clean").await.unwrap().skipped_entries, 0);
    let commands = server.commands.lock().unwrap();
    assert!(commands.iter().any(|c| c.starts_with(if mlsd { "MLSD " } else { "LIST -a " })));
    drop(commands);
    std::fs::remove_dir_all(local).unwrap();
}

#[tokio::test]
async fn mlsd_browsing_recovers_without_weakening_operations() { exercise(true).await; }

#[tokio::test]
async fn list_browsing_recovers_without_weakening_operations() { exercise(false).await; }
