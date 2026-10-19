use super::{HostDecision, HostKeyVerifier, HostPromptKind};
use crate::profiles::{AuthMethod, ConnectionProfile};
use crate::tls_trust;
use anyhow::{anyhow, Context, Result};
use encoding_rs::{Encoding, UTF_8, WINDOWS_1252};
use std::net::{IpAddr, SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{CertificateError, DigitallySignedStruct, SignatureScheme};
use suppaftp::native_tls::TlsConnector;
use suppaftp::{
    FtpError, FtpStream, Mode, NativeTlsConnector, NativeTlsFtpStream,
    RustlsConnector, RustlsFtpStream, TextCodec,
};

/// TCP connect budget for the control and data connections.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a control or data socket may sit without a byte moving before the
/// operation fails. Without it a dead server (or a NAT box that silently drops
/// the flow) hangs the session forever.
const IO_TIMEOUT: Duration = Duration::from_secs(60);

/// One FTP control connection. suppaftp is synchronous; we wrap it in a
/// `std::sync::Mutex` and route every operation through `spawn_blocking` so
/// it cannot block tokio's runtime threads. FTP has no multiplexing, so
/// transfers copy on their own logged-in connections from a small pool
/// (Plan 24 Phase 8) and browsing never waits behind a copy; the control
/// connection is the fallback when the server allows no extra logins.
///
/// If an operation loses the control connection (timeout, reset, server
/// restart), the session reconnects transparently before the next one.
pub struct FtpSession {
    pub id: String,
    pub profile: ConnectionProfile,
    inner: Arc<StdMutex<FtpStreamKind>>,
    /// The server advertised `MLST` in FEAT, so `MLSD` listings are available.
    mlsd: bool,
    /// The last operation lost the control connection; reconnect first.
    broken: Arc<AtomicBool>,
    /// FTPS certificate fingerprint the user trusted for this session, so a
    /// reconnect accepts the same (and only the same) certificate silently.
    pinned_cert: Option<String>,
    /// What auto charset detection settled on; outlives reconnects so a
    /// reconnected session keeps addressing non-ASCII paths correctly.
    detected_charset: Arc<AtomicU8>,
    /// Logged-in connections for transfers (Plan 24 Phase 8).
    pool: Arc<TransferPool>,
}

/// A few extra logged-in connections that transfers check out, so a copy
/// never holds the browsing connection. The cap starts at the profile's
/// `ftp_max_connections` (default 2) and drops when the server refuses a
/// login (`421` too many connections, `530`), the same way the ranged
/// download driver backs off its connection count.
struct TransferPool {
    idle: StdMutex<Vec<FtpStreamKind>>,
    /// Connections checked out right now.
    out: AtomicUsize,
    cap: AtomicUsize,
    returned: tokio::sync::Notify,
}

impl TransferPool {
    fn new(cap: usize) -> Self {
        Self {
            idle: StdMutex::new(Vec::new()),
            out: AtomicUsize::new(0),
            cap: AtomicUsize::new(cap.max(1)),
            returned: tokio::sync::Notify::new(),
        }
    }

    fn give_back(&self, conn: Option<FtpStreamKind>) {
        if let (Some(c), Ok(mut idle)) = (conn, self.idle.lock()) {
            idle.push(c);
        }
        self.out.fetch_sub(1, Ordering::AcqRel);
        self.returned.notify_one();
    }
}

/// Gives a checked-out slot back if the transfer is dropped (canceled)
/// before its connection reaches the blocking copy, which returns it itself.
struct SlotGuard(Option<Arc<TransferPool>>);

impl SlotGuard {
    fn defuse(mut self) {
        self.0 = None;
    }
}

impl Drop for SlotGuard {
    fn drop(&mut self) {
        if let Some(pool) = self.0.take() {
            pool.give_back(None);
        }
    }
}

/// What a checkout got: a pooled connection, or the right to open one.
enum Slot {
    Idle(FtpStreamKind),
    New,
}

/// Did the server refuse a login because of a connection limit?
fn refused_login(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        matches!(
            c.downcast_ref::<FtpError>(),
            Some(FtpError::UnexpectedResponse(r)) if matches!(r.status.code(), 421 | 530)
        )
    })
}

/// suppaftp has one stream type per TLS backend. We keep them in an enum so
/// all callsites can speak to any of them.
pub enum FtpStreamKind {
    Plain(FtpStream),
    /// FTPS over rustls — the default. One `ClientConfig` (and so one session
    /// cache) serves the control and every data connection, which gives the
    /// TLS session reuse that vsftpd (`require_ssl_reuse`), FileZilla Server
    /// and others demand before they'll open a data channel.
    Rustls(RustlsFtpStream),
    /// FTPS over the OS TLS stack — the fallback for servers rustls can't
    /// talk to (TLS 1.0/1.1 only).
    Tls(NativeTlsFtpStream),
}

/// Run `$body` against whichever suppaftp stream type `$self` holds.
macro_rules! each {
    ($self:expr, $s:ident => $body:expr) => {
        match $self {
            FtpStreamKind::Plain($s) => $body,
            FtpStreamKind::Rustls($s) => $body,
            FtpStreamKind::Tls($s) => $body,
        }
    };
}

impl FtpStreamKind {
    pub fn mlsd(&mut self, path: &str) -> Result<Vec<String>> {
        each!(self, s => s.mlsd(Some(path)).map_err(into_anyhow))
    }
    pub fn list(&mut self, path: Option<&str>) -> Result<Vec<String>> {
        each!(self, s => s.list(path).map_err(into_anyhow))
    }
    pub fn rename(&mut self, from: &str, to: &str) -> Result<()> {
        each!(self, s => s.rename(from, to).map_err(into_anyhow))
    }
    pub fn rm(&mut self, path: &str) -> Result<()> {
        each!(self, s => s.rm(path).map_err(into_anyhow))
    }
    pub fn rmdir(&mut self, path: &str) -> Result<()> {
        each!(self, s => s.rmdir(path).map_err(into_anyhow))
    }
    pub fn mkdir(&mut self, path: &str) -> Result<()> {
        each!(self, s => s.mkdir(path).map_err(into_anyhow))
    }
    pub fn site(&mut self, cmd: &str) -> Result<()> {
        each!(self, s => s.site(cmd).map(|_| ()).map_err(into_anyhow))
    }
    pub fn size(&mut self, path: &str) -> Result<usize> {
        each!(self, s => s.size(path).map_err(into_anyhow))
    }
    pub fn retr_to_writer<W: std::io::Write>(
        &mut self,
        path: &str,
        mut sink: W,
    ) -> Result<u64> {
        each!(self, s => s
            .retr(path, |r| std::io::copy(r, &mut sink).map_err(FtpError::ConnectionError))
            .map_err(into_anyhow))
    }
    pub fn put_from_reader<R: std::io::Read>(
        &mut self,
        path: &str,
        reader: &mut R,
    ) -> Result<u64> {
        each!(self, s => s.put_file(path, reader).map_err(into_anyhow))
    }
    /// Upload `reader` with `STOR`, or `APPE` when `append` (resumed
    /// uploads). `on_open` runs once the server has accepted the command and
    /// opened the data connection, i.e. once the remote file is really this
    /// upload's; a refused command never reaches it.
    pub fn upload<R: std::io::Read>(
        &mut self,
        path: &str,
        append: bool,
        reader: &mut R,
        on_open: impl FnOnce(&mut R) -> std::io::Result<()>,
    ) -> Result<u64> {
        each!(self, s => {
            let mut data = if append {
                s.append_with_stream(path)
            } else {
                s.put_with_stream(path)
            }
            .map_err(into_anyhow)?;
            // A copy cut short leaves the control channel mid-transfer, so
            // report it as a connection error (the session reconnects).
            let copied = on_open(reader)
                .and_then(|_| std::io::copy(reader, &mut data))
                .map_err(|e| into_anyhow(FtpError::ConnectionError(e)))?;
            s.finalize_put_stream(data).map_err(into_anyhow)?;
            Ok(copied)
        })
    }
    /// Download `[offset, offset + len)` of `path` (`REST` + `RETR`), handing
    /// each block to `emit` until `len` bytes went by, EOF, or `emit` returns
    /// false. Stopping before EOF sends `ABOR`; if the server answers that
    /// in a way suppaftp doesn't expect, the error is reported as a lost
    /// connection so the session reconnects instead of reading out of step.
    /// Returns the bytes emitted.
    pub fn retr_range(
        &mut self,
        path: &str,
        offset: u64,
        len: u64,
        mut emit: impl FnMut(&[u8]) -> bool,
    ) -> Result<u64> {
        use std::io::Read;
        let lost = |e: FtpError| {
            into_anyhow(FtpError::ConnectionError(std::io::Error::other(e.to_string())))
        };
        each!(self, s => {
            if offset > 0 {
                s.resume_transfer(offset as usize)
                    .map_err(into_anyhow)
                    .context("server refused REST (resume)")?;
            }
            let mut data = s.retr_as_stream(path).map_err(into_anyhow)?;
            let mut buf = vec![0u8; 256 * 1024];
            let mut got = 0u64;
            let mut early = false;
            loop {
                let want = buf.len().min(len.saturating_sub(got).min(usize::MAX as u64) as usize);
                if want == 0 {
                    // Got everything asked for: is the server done too?
                    let mut probe = [0u8; 1];
                    early = !matches!(data.read(&mut probe), Ok(0));
                    break;
                }
                let n = data
                    .read(&mut buf[..want])
                    .map_err(|e| into_anyhow(FtpError::ConnectionError(e)))?;
                if n == 0 {
                    break;
                }
                got += n as u64;
                if !emit(&buf[..n]) {
                    early = true;
                    break;
                }
            }
            if early {
                s.abort(data).map_err(lost)?;
            } else {
                s.finalize_retr_stream(data).map_err(into_anyhow)?;
            }
            Ok(got)
        })
    }
    /// Last-modified time (`MDTM`) as Unix seconds.
    pub fn mdtm_secs(&mut self, path: &str) -> Result<i64> {
        each!(self, s => s.mdtm(path).map(|t| t.and_utc().timestamp()).map_err(into_anyhow))
    }
    /// `REST <offset>`: make the next `RETR` start `offset` bytes in.
    pub fn restart_at(&mut self, offset: u64) -> Result<()> {
        each!(self, s => s.resume_transfer(offset as usize).map_err(into_anyhow))
    }
    pub fn set_text_codec(&mut self, codec: Option<TextCodec>) {
        each!(self, s => s.set_text_codec(codec))
    }
    /// The FEAT keywords the server advertises, upper-cased. Empty when the
    /// server doesn't implement FEAT.
    fn features(&mut self) -> Vec<String> {
        each!(self, s => s.feat())
            .map(|f| f.keys().map(|k| k.trim().to_ascii_uppercase()).collect())
            .unwrap_or_default()
    }
    /// `OPTS UTF8 ON`. Servers like IIS and FileZilla Server only switch path
    /// names to UTF-8 once the client asks; errors mean "not supported" and
    /// are ignored.
    fn opts_utf8_on(&mut self) {
        let _ = each!(self, s => s.opts("UTF8", Some("ON")));
    }
    fn login(&mut self, user: &str, password: &str) -> Result<()> {
        each!(self, s => s.login(user, password).map_err(into_anyhow))
    }
    pub fn quit(&mut self) {
        let _ = each!(self, s => s.quit());
    }
    fn noop(&mut self) -> Result<()> {
        each!(self, s => s.noop().map_err(into_anyhow))
    }
}

/// Keep suppaftp's error as the source so `is_connection_lost` can inspect it;
/// the message is unchanged.
fn into_anyhow(e: FtpError) -> anyhow::Error {
    anyhow::Error::new(e)
}

/// True when `e` came from the socket rather than from the server refusing a
/// command. After one of these the control channel is dead or out of sync
/// (a half-read reply, a transfer cut mid-stream), so the session reconnects.
fn is_connection_lost(e: &anyhow::Error) -> bool {
    e.chain().any(|c| {
        matches!(
            c.downcast_ref::<FtpError>(),
            Some(FtpError::ConnectionError(_)) | Some(FtpError::BadResponse)
        )
    })
}

/// The character set a profile asked for (`ftpEncoding`).
enum Charset {
    /// Unset / "auto": negotiate UTF-8, but fall back to Windows-1252 the
    /// first time the server sends bytes that aren't valid UTF-8.
    Auto,
    /// "utf-8": always UTF-8 (suppaftp's native behaviour).
    Utf8,
    /// Any other WHATWG label ("windows-1252", "shift_jis", "gbk", ...).
    Fixed(&'static Encoding),
}

fn resolve_charset(setting: Option<&str>) -> Result<Charset> {
    let label = setting.map(str::trim).unwrap_or("");
    if label.is_empty() || label.eq_ignore_ascii_case("auto") {
        return Ok(Charset::Auto);
    }
    let enc = Encoding::for_label(label.as_bytes())
        .ok_or_else(|| anyhow!("Unknown FTP character set \"{label}\""))?;
    if enc == UTF_8 {
        Ok(Charset::Utf8)
    } else if enc.output_encoding() != enc {
        // UTF-16 and "replacement" can't be encoded to; neither is used on an
        // FTP control channel anyway.
        Err(anyhow!("FTP character set \"{label}\" is not supported"))
    } else {
        Ok(Charset::Fixed(enc))
    }
}

/// Encode `text` in `enc`, refusing characters it can't represent.
/// `encoding_rs` would substitute an HTML numeric reference (`☃` ->
/// `&#9731;`), so the command would silently create or address a
/// different file.
fn encode_strict(enc: &'static Encoding, text: &str) -> Result<Vec<u8>, String> {
    let (bytes, _, unmappable) = enc.encode(text);
    if !unmappable {
        return Ok(bytes.into_owned());
    }
    let mut buf = [0u8; 4];
    let bad = text
        .chars()
        .find(|c| enc.encode(c.encode_utf8(&mut buf)).2)
        .unwrap_or('?');
    Err(format!(
        "\"{bad}\" can't be written in {}; pick a different character set for this connection",
        enc.name()
    ))
}

fn fixed_codec(enc: &'static Encoding) -> TextCodec {
    TextCodec::new(
        move |text| encode_strict(enc, text),
        move |bytes| enc.decode_without_bom_handling(bytes).0.into_owned(),
    )
}

/// Auto charset detection states (`FtpSession::detected_charset`).
const UNDETERMINED: u8 = 0;
const DETECTED_UTF8: u8 = 1;
const DETECTED_LEGACY: u8 = 2;

/// Settle on a charset from the first non-ASCII text the server sends: valid
/// UTF-8 means UTF-8 (legacy-codepage text almost never forms valid UTF-8
/// sequences), anything else means a legacy codepage, decoded as
/// Windows-1252. Until then, and for a UTF-8 server, commands go out as UTF-8.
///
/// The choice sticks, in both directions, so a name read from a listing is
/// sent back as the exact bytes the server gave us. (Without this, a Latin-1
/// name round-trips as U+FFFD, the server can't find the path, and many
/// servers answer `LIST` with an empty listing.) Windows-1252 maps every
/// byte, so even a Shift_JIS or GBK server stays navigable; the names just
/// look wrong until the user picks the right charset. Sticking also means one
/// stray non-UTF-8 name on a UTF-8 server doesn't break every other name.
fn auto_codec(host: String, state: Arc<AtomicU8>) -> TextCodec {
    let enc_state = state.clone();
    TextCodec::new(
        move |text| {
            if enc_state.load(Ordering::Relaxed) == DETECTED_LEGACY {
                encode_strict(WINDOWS_1252, text)
            } else {
                Ok(text.as_bytes().to_vec())
            }
        },
        move |bytes| {
            let mut current = state.load(Ordering::Relaxed);
            if current == UNDETERMINED && !bytes.is_ascii() {
                current = if std::str::from_utf8(bytes).is_ok() {
                    DETECTED_UTF8
                } else {
                    tracing::warn!(
                        "FTP {host}: server sends non-UTF-8 names; using Windows-1252 \
                         (set a character set on the connection to override)"
                    );
                    DETECTED_LEGACY
                };
                state.store(current, Ordering::Relaxed);
            }
            if current == DETECTED_LEGACY {
                WINDOWS_1252.decode_without_bom_handling(bytes).0.into_owned()
            } else {
                String::from_utf8_lossy(bytes).into_owned()
            }
        },
    )
}

impl FtpSession {
    pub fn supports_mlsd(&self) -> bool {
        self.mlsd
    }

    /// Parallel ranges one FTP download may use (each is its own login):
    /// the profile's `ftp_segments` (default 1), within the pool's cap.
    pub fn segments(&self) -> usize {
        let wanted = self.profile.ftp_segments.unwrap_or(1).clamp(1, 4) as usize;
        wanted.min(self.pool.cap.load(Ordering::Relaxed)).max(1)
    }

    /// Wait for a pooled connection or the right to open one. `None` means
    /// the server allows no extra logins: use the control connection.
    async fn checkout(&self) -> Option<Slot> {
        let pool = &self.pool;
        loop {
            if let Some(c) = pool.idle.lock().ok().and_then(|mut i| i.pop()) {
                pool.out.fetch_add(1, Ordering::AcqRel);
                return Some(Slot::Idle(c));
            }
            let cap = pool.cap.load(Ordering::Acquire);
            let out = pool.out.load(Ordering::Acquire);
            if out < cap {
                if pool
                    .out
                    .compare_exchange(out, out + 1, Ordering::AcqRel, Ordering::Acquire)
                    .is_ok()
                {
                    return Some(Slot::New);
                }
                continue;
            }
            // All busy: wait for one to come back (re-check now and then in
            // case the cap changed).
            let _ = tokio::time::timeout(Duration::from_secs(1), pool.returned.notified()).await;
        }
    }

    /// Run a transfer's data copy on its own logged-in connection (Plan 24
    /// Phase 8), so browsing never waits behind it. A pooled connection is
    /// probed with `NOOP` and replaced if it went stale; one that loses its
    /// connection mid-copy is dropped instead of being returned. If the
    /// server refuses the extra login, the pool's cap drops and the copy
    /// falls back to the control connection.
    pub async fn with_transfer_stream<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut FtpStreamKind) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let Some(slot) = self.checkout().await else {
            return self.with_stream(f).await;
        };
        let guard = SlotGuard(Some(self.pool.clone()));
        let profile = self.profile.clone();
        let tls = CertCheck::new(self.pinned_cert.clone());
        let charset = self.detected_charset.clone();
        let conn = match slot {
            Slot::Idle(c) => Some(c),
            Slot::New => {
                let (p, t, cs) = (profile.clone(), tls.clone(), charset.clone());
                match tokio::task::spawn_blocking(move || connect_blocking(&p, &t, &cs))
                    .await
                    .map_err(|e| anyhow!("FTP connect task: {e}"))
                    .and_then(|r| r)
                {
                    Ok((c, _)) => Some(c),
                    Err(e) => {
                        let pool = &self.pool;
                        guard.defuse();
                        pool.out.fetch_sub(1, Ordering::AcqRel);
                        if refused_login(&e) {
                            let busy = pool.out.load(Ordering::Acquire).max(1);
                            pool.cap.store(busy, Ordering::Release);
                            tracing::warn!(
                                "FTP {}: server refused another login ({e:#}); \
                                 using at most {busy} transfer connection(s)",
                                profile.host
                            );
                        }
                        pool.returned.notify_one();
                        if pool.out.load(Ordering::Acquire) == 0 {
                            // Not even one extra login: copy on the control
                            // connection, as before.
                            return self.with_stream(f).await;
                        }
                        if refused_login(&e) {
                            // Busy, not broken (some servers say 530 for a
                            // login limit): retry once a connection frees up.
                            return Err(into_anyhow(FtpError::ConnectionError(
                                std::io::Error::new(
                                    std::io::ErrorKind::ConnectionRefused,
                                    format!("server refused another login: {e:#}"),
                                ),
                            )));
                        }
                        return Err(e.context("FTP transfer connection"));
                    }
                }
            }
        };
        let pool = self.pool.clone();
        // From here the blocking copy returns the slot, even if this future
        // is dropped.
        guard.defuse();
        tokio::task::spawn_blocking(move || {
            let mut conn = conn;
            // A pooled connection may have been closed by the server while
            // idle: check, and log in afresh if so.
            if let Some(c) = conn.as_mut() {
                if c.noop().is_err() {
                    conn = None;
                }
            }
            let mut c = match conn {
                Some(c) => c,
                None => match connect_blocking(&profile, &tls, &charset) {
                    Ok((c, _)) => c,
                    Err(e) => {
                        pool.give_back(None);
                        return Err(e.context("FTP transfer connection"));
                    }
                },
            };
            let res = f(&mut c);
            let healthy = !matches!(&res, Err(e) if is_connection_lost(e));
            pool.give_back(healthy.then_some(c));
            res
        })
        .await
        .map_err(|e| anyhow!("FTP task join failed: {e}"))?
    }

    /// Run a closure with mutable access to the underlying FTP stream on a
    /// blocking thread. Use this for any FTP operation — it ensures the
    /// blocking syscalls don't pin a tokio worker.
    ///
    /// A previous operation that lost the connection leaves the session
    /// marked broken; this reconnects (same profile, fresh login) before
    /// running `f`. The failed operation itself still reports its error —
    /// callers that want to retry (transfers) do so on their own terms.
    pub async fn with_stream<F, T>(&self, f: F) -> Result<T>
    where
        F: FnOnce(&mut FtpStreamKind) -> Result<T> + Send + 'static,
        T: Send + 'static,
    {
        let inner = self.inner.clone();
        let broken = self.broken.clone();
        let profile = self.profile.clone();
        let tls = CertCheck::new(self.pinned_cert.clone());
        let charset = self.detected_charset.clone();
        tokio::task::spawn_blocking(move || {
            let mut g = inner.lock().map_err(|_| anyhow!("FTP stream lock poisoned"))?;
            if broken.load(Ordering::Acquire) {
                // No QUIT: the old socket is dead or desynced, and waiting for
                // its reply would only burn the read timeout.
                *g = connect_blocking(&profile, &tls, &charset)
                    .context("FTP reconnect")?
                    .0;
                broken.store(false, Ordering::Release);
                tracing::info!("FTP {}: reconnected", profile.host);
            }
            let res = f(&mut g);
            if let Err(e) = &res {
                if is_connection_lost(e) {
                    broken.store(true, Ordering::Release);
                }
            }
            res
        })
        .await
        .map_err(|e| anyhow!("FTP task join failed: {e}"))?
    }
}

/// Connect and log in. For FTPS, a certificate the OS trust store rejects
/// (self-signed, wrong name, expired) goes to `verifier` — the same prompt
/// SSH uses for unknown host keys — unless the user already trusted that
/// exact certificate for this host:port.
pub async fn ftp_connect(
    profile: &ConnectionProfile,
    verifier: Arc<dyn HostKeyVerifier>,
) -> Result<FtpSession> {
    let stored = tls_trust::lookup(&profile.host, profile.port);
    let mut pinned = stored.clone();
    let detected_charset = Arc::new(AtomicU8::new(UNDETERMINED));
    let mut asked = false;
    let (stream, mlsd) = loop {
        let tls = CertCheck::new(pinned.clone());
        let p = profile.clone();
        let attempt = {
            let tls = tls.clone();
            let charset = detected_charset.clone();
            tokio::task::spawn_blocking(move || connect_blocking(&p, &tls, &charset))
                .await
                .map_err(|e| anyhow!("FTP connect task: {e}"))?
        };
        let err = match attempt {
            Ok(ok) => break ok,
            Err(e) => e,
        };
        let Some(rejected) = tls.rejected() else {
            return Err(err);
        };
        if asked {
            return Err(err);
        }
        asked = true;
        let kind = if stored.is_some() {
            HostPromptKind::Mismatch
        } else {
            HostPromptKind::Unknown
        };
        let decision = verifier
            .decide_tls(
                &profile.host,
                profile.port,
                &rejected.fingerprint,
                stored.as_deref(),
                kind,
                &rejected.reason,
            )
            .await
            .map_err(|e| anyhow!("certificate prompt: {e}"))?;
        match decision {
            HostDecision::Reject => {
                return Err(anyhow!("FTPS certificate not trusted: {}", rejected.reason))
            }
            HostDecision::Accept => {}
            HostDecision::Trust => {
                if let Err(e) =
                    tls_trust::trust(&profile.host, profile.port, &rejected.fingerprint)
                {
                    tracing::warn!("failed to save trusted certificate: {e:#}");
                }
            }
        }
        pinned = Some(rejected.fingerprint);
    };

    Ok(FtpSession {
        id: uuid::Uuid::new_v4().to_string(),
        profile: profile.clone(),
        inner: Arc::new(StdMutex::new(stream)),
        mlsd,
        broken: Arc::new(AtomicBool::new(false)),
        pinned_cert: pinned,
        detected_charset,
        pool: Arc::new(TransferPool::new(
            profile.ftp_max_connections.unwrap_or(2).clamp(1, 8) as usize,
        )),
    })
}

/// Dial the control connection (with timeouts) as suppaftp stream type `$ty`
/// and pick the data-channel mode. A macro because suppaftp keeps the TLS
/// stream trait its generic is bounded by private.
macro_rules! open {
    ($ty:ty, $profile:expr) => {{
        let profile: &ConnectionProfile = $profile;
        let addr = format!("{}:{}", profile.host, profile.port);
        let tcp = dial(profile, host_only(&profile.host), profile.port)
            .with_context(|| format!("FTP connect {addr}"))?;
        // Through a proxy this is the proxy's address, which `data_mode` and
        // the builder below account for.
        let server_ip = tcp.peer_addr()?.ip();
        let data_profile = profile.clone();
        let mut ftp = <$ty>::connect_with_stream(tcp)
            .map_err(into_anyhow)
            .with_context(|| format!("FTP connect {addr}"))?
            .passive_stream_builder(move |addr| {
                let s = if data_profile.proxy.is_some() {
                    // EPSV reports the proxy's address and PASV often a
                    // private one, so dial the control host at the announced
                    // port, through the proxy.
                    dial(&data_profile, host_only(&data_profile.host), addr.port())
                } else {
                    TcpStream::connect_timeout(&passive_target(addr, server_ip), CONNECT_TIMEOUT)
                        .and_then(|s| set_io_timeouts(&s).map(|_| s))
                }
                .map_err(FtpError::ConnectionError)?;
                Ok(s)
            });
        ftp.set_mode(data_mode(profile, server_ip));
        ftp
    }};
}

/// Open, secure (FTPS), log in and configure one control connection.
/// Returns the stream and whether the server supports MLSD.
fn connect_blocking(
    profile: &ConnectionProfile,
    tls: &CertCheck,
    detected_charset: &Arc<AtomicU8>,
) -> Result<(FtpStreamKind, bool)> {
    let password = match &profile.auth {
        AuthMethod::Password { password } => password.as_str(),
        AuthMethod::Key { .. } => {
            return Err(anyhow!(
                "FTP does not support private-key auth; switch to password"
            ))
        }
        AuthMethod::Agent => {
            return Err(anyhow!(
                "FTP does not support ssh-agent auth; switch to password"
            ))
        }
        AuthMethod::KeyRef { .. } => {
            return Err(anyhow!(
                "FTP does not support keychain key auth; switch to password"
            ))
        }
    };
    if profile.proxy.is_some() && profile.ftp_active_mode == Some(true) {
        return Err(anyhow!(
            "FTP active mode can't work through a proxy (the server would have to connect back to you); switch to passive mode"
        ));
    }
    let charset = resolve_charset(profile.ftp_encoding.as_deref())?;
    let host = host_only(&profile.host);

    let mut stream = if profile.protocol.eq_ignore_ascii_case("ftps") {
        // Explicit FTPS: plain TCP, then AUTH TLS. rustls first (session
        // reuse); if the handshake fails for a reason other than the
        // certificate, retry on a fresh connection with the OS TLS stack,
        // which still speaks TLS 1.0/1.1.
        match open!(RustlsFtpStream, profile).into_secure(rustls_connector(tls)?, host) {
            Ok(s) => FtpStreamKind::Rustls(s),
            Err(e) if tls.rejected().is_some() => {
                return Err(anyhow!("FTPS certificate: {e}"));
            }
            Err(rustls_e) => {
                let tls = TlsConnector::new().map_err(|e| anyhow!("TLS init: {e}"))?;
                open!(NativeTlsFtpStream, profile)
                    .into_secure(NativeTlsConnector::from(tls), host)
                    .map(FtpStreamKind::Tls)
                    .map_err(|native_e| {
                        anyhow!("FTPS AUTH TLS: {rustls_e} (OS TLS fallback: {native_e})")
                    })?
            }
        }
    } else {
        FtpStreamKind::Plain(open!(FtpStream, profile))
    };

    // A fixed codepage applies to USER/PASS too; auto and UTF-8 send them as
    // UTF-8, which is identical for the ASCII credentials nearly everyone uses.
    if let Charset::Fixed(enc) = charset {
        stream.set_text_codec(Some(fixed_codec(enc)));
    }
    stream.login(&profile.username, password)?;
    // RFC 959's default type is ASCII, in which ProFTPD, IIS and others
    // rewrite line endings (corrupting binaries) and refuse SIZE. Everything
    // Faro moves is bytes.
    each!(&mut stream, s => s.transfer_type(suppaftp::types::FileType::Binary))
        .map_err(into_anyhow)
        .context("FTP TYPE I")?;

    let features = stream.features();
    let has = |f: &str| features.iter().any(|k| k == f);
    match charset {
        Charset::Fixed(_) => {}
        Charset::Utf8 => stream.opts_utf8_on(),
        Charset::Auto => {
            if has("UTF8") {
                stream.opts_utf8_on();
            }
            stream.set_text_codec(Some(auto_codec(host.to_string(), detected_charset.clone())));
        }
    }
    Ok((stream, has("MLST")))
}

/// PASV can only describe IPv4, so an IPv6 server needs EPSV. Active (PORT)
/// mode is opt-in, for servers whose passive port range is firewalled; it is
/// IPv4-only in suppaftp, so IPv6 servers stay on EPSV.
fn data_mode(profile: &ConnectionProfile, server_ip: IpAddr) -> Mode {
    if profile.proxy.is_some() {
        // `server_ip` is the proxy; only an IPv6 literal host needs EPSV.
        // Active mode is refused before connecting.
        return match host_only(&profile.host).parse::<IpAddr>() {
            Ok(IpAddr::V6(_)) => Mode::ExtendedPassive,
            _ => Mode::Passive,
        };
    }
    if server_ip.is_ipv6() {
        Mode::ExtendedPassive
    } else if profile.ftp_active_mode == Some(true) {
        Mode::Active
    } else {
        Mode::Passive
    }
}

/// TCP connect to the first address that answers within the timeout, through
/// the profile's proxy when it has one.
fn dial(profile: &ConnectionProfile, host: &str, port: u16) -> std::io::Result<TcpStream> {
    if profile.proxy.is_some() {
        let s = crate::proxy::dial(profile.proxy.as_ref(), host, port)
            .map_err(|e| std::io::Error::other(format!("{e:#}")))?;
        set_io_timeouts(&s)?;
        return Ok(s);
    }
    let mut last = None;
    for a in (host, port).to_socket_addrs()? {
        match TcpStream::connect_timeout(&a, CONNECT_TIMEOUT) {
            Ok(s) => {
                set_io_timeouts(&s)?;
                return Ok(s);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "host resolved to no addresses")
    }))
}

/// `[::1]` -> `::1`: users paste IPv6 literals in URL form.
fn host_only(host: &str) -> &str {
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

fn set_io_timeouts(s: &TcpStream) -> std::io::Result<()> {
    s.set_read_timeout(Some(IO_TIMEOUT))?;
    s.set_write_timeout(Some(IO_TIMEOUT))
}

/// Where to open a passive data connection. A server behind NAT often
/// answers PASV with its private address (10.x, 192.168.x, ...), which is
/// unreachable from here; when that happens and the control connection
/// itself went to a routable address, connect to the control address
/// instead (the same rule FileZilla applies).
fn passive_target(pasv: SocketAddr, server_ip: IpAddr) -> SocketAddr {
    let unroutable = |ip: IpAddr| match ip {
        IpAddr::V4(v4) => {
            v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_unspecified()
        }
        IpAddr::V6(v6) => v6.is_loopback() || v6.is_unspecified(),
    };
    if pasv.ip() != server_ip && unroutable(pasv.ip()) && !unroutable(server_ip) {
        SocketAddr::new(server_ip, pasv.port())
    } else if pasv.ip().is_unspecified() {
        SocketAddr::new(server_ip, pasv.port())
    } else {
        pasv
    }
}

/// rustls client config shared by the control and data connections of one
/// FTPS session, verifying certificates against the OS trust store (or the
/// fingerprint the user pinned).
fn rustls_connector(tls: &CertCheck) -> Result<RustlsConnector> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let platform = rustls_platform_verifier::Verifier::new(provider.clone())
        .map_err(|e| anyhow!("TLS init: {e}"))?;
    let verifier = PinningVerifier {
        platform: Arc::new(platform),
        check: tls.clone(),
    };
    let config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| anyhow!("TLS init: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();
    Ok(RustlsConnector::from(Arc::new(config)))
}

/// A certificate the OS trust store refused, as shown to the user.
#[derive(Clone, Debug)]
struct Rejected {
    fingerprint: String,
    reason: String,
}

/// Per-attempt certificate policy: the pinned fingerprint to accept, and a
/// slot where the verifier records a certificate it had to refuse.
#[derive(Clone, Debug, Default)]
struct CertCheck {
    pinned: Option<String>,
    rejected: Arc<StdMutex<Option<Rejected>>>,
}

impl CertCheck {
    fn new(pinned: Option<String>) -> Self {
        Self {
            pinned,
            rejected: Default::default(),
        }
    }

    fn rejected(&self) -> Option<Rejected> {
        self.rejected.lock().ok()?.clone()
    }
}

/// The OS verifier first; if it refuses, accept only the exact certificate
/// the user pinned. Signature checks always go through the OS verifier's
/// crypto, so a pinned certificate still has to prove key possession.
#[derive(Debug)]
struct PinningVerifier {
    platform: Arc<rustls_platform_verifier::Verifier>,
    check: CertCheck,
}

impl ServerCertVerifier for PinningVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let err = match self.platform.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Ok(ok) => return Ok(ok),
            Err(e) => e,
        };
        let fingerprint = tls_trust::fingerprint(end_entity);
        if self.check.pinned.as_deref() == Some(fingerprint.as_str()) {
            return Ok(ServerCertVerified::assertion());
        }
        if let Ok(mut slot) = self.check.rejected.lock() {
            *slot = Some(Rejected {
                fingerprint,
                reason: describe_cert_error(&err),
            });
        }
        Err(err)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.platform.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.platform.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.platform.supported_verify_schemes()
    }
}

fn describe_cert_error(e: &rustls::Error) -> String {
    match e {
        rustls::Error::InvalidCertificate(c) => match c {
            CertificateError::UnknownIssuer => {
                "issued by an unknown authority (self-signed?)".into()
            }
            CertificateError::NotValidForName
            | CertificateError::NotValidForNameContext { .. } => {
                "issued for a different host name".into()
            }
            CertificateError::Expired | CertificateError::ExpiredContext { .. } => {
                "expired".into()
            }
            CertificateError::NotValidYet | CertificateError::NotValidYetContext { .. } => {
                "not valid yet".into()
            }
            CertificateError::Revoked => "revoked".into(),
            other => format!("{other:?}"),
        },
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_charset_labels() {
        assert!(matches!(resolve_charset(None).unwrap(), Charset::Auto));
        assert!(matches!(resolve_charset(Some(" Auto ")).unwrap(), Charset::Auto));
        assert!(matches!(resolve_charset(Some("UTF-8")).unwrap(), Charset::Utf8));
        assert!(matches!(
            resolve_charset(Some("ISO-8859-1")).unwrap(),
            Charset::Fixed(e) if e == WINDOWS_1252
        ));
        assert!(resolve_charset(Some("utf-16le")).is_err());
        assert!(resolve_charset(Some("klingon")).is_err());
    }

    #[test]
    fn fixed_codec_round_trips_bytes() {
        let sjis = Encoding::for_label(b"shift_jis").unwrap();
        let codec = fixed_codec(sjis);
        let wire = sjis.encode("CWD /資料\r\n").0.into_owned();
        assert_eq!(codec.decode_text(&wire), "CWD /資料\r\n");
    }

    #[test]
    fn auto_codec_detects_legacy_servers() {
        let state = Arc::new(AtomicU8::new(UNDETERMINED));
        let codec = auto_codec("test".into(), state.clone());
        // ASCII settles nothing; commands go out as UTF-8 meanwhile.
        assert_eq!(codec.decode_text(b"226 Transfer complete"), "226 Transfer complete");
        assert_eq!(codec.encode_text("é").unwrap(), "é".as_bytes());
        // A Latin-1 listing line settles on Windows-1252...
        let line = b"-rw-r--r-- 1 ftp ftp 3 Jan 1 2024 caf\xe9.txt";
        assert!(codec.decode_text(line).ends_with("café.txt"));
        // ...so the same name is sent back as the server's original bytes,
        assert_eq!(codec.encode_text("café.txt").unwrap(), b"caf\xe9.txt");
        // Characters Windows-1252 lacks are refused, not turned into `&#…;`.
        let err = codec.encode_text("STOR snow☃.txt").unwrap_err();
        assert!(err.contains('☃') && err.contains("windows-1252"), "{err}");
        // and a codec rebuilt on reconnect keeps the verdict.
        let again = auto_codec("test".into(), state);
        assert_eq!(again.encode_text("café.txt").unwrap(), b"caf\xe9.txt");
    }

    #[test]
    fn auto_codec_sticks_with_utf8() {
        let codec = auto_codec("test".into(), Arc::new(AtomicU8::new(UNDETERMINED)));
        assert_eq!(codec.decode_text("résumé.txt".as_bytes()), "résumé.txt");
        // One stray Latin-1 name later doesn't flip a UTF-8 server.
        assert_eq!(codec.decode_text(b"caf\xe9"), "caf\u{FFFD}");
        assert_eq!(codec.encode_text("é☃").unwrap(), "é☃".as_bytes());
    }

    #[test]
    fn passive_target_fixes_nat_addresses() {
        let public: IpAddr = "203.0.113.7".parse().unwrap();
        let lan: IpAddr = "192.168.1.20".parse().unwrap();
        let pasv = |ip: &str| SocketAddr::new(ip.parse().unwrap(), 30001);
        // Private PASV address from a public server: use the control address.
        assert_eq!(passive_target(pasv("10.0.0.5"), public), SocketAddr::new(public, 30001));
        // 0.0.0.0 always means "same host".
        assert_eq!(passive_target(pasv("0.0.0.0"), lan), SocketAddr::new(lan, 30001));
        // A LAN server handing out its LAN address is left alone.
        assert_eq!(passive_target(pasv("192.168.1.20"), lan), pasv("192.168.1.20"));
        // A different public data host (rare, but legal) is honoured.
        assert_eq!(passive_target(pasv("198.51.100.9"), public), pasv("198.51.100.9"));
    }

    #[test]
    fn connection_errors_are_detected_through_context() {
        let io = std::io::Error::new(std::io::ErrorKind::TimedOut, "timed out");
        let lost = into_anyhow(FtpError::ConnectionError(io)).context("FTP LIST /");
        assert!(is_connection_lost(&lost));
        let refused = anyhow!("550 No such file").context("FTP RMD /x");
        assert!(!is_connection_lost(&refused));
    }
}
