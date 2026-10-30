//! Test helper for `proxy_command` (Plan 28): a ProxyCommand that relays its
//! stdin/stdout to a TCP target, and can misbehave the ways real ones do.
//! Copied to a file named `cloudflared` it also stands in for cloudflared.
//!
//!   stdio_relay [access ssh --hostname H] --target HOST:PORT [--mode M]
//!               [--say LINE]... [--argv-file PATH] [--expect-token ID:SECRET]
//!               [--die-after-ms N] [--pid-file PATH] [--linger]
//!               [--login-delay-ms N]
//!
//! Modes: relay (default), fail (say lines on stderr, exit 3), hang (never
//! answer), login (print a cloudflared-style sign-in URL, wait, then relay),
//! login-fail (print the URL, then give up), token (relay only with the
//! expected TUNNEL_SERVICE_TOKEN_* env), garbage (answer with an HTTP error
//! instead of SSH). `--linger` keeps the process alive after the relay ends,
//! so only being killed stops it.
//!
//! Plan 29: `--version` reports a version, and `access token|login|ssh`
//! emulate cloudflared's Access sign-in with files next to the executable,
//! per hostname H: `token-H.json` is the cached token (`{"email","exp"}`),
//! `login-H.json` is what a browser sign-in yields (plus `delayMs`), and
//! `notprotected-H` means no Access application. `access ssh --access` without a
//! valid token signs in first (if it can), then relays to `--target`.
//! `access ssh-gen` does the same check, then writes a short-lived key and
//! certificate (see `access_ssh_gen`).

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    if args.first().map(String::as_str) == Some("--version") {
        println!("cloudflared version 2099.1.0 (built 2099-01-01-0000 UTC)");
        return;
    }
    if args.first().map(String::as_str) == Some("access") {
        let host = flag("--app")
            .or_else(|| flag("--hostname"))
            .unwrap_or_default()
            .trim_start_matches("https://")
            .trim_end_matches('/')
            .to_string();
        match args.get(1).map(String::as_str) {
            Some("token") => access_token(&host),
            Some("login") => access_login(&host),
            Some("ssh-gen") => access_ssh_gen(&host),
            // `cloudflared access tcp --hostname H --url 127.0.0.1:PORT`:
            // bind the local port and stay up until killed. A stand-in for
            // the real listener so forward tests can watch the process.
            Some("tcp") => access_tcp(&args, &host),
            // Opt-in, so the plain relay tests keep their fake cloudflared.
            Some("ssh") if args.iter().any(|a| a == "--access") => {
                access_ready(&host);
            }
            // The app's own `access ssh --hostname H`, relayed to `target-H`.
            Some("ssh") => {
                if let Ok(target) = std::fs::read_to_string(state_file(&format!("target-{host}"))) {
                    // Which service token it was given (issue #57), if any.
                    if let Ok(id) = std::env::var("TUNNEL_SERVICE_TOKEN_ID") {
                        let _ = std::fs::write(state_file(&format!("envlog-{host}")), id);
                    }
                    access_ready(&host);
                    relay(target.trim(), None);
                    std::process::exit(0);
                }
            }
            _ => {}
        }
    }
    let say: Vec<&String> = args
        .iter()
        .enumerate()
        .filter(|(i, a)| *a == "--say" && *i + 1 < args.len())
        .map(|(i, _)| &args[i + 1])
        .collect();
    if let Some(path) = flag("--pid-file") {
        std::fs::write(path, std::process::id().to_string()).unwrap();
    }
    if let Some(path) = flag("--argv-file") {
        std::fs::write(path, args.join("\n")).unwrap();
    }
    for line in &say {
        eprintln!("{line}");
    }
    match flag("--mode").as_deref().unwrap_or("relay") {
        "fail" => std::process::exit(3),
        "hang" => loop {
            std::thread::sleep(Duration::from_secs(60));
        },
        "garbage" => {
            let mut out = std::io::stdout();
            let _ = out.write_all(b"HTTP/1.1 502 Bad Gateway\r\n\r\n");
            let _ = out.flush();
            eprintln!("websocket: bad handshake");
            std::process::exit(1);
        }
        mode @ ("login" | "login-fail") => {
            eprintln!("A browser window should have opened at the following URL:\n");
            eprintln!("https://team.cloudflareaccess.com/cdn-cgi/access/cli?aud=faro-test&token=abc\n");
            eprintln!("If the browser failed to open, please visit the URL above directly in your browser.");
            let delay = flag("--login-delay-ms").and_then(|v| v.parse().ok()).unwrap_or(1500);
            std::thread::sleep(Duration::from_millis(delay));
            if mode == "login-fail" {
                eprintln!("failed to find token: login timed out");
                std::process::exit(1);
            }
        }
        "token" => {
            let want = flag("--expect-token").unwrap_or_default();
            let got = format!(
                "{}:{}",
                std::env::var("TUNNEL_SERVICE_TOKEN_ID").unwrap_or_default(),
                std::env::var("TUNNEL_SERVICE_TOKEN_SECRET").unwrap_or_default()
            );
            if got != want {
                eprintln!("failed to fetch token: 403 Forbidden");
                std::process::exit(1);
            }
        }
        _ => {}
    }
    let target = flag("--target").expect("--target HOST:PORT");
    relay(&target, flag("--die-after-ms").and_then(|v| v.parse().ok()));
    if args.iter().any(|a| a == "--linger") {
        loop {
            std::thread::sleep(Duration::from_secs(60));
        }
    }
}

fn state_file(name: &str) -> std::path::PathBuf {
    std::env::current_exe().unwrap().parent().unwrap().join(name)
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64
}

fn token(host: &str) -> Option<serde_json::Value> {
    serde_json::from_slice(&std::fs::read(state_file(&format!("token-{host}.json"))).ok()?).ok()
}

fn jwt(claims: &serde_json::Value) -> String {
    use base64::Engine as _;
    let b = |v: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(v);
    format!("{}.{}.{}", b(br#"{"alg":"RS256"}"#), b(claims.to_string().as_bytes()), b(b"sig"))
}

fn not_protected(host: &str) {
    if state_file(&format!("notprotected-{host}")).exists() {
        eprintln!("failed to find Access application at https://{host}");
        std::process::exit(1);
    }
}

fn access_token(host: &str) -> ! {
    not_protected(host);
    match token(host) {
        Some(t) => {
            println!("{}", jwt(&t));
            std::process::exit(0)
        }
        None => {
            eprintln!("Unable to find token for provided application. Please run login command to generate token.");
            std::process::exit(1)
        }
    }
}

/// A browser sign-in: print the URL, wait for the "user", store the token.
fn sign_in(host: &str) -> bool {
    let Ok(raw) = std::fs::read(state_file(&format!("login-{host}.json"))) else {
        return false;
    };
    let login: serde_json::Value = serde_json::from_slice(&raw).unwrap();
    eprintln!("A browser window should have opened at the following URL:\n");
    eprintln!("https://team.cloudflareaccess.com/cdn-cgi/access/cli?aud={host}&token=abc\n");
    std::thread::sleep(Duration::from_millis(login["delayMs"].as_u64().unwrap_or(300)));
    let mut claims = login.clone();
    claims.as_object_mut().unwrap().remove("delayMs");
    if claims.get("exp").is_none() {
        claims["exp"] = (now() + 3600).into();
    }
    std::fs::write(state_file(&format!("token-{host}.json")), claims.to_string()).unwrap();
    true
}

fn access_login(host: &str) -> ! {
    not_protected(host);
    if sign_in(host) {
        std::process::exit(0)
    }
    eprintln!("failed to fetch token: the sign-in was cancelled");
    std::process::exit(1)
}

/// `access ssh-gen` (issue #55): after the usual token check, writes the
/// pre-made `sshgen-H-key` / `sshgen-H-cert.pub` where cloudflared would put
/// its short-lived pair, which is the folder named in `sshgen-dir` (else
/// `~/.cloudflared`). No `sshgen-H-key` means no certificate CA.
fn access_ssh_gen(host: &str) -> ! {
    not_protected(host);
    access_ready(host);
    let (Ok(key), Ok(cert)) = (
        std::fs::read(state_file(&format!("sshgen-{host}-key"))),
        std::fs::read(state_file(&format!("sshgen-{host}-cert.pub"))),
    ) else {
        eprintln!("failed to generate SSH certificate: 404 Not Found (no short-lived certificate CA for {host})");
        std::process::exit(1)
    };
    // Per host first, so tests running side by side don't share a folder.
    let dir = std::fs::read_to_string(state_file(&format!("sshgen-dir-{host}")))
        .or_else(|_| std::fs::read_to_string(state_file("sshgen-dir")))
        .map(|d| std::path::PathBuf::from(d.trim()))
        .unwrap_or_else(|_| {
            let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).unwrap();
            std::path::PathBuf::from(home).join(".cloudflared")
        });
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{host}-cf_key")), key).unwrap();
    std::fs::write(dir.join(format!("{host}-cf_key-cert.pub")), cert).unwrap();
    std::fs::write(dir.join(format!("{host}-cf_key.pub")), b"").unwrap();
    std::process::exit(0)
}

/// `access ssh --access`: a valid token, or a sign-in that yields one.
fn access_ready(host: &str) {
    let valid = token(host).and_then(|t| t["exp"].as_i64()).is_some_and(|exp| exp > now());
    if !valid && !sign_in(host) {
        eprintln!("failed to find token for {host}");
        std::process::exit(1)
    }
}

/// `access tcp`: listen on `--url` until killed. `exit.faro.test` fails
/// immediately so the app can prove a crashed cloudflared is reaped.
/// Writes argv and the service-token env to the temp dir, keyed by hostname,
/// for the forward tests. The secret stays out of argv.
fn access_tcp(args: &[String], host: &str) -> ! {
    if host == "exit.faro.test" {
        eprintln!("cloudflared: simulated failure");
        std::process::exit(1);
    }
    let url = args.iter().position(|a| a == "--url").and_then(|i| args.get(i + 1)).cloned().unwrap_or_else(|| "127.0.0.1:0".into());
    let addr = url.trim().trim_start_matches("tcp://");
    let (listen_host, port) = addr.rsplit_once(':').unwrap_or(("127.0.0.1", "0"));
    let port: u16 = port.parse().unwrap_or(0);
    let bind_host = if listen_host == "localhost" { "127.0.0.1" } else { listen_host };
    let id = std::env::var("TUNNEL_SERVICE_TOKEN_ID").unwrap_or_default();
    let secret = std::env::var("TUNNEL_SERVICE_TOKEN_SECRET").unwrap_or_default();
    let safe: String = host.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
    let log = std::env::temp_dir().join(format!("faro-cf-tcp-{safe}.log"));
    let _ = std::fs::write(&log, format!("argv={}\nid={id}\nsecret={secret}\n", args.join(" ")));
    match std::net::TcpListener::bind((bind_host, port)) {
        Ok(listener) => {
            let _ = listener.set_nonblocking(true);
            loop {
                let _ = listener.accept();
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        Err(e) => {
            eprintln!("failed to bind {addr}: {e}");
            std::process::exit(1);
        }
    }
}

fn relay(target: &str, die_after_ms: Option<u64>) {
    let tcp = match TcpStream::connect(target) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("dial tcp {target}: {e}");
            std::process::exit(2);
        }
    };
    if let Some(ms) = die_after_ms {
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(ms));
            eprintln!("connection lost");
            std::process::exit(4);
        });
    }
    let mut up = tcp.try_clone().unwrap();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buf = [0u8; 16 * 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if up.write_all(&buf[..n]).is_err() {
                        break;
                    }
                }
            }
        }
        let _ = up.shutdown(Shutdown::Write);
    });
    let mut down = tcp;
    let mut stdout = std::io::stdout().lock();
    let mut buf = [0u8; 16 * 1024];
    loop {
        match down.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if stdout.write_all(&buf[..n]).and_then(|_| stdout.flush()).is_err() {
                    break;
                }
            }
        }
    }
}
