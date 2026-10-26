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

use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream};
use std::time::Duration;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let flag = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
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
