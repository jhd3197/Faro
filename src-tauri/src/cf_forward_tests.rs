//! Forward lifecycle against a small stand-in for `cloudflared access tcp`.
//! No real Access account, and no nested `cargo build` (that rebuild races
//! the test harness and gets the CI job canceled).

use super::*;
use crate::profiles::{ConnectionProfile, ProxyCommandConfig, ProxyCommandKind};
use std::net::TcpListener;

/// A python process that speaks just enough of `cloudflared access tcp`:
/// bind `--url`, record argv and the service-token env, or exit at once
/// for hostname `exit.faro.test`.
fn stand_in(dir: &std::path::Path) -> PathBuf {
    let path = dir.join("cloudflared");
    std::fs::write(
        &path,
        r#"#!/usr/bin/env python3
import os, sys, socket, time
args = sys.argv[1:]
def flag(name):
    return args[args.index(name) + 1] if name in args else ""
host = flag("--hostname")
if host == "exit.faro.test":
    print("cloudflared: simulated failure", file=sys.stderr)
    sys.exit(1)
url = flag("--url") or "127.0.0.1:0"
listen_host, port = url.rsplit(":", 1)
if listen_host == "localhost":
    listen_host = "127.0.0.1"
ident = os.environ.get("TUNNEL_SERVICE_TOKEN_ID", "")
secret = os.environ.get("TUNNEL_SERVICE_TOKEN_SECRET", "")
safe = "".join(c if c.isalnum() or c in ".-" else "_" for c in host)
log = os.path.join(os.environ.get("TMPDIR", "/tmp"), f"faro-cf-tcp-{safe}.log")
open(log, "w").write(f"argv={' '.join(args)}\nid={ident}\nsecret={secret}\n")
s = socket.socket()
try:
    s.bind((listen_host, int(port)))
except OSError as e:
    print(f"failed to bind {url}: {e}", file=sys.stderr)
    sys.exit(1)
s.listen(8)
while True:
    time.sleep(0.05)
"#,
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
    }
    path
}

fn dir(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("faro-cf-fwd-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&path);
    std::fs::create_dir_all(&path).unwrap();
    path
}

fn profile(
    forward: &str,
    hostname: &str,
    port: u16,
    web: bool,
    token: Option<(&str, &str)>,
) -> ConnectionProfile {
    let mut p: ConnectionProfile = serde_json::from_value(serde_json::json!({
        "id": format!("id-{forward}"),
        "name": "edge",
        "protocol": "sftp",
        "host": "ssh.edge.example",
        "port": 22,
        "username": "deploy",
        "auth": { "kind": "agent" },
        "proxyCommand": { "kind": "cloudflare", "hostname": "ssh.edge.example" },
        "cfForwards": [{ "name": forward, "hostname": hostname, "localPort": port, "web": web }]
    }))
    .unwrap();
    if let Some((id, secret)) = token {
        let cmd = p.proxy_command.as_mut().unwrap();
        cmd.service_token_id = Some(id.into());
        cmd.service_token_secret = Some(secret.into());
    }
    p
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn log_for(hostname: &str) -> PathBuf {
    let safe: String = hostname
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    std::env::temp_dir().join(format!("faro-cf-tcp-{safe}.log"))
}

fn wait_dead(pid: u32) {
    let start = Instant::now();
    while alive(pid) && start.elapsed() < Duration::from_secs(3) {
        std::thread::sleep(Duration::from_millis(40));
    }
    assert!(!alive(pid), "pid {pid} is still running");
}

/// Kills anything the test started, including on panic.
struct Cleanup {
    dir: PathBuf,
    pids: Vec<u32>,
}

impl Drop for Cleanup {
    fn drop(&mut self) {
        for record in load(&self.dir) {
            kill_tree(record.pid);
        }
        for pid in &self.pids {
            kill_tree(*pid);
        }
    }
}

#[test]
fn start_stop_and_exit_leave_no_process() {
    let dir = dir("life");
    let bin = stand_in(&dir);
    let mut cleanup = Cleanup {
        dir: dir.clone(),
        pids: Vec::new(),
    };
    let port = free_port();
    let host = "db.life.faro.test";
    let _ = std::fs::remove_file(log_for(host));
    let profile = profile(
        "postgres",
        host,
        port,
        false,
        Some(("cid.access", "secret-value")),
    );
    let forward = &profile.cf_forwards[0];

    let running = start(&dir, &profile, forward, "app", Some(&bin)).unwrap();
    cleanup.pids.push(running.pid);
    assert!(!running.already);
    assert!(alive(running.pid));
    // The listener holds the port; a second bind fails.
    assert!(
        TcpListener::bind(("127.0.0.1", port)).is_err(),
        "forward did not listen"
    );
    let log = std::fs::read_to_string(log_for(host)).unwrap();
    assert!(log.contains("access tcp"), "{log}");
    assert!(log.contains("--hostname"), "{log}");
    assert!(
        log.contains(host) && log.contains(&format!("127.0.0.1:{port}")),
        "{log}"
    );
    // Credentials travel in the environment, not on the command line.
    assert!(log.contains("id=cid.access"), "{log}");
    assert!(log.contains("secret=secret-value"), "{log}");
    let argv = log.lines().next().unwrap_or("");
    assert!(
        argv.starts_with("argv=") && !argv.contains("secret-value"),
        "{log}"
    );

    // Starting again does not spawn a second process.
    let again = start(&dir, &profile, forward, "app", Some(&bin)).unwrap();
    assert!(again.already && again.pid == running.pid);
    drop(again);

    stop(&dir, &profile.id, "postgres").unwrap();
    wait_dead(running.pid);
    assert!(load(&dir).is_empty(), "stop left a pid record");
    // The port is free — the process is gone, not just untracked.
    let rebound = TcpListener::bind(("127.0.0.1", port));
    assert!(rebound.is_ok(), "port {port} still taken after stop");
    drop(rebound);

    // Exit cleanup kills an app-owned forward and reaps it (no zombie left
    // that still holds the port).
    let mut running = start(&dir, &profile, forward, "app", Some(&bin)).unwrap();
    cleanup.pids.push(running.pid);
    let pid = running.pid;
    let mgr = Manager::new(&dir);
    if let Some(child) = running.child.take() {
        mgr.children
            .lock()
            .unwrap()
            .insert((profile.id.clone(), "postgres".into()), child);
    }
    assert!(alive(pid));
    mgr.shutdown();
    wait_dead(pid);
    assert!(load(&dir).is_empty(), "shutdown left a pid record");
    assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
}

#[test]
fn a_taken_port_is_reported_and_spawns_nothing() {
    let dir = dir("busy");
    let bin = stand_in(&dir);
    let _cleanup = Cleanup {
        dir: dir.clone(),
        pids: Vec::new(),
    };
    let port = free_port();
    let _hold = TcpListener::bind(("127.0.0.1", port)).unwrap();
    let host = "db.busy.faro.test";
    let _ = std::fs::remove_file(log_for(host));
    let profile = profile("postgres", host, port, false, None);
    let err = start(
        &dir,
        &profile,
        &profile.cf_forwards[0],
        "app",
        Some(&bin),
    )
    .unwrap_err();
    let msg = format!("{err:#}");
    assert!(
        msg.contains(&port.to_string()) && msg.contains("already in use"),
        "{msg}"
    );
    assert!(load(&dir).is_empty(), "a failed start recorded a pid");
    assert!(
        !log_for(host).exists(),
        "cloudflared was spawned despite the conflict"
    );
}

#[test]
fn a_cloudflared_that_exits_immediately_is_reaped() {
    let dir = dir("die");
    let bin = stand_in(&dir);
    let _cleanup = Cleanup {
        dir: dir.clone(),
        pids: Vec::new(),
    };
    let port = free_port();
    let profile = profile("postgres", "exit.faro.test", port, false, None);
    let err = start(
        &dir,
        &profile,
        &profile.cf_forwards[0],
        "app",
        Some(&bin),
    )
    .unwrap_err();
    let msg = format!("{err:#}");
    assert!(msg.contains("simulated failure"), "{msg}");
    assert!(load(&dir).is_empty());
    // No stdio_relay left holding the port.
    assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
}

#[test]
fn cli_owned_forward_survives_app_shutdown_until_stop() {
    let dir = dir("cli");
    let bin = stand_in(&dir);
    let mut cleanup = Cleanup {
        dir: dir.clone(),
        pids: Vec::new(),
    };
    let port = free_port();
    let profile = profile("redis", "redis.cli.faro.test", port, false, None);
    let running = start(
        &dir,
        &profile,
        &profile.cf_forwards[0],
        "cli",
        Some(&bin),
    )
    .unwrap();
    cleanup.pids.push(running.pid);
    drop(running);
    Manager::new(&dir).shutdown();
    assert!(alive(cleanup.pids[0]), "app exit killed a CLI forward");
    stop(&dir, &profile.id, "redis").unwrap();
    wait_dead(cleanup.pids[0]);
    assert!(load(&dir).is_empty());
}

#[test]
fn resolve_finds_a_name_and_disambiguates() {
    let mut a = profile("db", "db.a.example", 5433, false, None);
    a.name = "alpha".into();
    a.id = "a".into();
    let mut b = profile("db", "db.b.example", 5434, true, None);
    b.name = "beta".into();
    b.id = "b".into();
    let profiles = vec![a, b];
    let err = resolve(&profiles, "db").unwrap_err().to_string();
    assert!(err.contains("alpha/db") && err.contains("beta/db"), "{err}");
    let (profile, forward) = resolve(&profiles, "beta/db").unwrap();
    assert_eq!(profile.id, "b");
    assert!(forward.web);
    assert!(resolve(&profiles, "missing")
        .unwrap_err()
        .to_string()
        .contains("no saved forward"));
}

#[test]
fn hostname_falls_back_to_the_connection() {
    let mut p = profile("db", "", 1, false, None);
    p.cf_forwards[0].hostname = None;
    assert_eq!(
        access_hostname(&p, &p.cf_forwards[0]).unwrap(),
        "ssh.edge.example"
    );
    p.proxy_command = Some(ProxyCommandConfig {
        kind: ProxyCommandKind::Cloudflare,
        command: String::new(),
        hostname: None,
        service_token_id: None,
        service_token_secret: None,
    });
    assert_eq!(
        access_hostname(&p, &p.cf_forwards[0]).unwrap(),
        "ssh.edge.example"
    );
}
