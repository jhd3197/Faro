//! Tests for Plan 29: the managed cloudflared installer (against a local
//! HTTP server standing in for GitHub) and Access sign-in state (against the
//! fake cloudflared from `examples/stdio_relay.rs`).

use super::*;
use crate::proxy_command::e2e::{fake_cloudflared, quoted, relay_exe, scratch, ssh_server, Prompter, Verifier};
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

// ---- Pure helpers ------------------------------------------------------------

#[test]
fn assets_for_every_platform_faro_ships_on() {
    assert_eq!(asset_name("windows", "x86_64").unwrap(), "cloudflared-windows-amd64.exe");
    assert_eq!(asset_name("windows", "aarch64").unwrap(), "cloudflared-windows-amd64.exe");
    assert_eq!(asset_name("linux", "x86_64").unwrap(), "cloudflared-linux-amd64");
    assert_eq!(asset_name("linux", "aarch64").unwrap(), "cloudflared-linux-arm64");
    assert_eq!(asset_name("linux", "arm").unwrap(), "cloudflared-linux-arm");
    assert_eq!(asset_name("macos", "x86_64").unwrap(), "cloudflared-darwin-amd64.tgz");
    assert_eq!(asset_name("macos", "aarch64").unwrap(), "cloudflared-darwin-arm64.tgz");
    assert!(asset_name("freebsd", "x86_64").unwrap_err().to_string().contains("freebsd/x86_64"));
    // The running platform has one.
    assert!(asset_name(std::env::consts::OS, std::env::consts::ARCH).is_ok());
}

#[test]
fn versions_parse_and_compare() {
    assert_eq!(parse_version("cloudflared version 2025.8.1 (built 2025-08-21-1534 UTC)").as_deref(), Some("2025.8.1"));
    assert_eq!(parse_version("cloudflared version v2026.10.4").as_deref(), Some("2026.10.4"));
    assert_eq!(parse_version("no version here"), None);
    assert_eq!(parse_version(""), None);
    assert!(is_newer("2026.10.4", "2025.8.1"));
    assert!(is_newer("2026.10.10", "2026.10.9"), "numeric, not lexical");
    assert!(!is_newer("2026.10.4", "2026.10.4"));
    assert!(!is_newer("2025.1.0", "2026.1.0"));
}

fn asset(name: &str, digest: Option<&str>) -> Asset {
    Asset { name: name.into(), browser_download_url: String::new(), digest: digest.map(Into::into) }
}

#[test]
fn checksums_come_from_the_digest_then_the_notes() {
    let hex = "a".repeat(64);
    let body = format!("### SHA256 Checksums:\n```\ncloudflared-linux-amd64: {hex}\ncloudflared-linux-arm64: {}\n```", "b".repeat(64));
    // GitHub's digest wins, even over a (different) table entry.
    let d = format!("sha256:{}", "C".repeat(64));
    assert_eq!(expected_sha256(&asset("cloudflared-linux-amd64", Some(&d)), &body).unwrap(), "c".repeat(64));
    assert_eq!(expected_sha256(&asset("cloudflared-linux-amd64", None), &body).unwrap(), hex);
    assert_eq!(expected_sha256(&asset("cloudflared-linux-arm64", None), &body).unwrap(), "b".repeat(64));
    // `cloudflared-linux-arm` must not match the `-arm64` line.
    assert!(expected_sha256(&asset("cloudflared-linux-arm", None), &body).is_err());
    assert!(expected_sha256(&asset("cloudflared-linux-amd64", None), "cloudflared-linux-amd64: nothex").is_err());
    assert!(expected_sha256(&asset("x", None), "").unwrap_err().to_string().contains("can't be verified"));
}

/// A minimal ustar archive of `(name, bytes)` entries, gzipped.
fn tgz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut tar = Vec::new();
    for (name, data) in entries {
        let mut h = [0u8; 512];
        h[..name.len()].copy_from_slice(name.as_bytes());
        h[124..135].copy_from_slice(format!("{:011o}", data.len()).as_bytes());
        h[156] = b'0';
        tar.extend_from_slice(&h);
        tar.extend_from_slice(data);
        tar.resize(tar.len().div_ceil(512) * 512, 0);
    }
    tar.extend_from_slice(&[0u8; 1024]);
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    gz.write_all(&tar).unwrap();
    gz.finish().unwrap()
}

#[test]
fn darwin_tgz_yields_the_binary() {
    let bin = vec![7u8; 1500];
    assert_eq!(extract_from_tgz(&tgz(&[("README", b"hi"), ("./cloudflared", &bin)])).unwrap(), bin);
    assert_eq!(extract_from_tgz(&tgz(&[("cloudflared", b"x")])).unwrap(), b"x");
    assert!(extract_from_tgz(&tgz(&[("other", b"x")])).unwrap_err().to_string().contains("no cloudflared"));
    assert!(extract_from_tgz(b"not gzip").is_err());
}

fn jwt(claims: serde_json::Value) -> String {
    let b = |v: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v);
    format!("{}.{}.{}", b(b"{}"), b(claims.to_string().as_bytes()), b(b"s"))
}

#[test]
fn access_tokens_are_read() {
    let t = jwt(serde_json::json!({ "email": "ana@example.com", "exp": 2000 }));
    assert_eq!(decode_jwt(&t), Some((Some("ana@example.com".into()), Some(2000))));
    let t = jwt(serde_json::json!({ "common_name": "ci-bot.access", "exp": 5 }));
    assert_eq!(decode_jwt(&t), Some((Some("ci-bot.access".into()), Some(5))));
    assert_eq!(decode_jwt("garbage"), None);

    let h = "ssh.example.com";
    let ok = classify_token(h, true, &format!("{}\n", jwt(serde_json::json!({ "email": "a@b", "exp": 2000 }))), "", 1000);
    assert_eq!((ok.state, ok.identity.as_deref(), ok.expires_at), (AccessState::LoggedIn, Some("a@b"), Some(2000)));
    let old = classify_token(h, true, &jwt(serde_json::json!({ "email": "a@b", "exp": 999 })), "", 1000);
    assert_eq!(old.state, AccessState::Expired);
    let none = classify_token(h, false, "", "Unable to find token for provided application. Please run login command to generate token.", 1000);
    assert_eq!(none.state, AccessState::LoggedOut);
    let open = classify_token(h, false, "", "failed to find Access application at https://ssh.example.com", 1000);
    assert_eq!(open.state, AccessState::NotProtected);
    let odd = classify_token(h, false, "", "panic: something new\n", 1000);
    assert_eq!((odd.state, odd.message.as_deref()), (AccessState::Unknown, Some("panic: something new")));
}

// ---- Which binary ------------------------------------------------------------

/// Tests that change the process-wide cloudflared choice take turns.
async fn binary_choice_lock() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    LOCK.lock().await
}

#[tokio::test]
async fn binary_choice_custom_then_managed_then_path() {
    let _turn = binary_choice_lock().await;
    let dir = scratch("locate");
    let cfg = Config::default();
    let (source, _) = locate(&dir, &cfg);
    assert!(matches!(source, BinarySource::Path | BinarySource::Missing));

    std::fs::create_dir_all(dir.join("bin")).unwrap();
    std::fs::copy(fake_cloudflared(), managed_path(&dir)).unwrap();
    assert_eq!(locate(&dir, &cfg), (BinarySource::Managed, Some(managed_path(&dir))));

    let custom = Config { custom_path: Some(fake_cloudflared().display().to_string()) };
    assert_eq!(locate(&dir, &custom), (BinarySource::Custom, Some(fake_cloudflared())));

    // The manager reports it, and proxy commands start running it.
    let m = Manager::from_dir(dir.clone());
    let s = m.status().await;
    assert_eq!((s.source, s.version.as_deref()), (BinarySource::Managed, Some("2099.1.0")));
    assert_eq!(proxy_command::resolve_cloudflared().unwrap(), managed_path(&dir));

    let s = m.set_custom_path(Some(fake_cloudflared().display().to_string())).await.unwrap();
    assert_eq!(s.source, BinarySource::Custom);
    assert_eq!(proxy_command::resolve_cloudflared().unwrap(), fake_cloudflared());
    let err = m.set_custom_path(Some(dir.join("nope.exe").display().to_string())).await.unwrap_err();
    assert!(err.to_string().contains("doesn't exist"));
    let not_cf = dir.join("not-cloudflared.txt");
    std::fs::write(&not_cf, "x").unwrap();
    assert!(m.set_custom_path(Some(not_cf.display().to_string())).await.is_err());
    // Persisted for faro-cli.
    assert_eq!(read_config(&dir).custom_path, Some(fake_cloudflared().display().to_string()));

    m.set_custom_path(None).await.unwrap();
    std::fs::remove_file(managed_path(&dir)).unwrap();
    configure(&dir);
    // Back to PATH: the hint is cleared.
    assert_ne!(proxy_command::resolve_cloudflared().ok(), Some(managed_path(&dir)));
}

// ---- Installer against a fake GitHub ------------------------------------------

/// A fake GitHub serving a release whose asset for this platform is `bytes`
/// (the relay, so it runs and reports 2099.1.0). `digest`: Some(None) = no
/// digest, Some(Some(x)) = this digest, None = the real one.
async fn fake_github(bytes: Vec<u8>, digest: Option<Option<String>>, body: &str) -> Installer {
    let name = asset_name(std::env::consts::OS, std::env::consts::ARCH).unwrap();
    let payload = if name.ends_with(".tgz") { tgz(&[("cloudflared", &bytes)]) } else { bytes };
    let real = format!("sha256:{:x}", Sha256::digest(&payload));
    let digest = digest.unwrap_or(Some(real));
    let mut routes = HashMap::new();
    routes.insert("/asset".to_string(), payload);
    // The release JSON names the server's own URL, so it's added after.
    let base = http_server(routes).await;
    let release = serde_json::json!({
        "tag_name": "2099.1.0",
        "body": body.replace("{NAME}", name),
        "assets": [
            { "name": "cloudflared-unrelated.deb", "browser_download_url": format!("{base}/nope"), "digest": null },
            { "name": name, "browser_download_url": format!("{base}/asset"), "digest": digest },
        ],
    });
    set_route(&base, "/release", serde_json::to_vec(&release).unwrap());
    Installer::new(&format!("{base}/release"))
}

// Routes are filled after the server knows its own address.
fn route_table() -> &'static StdMutex<HashMap<String, HashMap<String, Vec<u8>>>> {
    static T: OnceLock<StdMutex<HashMap<String, HashMap<String, Vec<u8>>>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

fn set_route(base: &str, path: &str, body: Vec<u8>) {
    route_table().lock().unwrap().entry(base.to_string()).or_default().insert(path.to_string(), body);
}

/// Serves the route table's paths for this server over HTTP/1.1 until the
/// test ends.
async fn http_server(initial: HashMap<String, Vec<u8>>) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    route_table().lock().unwrap().insert(base.clone(), initial);
    let key = base.clone();
    tokio::spawn(async move {
        while let Ok((mut sock, _)) = listener.accept().await {
            let key = key.clone();
            tokio::spawn(async move {
                let mut req = Vec::new();
                let mut buf = [0u8; 1024];
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    match sock.read(&mut buf).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => req.extend_from_slice(&buf[..n]),
                    }
                }
                let line = String::from_utf8_lossy(&req).lines().next().unwrap_or("").to_string();
                let path = line.split_whitespace().nth(1).unwrap_or("/").to_string();
                let body = route_table().lock().unwrap().get(&key).and_then(|r| r.get(&path).cloned());
                let (status, body) = match body {
                    Some(b) => ("200 OK", b),
                    None => ("404 Not Found", b"not found".to_vec()),
                };
                let head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.write_all(&body).await;
            });
        }
    });
    base
}

fn relay_bytes() -> Vec<u8> {
    std::fs::read(relay_exe()).unwrap()
}

#[tokio::test]
async fn installs_a_verified_release() {
    let dest = scratch("install").join("bin").join(exe_name());
    let installer = fake_github(relay_bytes(), None, "").await;
    assert_eq!(installer.install(&dest).await.unwrap(), "2099.1.0");
    assert_eq!(std::fs::read(&dest).unwrap(), relay_bytes());
    assert_eq!(version(&dest).await.as_deref(), Some("2099.1.0"));
    assert!(!dest.with_extension("download").exists() && !dest.with_extension("old").exists());
}

#[tokio::test]
async fn a_tampered_download_is_refused_and_nothing_changes() {
    let dir = scratch("tamper").join("bin");
    let dest = dir.join(exe_name());
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(&dest, b"previous copy").unwrap();
    let bad = Some(Some(format!("sha256:{}", "0".repeat(64))));
    let err = fake_github(relay_bytes(), bad, "").await.install(&dest).await.unwrap_err();
    assert!(err.to_string().contains("failed its checksum"), "{err:#}");
    assert_eq!(std::fs::read(&dest).unwrap(), b"previous copy");
    assert!(!dest.with_extension("download").exists());
}

#[tokio::test]
async fn release_notes_checksum_is_the_fallback() {
    let bytes = relay_bytes();
    let name = asset_name(std::env::consts::OS, std::env::consts::ARCH).unwrap();
    let payload = if name.ends_with(".tgz") { tgz(&[("cloudflared", &bytes)]) } else { bytes.clone() };
    let body = format!("### SHA256 Checksums:\n```\n{{NAME}}: {:x}\n```", Sha256::digest(&payload));
    let dest = scratch("notes").join("bin").join(exe_name());
    fake_github(bytes.clone(), Some(None), &body).await.install(&dest).await.unwrap();
    assert!(dest.is_file());

    // No digest and no table: refuse rather than install unverified.
    let dest = scratch("unverified").join("bin").join(exe_name());
    let err = fake_github(bytes, Some(None), "no checksums here").await.install(&dest).await.unwrap_err();
    assert!(err.to_string().contains("can't be verified"), "{err:#}");
    assert!(!dest.exists());
}

#[tokio::test]
async fn a_download_that_does_not_run_is_not_installed() {
    let dest = scratch("broken").join("bin").join(exe_name());
    let err = fake_github(vec![0u8; 4096], None, "").await.install(&dest).await.unwrap_err();
    assert!(err.to_string().contains("doesn't run on this machine"), "{err:#}");
    assert!(!dest.exists() && !dest.with_extension("download").exists());
}

#[tokio::test]
async fn updating_while_the_old_copy_is_running() {
    let dest = scratch("busy").join("bin").join(exe_name());
    fake_github(relay_bytes(), None, "").await.install(&dest).await.unwrap();
    // A session is using the managed copy right now.
    let mut running = tokio::process::Command::new(&dest)
        .args(["--target", "127.0.0.1:1", "--mode", "hang"])
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    tokio::time::sleep(Duration::from_millis(300)).await;
    fake_github(relay_bytes(), None, "").await.install(&dest).await.expect("update over a running copy");
    assert_eq!(version(&dest).await.as_deref(), Some("2099.1.0"));
    let _ = running.kill().await;
}

#[tokio::test]
async fn manager_install_switches_faro_to_its_copy() {
    let _turn = binary_choice_lock().await;
    let dir = scratch("manager");
    let m = Manager::from_dir(dir.clone());
    let installer = fake_github(relay_bytes(), None, "").await;
    let checked = m.check(&installer).await;
    assert_eq!(checked.latest.as_deref(), Some("2099.1.0"));
    let s = m.install(&installer).await.unwrap();
    assert_eq!((s.source, s.version.as_deref()), (BinarySource::Managed, Some("2099.1.0")));
    assert!(!s.update_available);
    assert_eq!(s.message.as_deref(), Some("Installed cloudflared 2099.1.0"));
    // GitHub unreachable: a status with the reason, not an error.
    let offline = m.check(&Installer::new("http://127.0.0.1:1/release")).await;
    assert!(offline.message.unwrap().contains("couldn't reach GitHub"));
    proxy_command::set_cloudflared_path(None);
}

// ---- Access sign-in against the fake cloudflared --------------------------------

fn cf_state(name: &str, body: &str) {
    std::fs::write(fake_cloudflared().parent().unwrap().join(name), body).unwrap();
}

fn cf_clear(host: &str) {
    for f in [format!("token-{host}.json"), format!("login-{host}.json"), format!("notprotected-{host}")] {
        let _ = std::fs::remove_file(fake_cloudflared().parent().unwrap().join(f));
    }
}

#[tokio::test]
async fn sign_in_status_login_and_expiry() {
    let host = "status.faro.test";
    cf_clear(host);
    let bin = fake_cloudflared();
    assert_eq!(access_status(&bin, host).await.state, AccessState::LoggedOut);

    // A browser sign-in: the URL is surfaced once, then the identity shows.
    cf_state(&format!("login-{host}.json"), r#"{"email":"ana@example.com","delayMs":400}"#);
    let urls = Arc::new(StdMutex::new(Vec::new()));
    let u = urls.clone();
    let s = access_login(&bin, host, move |url| u.lock().unwrap().push(url)).await.unwrap();
    assert_eq!((s.state, s.identity.as_deref()), (AccessState::LoggedIn, Some("ana@example.com")));
    let left = s.expires_at.unwrap() - now();
    assert!((3500..=3600).contains(&left), "{left}");
    let urls = urls.lock().unwrap().clone();
    assert_eq!(urls.len(), 1, "{urls:?}");
    assert!(urls[0].contains("/cdn-cgi/access/cli?aud=status.faro.test"));
    assert_eq!(access_status(&bin, host).await.state, AccessState::LoggedIn);

    // The token runs out.
    cf_state(&format!("token-{host}.json"), &format!(r#"{{"email":"ana@example.com","exp":{}}}"#, now() - 60));
    assert_eq!(access_status(&bin, host).await.state, AccessState::Expired);

    // A service token identifies by its name.
    cf_state(&format!("token-{host}.json"), &format!(r#"{{"common_name":"ci-bot.access","exp":{}}}"#, now() + 600));
    assert_eq!(access_status(&bin, host).await.identity.as_deref(), Some("ci-bot.access"));
    cf_clear(host);
}

#[tokio::test]
async fn hosts_without_access_need_no_sign_in() {
    let host = "open.faro.test";
    cf_clear(host);
    cf_state(&format!("notprotected-{host}"), "");
    let bin = fake_cloudflared();
    assert_eq!(access_status(&bin, host).await.state, AccessState::NotProtected);
    assert_eq!(access_login(&bin, host, |_| {}).await.unwrap().state, AccessState::NotProtected);
    cf_clear(host);
}

#[tokio::test]
async fn a_cancelled_sign_in_is_an_error() {
    let host = "cancel.faro.test";
    cf_clear(host);
    let err = access_login(&fake_cloudflared(), host, |_| {}).await.unwrap_err();
    assert!(err.to_string().contains("sign-in for cancel.faro.test failed"), "{err:#}");
    assert!(err.to_string().contains("cancelled"), "{err:#}");
}

/// A Cloudflare-routed profile run by the fake cloudflared, which checks the
/// token before relaying to the in-process SSH server.
fn access_profile(host: &str, port: u16, extra: &str) -> crate::profiles::ConnectionProfile {
    crate::proxy_command::e2e::profile(
        host,
        format!(
            "{} access ssh --hostname %h --access --target 127.0.0.1:{port} {extra}",
            quoted(&fake_cloudflared())
        ),
    )
}

#[tokio::test]
async fn a_connect_that_needed_a_sign_in_says_who_is_signed_in() {
    let host = "who.faro.test";
    cf_clear(host);
    cf_state(&format!("login-{host}.json"), r#"{"email":"ana@example.com","delayMs":300}"#);
    let port = ssh_server().await;
    let prompter = Arc::new(Prompter::default());
    let conn = crate::session::ssh_connect(&access_profile(host, port, ""), Arc::new(Verifier::default()), prompter.clone())
        .await
        .unwrap();
    assert_eq!(crate::proxy_command::e2e::exec_str(&conn, "echo in").await, "in");
    let mut notices = Vec::new();
    for _ in 0..50 {
        notices = prompter.0.lock().unwrap().clone();
        if notices.len() >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(notices[0].1.as_deref().is_some_and(|u| u.contains("aud=who.faro.test")), "{notices:?}");
    assert_eq!(notices[1], ("Logged in to Cloudflare as ana@example.com".to_string(), None));

    // Already signed in: no sign-in, no notices.
    let quiet = Arc::new(Prompter::default());
    crate::session::ssh_connect(&access_profile(host, port, ""), Arc::new(Verifier::default()), quiet.clone())
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(quiet.0.lock().unwrap().is_empty());
    cf_clear(host);
}

/// The issue's acceptance: a token that expires mid-session brings the
/// sign-in back and the same operation resumes, instead of failing.
#[tokio::test]
async fn expiry_mid_session_pauses_for_sign_in_and_resumes() {
    static NOTICES: OnceLock<StdMutex<Vec<(String, Option<String>)>>> = OnceLock::new();
    let notices = NOTICES.get_or_init(Default::default);
    crate::proxy_command::set_notice_hook(|m, u| {
        if let Some(n) = NOTICES.get() {
            n.lock().unwrap().push((m.to_string(), u.map(String::from)));
        }
    });

    let host = "expiry.faro.test";
    cf_clear(host);
    cf_state(&format!("token-{host}.json"), &format!(r#"{{"email":"ana@example.com","exp":{}}}"#, now() + 3600));
    let port = ssh_server().await;
    // The tunnel drops after 1.5 s, as cloudflared does when Access stops
    // accepting the token.
    let p = access_profile(host, port, "--die-after-ms 1500");
    let ssh = crate::session::ssh_session_for_tests(&p, Arc::new(Verifier::default())).await.unwrap();
    assert_eq!(ssh.exec("echo before").await.unwrap().stdout, "before");

    // Meanwhile the token expires; signing in takes the user a moment.
    cf_clear(host);
    cf_state(&format!("login-{host}.json"), r#"{"email":"ana@example.com","delayMs":1200}"#);
    tokio::time::sleep(Duration::from_millis(2500)).await;

    let started = std::time::Instant::now();
    let out = ssh.exec("echo after").await.expect("the op resumes after the sign-in");
    assert_eq!(out.stdout, "after");
    assert!(started.elapsed() >= Duration::from_millis(1200), "it waited for the sign-in");
    let seen = notices.lock().unwrap().clone();
    assert!(
        seen.iter().any(|(_, u)| u.as_deref().is_some_and(|u| u.contains("aud=expiry.faro.test"))),
        "the sign-in reached the UI: {seen:?}"
    );
    cf_clear(host);
}

#[test]
fn unreachable_hosts_say_so() {
    let s = classify_token("team.example", false, "", "failed to get app info: Head \"https://team.example\": dial tcp: lookup team.example: no such host", 1);
    assert_eq!(s.state, AccessState::Unknown);
    assert_eq!(s.message.as_deref(), Some("can't reach https://team.example (check the hostname and your network)"));
}

// ---- Short-lived SSH certificates (issue #55) --------------------------------

/// `ssh-gen` output goes to a scratch folder (for the fake and for Faro), and
/// the fake has a certificate for `principal` to hand out for `host`.
/// Held by each test that points Faro at an ssh-gen folder: that override
/// (`ssh_cert::tests::CLOUDFLARED_DIR`) is one global.
static SSHGEN_LOCK: StdMutex<()> = StdMutex::new(());

fn sshgen_lock() -> std::sync::MutexGuard<'static, ()> {
    SSHGEN_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

fn sshgen_setup(host: &str, principal: &str) -> PathBuf {
    let dir = scratch(&format!("sshgen-out-{host}"));
    cf_state(&format!("sshgen-dir-{host}"), &dir.to_string_lossy());
    *crate::ssh_cert::tests::CLOUDFLARED_DIR.lock().unwrap() = Some(dir.clone());
    let (_, cert, user) = crate::ssh_cert::tests::issue(&[principal], 300);
    cf_state(&format!("sshgen-{host}-key"), &user.to_openssh(ssh_key::LineEnding::LF).unwrap());
    cf_state(&format!("sshgen-{host}-cert.pub"), &cert);
    dir
}

fn sshgen_clear(host: &str) {
    cf_clear(host);
    for f in [format!("sshgen-{host}-key"), format!("sshgen-{host}-cert.pub")] {
        let _ = std::fs::remove_file(fake_cloudflared().parent().unwrap().join(f));
    }
}

#[tokio::test]
async fn ssh_gen_signs_in_then_hands_over_a_fresh_pair() {
    let host = "cert.faro.test";
    sshgen_clear(host);
    let _serial = sshgen_lock();
    let dir = sshgen_setup(host, "jane.doe");
    cf_state(&format!("login-{host}.json"), r#"{"email":"jane.doe@example.com","delayMs":200}"#);
    let urls = Arc::new(StdMutex::new(Vec::new()));
    let u = urls.clone();
    let (key, cert) = ssh_gen_in(&fake_cloudflared(), host, &dir, move |url| u.lock().unwrap().push(url))
        .await
        .unwrap();
    assert!(crate::ssh_cert::matches(&key, &cert));
    assert_eq!(cert.valid_principals(), ["jane.doe".to_string()]);
    assert_eq!(urls.lock().unwrap().len(), 1, "the sign-in page reached the UI");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "the key and certificate are deleted after use");

    // Signed in now: the next one needs no browser.
    let quiet = Arc::new(StdMutex::new(Vec::<String>::new()));
    let q = quiet.clone();
    ssh_gen_in(&fake_cloudflared(), host, &dir, move |url| q.lock().unwrap().push(url)).await.unwrap();
    assert!(quiet.lock().unwrap().is_empty());
    sshgen_clear(host);
}

#[tokio::test]
async fn ssh_gen_failures_say_what_is_missing() {
    let host = "noca.faro.test";
    sshgen_clear(host);
    let dir = scratch("sshgen-noca");
    cf_state(&format!("token-{host}.json"), &format!(r#"{{"email":"jane@example.com","exp":{}}}"#, now() + 600));
    let err = ssh_gen_in(&fake_cloudflared(), host, &dir, |_| {}).await.unwrap_err();
    assert!(err.to_string().contains("Cloudflare didn't issue an SSH certificate for noca.faro.test"), "{err:#}");
    assert!(err.to_string().contains("short-lived certificate CA"), "{err:#}");

    cf_state(&format!("notprotected-{host}"), "");
    let err = ssh_gen_in(&fake_cloudflared(), host, &dir, |_| {}).await.unwrap_err();
    assert!(err.to_string().contains("has no Cloudflare Access application"), "{err:#}");
    sshgen_clear(host);
}

#[test]
fn certificate_login_needs_the_access_route_and_a_person() {
    use crate::profiles::{ProxyCommandConfig, ProxyCommandKind};
    let _ = proxy_command::access_cert_target(None, "h", 22, "u").unwrap_err();
    let mut cfg = ProxyCommandConfig {
        kind: ProxyCommandKind::Command,
        command: "nc %h %p".into(),
        hostname: None,
        service_token_id: None,
        service_token_secret: None,
    };
    let err = proxy_command::access_cert_target(Some(&cfg), "h", 22, "u").unwrap_err();
    assert!(err.to_string().contains("needs the Cloudflare Access route"), "{err:#}");
    // A cloudflared ProxyCommand counts, with its --hostname.
    cfg.command = format!("{} access ssh --hostname %h", quoted(&fake_cloudflared()));
    let (bin, hostname) = proxy_command::access_cert_target(Some(&cfg), "ssh.example.com", 22, "u").unwrap();
    assert_eq!((bin, hostname.as_str()), (fake_cloudflared(), "ssh.example.com"));
    // Service tokens carry no person to issue a certificate for.
    cfg.kind = ProxyCommandKind::Cloudflare;
    cfg.service_token_id = Some("id.access".into());
    cfg.service_token_secret = Some("s".into());
    let err = proxy_command::access_cert_target(Some(&cfg), "h", 22, "u").unwrap_err();
    assert!(err.to_string().contains("uses an Access service token"), "{err:#}");
}

/// The whole connect: tunnel, sign-in, certificate. The in-process server
/// takes no certificates, so this ends at the refusal, which must name the
/// principal Cloudflare issued and the user the server refused.
#[tokio::test]
async fn a_refused_cloudflare_certificate_names_principal_and_user() {
    let host = "refused.faro.test";
    sshgen_clear(host);
    let _serial = sshgen_lock();
    let dir = sshgen_setup(host, "jane.doe");
    cf_state(&format!("token-{host}.json"), &format!(r#"{{"email":"jane.doe@example.com","exp":{}}}"#, now() + 600));
    let port = ssh_server().await;
    let mut p = access_profile(host, port, "");
    p.username = "deploy".into();
    p.auth = crate::profiles::AuthMethod::CloudflareCert;
    let err = match crate::session::ssh_connect(&p, Arc::new(Verifier::default()), Arc::new(Prompter::default())).await {
        Ok(_) => panic!("the server takes no certificates"),
        Err(e) => e,
    };
    assert!(
        err.to_string().contains("Cloudflare issued a certificate for `jane.doe`, but the server refused it for user `deploy`"),
        "{err:#}"
    );
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    sshgen_clear(host);
}

// ---- Live: a real sshd that trusts only an SSH CA (scripts/cert-lab.yml) -----
//
// FARO_LIVE_CERT=127.0.0.1:2223 FARO_LIVE_CERT_CA=<repo>/scripts/.cert-lab/ca
// cargo test -p faro --lib live_cert -- --ignored --test-threads=1

struct CertLab {
    port: u16,
    ca: ssh_key::PrivateKey,
}

fn cert_lab() -> CertLab {
    let addr = std::env::var("FARO_LIVE_CERT").expect("FARO_LIVE_CERT=host:port");
    let ca = std::env::var("FARO_LIVE_CERT_CA").expect("FARO_LIVE_CERT_CA=path to the lab CA key");
    CertLab {
        port: addr.rsplit(':').next().unwrap().parse().unwrap(),
        ca: ssh_key::PrivateKey::read_openssh_file(std::path::Path::new(&ca)).unwrap(),
    }
}

impl CertLab {
    /// A certificate for `public`, signed by the lab CA.
    fn sign(&self, public: ssh_key::public::KeyData, principals: &[&str], valid_for: i64) -> String {
        use ssh_key::{certificate, rand_core::OsRng};
        let now = now() as u64;
        let before = (now as i64 + valid_for) as u64;
        let mut b = certificate::Builder::new_with_random_nonce(&mut OsRng, public, now - 120, before).unwrap();
        b.cert_type(certificate::CertType::User).unwrap().key_id("faro-live").unwrap();
        for p in principals {
            b.valid_principal(*p).unwrap();
        }
        b.sign(&self.ca).unwrap().to_openssh().unwrap()
    }

    /// What `cloudflared access ssh-gen` hands out: a SEC1 P-256 key and its
    /// certificate.
    fn ssh_gen_pair(&self, principals: &[&str], valid_for: i64) -> (String, String) {
        use p256::elliptic_curve::sec1::ToEncodedPoint;
        let secret = p256::SecretKey::random(&mut ssh_key::rand_core::OsRng);
        let point = secret.public_key().to_encoded_point(false);
        let public = ssh_key::public::KeyData::Ecdsa(ssh_key::public::EcdsaPublicKey::from_sec1_bytes(point.as_bytes()).unwrap());
        let pem = secret.to_sec1_pem(p256::pkcs8::LineEnding::LF).unwrap().to_string();
        (pem, self.sign(public, principals, valid_for))
    }

    fn profile(&self, user: &str, auth: crate::profiles::AuthMethod) -> crate::profiles::ConnectionProfile {
        let mut p: crate::profiles::ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id": format!("live-cert-{user}"), "name": "cert-lab", "protocol": "sftp",
            "host": "127.0.0.1", "port": self.port, "username": user,
            "auth": { "kind": "agent" },
        }))
        .unwrap();
        p.auth = auth;
        p
    }

    /// Through the fake cloudflared, which relays to the lab sshd.
    fn access_profile(&self, host: &str, user: &str) -> crate::profiles::ConnectionProfile {
        let mut p = access_profile(host, self.port, "");
        p.username = user.into();
        p.auth = crate::profiles::AuthMethod::CloudflareCert;
        p
    }
}

async fn connect(p: &crate::profiles::ConnectionProfile) -> Result<crate::session::SshConnection> {
    crate::session::ssh_connect(p, Arc::new(Verifier::default()), Arc::new(Prompter::default())).await
}

fn expect_err(r: Result<crate::session::SshConnection>) -> String {
    match r {
        Ok(_) => panic!("the server should have refused this login"),
        Err(e) => format!("{e:#}"),
    }
}

/// Acceptance: key file auth with an OpenSSH certificate, for a CA that has
/// nothing to do with Cloudflare.
#[tokio::test]
#[ignore = "needs scripts/cert-lab.yml"]
async fn live_cert_key_file_with_certificate() {
    use ssh_key::{rand_core::OsRng, Algorithm, LineEnding, PrivateKey};
    let lab = cert_lab();
    let dir = scratch("live-cert-key");
    let user = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
    let key = dir.join("id_ed25519");
    std::fs::write(&key, user.to_openssh(LineEnding::LF).unwrap()).unwrap();
    let key_auth = |cert: Option<&std::path::Path>| crate::profiles::AuthMethod::Key {
        path: key.to_string_lossy().into_owned(),
        passphrase: None,
        cert_path: cert.map(|c| c.to_string_lossy().into_owned()),
    };

    // No certificate: the server has no authorized_keys, so the bare key fails.
    let err = expect_err(connect(&lab.profile("jane.doe", key_auth(None))).await);
    assert!(err.contains("Authentication failed"), "{err}");

    // `<key>-cert.pub` is picked up on its own.
    let cert = lab.sign(user.public_key().key_data().clone(), &["jane.doe"], 600);
    std::fs::write(dir.join("id_ed25519-cert.pub"), &cert).unwrap();
    let conn = connect(&lab.profile("jane.doe", key_auth(None))).await.unwrap();
    assert_eq!(crate::proxy_command::e2e::exec_str(&conn, "whoami").await.trim(), "jane.doe");

    // A chosen certificate file, logging in to a shared account by principal.
    let chosen = dir.join("chosen-cert.pub");
    std::fs::write(&chosen, &cert).unwrap();
    std::fs::remove_file(dir.join("id_ed25519-cert.pub")).unwrap();
    let conn = connect(&lab.profile("shared", key_auth(Some(&chosen)))).await.unwrap();
    assert_eq!(crate::proxy_command::e2e::exec_str(&conn, "whoami").await.trim(), "shared");

    // A principal the account doesn't accept.
    let err = expect_err(connect(&lab.profile("deploy", key_auth(Some(&chosen)))).await);
    assert!(err.contains("the SSH certificate is for `jane.doe`, but the server refused it for user `deploy`"), "{err}");

    // An expired one.
    std::fs::write(&chosen, lab.sign(user.public_key().key_data().clone(), &["jane.doe"], -60)).unwrap();
    let err = expect_err(connect(&lab.profile("jane.doe", key_auth(Some(&chosen)))).await);
    assert!(err.contains("the SSH certificate has expired"), "{err}");

    // RSA: russh can only offer `ssh-rsa-cert-v01` (SHA-1), which OpenSSH
    // refuses. The error has to say so rather than blame the CA.
    let rsa = PrivateKey::from(ssh_key::private::RsaKeypair::random(&mut OsRng, 2048).unwrap());
    let rsa_key = dir.join("id_rsa");
    std::fs::write(&rsa_key, rsa.to_openssh(LineEnding::LF).unwrap()).unwrap();
    std::fs::write(dir.join("id_rsa-cert.pub"), lab.sign(rsa.public_key().key_data().clone(), &["jane.doe"], 600)).unwrap();
    let rsa_auth = crate::profiles::AuthMethod::Key {
        path: rsa_key.to_string_lossy().into_owned(),
        passphrase: None,
        cert_path: None,
    };
    let err = expect_err(connect(&lab.profile("jane.doe", rsa_auth)).await);
    assert!(err.contains("Use an Ed25519 or ECDSA key for the certificate"), "{err}");
}

/// Acceptance: the Cloudflare auth type logs in with no SSH key installed,
/// gets a fresh certificate on every connect, and explains a principal
/// mismatch.
#[tokio::test]
#[ignore = "needs scripts/cert-lab.yml"]
async fn live_cert_cloudflare_short_lived_certificate() {
    let lab = cert_lab();
    let host = "lab.faro.test";
    sshgen_clear(host);
    let _serial = sshgen_lock();
    let out = sshgen_setup(host, "unused");
    cf_state(&format!("token-{host}.json"), &format!(r#"{{"email":"jane.doe@example.com","exp":{}}}"#, now() + 600));
    let issue = |valid_for: i64| {
        let (key, cert) = lab.ssh_gen_pair(&["jane.doe"], valid_for);
        cf_state(&format!("sshgen-{host}-key"), &key);
        cf_state(&format!("sshgen-{host}-cert.pub"), &cert);
        cert
    };

    let first = issue(120);
    let conn = connect(&lab.access_profile(host, "jane.doe")).await.unwrap();
    assert_eq!(crate::proxy_command::e2e::exec_str(&conn, "whoami").await.trim(), "jane.doe");
    assert_eq!(std::fs::read_dir(&out).unwrap().count(), 0, "the key and certificate are deleted after use");

    // A reconnect gets the certificate cloudflared issues then, not the old one.
    let second = issue(120);
    assert_ne!(first, second);
    let conn = connect(&lab.access_profile(host, "shared")).await.unwrap();
    assert_eq!(crate::proxy_command::e2e::exec_str(&conn, "whoami").await.trim(), "shared");

    // An account that doesn't accept the principal.
    issue(120);
    let err = expect_err(connect(&lab.access_profile(host, "deploy")).await);
    assert!(
        err.contains("Cloudflare issued a certificate for `jane.doe`, but the server refused it for user `deploy`. Add `jane.doe` to the server's principals file, or log in as `jane.doe`."),
        "{err}"
    );

    // Removed from the Access policy: cloudflared can't get a token or a
    // certificate, and nothing changed on the server.
    sshgen_clear(host);
    let err = expect_err(connect(&lab.access_profile(host, "jane.doe")).await);
    assert!(err.contains("Cloudflare Access"), "{err}");
    sshgen_clear(host);
}
