//! One [`RangeSource`] per backend (Plan 24 Phase 3), plus what each knows
//! about the remote file's identity (Phase 4).

use super::ranged::{Flow, RangeSink, RangeSource, UNBOUNDED};
use super::retry::{RemoteChanged, RetryAfter};
use crate::session::{
    AgentSession, FtpSession, ObjectSession, Session, SshSession,
};
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use bytes::Bytes;
use futures::future::BoxFuture;
use futures::stream::{FuturesOrdered, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// What a remote file looked like when a transfer started: resume only
/// continues while this still matches, so two versions are never stitched
/// together (Plan 24 Phase 4).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RemoteIdentity {
    pub size: Option<u64>,
    /// ETag (object stores, HTTP, WebDAV); HTTP falls back to Last-Modified.
    pub etag: Option<String>,
    /// Modification time, Unix seconds (SFTP, FTP, Agent).
    pub mtime: Option<i64>,
}

impl RemoteIdentity {
    /// Same file as `saved`? Size must match, and every token both sides
    /// know must match. A file with no token at all only resumes on size.
    pub fn matches(&self, saved: &RemoteIdentity) -> bool {
        if self.size != saved.size {
            return false;
        }
        if let (Some(a), Some(b)) = (&self.etag, &saved.etag) {
            if a != b {
                return false;
            }
        }
        if let (Some(a), Some(b)) = (self.mtime, saved.mtime) {
            if a != b {
                return false;
            }
        }
        true
    }

    pub fn mtime_systime(&self) -> Option<std::time::SystemTime> {
        let secs = u64::try_from(self.mtime?).ok()?;
        std::time::UNIX_EPOCH.checked_add(Duration::from_secs(secs))
    }
}

/// Look up the remote file's identity with each backend's native call.
pub async fn remote_identity(session: &Arc<Session>, path: &str) -> Result<RemoteIdentity> {
    Ok(match &**session {
        Session::Ssh(ssh) => {
            let p = path.to_string();
            let meta = ssh
                .with_sftp(|cell| {
                    let p = p.clone();
                    async move {
                        let sftp = cell.lock().await;
                        Ok(sftp.metadata(&p).await?)
                    }
                })
                .await
                .with_context(|| format!("stat {path}"))?;
            RemoteIdentity {
                size: meta.size,
                etag: None,
                mtime: meta.mtime.map(i64::from),
            }
        }
        Session::Ftp(ftp) => {
            let p = path.to_string();
            let (size, mtime) = ftp
                .with_stream(move |s| Ok((s.size(&p)? as u64, s.mdtm_secs(&p).ok())))
                .await?;
            RemoteIdentity {
                size: Some(size),
                etag: None,
                mtime,
            }
        }
        Session::Object(obj) => {
            let key = path.trim_start_matches('/');
            let meta = obj
                .store
                .head(&object_store::path::Path::parse(key)?)
                .await
                .with_context(|| format!("object head {key}"))?;
            RemoteIdentity {
                size: Some(meta.size as u64),
                etag: meta.e_tag,
                mtime: Some(meta.last_modified.timestamp()),
            }
        }
        Session::Webdav(dav) => {
            let req = dav.request(reqwest::Method::HEAD, dav.url_for(path, false));
            head_identity(req).await
        }
        Session::Http(http) => {
            let req = http.request(reqwest::Method::HEAD, http.url_for(path, false));
            head_identity(req).await
        }
        Session::Agent(agent) => {
            use faro_agent_proto::msg::{Request, Response};
            match agent.request(Request::Stat { path: path.to_string() }).await? {
                Response::Stat { entry } => RemoteIdentity {
                    size: Some(entry.size),
                    etag: None,
                    // The daemon reports milliseconds.
                    mtime: entry.modified.map(|ms| ms / 1000),
                },
                Response::Error { message, .. } => anyhow::bail!("stat {path}: {message}"),
                other => anyhow::bail!("stat {path}: unexpected {other:?}"),
            }
        }
        _ => RemoteIdentity {
            size: super::remote_size(session, path).await.ok().filter(|&s| s > 0),
            ..Default::default()
        },
    })
}

/// HEAD → size, ETag (or Last-Modified as the change token). Best-effort:
/// a server that rejects HEAD yields an empty identity.
async fn head_identity(req: reqwest::RequestBuilder) -> RemoteIdentity {
    let Ok(resp) = req.send().await else {
        return RemoteIdentity::default();
    };
    if !resp.status().is_success() {
        return RemoteIdentity::default();
    }
    let h = resp.headers();
    let text = |name: reqwest::header::HeaderName| {
        h.get(name).and_then(|v| v.to_str().ok()).map(str::to_string)
    };
    RemoteIdentity {
        size: text(reqwest::header::CONTENT_LENGTH).and_then(|s| s.parse().ok()),
        etag: text(reqwest::header::ETAG)
            .or_else(|| text(reqwest::header::LAST_MODIFIED).map(|lm| format!("lm:{lm}"))),
        mtime: None,
    }
}

/// Build the source for downloading `path` from `session`.
pub async fn source_for(
    session: &Arc<Session>,
    path: &str,
    ident: &RemoteIdentity,
) -> Result<Arc<dyn RangeSource>> {
    let path_s = path.to_string();
    Ok(match &**session {
        Session::Ssh(ssh) => Arc::new(SftpSource::new(ssh.clone(), path_s, ident.size)),
        Session::Object(obj) => Arc::new(ObjectSource {
            session: obj.clone(),
            key: object_store::path::Path::parse(path.trim_start_matches('/'))?,
            etag: ident.etag.clone(),
        }),
        Session::Webdav(dav) => {
            let dav = dav.clone();
            let p = path_s.clone();
            let req: ReqFn = Arc::new(move || dav.request(reqwest::Method::GET, dav.url_for(&p, false)));
            Arc::new(HttpSource::probe(req, path_s, ident).await)
        }
        Session::Http(http) => {
            let http = http.clone();
            let p = path_s.clone();
            let req: ReqFn = Arc::new(move || http.request(reqwest::Method::GET, http.url_for(&p, false)));
            Arc::new(HttpSource::probe(req, path_s, ident).await)
        }
        Session::Ftp(ftp) => Arc::new(FtpSource {
            session: ftp.clone(),
            path: path_s,
        }),
        Session::Agent(agent) => Arc::new(AgentSource {
            session: agent.clone(),
            path: path_s,
        }),
        Session::Dropbox(dbx) => {
            let dbx = dbx.clone();
            let arg = serde_json::json!({ "path": crate::remotefs::dropbox::dropbox_api_path(path) })
                .to_string();
            stream_source(path_s, move || {
                let dbx = dbx.clone();
                let arg = arg.clone();
                Box::pin(async move { dbx.content_get("/2/files/download", &arg).await })
            })
        }
        Session::OneDrive(od) => {
            let od = od.clone();
            let content = crate::remotefs::onedrive::content_ref(path);
            stream_source(path_s, move || {
                let od = od.clone();
                let content = content.clone();
                Box::pin(async move { od.get_stream(&content).await })
            })
        }
        Session::GDrive(gd) => {
            let gd = gd.clone();
            let p = path_s.clone();
            stream_source(path_s, move || {
                let gd = gd.clone();
                let p = p.clone();
                Box::pin(async move {
                    let (file_id, _) = gd
                        .resolve_item(&p)
                        .await?
                        .ok_or_else(|| anyhow!("{p}: not found"))?;
                    gd.get_stream(&format!("/files/{file_id}?alt=media")).await
                })
            })
        }
        Session::Box(bx) => {
            let bx = bx.clone();
            let p = path_s.clone();
            stream_source(path_s, move || {
                let bx = bx.clone();
                let p = p.clone();
                Box::pin(async move {
                    let (file_id, _) = bx
                        .resolve_item(&p)
                        .await?
                        .ok_or_else(|| anyhow!("{p}: not found"))?;
                    bx.get_stream(&format!("/files/{file_id}/content")).await
                })
            })
        }
        Session::Shopify(sh) => {
            let sh = sh.clone();
            let p = path_s.clone();
            one_shot(move || {
                let sh = sh.clone();
                let p = p.clone();
                Box::pin(async move { crate::remotefs::shopify::read_asset(&sh, &p).await })
            })
        }
        Session::HubSpot(hs) => {
            let hs = hs.clone();
            let p = path_s.clone();
            one_shot(move || {
                let hs = hs.clone();
                let p = p.clone();
                Box::pin(async move { crate::remotefs::hubspot::read_file(&hs, &p).await })
            })
        }
        Session::Dynamics(dynm) => {
            let dynm = dynm.clone();
            let p = path_s.clone();
            one_shot(move || {
                let dynm = dynm.clone();
                let p = p.clone();
                Box::pin(async move { crate::remotefs::dynamics::read_file(&dynm, &p).await })
            })
        }
        Session::WordPress(wp) => {
            let wp = wp.clone();
            let p = path_s.clone();
            one_shot(move || {
                let wp = wp.clone();
                let p = p.clone();
                Box::pin(async move { crate::remotefs::wordpress::read_file(&wp, &p).await })
            })
        }
    })
}

/// Is `session`'s reported size a guess (whole-file APIs that answer with
/// the body)? Those run with an unknown size and take what arrives.
pub fn size_is_advisory(session: &Session) -> bool {
    matches!(
        session,
        Session::Shopify(_) | Session::HubSpot(_) | Session::Dynamics(_) | Session::WordPress(_)
    )
}

/// Turn a non-success HTTP answer into an error the retry policy reads:
/// `Retry-After` on 429/503 becomes a [`RetryAfter`] wait.
fn http_failure(resp: &reqwest::Response, what: &str) -> anyhow::Error {
    let code = resp.status().as_u16();
    let base = anyhow!("{what} failed: HTTP {code}");
    if matches!(code, 429 | 503) {
        if let Some(secs) = resp
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.trim().parse::<u64>().ok())
        {
            return anyhow::Error::new(RetryAfter(Duration::from_secs(secs.min(300))))
                .context(base.to_string());
        }
    }
    base
}

/// Push a byte stream into the sink until it stops wanting more.
async fn pump<S, E>(mut stream: S, sink: &mut RangeSink, what: &str) -> Result<()>
where
    S: futures::Stream<Item = std::result::Result<Bytes, E>> + Unpin,
    E: std::error::Error + Send + Sync + 'static,
{
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.with_context(|| format!("reading {what}"))?;
        if sink.push(chunk).await? == Flow::Stop {
            break;
        }
    }
    Ok(())
}

// ---------- SFTP: pipelined reads on dedicated channels ----------

/// Reads in flight per range. OpenSSH's own `sftp` keeps 64 by default;
/// 32 fills most links, 16 is the conservative start for servers that don't
/// announce their limits.
const SFTP_DEPTH: usize = 32;
const SFTP_DEPTH_UNKNOWN: usize = 16;
/// Largest read asked for (fits the 256 KiB packet with its header).
const SFTP_CHUNK_MAX: u32 = 255 * 1024;
const SFTP_CHUNK_MIN: u32 = 32 * 1024;

struct SftpChannel {
    raw: russh_sftp::client::RawSftpSession,
}

pub struct SftpSource {
    ssh: Arc<SshSession>,
    path: String,
    size: Option<u64>,
    idle: tokio::sync::Mutex<Vec<Arc<SftpChannel>>>,
    every: tokio::sync::Mutex<Vec<Arc<SftpChannel>>>,
    chunk: AtomicU32,
    depth: AtomicUsize,
    /// Dedicated channels can't be opened here: read through the shared one.
    shared_only: AtomicBool,
}

impl SftpSource {
    fn new(ssh: Arc<SshSession>, path: String, size: Option<u64>) -> Self {
        Self {
            ssh,
            path,
            size,
            idle: Default::default(),
            every: Default::default(),
            chunk: AtomicU32::new(SFTP_CHUNK_MAX),
            depth: AtomicUsize::new(SFTP_DEPTH_UNKNOWN),
            shared_only: AtomicBool::new(false),
        }
    }

    /// An idle dedicated channel, a new one, or (when the server's
    /// `MaxSessions` is used up) one already in use by another range.
    async fn channel(&self) -> Option<Arc<SftpChannel>> {
        if self.shared_only.load(Ordering::Relaxed) {
            return None;
        }
        if let Some(c) = self.idle.lock().await.pop() {
            return Some(c);
        }
        match self.ssh.open_raw_sftp_channel().await {
            Ok(ch) => {
                let read_len = ch.limits.and_then(|l| l.read_len);
                if ch.limits.is_some() {
                    self.depth.store(SFTP_DEPTH, Ordering::Relaxed);
                }
                if let Some(r) = read_len {
                    let cap = (r.min(u64::from(SFTP_CHUNK_MAX)) as u32).max(1024);
                    self.chunk.fetch_min(cap, Ordering::Relaxed);
                }
                let c = Arc::new(SftpChannel { raw: ch.raw });
                self.every.lock().await.push(Arc::clone(&c));
                Some(c)
            }
            Err(e) => {
                let every = self.every.lock().await;
                if let Some(c) = every.first() {
                    return Some(Arc::clone(c));
                }
                tracing::warn!("SFTP: no dedicated transfer channel ({e:#}); using the shared one");
                self.shared_only.store(true, Ordering::Relaxed);
                None
            }
        }
    }

    async fn pipelined(&self, ch: &SftpChannel, offset: u64, len: u64, sink: &mut RangeSink) -> Result<()> {
        use russh_sftp::client::error::Error as SftpErr;
        use russh_sftp::protocol::{FileAttributes, OpenFlags, StatusCode};
        let raw = &ch.raw;
        let handle = raw
            .open(&self.path, OpenFlags::READ, FileAttributes::default())
            .await
            .with_context(|| format!("open remote {}", self.path))?
            .handle;
        let file_end = self.size.unwrap_or(UNBOUNDED);
        let end = if len == UNBOUNDED { file_end } else { offset.saturating_add(len).min(file_end) };
        let res: Result<()> = async {
            let mut next = offset;
            let mut inflight = FuturesOrdered::new();
            loop {
                let depth = self.depth.load(Ordering::Relaxed);
                while inflight.len() < depth && next < end {
                    let n = u64::from(self.chunk.load(Ordering::Relaxed)).min(end - next) as u32;
                    let at = next;
                    let h = handle.clone();
                    inflight.push_back(async move { (at, n, raw.read(h, at, n).await) });
                    next += u64::from(n);
                }
                let Some((at, n, res)) = inflight.next().await else {
                    return Ok(());
                };
                let data = match res {
                    Ok(d) => d.data,
                    Err(SftpErr::Status(s)) if s.status_code == StatusCode::Eof => return Ok(()),
                    Err(SftpErr::Limited(m)) => {
                        // The server's limits are tighter than announced.
                        self.chunk.store(SFTP_CHUNK_MIN, Ordering::Relaxed);
                        let d = self.depth.load(Ordering::Relaxed);
                        self.depth.store((d / 2).max(1), Ordering::Relaxed);
                        return Err(anyhow::Error::new(super::retry::Transient(format!(
                            "SFTP read limit: {m}"
                        ))));
                    }
                    Err(e) => return Err(anyhow::Error::new(e).context(format!("read {}", self.path))),
                };
                if data.is_empty() {
                    return Ok(());
                }
                let got = data.len() as u64;
                if sink.push(Bytes::from(data)).await? == Flow::Stop {
                    return Ok(());
                }
                if got < u64::from(n) {
                    // The server caps reads below what we ask: ask for that
                    // much from now on, and fill this gap before anything
                    // after it (the sink takes bytes in order).
                    self.chunk.fetch_min((got as u32).max(4096), Ordering::Relaxed);
                    let gap_end = at + u64::from(n);
                    let mut at = at + got;
                    while at < gap_end {
                        let d = match raw.read(handle.clone(), at, (gap_end - at) as u32).await {
                            Ok(d) => d.data,
                            Err(SftpErr::Status(s)) if s.status_code == StatusCode::Eof => {
                                return Ok(())
                            }
                            Err(e) => {
                                return Err(anyhow::Error::new(e).context(format!("read {}", self.path)))
                            }
                        };
                        if d.is_empty() {
                            return Ok(());
                        }
                        at += d.len() as u64;
                        if sink.push(Bytes::from(d)).await? == Flow::Stop {
                            return Ok(());
                        }
                    }
                }
            }
        }
        .await;
        let _ = raw.close(handle).await;
        res
    }

    /// Fallback: sequential reads through the shared browsing session.
    async fn shared(&self, offset: u64, sink: &mut RangeSink) -> Result<()> {
        use tokio::io::{AsyncReadExt, AsyncSeekExt};
        let cell = self.ssh.ensure_sftp().await?;
        let mut file = {
            let sftp = cell.lock().await;
            sftp.open(&self.path)
                .await
                .with_context(|| format!("open remote {}", self.path))?
        };
        if offset > 0 {
            file.seek(std::io::SeekFrom::Start(offset)).await?;
        }
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf).await?;
            if n == 0 {
                return Ok(());
            }
            if sink.push(Bytes::copy_from_slice(&buf[..n])).await? == Flow::Stop {
                return Ok(());
            }
        }
    }
}

#[async_trait]
impl RangeSource for SftpSource {
    async fn read_range(&self, offset: u64, len: u64, sink: &mut RangeSink) -> Result<()> {
        let Some(ch) = self.channel().await else {
            return self.shared(offset, sink).await;
        };
        let res = self.pipelined(&ch, offset, len, sink).await;
        if res.is_ok() {
            self.idle.lock().await.push(ch);
        } else {
            // A failed channel may be desynced or dead: never reuse it.
            self.every.lock().await.retain(|c| !Arc::ptr_eq(c, &ch));
        }
        res
    }

    fn max_parallel(&self) -> usize {
        4
    }
}

// ---------- Object stores: ranged GETs pinned to the ETag ----------

pub struct ObjectSource {
    session: Arc<ObjectSession>,
    key: object_store::path::Path,
    etag: Option<String>,
}

#[async_trait]
impl RangeSource for ObjectSource {
    async fn read_range(&self, offset: u64, len: u64, sink: &mut RangeSink) -> Result<()> {
        use object_store::{GetOptions, GetRange};
        let range = if len == UNBOUNDED {
            (offset > 0).then_some(GetRange::Offset(offset as usize))
        } else {
            Some(GetRange::Bounded(offset as usize..(offset + len) as usize))
        };
        let opts = GetOptions {
            range,
            // The server refuses the range if the object changed meanwhile.
            if_match: self.etag.clone(),
            ..Default::default()
        };
        let got = match self.session.store.get_opts(&self.key, opts).await {
            Ok(g) => g,
            Err(object_store::Error::Precondition { .. }) => {
                return Err(anyhow::Error::new(RemoteChanged))
            }
            Err(e) => return Err(anyhow::Error::new(e).context(format!("get {}", self.key))),
        };
        pump(got.into_stream(), sink, self.key.as_ref()).await
    }

    fn max_parallel(&self) -> usize {
        8
    }
}

// ---------- HTTP / WebDAV: Range requests ----------

type ReqFn = Arc<dyn Fn() -> reqwest::RequestBuilder + Send + Sync>;

const RANGES_UNKNOWN: u8 = 0;
const RANGES_YES: u8 = 1;
const RANGES_NO: u8 = 2;

pub struct HttpSource {
    req: ReqFn,
    path: String,
    etag: Option<String>,
    ranges: AtomicU8,
}

impl HttpSource {
    /// Find out whether the server serves byte ranges. A file over 1 MiB
    /// gets a one-byte test request; smaller files never split anyway.
    async fn probe(req: ReqFn, path: String, ident: &RemoteIdentity) -> Self {
        let etag = ident
            .etag
            .clone()
            .filter(|e| !e.starts_with("lm:") && !e.starts_with("W/"));
        let src = Self {
            req,
            path,
            etag,
            ranges: AtomicU8::new(RANGES_UNKNOWN),
        };
        if ident.size.is_some_and(|s| s > 1024 * 1024) {
            let ok = match (src.req)().header(reqwest::header::RANGE, "bytes=0-0").send().await {
                Ok(r) => r.status() == reqwest::StatusCode::PARTIAL_CONTENT,
                Err(_) => false,
            };
            src.ranges
                .store(if ok { RANGES_YES } else { RANGES_NO }, Ordering::Relaxed);
        }
        src
    }

    fn ranged(&self) -> bool {
        self.ranges.load(Ordering::Relaxed) == RANGES_YES
    }
}

/// `Content-Range: bytes a-b/total` → `a`.
fn content_range_start(resp: &reqwest::Response) -> Option<u64> {
    let v = resp.headers().get(reqwest::header::CONTENT_RANGE)?.to_str().ok()?;
    let rest = v.trim().strip_prefix("bytes")?.trim();
    rest.split('-').next()?.trim().parse().ok()
}

#[async_trait]
impl RangeSource for HttpSource {
    async fn read_range(&self, offset: u64, len: u64, sink: &mut RangeSink) -> Result<()> {
        let mut rb = (self.req)();
        let partial = offset > 0 || (len != UNBOUNDED && self.ranged());
        if partial {
            let spec = if len == UNBOUNDED {
                format!("bytes={offset}-")
            } else {
                format!("bytes={offset}-{}", offset + len - 1)
            };
            rb = rb.header(reqwest::header::RANGE, spec);
            if let Some(tag) = &self.etag {
                rb = rb.header(reqwest::header::IF_RANGE, tag);
            }
        }
        let resp = rb
            .send()
            .await
            .with_context(|| format!("GET {}", self.path))?;
        let status = resp.status();
        if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
            return Err(anyhow::Error::new(RemoteChanged));
        }
        if !status.is_success() {
            return Err(http_failure(&resp, &format!("download {}", self.path)));
        }
        if partial {
            if status == reqwest::StatusCode::PARTIAL_CONTENT {
                if content_range_start(&resp) != Some(offset) {
                    anyhow::bail!("download {}: server sent the wrong range", self.path);
                }
            } else if offset > 0 {
                // A full 200 for a ranged ask: the ETag no longer matched
                // (If-Range) or ranges aren't supported after all.
                if self.etag.is_some() {
                    return Err(anyhow::Error::new(RemoteChanged));
                }
                self.ranges.store(RANGES_NO, Ordering::Relaxed);
                anyhow::bail!("download {}: server ignored the byte range", self.path);
            }
        }
        pump(resp.bytes_stream(), sink, &self.path).await
    }

    fn max_parallel(&self) -> usize {
        if self.ranged() {
            4
        } else {
            1
        }
    }

    fn seekable(&self) -> bool {
        self.ranges.load(Ordering::Relaxed) != RANGES_NO
    }
}

// ---------- FTP: REST + RETR ----------

pub struct FtpSource {
    session: Arc<FtpSession>,
    path: String,
}

#[async_trait]
impl RangeSource for FtpSource {
    async fn read_range(&self, offset: u64, len: u64, sink: &mut RangeSink) -> Result<()> {
        let (tx, mut rx) = tokio::sync::mpsc::channel::<Bytes>(8);
        let path = self.path.clone();
        let copy = self.session.with_transfer_stream(move |s| {
            s.retr_range(&path, offset, len, |b| {
                tx.blocking_send(Bytes::copy_from_slice(b)).is_ok()
            })
        });
        // Dropping `rx` (stop, pause, error) makes the blocking side's next
        // send fail, which ends the RETR.
        let consume = async move {
            while let Some(b) = rx.recv().await {
                if sink.push(b).await? == Flow::Stop {
                    break;
                }
            }
            Ok::<(), anyhow::Error>(())
        };
        let (copied, consumed) = tokio::join!(copy, consume);
        consumed?;
        copied.map(|_| ())
    }

    fn max_parallel(&self) -> usize {
        self.session.segments()
    }
}

// ---------- Faro Agent: ReadChunk at an offset ----------

pub struct AgentSource {
    session: Arc<AgentSession>,
    path: String,
}

#[async_trait]
impl RangeSource for AgentSource {
    async fn read_range(&self, offset: u64, len: u64, sink: &mut RangeSink) -> Result<()> {
        use base64::Engine as _;
        use faro_agent_proto::msg::{Request, Response};
        let mut at = offset;
        loop {
            let want = if len == UNBOUNDED { 0 } else { (offset + len).saturating_sub(at) };
            if len != UNBOUNDED && want == 0 {
                return Ok(());
            }
            let resp = self
                .session
                .request(Request::ReadChunk {
                    path: self.path.clone(),
                    offset: at,
                    len: want,
                })
                .await?;
            let (data, eof) = match resp {
                Response::Chunk { data, eof } => (data, eof),
                Response::Error { message, .. } => anyhow::bail!("download {}: {message}", self.path),
                other => anyhow::bail!("download {}: unexpected {other:?}", self.path),
            };
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(&data)
                .context("decode chunk")?;
            let n = bytes.len() as u64;
            if n > 0 && sink.push(Bytes::from(bytes)).await? == Flow::Stop {
                return Ok(());
            }
            at += n;
            if eof || n == 0 {
                return Ok(());
            }
        }
    }
}

// ---------- Streams from byte 0 (OAuth clouds) and one-shot APIs ----------

type OpenFn = Arc<dyn Fn() -> BoxFuture<'static, Result<reqwest::Response>> + Send + Sync>;

/// A backend that can only stream the whole file from the start.
struct StreamSource {
    path: String,
    open: OpenFn,
}

fn stream_source(
    path: String,
    open: impl Fn() -> BoxFuture<'static, Result<reqwest::Response>> + Send + Sync + 'static,
) -> Arc<dyn RangeSource> {
    Arc::new(StreamSource {
        path,
        open: Arc::new(open),
    })
}

#[async_trait]
impl RangeSource for StreamSource {
    async fn read_range(&self, offset: u64, _len: u64, sink: &mut RangeSink) -> Result<()> {
        if offset != 0 {
            anyhow::bail!("this backend can't resume mid-file");
        }
        let resp = (self.open)().await?;
        pump(resp.bytes_stream(), sink, &self.path).await
    }

    fn seekable(&self) -> bool {
        false
    }
}

type FetchFn = Arc<dyn Fn() -> BoxFuture<'static, Result<Vec<u8>>> + Send + Sync>;

/// A whole-file API that answers with the body in one piece.
struct OneShotSource {
    fetch: FetchFn,
}

fn one_shot(
    fetch: impl Fn() -> BoxFuture<'static, Result<Vec<u8>>> + Send + Sync + 'static,
) -> Arc<dyn RangeSource> {
    Arc::new(OneShotSource {
        fetch: Arc::new(fetch),
    })
}

#[async_trait]
impl RangeSource for OneShotSource {
    async fn read_range(&self, offset: u64, _len: u64, sink: &mut RangeSink) -> Result<()> {
        if offset != 0 {
            anyhow::bail!("this backend can't resume mid-file");
        }
        let data = (self.fetch)().await?;
        sink.push(Bytes::from(data)).await?;
        Ok(())
    }

    fn seekable(&self) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_matching() {
        let a = RemoteIdentity {
            size: Some(10),
            etag: Some("\"x\"".into()),
            mtime: Some(5),
        };
        assert!(a.matches(&a.clone()));
        assert!(!a.matches(&RemoteIdentity { size: Some(11), ..a.clone() }));
        assert!(!a.matches(&RemoteIdentity { etag: Some("\"y\"".into()), ..a.clone() }));
        assert!(!a.matches(&RemoteIdentity { mtime: Some(6), ..a.clone() }));
        // A token one side lacks isn't held against it; size still must match.
        assert!(a.matches(&RemoteIdentity { etag: None, ..a.clone() }));
    }
}
