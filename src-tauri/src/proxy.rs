//! Client-side proxies (SOCKS5 and HTTP CONNECT) for the backends that dial
//! TCP themselves: SSH, FTP and the Faro agent. `dial` returns a socket that
//! is already tunneled to the target, so the protocol code on top runs
//! unchanged. reqwest / object_store backends get the same proxy as a URL
//! from `proxy_url`.
//!
//! The handshakes are blocking (FTP is synchronous); `dial_async` runs them
//! on a blocking thread and hands back a tokio socket.

use crate::profiles::{ConnectionProfile, ProxyConfig, ProxyKind};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use std::io::{Read, Write};
use std::net::{IpAddr, TcpStream, ToSocketAddrs};
use std::time::Duration;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the proxy may take to answer each handshake step.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(20);
/// Upper bound on an HTTP proxy's CONNECT response headers.
const MAX_HTTP_HEADER: usize = 16 * 1024;

impl ProxyKind {
    pub fn label(self) -> &'static str {
        match self {
            ProxyKind::Socks5 => "SOCKS5",
            ProxyKind::Http => "HTTP",
        }
    }
}

/// TCP connect to `host:port`, through `proxy` when set. The returned socket
/// has no read/write timeouts; callers set their own.
pub fn dial(proxy: Option<&ProxyConfig>, host: &str, port: u16) -> Result<TcpStream> {
    let Some(p) = proxy else {
        return connect_direct(host, port).with_context(|| format!("connect to {host}:{port}"));
    };
    let mut s = connect_direct(&p.host, p.port)
        .with_context(|| format!("connect to {} proxy {}:{}", p.kind.label(), p.host, p.port))?;
    s.set_read_timeout(Some(HANDSHAKE_TIMEOUT))?;
    s.set_write_timeout(Some(HANDSHAKE_TIMEOUT))?;
    match p.kind {
        ProxyKind::Socks5 => socks5_connect(&mut s, p, host, port),
        ProxyKind::Http => http_connect(&mut s, p, host, port),
    }
    .with_context(|| {
        format!(
            "{} proxy {}:{} could not open {host}:{port}",
            p.kind.label(),
            p.host,
            p.port
        )
    })?;
    s.set_read_timeout(None)?;
    s.set_write_timeout(None)?;
    Ok(s)
}

/// `dial` for async callers. Without a proxy this is a plain tokio connect.
pub async fn dial_async(
    proxy: Option<&ProxyConfig>,
    host: &str,
    port: u16,
) -> Result<tokio::net::TcpStream> {
    let Some(p) = proxy.cloned() else {
        return tokio::net::TcpStream::connect((host, port))
            .await
            .with_context(|| format!("connect to {host}:{port}"));
    };
    let host = host.to_string();
    let s = tokio::task::spawn_blocking(move || dial(Some(&p), &host, port))
        .await
        .map_err(|e| anyhow!("proxy dial task failed: {e}"))??;
    s.set_nonblocking(true)?;
    Ok(tokio::net::TcpStream::from_std(s)?)
}

/// The proxy as a URL for reqwest / object_store: `socks5h://` so the proxy
/// resolves DNS (internal names work), credentials percent-encoded.
pub fn proxy_url(p: &ProxyConfig) -> String {
    let scheme = match p.kind {
        ProxyKind::Socks5 => "socks5h",
        ProxyKind::Http => "http",
    };
    let auth = match p.username.as_deref().filter(|u| !u.is_empty()) {
        Some(user) => format!(
            "{}:{}@",
            utf8_percent_encode(user, NON_ALPHANUMERIC),
            utf8_percent_encode(p.password.as_deref().unwrap_or(""), NON_ALPHANUMERIC)
        ),
        None => String::new(),
    };
    let host = if p.host.contains(':') && !p.host.starts_with('[') {
        format!("[{}]", p.host)
    } else {
        p.host.clone()
    };
    format!("{scheme}://{auth}{host}:{}", p.port)
}

/// The proxy for a reqwest client builder.
pub fn reqwest_proxy(p: &ProxyConfig) -> Result<reqwest::Proxy> {
    reqwest::Proxy::all(proxy_url(p))
        .with_context(|| format!("invalid {} proxy {}:{}", p.kind.label(), p.host, p.port))
}

/// A reqwest client builder routed through the profile's proxy, if any.
pub fn http_client_builder(profile: &ConnectionProfile) -> Result<reqwest::ClientBuilder> {
    let builder = reqwest::Client::builder();
    Ok(match &profile.proxy {
        Some(p) => builder.proxy(reqwest_proxy(p)?),
        None => builder,
    })
}

/// Connect to the first address that answers within the timeout.
fn connect_direct(host: &str, port: u16) -> std::io::Result<TcpStream> {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    let mut last = None;
    for a in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&a, CONNECT_TIMEOUT) {
            Ok(s) => return Ok(s),
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "host resolved to no addresses")
    }))
}

fn credentials(p: &ProxyConfig) -> Option<(&str, &str)> {
    p.username
        .as_deref()
        .filter(|u| !u.is_empty())
        .map(|u| (u, p.password.as_deref().unwrap_or("")))
}

/// RFC 1928 CONNECT, with RFC 1929 username/password auth when configured.
/// Hostnames go to the proxy unresolved.
fn socks5_connect(s: &mut TcpStream, p: &ProxyConfig, host: &str, port: u16) -> Result<()> {
    let creds = credentials(p);
    if creds.is_some() {
        s.write_all(&[5, 2, 0x00, 0x02])?;
    } else {
        s.write_all(&[5, 1, 0x00])?;
    }
    let mut choice = [0u8; 2];
    s.read_exact(&mut choice).context("no SOCKS5 greeting reply")?;
    if choice[0] != 5 {
        bail!("not a SOCKS5 proxy");
    }
    match (choice[1], creds) {
        (0x00, _) => {}
        (0x02, Some((user, pass))) => {
            if user.len() > 255 || pass.len() > 255 {
                bail!("SOCKS5 username and password are limited to 255 bytes");
            }
            let mut msg = vec![1, user.len() as u8];
            msg.extend_from_slice(user.as_bytes());
            msg.push(pass.len() as u8);
            msg.extend_from_slice(pass.as_bytes());
            s.write_all(&msg)?;
            let mut status = [0u8; 2];
            s.read_exact(&mut status).context("no SOCKS5 auth reply")?;
            if status[1] != 0 {
                bail!("the proxy rejected the username or password");
            }
        }
        (0x02, None) | (0xff, None) => bail!("the proxy requires a username and password"),
        (0xff, Some(_)) => bail!("the proxy accepts none of the offered auth methods"),
        (m, _) => bail!("the proxy chose unsupported auth method {m:#04x}"),
    }

    let mut req = vec![5, 1, 0];
    match host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            req.push(1);
            req.extend_from_slice(&ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            req.push(4);
            req.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            if host.len() > 255 {
                bail!("hostname too long for SOCKS5");
            }
            req.push(3);
            req.push(host.len() as u8);
            req.extend_from_slice(host.as_bytes());
        }
    }
    req.extend_from_slice(&port.to_be_bytes());
    s.write_all(&req)?;

    let mut head = [0u8; 4];
    s.read_exact(&mut head).context("no SOCKS5 connect reply")?;
    if head[1] != 0 {
        bail!("{}", socks5_reply(head[1]));
    }
    // Skip the bound address the proxy reports.
    let addr_len = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len)?;
            len[0] as usize
        }
        t => bail!("malformed SOCKS5 reply (address type {t})"),
    };
    let mut rest = vec![0u8; addr_len + 2];
    s.read_exact(&mut rest)?;
    Ok(())
}

fn socks5_reply(code: u8) -> &'static str {
    match code {
        1 => "general SOCKS server failure",
        2 => "connection not allowed by the proxy's rules",
        3 => "network unreachable",
        4 => "host unreachable",
        5 => "connection refused by the target",
        6 => "TTL expired",
        7 => "command not supported by the proxy",
        8 => "address type not supported by the proxy",
        _ => "unknown SOCKS5 error",
    }
}

/// HTTP `CONNECT host:port`. The response is read a byte at a time so nothing
/// past the header block (the tunneled protocol's first bytes) is consumed.
fn http_connect(s: &mut TcpStream, p: &ProxyConfig, host: &str, port: u16) -> Result<()> {
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    let authority = if bare.contains(':') {
        format!("[{bare}]:{port}")
    } else {
        format!("{bare}:{port}")
    };
    let mut req = format!("CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n");
    if let Some((user, pass)) = credentials(p) {
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        req.push_str(&format!("Proxy-Authorization: Basic {token}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes())?;

    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        if buf.len() >= MAX_HTTP_HEADER {
            bail!("the proxy's CONNECT response is too large");
        }
        if s.read(&mut byte)? == 0 {
            bail!("the proxy closed the connection");
        }
        buf.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&buf);
    let status = head.lines().next().unwrap_or("").trim();
    let code = status
        .split_whitespace()
        .nth(1)
        .and_then(|c| c.parse::<u16>().ok())
        .ok_or_else(|| anyhow!("not an HTTP proxy (got {status:?})"))?;
    match code {
        200..=299 => Ok(()),
        407 if credentials(p).is_some() => bail!("the proxy rejected the username or password ({status})"),
        407 => bail!("the proxy requires a username and password ({status})"),
        _ => bail!("the proxy refused the tunnel ({status})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn cfg(kind: ProxyKind, port: u16, user: Option<&str>, pass: Option<&str>) -> ProxyConfig {
        ProxyConfig {
            kind,
            host: "127.0.0.1".into(),
            port,
            username: user.map(Into::into),
            password: pass.map(Into::into),
        }
    }

    /// One-shot fake proxy: runs `handshake` on the accepted socket, then
    /// echoes whatever the client sends next, standing in for the target.
    fn fake_proxy(handshake: impl FnOnce(&mut TcpStream) -> bool + Send + 'static) -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            let (mut s, _) = l.accept().unwrap();
            if handshake(&mut s) {
                let mut buf = [0u8; 4];
                if s.read_exact(&mut buf).is_ok() {
                    let _ = s.write_all(&buf);
                }
            }
        });
        port
    }

    fn read_n(s: &mut TcpStream, n: usize) -> Vec<u8> {
        let mut v = vec![0u8; n];
        s.read_exact(&mut v).unwrap();
        v
    }

    fn ping(mut s: TcpStream) {
        s.write_all(b"ping").unwrap();
        assert_eq!(read_n(&mut s, 4), b"ping");
    }

    #[test]
    fn socks5_with_auth_sends_domain_unresolved() {
        let port = fake_proxy(|s| {
            assert_eq!(read_n(s, 4), [5, 2, 0, 2]);
            s.write_all(&[5, 2]).unwrap();
            assert_eq!(read_n(s, 2), [1, 3]);
            assert_eq!(read_n(s, 3), b"bob");
            assert_eq!(read_n(s, 1), [6]);
            assert_eq!(read_n(s, 6), b"p@ss:w");
            s.write_all(&[1, 0]).unwrap();
            assert_eq!(read_n(s, 5), [5, 1, 0, 3, 13]);
            assert_eq!(read_n(s, 13), b"internal.host");
            assert_eq!(read_n(s, 2), 22u16.to_be_bytes());
            s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).unwrap();
            true
        });
        let p = cfg(ProxyKind::Socks5, port, Some("bob"), Some("p@ss:w"));
        ping(dial(Some(&p), "internal.host", 22).unwrap());
    }

    #[test]
    fn socks5_without_auth_and_ipv4_target() {
        let port = fake_proxy(|s| {
            assert_eq!(read_n(s, 3), [5, 1, 0]);
            s.write_all(&[5, 0]).unwrap();
            assert_eq!(read_n(s, 10), [5, 1, 0, 1, 10, 0, 0, 7, 0, 21]);
            // Domain-form bound address in the reply must be skipped too.
            s.write_all(&[5, 0, 0, 3, 3, b'a', b'b', b'c', 0, 0]).unwrap();
            true
        });
        ping(dial(Some(&cfg(ProxyKind::Socks5, port, None, None)), "10.0.0.7", 21).unwrap());
    }

    #[test]
    fn socks5_errors_are_readable() {
        let port = fake_proxy(|s| {
            read_n(s, 3);
            s.write_all(&[5, 0]).unwrap();
            read_n(s, 10);
            s.write_all(&[5, 5, 0, 1, 0, 0, 0, 0, 0, 0]).unwrap();
            false
        });
        let err = dial(Some(&cfg(ProxyKind::Socks5, port, None, None)), "10.0.0.7", 21).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("connection refused by the target"), "{msg}");
        assert!(msg.contains("SOCKS5 proxy 127.0.0.1"), "{msg}");

        let port = fake_proxy(|s| {
            read_n(s, 3);
            s.write_all(&[5, 0xff]).unwrap();
            false
        });
        let err = dial(Some(&cfg(ProxyKind::Socks5, port, None, None)), "h", 1).unwrap_err();
        assert!(format!("{err:#}").contains("requires a username and password"));
    }

    fn read_head(s: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut b = [0u8; 1];
        while !buf.ends_with(b"\r\n\r\n") {
            s.read_exact(&mut b).unwrap();
            buf.push(b[0]);
        }
        String::from_utf8(buf).unwrap()
    }

    #[test]
    fn http_connect_with_basic_auth() {
        let port = fake_proxy(|s| {
            let head = read_head(s);
            assert!(head.starts_with("CONNECT db.internal:5432 HTTP/1.1\r\n"), "{head}");
            // base64("u:pw")
            assert!(head.contains("Proxy-Authorization: Basic dTpwdw==\r\n"), "{head}");
            // The tunnel's first bytes arrive in the same write as the
            // header; the client must not swallow them.
            s.write_all(b"HTTP/1.1 200 Connection established\r\nVia: x\r\n\r\n").unwrap();
            true
        });
        let p = cfg(ProxyKind::Http, port, Some("u"), Some("pw"));
        ping(dial(Some(&p), "db.internal", 5432).unwrap());
    }

    #[test]
    fn http_connect_ipv6_and_refusal() {
        let port = fake_proxy(|s| {
            let head = read_head(s);
            assert!(head.starts_with("CONNECT [::1]:22 HTTP/1.1\r\n"), "{head}");
            assert!(!head.contains("Proxy-Authorization"));
            s.write_all(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n").unwrap();
            false
        });
        let err = dial(Some(&cfg(ProxyKind::Http, port, None, None)), "[::1]", 22).unwrap_err();
        let msg = format!("{err:#}");
        assert!(msg.contains("requires a username and password") && msg.contains("407"), "{msg}");
    }

    #[tokio::test]
    async fn dial_async_returns_tunneled_tokio_socket() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let port = fake_proxy(|s| {
            read_n(s, 3);
            s.write_all(&[5, 0]).unwrap();
            read_n(s, 10);
            s.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).unwrap();
            true
        });
        let p = cfg(ProxyKind::Socks5, port, None, None);
        let mut s = dial_async(Some(&p), "10.0.0.7", 22).await.unwrap();
        s.write_all(b"ping").await.unwrap();
        let mut buf = [0u8; 4];
        s.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"ping");
    }

    #[test]
    fn proxy_url_encodes_credentials() {
        let p = cfg(ProxyKind::Socks5, 1080, Some("me@corp"), Some("p:w/d"));
        assert_eq!(proxy_url(&p), "socks5h://me%40corp:p%3Aw%2Fd@127.0.0.1:1080");
        let mut h = cfg(ProxyKind::Http, 3128, None, None);
        h.host = "::1".into();
        assert_eq!(proxy_url(&h), "http://[::1]:3128");
        assert!(reqwest_proxy(&p).is_ok());
    }
}
