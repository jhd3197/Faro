//! End-to-end tests for proxy commands (Plan 28): the real `ssh_connect`
//! against an in-process SSH server, with `examples/stdio_relay.rs` as the
//! ProxyCommand. No Docker or network needed. The relay, copied to a file
//! named `cloudflared`, stands in for cloudflared's login and error output.

use super::*;
use crate::profiles::{AuthMethod, ConnectionProfile, JumpVia, ProxyConfig, ProxyKind};
use crate::session::{
    ssh_connect, AuthPromptField, AuthPrompter, HostDecision, HostKeyVerifier, HostPromptKind, SshConnection,
};
use russh::server::{Auth, Msg, Session as ServerSession};
use russh::{Channel, ChannelId, ChannelMsg, CryptoVec};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex as StdMutex, OnceLock};

// ---- The relay binary --------------------------------------------------

/// `examples/stdio_relay`, built once per test run.
pub(crate) fn relay_exe() -> PathBuf {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let status = std::process::Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
            .args(["build", "-q", "-p", "faro", "--example", "stdio_relay"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status()
            .expect("run cargo build --example stdio_relay");
        assert!(status.success(), "building the stdio_relay example failed");
        // target/<profile>/deps/faro_lib-xxxx(.exe) -> target/<profile>/examples/
        let exe = std::env::current_exe().unwrap();
        let profile_dir = exe.parent().unwrap().parent().unwrap();
        let relay = profile_dir.join("examples").join(format!("stdio_relay{}", std::env::consts::EXE_SUFFIX));
        assert!(relay.is_file(), "{} missing", relay.display());
        relay
    })
    .clone()
}

/// The relay under the name `cloudflared`, so Faro treats it as such.
pub(crate) fn fake_cloudflared() -> PathBuf {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let dir = scratch("fake-cloudflared");
        let exe = dir.join(format!("cloudflared{}", std::env::consts::EXE_SUFFIX));
        std::fs::copy(relay_exe(), &exe).unwrap();
        exe
    })
    .clone()
}

pub(crate) fn scratch(tag: &str) -> PathBuf {
    static N: AtomicUsize = AtomicUsize::new(0);
    let dir = std::env::temp_dir().join(format!(
        "faro-proxycmd-{}-{tag}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub(crate) fn quoted(p: &std::path::Path) -> String {
    format!("\"{}\"", p.display())
}

/// Whether a process is still running.
pub(crate) fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&format!("\"{pid}\""))
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

async fn read_pid(file: &std::path::Path) -> u32 {
    for _ in 0..100 {
        if let Ok(s) = std::fs::read_to_string(file) {
            if let Ok(pid) = s.trim().parse() {
                return pid;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("relay never wrote {}", file.display());
}

async fn wait_dead(pid: u32) {
    for _ in 0..100 {
        if !alive(pid) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("proxy command process {pid} is still running (orphaned)");
}

// ---- In-process SSH server ---------------------------------------------

#[derive(Clone, Default)]
struct Server {
    /// Bytes received per channel, for the upload test.
    uploads: Arc<StdMutex<HashMap<ChannelId, (u64, u64)>>>,
    /// Open session channels, so `blob` can write through the channel's own
    /// flow-controlled writer.
    channels: Arc<StdMutex<HashMap<ChannelId, Channel<Msg>>>>,
}

/// FNV-1a, folded over a stream of chunks.
fn fnv(mut h: u64, data: &[u8]) -> u64 {
    for b in data {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}
const FNV0: u64 = 0xcbf29ce484222325;

#[async_trait::async_trait]
impl russh::server::Handler for Server {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == "pw" && !user.is_empty() {
            Auth::Accept
        } else {
            Auth::Reject { proceed_with_methods: None }
        })
    }

    async fn channel_open_session(&mut self, channel: Channel<Msg>, _: &mut ServerSession) -> Result<bool, Self::Error> {
        self.channels.lock().unwrap().insert(channel.id(), channel);
        Ok(true)
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _: &str,
        _: u32,
        _: &mut ServerSession,
    ) -> Result<bool, Self::Error> {
        let Ok(mut tcp) = tokio::net::TcpStream::connect((host, port as u16)).await else {
            return Ok(false);
        };
        tokio::spawn(async move {
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut stream, &mut tcp).await;
        });
        Ok(true)
    }

    /// `echo X` answers `X`; `blob N` streams N pseudo-random bytes; `sink`
    /// reads the client's data and answers its length and hash at EOF.
    async fn exec_request(&mut self, ch: ChannelId, data: &[u8], s: &mut ServerSession) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).to_string();
        let handle = s.handle();
        if let Some(n) = cmd.strip_prefix("blob ") {
            let n: usize = n.parse().unwrap();
            let channel = self.channels.lock().unwrap().remove(&ch).expect("exec on an open channel");
            // Through the channel's writer, which waits for the client's
            // window: `Handle::data` only queues, and a close sent behind a
            // queue that outruns the window drops what's still queued.
            tokio::spawn(async move {
                use tokio::io::AsyncWriteExt;
                let mut writer = channel.make_writer();
                let mut sent = 0;
                let mut seed = 7u64;
                while sent < n {
                    let len = (n - sent).min(32 * 1024);
                    let chunk: Vec<u8> = (0..len)
                        .map(|_| {
                            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
                            (seed >> 33) as u8
                        })
                        .collect();
                    if writer.write_all(&chunk).await.is_err() {
                        return;
                    }
                    sent += len;
                }
                let _ = writer.flush().await;
                let _ = handle.exit_status_request(ch, 0).await;
                let _ = channel.eof().await;
                let _ = channel.close().await;
            });
        } else if cmd == "sink" {
            self.uploads.lock().unwrap().insert(ch, (0, FNV0));
        } else {
            let reply = cmd.strip_prefix("echo ").unwrap_or(&cmd).to_string();
            tokio::spawn(async move {
                let _ = handle.data(ch, CryptoVec::from_slice(reply.as_bytes())).await;
                let _ = handle.exit_status_request(ch, 0).await;
                let _ = handle.eof(ch).await;
                let _ = handle.close(ch).await;
            });
        }
        Ok(())
    }

    async fn data(&mut self, ch: ChannelId, data: &[u8], _: &mut ServerSession) -> Result<(), Self::Error> {
        if let Some((n, h)) = self.uploads.lock().unwrap().get_mut(&ch) {
            *n += data.len() as u64;
            *h = fnv(*h, data);
        }
        Ok(())
    }

    async fn channel_eof(&mut self, ch: ChannelId, s: &mut ServerSession) -> Result<(), Self::Error> {
        if let Some((n, h)) = self.uploads.lock().unwrap().remove(&ch) {
            s.data(ch, CryptoVec::from_slice(format!("{n} {h:x}").as_bytes()));
            s.exit_status_request(ch, 0);
            s.eof(ch);
            s.close(ch);
        }
        Ok(())
    }
}

/// An SSH server on 127.0.0.1, answering until the test process ends.
pub(crate) async fn ssh_server() -> u16 {
    let config = Arc::new(russh::server::Config {
        keys: vec![russh_keys::key::KeyPair::generate_ed25519().unwrap()],
        auth_rejection_time: Duration::from_millis(10),
        auth_rejection_time_initial: Some(Duration::ZERO),
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let config = config.clone();
            tokio::spawn(async move {
                if let Ok(session) = russh::server::run_stream(config, sock, Server::default()).await {
                    let _ = session.await;
                }
            });
        }
    });
    port
}

// ---- Client side -------------------------------------------------------

/// Accepts every key, recording which host:port each check was for.
#[derive(Default)]
pub(crate) struct Verifier(pub(crate) StdMutex<Vec<(String, u16)>>);

#[async_trait::async_trait]
impl HostKeyVerifier for Verifier {
    async fn decide(
        &self,
        host: &str,
        port: u16,
        _: &str,
        _: &str,
        _: Option<&str>,
        _: HostPromptKind,
    ) -> std::result::Result<HostDecision, russh::Error> {
        self.0.lock().unwrap().push((host.to_string(), port));
        Ok(HostDecision::Accept)
    }
}

/// Refuses prompts, records notices.
#[derive(Default)]
pub(crate) struct Prompter(pub(crate) StdMutex<Vec<(String, Option<String>)>>);

#[async_trait::async_trait]
impl AuthPrompter for Prompter {
    async fn prompt(&self, _: &str, _: &str, _: &[AuthPromptField]) -> Result<Vec<String>> {
        Err(anyhow!("no prompts in tests"))
    }

    fn notice(&self, message: &str, url: Option<&str>) {
        self.0.lock().unwrap().push((message.to_string(), url.map(String::from)));
    }
}

/// A profile for the unroutable `host`, reached only through `command`.
pub(crate) fn profile(host: &str, command: String) -> ConnectionProfile {
    let mut p: ConnectionProfile = serde_json::from_value(serde_json::json!({
        "id": format!("pc-{host}"), "name": host, "protocol": "sftp", "host": host, "port": 22,
        "username": "faro", "auth": { "kind": "password", "password": "pw" },
    }))
    .unwrap();
    p.proxy_command = Some(ProxyCommandConfig {
        kind: ProxyCommandKind::Command,
        command,
        hostname: None,
        service_token_id: None,
        service_token_secret: None,
    });
    p
}

fn relay_to(port: u16, extra: &str) -> String {
    format!("{} --target 127.0.0.1:{port} {extra}", quoted(&relay_exe()))
}

struct Harness {
    verifier: Arc<Verifier>,
    prompter: Arc<Prompter>,
}

impl Harness {
    fn new() -> Self {
        Self { verifier: Arc::default(), prompter: Arc::default() }
    }

    async fn connect(&self, p: &ConnectionProfile) -> Result<SshConnection> {
        ssh_connect(p, self.verifier.clone(), self.prompter.clone()).await
    }
}

pub(crate) async fn exec(conn: &SshConnection, cmd: &str) -> Result<Vec<u8>> {
    let mut ch = conn.handle.channel_open_session().await?;
    ch.exec(true, cmd).await?;
    let mut out = Vec::new();
    while let Some(msg) = ch.wait().await {
        if let ChannelMsg::Data { data } = msg {
            out.extend_from_slice(&data);
        }
    }
    Ok(out)
}

pub(crate) async fn exec_str(conn: &SshConnection, cmd: &str) -> String {
    String::from_utf8(exec(conn, cmd).await.unwrap()).unwrap()
}

/// The top line of an error, which is all the UI shows.
pub(crate) fn top(e: &anyhow::Error) -> String {
    e.to_string()
}

// ---- Tests ---------------------------------------------------------------

#[tokio::test]
async fn connects_through_the_command_and_checks_the_real_host_key() {
    let port = ssh_server().await;
    let dir = scratch("happy");
    let argv = dir.join("argv.txt");
    let p = profile(
        "sealed.faro.test",
        relay_to(port, &format!("--argv-file {} --host %h --port %p --user %r", quoted(&argv))),
    );
    let h = Harness::new();
    let conn = h.connect(&p).await.unwrap();
    assert_eq!(exec_str(&conn, "echo hello").await, "hello");
    // known_hosts is keyed by the server's real name, not the local pipe.
    assert_eq!(*h.verifier.0.lock().unwrap(), [("sealed.faro.test".to_string(), 22)]);
    let args = std::fs::read_to_string(&argv).unwrap();
    assert!(args.ends_with("--host\nsealed.faro.test\n--port\n22\n--user\nfaro"), "{args}");
    assert!(h.prompter.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn hostile_host_and_user_stay_single_arguments() {
    let port = ssh_server().await;
    let dir = scratch("inject");
    let argv = dir.join("argv.txt");
    let host = r#"x" --mode fail '; calc.exe & rm -rf ~ | nc"#;
    let mut p = profile(host, relay_to(port, &format!("--argv-file {} %h %r", quoted(&argv))));
    p.username = "a b --mode hang".into();
    let h = Harness::new();
    // Auth fails (the user name is odd), but the relay must still have run
    // in relay mode with the values as two plain arguments.
    let _ = h.connect(&p).await;
    let args: Vec<String> = std::fs::read_to_string(&argv).unwrap().lines().map(String::from).collect();
    assert_eq!(args[args.len() - 2..], [host.to_string(), "a b --mode hang".to_string()]);
}

#[tokio::test]
async fn bulk_data_both_ways_survives_the_pipes() {
    let port = ssh_server().await;
    let conn = Harness::new().connect(&profile("bulk.faro.test", relay_to(port, ""))).await.unwrap();

    // Download: 24 MiB through stdout, checked against the server's stream.
    const N: usize = 24 * 1024 * 1024;
    let got = exec(&conn, &format!("blob {N}")).await.unwrap();
    assert_eq!(got.len(), N);
    let mut seed = 7u64;
    let want = fnv(FNV0, &(0..N).map(|_| {
        seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
        (seed >> 33) as u8
    }).collect::<Vec<u8>>());
    assert_eq!(fnv(FNV0, &got), want);

    // Upload: 16 MiB through stdin, in odd-sized writes.
    let mut ch = conn.handle.channel_open_session().await.unwrap();
    ch.exec(true, "sink").await.unwrap();
    let mut h = FNV0;
    let mut total = 0u64;
    let mut i = 0u32;
    while total < 16 * 1024 * 1024 {
        let len = 1 + (i as usize * 7919) % 50_000;
        let chunk: Vec<u8> = (0..len).map(|j| (j as u32 ^ i) as u8).collect();
        h = fnv(h, &chunk);
        total += len as u64;
        ch.data(&chunk[..]).await.unwrap();
        i += 1;
    }
    ch.eof().await.unwrap();
    let mut reply = Vec::new();
    while let Some(msg) = ch.wait().await {
        if let ChannelMsg::Data { data } = msg {
            reply.extend_from_slice(&data);
        }
    }
    assert_eq!(String::from_utf8(reply).unwrap(), format!("{total} {h:x}"));
}

#[tokio::test]
async fn missing_program_is_named() {
    let p = profile("x.faro.test", "faro-no-such-proxy-tool-xyz %h %p".into());
    let err = Harness::new().connect(&p).await.err().unwrap();
    assert!(format!("{err:#}").contains("faro-no-such-proxy-tool-xyz` was not found on PATH"), "{err:#}");
}

#[tokio::test]
async fn failing_command_reports_its_stderr_and_exit() {
    let p = profile(
        "x.faro.test",
        relay_to(1, "--mode fail --say \"first line\" --say \"boom: tunnel refused by policy\""),
    );
    let err = Harness::new().connect(&p).await.err().unwrap();
    let msg = top(&err);
    assert!(msg.contains("exited") && msg.contains("boom: tunnel refused by policy"), "{msg}");
    // The full tail is there too, and the transport error underneath.
    let full = format!("{err:#}");
    assert!(full.contains("first line"), "{full}");
}

#[tokio::test]
async fn silent_command_times_out_and_is_killed() {
    let dir = scratch("hang");
    let pid_file = dir.join("pid");
    let p = profile("x.faro.test", relay_to(1, &format!("--mode hang --pid-file {}", quoted(&pid_file))));
    let started = Instant::now();
    let err = Harness::new().connect(&p).await.err().unwrap();
    assert!(top(&err).contains("produced no output"), "{err:#}");
    assert!(started.elapsed() >= FIRST_BYTE_TIMEOUT && started.elapsed() < FIRST_BYTE_TIMEOUT * 3);
    wait_dead(read_pid(&pid_file).await).await;
}

#[tokio::test]
async fn abandoned_connect_kills_the_command() {
    let dir = scratch("abandon");
    let pid_file = dir.join("pid");
    let p = profile("x.faro.test", relay_to(1, &format!("--mode hang --pid-file {}", quoted(&pid_file))));
    let h = Harness::new();
    // The user cancels (the connect future is dropped) mid-handshake.
    assert!(tokio::time::timeout(Duration::from_millis(800), h.connect(&p)).await.is_err());
    wait_dead(read_pid(&pid_file).await).await;
}

#[tokio::test]
async fn closing_the_session_kills_the_command() {
    let port = ssh_server().await;
    let dir = scratch("close");
    let pid_file = dir.join("pid");
    // --linger: the relay won't exit on its own when the pipe closes.
    let p = profile("x.faro.test", relay_to(port, &format!("--linger --pid-file {}", quoted(&pid_file))));
    let conn = Harness::new().connect(&p).await.unwrap();
    assert_eq!(exec_str(&conn, "echo up").await, "up");
    let pid = read_pid(&pid_file).await;
    assert!(alive(pid));
    let _ = conn.handle.disconnect(russh::Disconnect::ByApplication, "", "en").await;
    drop(conn);
    wait_dead(pid).await;
}

#[tokio::test]
async fn command_dying_mid_session_then_reconnect_respawns() {
    let port = ssh_server().await;
    let p = profile("x.faro.test", relay_to(port, "--die-after-ms 1500"));
    let h = Harness::new();
    let conn = h.connect(&p).await.unwrap();
    assert_eq!(exec_str(&conn, "echo before").await, "before");
    tokio::time::sleep(Duration::from_millis(2500)).await;
    assert!(exec(&conn, "echo after").await.is_err(), "the dead transport must surface");
    assert!(conn.handle.is_closed());
    // What a reconnect does: run ssh_connect again, which spawns afresh.
    let again = h.connect(&p).await.unwrap();
    assert_eq!(exec_str(&again, "echo again").await, "again");
}

#[tokio::test]
async fn cloudflared_login_url_is_surfaced_and_the_wait_is_extended() {
    let port = ssh_server().await;
    // The "login" takes longer than the first-byte deadline.
    let delay = FIRST_BYTE_TIMEOUT.as_millis() + 1500;
    let p = profile(
        "ssh.example.com",
        format!(
            "{} access ssh --hostname %h --target 127.0.0.1:{port} --mode login --login-delay-ms {delay}",
            quoted(&fake_cloudflared())
        ),
    );
    let h = Harness::new();
    let conn = h.connect(&p).await.unwrap();
    assert_eq!(exec_str(&conn, "echo signed-in").await, "signed-in");
    let notices = h.prompter.0.lock().unwrap().clone();
    assert_eq!(notices.len(), 1, "{notices:?}");
    let url = notices[0].1.as_deref().unwrap();
    assert!(url.starts_with("https://team.cloudflareaccess.com/cdn-cgi/access/cli"), "{url}");
    assert!(notices[0].0.contains("Cloudflare Access"));
}

#[tokio::test]
async fn cloudflared_login_that_never_finishes_is_explained() {
    let p = profile(
        "ssh.example.com",
        format!(
            "{} access ssh --hostname %h --target 127.0.0.1:1 --mode login-fail --login-delay-ms 200",
            quoted(&fake_cloudflared())
        ),
    );
    let err = Harness::new().connect(&p).await.err().unwrap();
    let msg = top(&err);
    assert!(msg.contains("sign-in for ssh.example.com didn't finish"), "{msg}");
    assert!(msg.contains("/cdn-cgi/access/cli"), "{msg}");
}

#[tokio::test]
async fn cloudflared_unreachable_origin_is_explained() {
    let p = profile(
        "ssh.example.com",
        format!("{} access ssh --hostname %h --mode garbage", quoted(&fake_cloudflared())),
    );
    let err = Harness::new().connect(&p).await.err().unwrap();
    assert!(top(&err).contains("couldn't reach the SSH server behind ssh.example.com"), "{err:#}");
}

#[tokio::test]
async fn cloudflare_service_token_reaches_cloudflared_through_env() {
    let port = ssh_server().await;
    let token = ProxyCommandConfig {
        kind: ProxyCommandKind::Cloudflare,
        command: String::new(),
        hostname: Some("ssh.example.com".into()),
        service_token_id: Some("tok.access".into()),
        service_token_secret: Some("s3cr3t-value".into()),
    };
    // The real Cloudflare argv and env, run by the fake cloudflared.
    let run = |cfg: &ProxyCommandConfig, expect: &str| {
        let mut spec = build(cfg, "ssh.example.com", 22, "faro").unwrap();
        spec.program = fake_cloudflared().display().to_string();
        spec.args.extend(["--target".into(), format!("127.0.0.1:{port}"), "--mode".into(), "token".into()]);
        spec.args.extend(["--expect-token".into(), expect.into()]);
        spawn(&spec, |_| {}).unwrap()
    };
    let config = Arc::new(russh::client::Config::default());

    let stream = run(&token, "tok.access:s3cr3t-value");
    let handler = crate::session::ClientHandler::for_tests("ssh.example.com", 22, Arc::new(Verifier::default()));
    let mut session = russh::client::connect_stream(config.clone(), stream, handler).await.unwrap();
    assert!(session.authenticate_password("faro", "pw").await.unwrap());

    let stream = run(&token, "tok.access:a-different-secret");
    let diag = stream.diagnostics();
    let handler = crate::session::ClientHandler::for_tests("ssh.example.com", 22, Arc::new(Verifier::default()));
    let err = russh::client::connect_stream(config, stream, handler).await.err().unwrap();
    let err = diag.explain(err.into()).await;
    assert!(top(&err).contains("refused the login for ssh.example.com"), "{err:#}");
}

#[tokio::test]
async fn proxy_command_bastion_is_the_first_hop_of_a_jump_chain() {
    let port = ssh_server().await;
    let bastion = profile("bastion.faro.test", relay_to(port, ""));
    // The target is only reachable from the bastion (here: the same server,
    // through its direct-tcpip channel).
    let mut target: ConnectionProfile = serde_json::from_value(serde_json::json!({
        "id": "target", "name": "target", "protocol": "sftp", "host": "127.0.0.1", "port": port,
        "username": "faro", "auth": { "kind": "password", "password": "pw" },
        "jumpProfile": "pc-bastion.faro.test",
    }))
    .unwrap();
    target.jump_via = Some(JumpVia::Profile(Box::new(bastion)));
    let h = Harness::new();
    let conn = h.connect(&target).await.unwrap();
    assert_eq!(conn.jump_handles.len(), 1);
    assert_eq!(exec_str(&conn, "echo via-bastion").await, "via-bastion");
    assert_eq!(
        *h.verifier.0.lock().unwrap(),
        [("bastion.faro.test".to_string(), 22), ("127.0.0.1".to_string(), port)]
    );
}

#[tokio::test]
async fn inline_jump_host_rides_the_proxy_command() {
    let port = ssh_server().await;
    let mut p = profile("127.0.0.1", relay_to(port, "--argv-file ARGV --host %h --port %p --user %r"));
    let argv = scratch("inline").join("argv.txt");
    if let Some(c) = p.proxy_command.as_mut() {
        c.command = c.command.replace("ARGV", &quoted(&argv));
    }
    p.port = port;
    p.jump_host = Some("gw.faro.test".into());
    p.jump_port = Some(2200);
    p.jump_username = Some("jumper".into());
    let h = Harness::new();
    let conn = h.connect(&p).await.unwrap();
    assert_eq!(exec_str(&conn, "echo inline").await, "inline");
    // The command was run for the jump host, not the target.
    let args = std::fs::read_to_string(&argv).unwrap();
    assert!(args.ends_with("--host\ngw.faro.test\n--port\n2200\n--user\njumper"), "{args}");
}

#[tokio::test]
async fn twenty_concurrent_sessions_each_get_their_own_process() {
    let port = ssh_server().await;
    let dir = scratch("many");
    let h = Arc::new(Harness::new());
    let tasks: Vec<_> = (0..20)
        .map(|i| {
            let h = h.clone();
            let pid_file = dir.join(format!("pid{i}"));
            tokio::spawn(async move {
                let p = profile(&format!("n{i}.faro.test"), relay_to(port, &format!("--pid-file {}", quoted(&pid_file))));
                let conn = h.connect(&p).await.unwrap();
                assert_eq!(exec_str(&conn, &format!("echo {i}")).await, i.to_string());
                (conn, read_pid(&pid_file).await)
            })
        })
        .collect();
    let mut pids = Vec::new();
    let mut conns = Vec::new();
    for t in tasks {
        let (conn, pid) = t.await.unwrap();
        conns.push(conn);
        pids.push(pid);
    }
    pids.sort();
    pids.dedup();
    assert_eq!(pids.len(), 20);
    drop(conns);
    for pid in pids {
        wait_dead(pid).await;
    }
}

#[tokio::test]
async fn proxy_and_proxy_command_together_are_refused() {
    let mut p = profile("x.faro.test", "anything".into());
    p.proxy = Some(ProxyConfig {
        kind: ProxyKind::Socks5,
        host: "127.0.0.1".into(),
        port: 1080,
        username: None,
        password: None,
    });
    let err = Harness::new().connect(&p).await.err().unwrap();
    assert!(top(&err).contains("both a proxy and a proxy command"), "{err:#}");
}

#[tokio::test]
async fn wrong_password_is_an_auth_error_not_a_proxy_error() {
    let port = ssh_server().await;
    let mut p = profile("x.faro.test", relay_to(port, ""));
    p.auth = AuthMethod::Password { password: "nope".into() };
    let err = Harness::new().connect(&p).await.err().unwrap();
    let msg = format!("{err:#}");
    assert!(!msg.contains("proxy command"), "{msg}");
}

#[tokio::test]
async fn rejected_host_key_is_not_blamed_on_the_command() {
    struct Reject;
    #[async_trait::async_trait]
    impl HostKeyVerifier for Reject {
        async fn decide(&self, _: &str, _: u16, _: &str, _: &str, _: Option<&str>, _: HostPromptKind) -> std::result::Result<HostDecision, russh::Error> {
            Ok(HostDecision::Reject)
        }
    }
    let port = ssh_server().await;
    let p = profile("x.faro.test", relay_to(port, ""));
    let err = ssh_connect(&p, Arc::new(Reject), Arc::new(Prompter::default())).await.err().unwrap();
    let msg = format!("{err:#}");
    assert!(!top(&err).contains("proxy command"), "{msg}");
    assert!(msg.contains("connect to x.faro.test:22"), "{msg}");
}
