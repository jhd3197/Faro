use crate::session::{
    BoxSession, DropboxSession, DynamicsSession, FtpSession, GDriveSession, HttpSession,
    HubSpotSession, ObjectSession, WordPressSession, OneDriveSession, Session, ShopifySession, SshSession,
    WebdavSession,
};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{watch, Mutex, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;
use uuid::Uuid;

#[cfg(test)]
mod live_tests;
mod partfile;
mod ranged;
mod retry;
mod sources;
mod speed;
mod verify;

pub use partfile::is_part_file;
use speed::Live;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OverwritePolicy {
    #[default]
    Overwrite,
    Skip,
    Rename,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferKind {
    Download,
    Upload,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum TransferStatus {
    Queued,
    Transferring,
    Paused,
    Done,
    Skipped,
    Error,
    Canceled,
}

/// Marker error: the transfer (or the whole queue) was paused at a chunk
/// checkpoint. The copy loop unwinds with this; the runner gives back its
/// concurrency slot, re-queues the transfer and waits for its turn again, so
/// pausing never stalls the rest of the queue (Plan 24 Phase 1).
#[derive(Debug)]
struct Paused;

impl std::fmt::Display for Paused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("transfer paused")
    }
}

impl std::error::Error for Paused {}

fn is_paused(e: &anyhow::Error) -> bool {
    e.downcast_ref::<Paused>().is_some()
}

/// Bytes between FTP checkpoint round-trips (throttle, pause, progress).
const FTP_CHUNK: u64 = 256 * 1024;

/// Message from a blocking FTP copy to `TransferManager::ftp_pump`.
enum FtpProgress {
    /// The destination is open and the copy starts at this offset.
    Start(u64),
    /// This many more bytes moved.
    Chunk(u64),
}

/// Blocking side of the FTP copy <-> transfer manager handshake: report,
/// then wait for the go-ahead. A refusal (pause, cancel) or a vanished pump
/// aborts the copy with an I/O error.
struct FtpGate {
    tx: tokio::sync::mpsc::Sender<FtpProgress>,
    ack: std::sync::mpsc::Receiver<bool>,
}

impl FtpGate {
    fn new() -> (
        Self,
        tokio::sync::mpsc::Receiver<FtpProgress>,
        std::sync::mpsc::SyncSender<bool>,
    ) {
        let (tx, rx) = tokio::sync::mpsc::channel(1);
        let (ack_tx, ack) = std::sync::mpsc::sync_channel(1);
        (Self { tx, ack }, rx, ack_tx)
    }

    fn send(&self, msg: FtpProgress) -> std::io::Result<()> {
        let interrupted = || std::io::Error::new(std::io::ErrorKind::Interrupted, "transfer interrupted");
        self.tx.blocking_send(msg).map_err(|_| interrupted())?;
        match self.ack.recv() {
            Ok(true) => Ok(()),
            _ => Err(interrupted()),
        }
    }

    fn start(&self, offset: u64) -> std::io::Result<()> {
        self.send(FtpProgress::Start(offset))
    }
}

/// Upload source: read through, reporting every `FTP_CHUNK` to the gate.
struct GatedReader<R: std::io::Read> {
    inner: R,
    gate: FtpGate,
    pending: u64,
}

impl<R: std::io::Read> std::io::Read for GatedReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        if self.pending >= FTP_CHUNK {
            self.gate.send(FtpProgress::Chunk(std::mem::take(&mut self.pending)))?;
        }
        let n = self.inner.read(buf)?;
        self.pending += n as u64;
        Ok(n)
    }
}

impl<R: std::io::Read> GatedReader<R> {
    fn finish(mut self) -> std::io::Result<()> {
        let rest = std::mem::take(&mut self.pending);
        self.gate.send(FtpProgress::Chunk(rest))
    }
}

/// Payload of the `transfer://queue` event: the FIFO of waiting transfer ids
/// plus the manager-level state the panel header renders (Plan 17).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueState {
    pub waiting: Vec<String>,
    pub paused_all: bool,
    pub concurrency: usize,
    pub throttle_kbps: u64,
}

/// Global bandwidth cap shared by every active copy loop (Plan 17 Phase 4):
/// a token bucket refilling at `rate` bytes/sec (0 = unlimited). Because all
/// transfers draw from this one bucket, the cap is split across active
/// transfers rather than applied per transfer.
struct TokenBucket {
    inner: Mutex<BucketInner>,
    rate_bps: AtomicU64,
}

struct BucketInner {
    tokens: f64,
    // tokio's Instant (not std's) so `start_paused` tests drive refills.
    last: tokio::time::Instant,
}

impl TokenBucket {
    fn new() -> Self {
        Self {
            inner: Mutex::new(BucketInner {
                tokens: 0.0,
                last: tokio::time::Instant::now(),
            }),
            rate_bps: AtomicU64::new(0),
        }
    }

    fn rate_kbps(&self) -> u64 {
        self.rate_bps.load(Ordering::Relaxed) / 1024
    }

    fn set_rate_kbps(&self, kbps: u64) {
        self.rate_bps
            .store(kbps.saturating_mul(1024), Ordering::Relaxed);
    }

    /// Wait until `bytes` may flow under the cap. Drawn in tranches capped at
    /// one second's worth of rate (min 64 KiB) so a large chunk is charged in
    /// full while a 1 KiB file never waits a whole token window.
    async fn acquire(&self, bytes: u64) {
        let mut remaining = bytes as f64;
        while remaining > 0.0 {
            let rate = self.rate_bps.load(Ordering::Relaxed);
            if rate == 0 {
                return;
            }
            let wait = {
                let mut g = self.inner.lock().await;
                let now = tokio::time::Instant::now();
                let elapsed = now.duration_since(g.last).as_secs_f64();
                let rate_f = rate as f64;
                let cap = rate_f.max(64.0 * 1024.0);
                g.tokens = (g.tokens + elapsed * rate_f).min(cap);
                g.last = now;
                let tranche = remaining.min(cap);
                if g.tokens >= tranche {
                    g.tokens -= tranche;
                    remaining -= tranche;
                    continue;
                }
                Duration::from_secs_f64((tranche - g.tokens) / rate_f)
            };
            // Cap the sleep so a live rate change takes effect promptly.
            tokio::time::sleep(wait.min(Duration::from_millis(250))).await;
        }
    }
}

/// A pause gate shared by the scheduler (pause-all) and individual transfers
/// (Phase 2). watch-channel based so waiters never miss a wakeup.
#[derive(Debug, Clone)]
pub struct PauseGate {
    tx: watch::Sender<bool>,
    // Keeps the channel open: with zero receivers `send()` silently fails.
    _rx: watch::Receiver<bool>,
}

impl PauseGate {
    fn new() -> Self {
        let (tx, _rx) = watch::channel(false);
        Self { tx, _rx }
    }
    fn is_paused(&self) -> bool {
        *self.tx.borrow()
    }
    fn set(&self, paused: bool) {
        let _ = self.tx.send(paused);
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub kind: TransferKind,
    pub source: String,
    pub destination: String,
    pub size: u64,
    pub transferred: u64,
    pub status: TransferStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Auto-retry round in progress (1- or 2-of-2), for the panel's
    /// "retrying in Ns (attempt N/3)" state (Plan 17 Phase 3).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_attempt: Option<u32>,
    /// Delta-sync accounting, present when this transfer ran as a block-level
    /// delta instead of a whole-file copy: how many bytes actually crossed the
    /// wire vs. how many were reused from the basis.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delta: Option<DeltaStats>,
    pub started_at: i64,
    /// Moving-average speed over the last ~10 s while transferring.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_per_sec: Option<u64>,
    /// Seconds left at the current speed; absent when unknown.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eta_secs: Option<u64>,
    /// Parallel ranges/parts in flight (segmented transfers only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segments: Option<u32>,
    /// No bytes have moved for a few seconds ("not responding").
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub stalled: bool,
    /// One-line note about the run, e.g. "remote changed, restarted".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notice: Option<String>,
    /// Loaded from `faro.db` at startup: an unfinished transfer from an
    /// earlier session, waiting for its connection and a Resume.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub restored: bool,
}

impl Transfer {
    /// Drop the live-only fields once the row stops transferring.
    fn settle(&mut self) {
        self.bytes_per_sec = None;
        self.eta_secs = None;
        self.segments = None;
        self.stalled = false;
    }
}

/// Delta-sync outcome attached to a finished [`Transfer`] (Agent backend only).
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeltaStats {
    /// Literal bytes that crossed the wire.
    pub sent: u64,
    /// Bytes reused from the basis (never transferred).
    pub reused: u64,
}

/// Everything needed to re-run a failed/canceled transfer with its already
/// policy-resolved destination (overwrite/skip/rename was applied at enqueue
/// time) — Plan 17 Phase 3 manual retry.
#[derive(Clone)]
enum RetryInfo {
    Download {
        session: Arc<Session>,
        remote_path: String,
        /// Where the file should end up; the policy is applied when the
        /// finished temp is renamed into place (Plan 24 Phase 2).
        target: PathBuf,
        policy: OverwritePolicy,
    },
    Upload {
        session: Arc<Session>,
        local: PathBuf,
        final_remote: String,
    },
    /// Unit tests drive the runner with a fake copy loop.
    #[cfg(test)]
    Test(
        Arc<
            dyn Fn(Arc<TransferManager>, String) -> futures::future::BoxFuture<'static, Result<u64>>
                + Send
                + Sync,
        >,
    ),
}

/// Default bound on concurrently running transfers (Plan 17); the rest wait
/// in the FIFO as `Queued`. Overridden by the `transferConcurrency` setting.
const DEFAULT_CONCURRENCY: usize = 3;

pub struct TransferManager {
    transfers: Mutex<HashMap<String, Transfer>>,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
    /// FIFO of transfer ids waiting for a slot (Plan 17). An id is popped only
    /// once it is at the front, the pause-all gate is open, and a concurrency
    /// permit is available — until then it waits as `Queued`.
    waiting: Mutex<VecDeque<String>>,
    semaphore: Arc<Semaphore>,
    concurrency: AtomicUsize,
    /// Manager-level pause gate. Admission checks it; Phase 2 checkpoints do too.
    pause_all: PauseGate,
    /// Per-transfer pause gates, created at enqueue time (Plan 17 Phase 2).
    pauses: Mutex<HashMap<String, PauseGate>>,
    /// Original resolved inputs per transfer, for manual retry (Phase 3).
    retry: Mutex<HashMap<String, RetryInfo>>,
    /// Bumped on every queue change so admission waiters re-check their turn.
    queue_gen: watch::Sender<u64>,
    /// Global bandwidth cap every copy loop draws from per chunk (Phase 4).
    bucket: TokenBucket,
    /// Delta-sync master switch (Plan 23 Phase 3): the `deltaSync` setting,
    /// live-adjustable like the concurrency bound. `FARO_DELTA=0` still
    /// force-disables regardless of this flag.
    delta_enabled: AtomicBool,
    /// Where events go. Bound by the first public call that carries an
    /// `AppHandle` (or `set_app` at startup); unset in unit tests, where
    /// emits are simply skipped.
    app: std::sync::OnceLock<AppHandle>,
    /// Lock-free counters of running transfers, read by the progress tick.
    live: std::sync::Mutex<HashMap<String, Arc<Live>>>,
    ticker: AtomicBool,
    /// What each unfinished download already has on disk (Plan 24).
    resumes: std::sync::Mutex<HashMap<String, ResumeState>>,
    /// `.faro-part` paths in use, so two downloads of one target never share
    /// a temp file.
    parts: std::sync::Mutex<HashMap<PathBuf, String>>,
    /// Paused object-store multipart uploads (see [`ObjectStash`]).
    object_uploads: Mutex<HashMap<String, ObjectStash>>,
    /// The `transferSegments` setting: max parallel ranges/parts per file,
    /// 0 = auto.
    segments: AtomicUsize,
    /// The `transferVerify` setting (Phase 6).
    verify: AtomicBool,
    /// Where resume records persist (Phase 4); unset in unit tests.
    db: std::sync::OnceLock<Arc<crate::db::Db>>,
    /// Rows restored from `faro.db`, by transfer id, until resumed.
    restored: Mutex<HashMap<String, crate::db::ResumeRow>>,
}

/// Bytes moved between resume checkpoints.
const RESUME_SAVE_BYTES: u64 = 8 * 1024 * 1024;
/// Longest gap between resume checkpoints while bytes move.
const RESUME_SAVE_EVERY: Duration = Duration::from_secs(2);
/// Ranges per file when `transferSegments` is `auto`, before probing.
const AUTO_SEGMENTS: usize = 4;

/// What an unfinished transfer already moved, and between which files.
/// A download resumes only while the remote identity still matches; an
/// upload only while the local source is unchanged.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub(crate) struct ResumeState {
    /// Downloads: byte ranges on disk. Uploads: `[0, n)` acknowledged.
    pub ranges: ranged::Intervals,
    /// Downloads: the remote file being fetched.
    pub identity: sources::RemoteIdentity,
    /// Downloads: the `.faro-part` temp.
    pub part_path: Option<PathBuf>,
    /// Uploads: the local source as it was when the upload started.
    pub local: Option<LocalIdentity>,
}

/// Size and mtime of a local upload source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct LocalIdentity {
    pub size: u64,
    pub mtime: i64,
}

async fn local_identity(path: &Path) -> Result<LocalIdentity> {
    let meta = tokio::fs::metadata(path)
        .await
        .with_context(|| format!("stat {}", path.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    Ok(LocalIdentity {
        size: meta.len(),
        mtime,
    })
}

/// An object-store multipart upload kept open across a pause, so resuming
/// sends only the parts not yet uploaded (within this app session;
/// object_store can't list an upload's parts after a restart).
struct ObjectStash {
    guard: MultipartGuard,
    offset: u64,
    local: LocalIdentity,
    key: String,
    /// MD5 of each part sent so far (ETag check, Phase 6).
    part_md5s: Vec<[u8; 16]>,
}

/// The Skip policy found the target already there when the download was
/// ready to move into place: the row ends as Skipped, not Done.
#[derive(Debug)]
struct SkippedAtPlace;

impl std::fmt::Display for SkippedAtPlace {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("destination already exists; skipped")
    }
}

impl std::error::Error for SkippedAtPlace {}

/// The ranged engine's view of one transfer: the shared bandwidth bucket,
/// the pause gates (no lock per chunk) and the live byte counter.
struct TransferCtl {
    mgr: Arc<TransferManager>,
    gate: Option<PauseGate>,
    live: Arc<Live>,
}

#[async_trait::async_trait]
impl ranged::Ctl for TransferCtl {
    async fn checkpoint(&self, bytes: u64) -> Result<()> {
        self.mgr.bucket.acquire(bytes).await;
        if self.mgr.pause_all.is_paused() || self.gate.as_ref().is_some_and(|g| g.is_paused()) {
            return Err(Paused.into());
        }
        Ok(())
    }

    fn progressed(&self, bytes: u64) {
        self.live.add(bytes);
    }

    fn rewound(&self, bytes: u64) {
        let _ = self
            .live
            .bytes
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |b| Some(b.saturating_sub(bytes)));
    }
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Join a remote directory and a file name using the separator the directory
/// already speaks: backslash for a Windows-style path (`C:\srv`, `\\host\share`),
/// forward slash everywhere else. An existing trailing separator is reused
/// rather than doubled.
fn join_remote(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        return name.to_string();
    }
    if dir.ends_with('/') || dir.ends_with('\\') {
        return format!("{dir}{name}");
    }
    let windows_style = dir.contains('\\') && !dir.contains('/');
    format!("{dir}{}{name}", if windows_style { '\\' } else { '/' })
}

fn basename(path: &str) -> String {
    path.trim_end_matches(['/', '\\']).rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(path)
        .to_string()
}

/// Append _1, _2, … to the stem until a free local path is found.
fn resolve_local_rename(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or(Path::new("."));
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for i in 1..=999 {
        let candidate = parent.join(format!("{stem}_{i}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    path.to_path_buf()
}

/// Same idea for a remote path. Uses sftp.metadata to probe existence.
async fn resolve_remote_rename(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
) -> String {
    if sftp.metadata(path).await.is_err() {
        return path.to_string();
    }
    let (stem, ext) = match path.rfind('.') {
        Some(dot) if dot > path.rfind('/').unwrap_or(0) => {
            (&path[..dot], &path[dot..])
        }
        _ => (path, ""),
    };
    for i in 1..=999 {
        let candidate = format!("{stem}_{i}{ext}");
        if sftp.metadata(&candidate).await.is_err() {
            return candidate;
        }
    }
    path.to_string()
}

impl TransferManager {
    pub fn new() -> Self {
        Self {
            transfers: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            waiting: Mutex::new(VecDeque::new()),
            semaphore: Arc::new(Semaphore::new(DEFAULT_CONCURRENCY)),
            concurrency: AtomicUsize::new(DEFAULT_CONCURRENCY),
            pause_all: PauseGate::new(),
            pauses: Mutex::new(HashMap::new()),
            retry: Mutex::new(HashMap::new()),
            queue_gen: watch::channel(0).0,
            bucket: TokenBucket::new(),
            delta_enabled: AtomicBool::new(true),
            app: std::sync::OnceLock::new(),
            live: std::sync::Mutex::new(HashMap::new()),
            ticker: AtomicBool::new(false),
            resumes: std::sync::Mutex::new(HashMap::new()),
            parts: std::sync::Mutex::new(HashMap::new()),
            object_uploads: Mutex::new(HashMap::new()),
            segments: AtomicUsize::new(0),
            verify: AtomicBool::new(false),
            db: std::sync::OnceLock::new(),
            restored: Mutex::new(HashMap::new()),
        }
    }

    /// Persist resume records in `db` (Plan 24 Phase 4).
    pub fn set_db(&self, db: Arc<crate::db::Db>) {
        let _ = self.db.set(db);
    }

    /// Bring back the unfinished transfers an earlier session left in
    /// `faro.db`, as Paused rows with a Resume action. They need their
    /// connection, so they wait for the user to open it and resume.
    pub async fn restore(&self) {
        let Some(db) = self.db.get() else { return };
        let rows = match db.resume_list() {
            Ok(r) => r,
            Err(e) => {
                tracing::warn!("loading unfinished transfers: {e:#}");
                return;
            }
        };
        for row in rows {
            let download = row.kind == "download";
            // A download whose temp is gone has nothing left to resume (it
            // finished just before the app closed, or the user deleted it).
            if download
                && !row
                    .part_path
                    .as_deref()
                    .is_some_and(|p| std::path::Path::new(p).exists())
            {
                let _ = db.resume_delete(&row.id);
                continue;
            }
            let ranges: ranged::Intervals =
                serde_json::from_str(&row.ranges_done).unwrap_or_default();
            let t = Transfer {
                id: row.id.clone(),
                kind: if download {
                    TransferKind::Download
                } else {
                    TransferKind::Upload
                },
                source: row.source.clone(),
                destination: row.destination.clone(),
                size: row.size,
                transferred: ranges.total(),
                status: TransferStatus::Paused,
                error: None,
                retry_attempt: None,
                delta: None,
                started_at: (row.updated_at / 1000).max(0),
                bytes_per_sec: None,
                eta_secs: None,
                segments: None,
                stalled: false,
                notice: None,
                restored: true,
            };
            let state = ResumeState {
                ranges,
                identity: sources::RemoteIdentity {
                    size: row.remote_size,
                    etag: row.remote_etag.clone(),
                    mtime: row.remote_mtime,
                },
                part_path: row.part_path.as_ref().map(PathBuf::from),
                local: match (row.local_size, row.local_mtime) {
                    (Some(size), Some(mtime)) => Some(LocalIdentity { size, mtime }),
                    _ => None,
                },
            };
            if let Some(p) = &state.part_path {
                self.parts
                    .lock()
                    .expect("part map")
                    .insert(p.clone(), row.id.clone());
            }
            self.resumes
                .lock()
                .expect("resume map")
                .insert(row.id.clone(), state);
            self.pauses.lock().await.insert(row.id.clone(), PauseGate::new());
            self.insert(t).await;
            self.restored.lock().await.insert(row.id.clone(), row);
        }
    }

    /// The connection (profile id) a restored row needs, if `id` is one.
    pub async fn restored_connection(&self, id: &str) -> Option<String> {
        self.restored
            .lock()
            .await
            .get(id)
            .map(|r| r.connection_id.clone())
    }

    /// Resume a row restored from an earlier session on `session` (the
    /// now-open connection it belongs to).
    pub async fn resume_restored(
        self: &Arc<Self>,
        id: &str,
        session: Arc<Session>,
        app: &AppHandle,
    ) -> Result<()> {
        self.set_app(app);
        self.requeue_restored(id, session).await
    }

    async fn requeue_restored(self: &Arc<Self>, id: &str, session: Arc<Session>) -> Result<()> {
        let row = self
            .restored
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| anyhow::anyhow!("transfer {id} is not waiting to be resumed"))?;
        let job = if row.kind == "download" {
            RetryInfo::Download {
                session,
                remote_path: row.source.clone(),
                target: PathBuf::from(&row.destination),
                policy: match row.policy.as_str() {
                    "skip" => OverwritePolicy::Skip,
                    "rename" => OverwritePolicy::Rename,
                    _ => OverwritePolicy::Overwrite,
                },
            }
        } else {
            RetryInfo::Upload {
                session,
                local: PathBuf::from(&row.source),
                final_remote: row.destination.clone(),
            }
        };
        self.retry.lock().await.insert(id.to_string(), job.clone());
        if let Some(g) = self.pauses.lock().await.get(id) {
            g.set(false);
        }
        self.update(id, |t| {
            t.status = TransferStatus::Queued;
            t.restored = false;
        })
        .await;
        if let Some(t) = self.get(id).await {
            self.emit("transfer://updated", &t);
        }
        self.waiting.lock().await.push_back(id.to_string());
        self.bump_queue_quiet().await;
        let task = tokio::spawn(run_job(Arc::clone(self), id.to_string(), job));
        self.tasks.lock().await.insert(id.to_string(), task);
        Ok(())
    }

    /// The `faro.db` record for a transfer's resume state.
    async fn resume_row(&self, id: &str, st: &ResumeState) -> Option<crate::db::ResumeRow> {
        let t = self.get(id).await?;
        let info = self.retry.lock().await.get(id).cloned()?;
        let (session, destination, policy, kind) = match &info {
            RetryInfo::Download {
                session,
                target,
                policy,
                ..
            } => (
                Arc::clone(session),
                target.to_string_lossy().into_owned(),
                *policy,
                "download",
            ),
            RetryInfo::Upload { session, .. } => (
                Arc::clone(session),
                t.destination.clone(),
                OverwritePolicy::Overwrite,
                "upload",
            ),
            #[cfg(test)]
            RetryInfo::Test(_) => return None,
        };
        Some(crate::db::ResumeRow {
            id: id.to_string(),
            connection_id: session.profile().id.clone(),
            kind: kind.into(),
            source: t.source.clone(),
            destination,
            part_path: st.part_path.as_ref().map(|p| p.to_string_lossy().into_owned()),
            size: t.size,
            policy: serde_json::to_value(policy)
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_else(|| "overwrite".into()),
            remote_size: st.identity.size,
            remote_etag: st.identity.etag.clone(),
            remote_mtime: st.identity.mtime,
            local_size: st.local.map(|l| l.size),
            local_mtime: st.local.map(|l| l.mtime),
            ranges_done: serde_json::to_string(&st.ranges).unwrap_or_else(|_| "[]".into()),
            updated_at: crate::db::now_ms(),
        })
    }

    /// Live-adjust `transferSegments` (`None` = auto).
    pub fn set_segments(&self, n: Option<usize>) {
        self.segments
            .store(n.map(|n| n.clamp(1, 16)).unwrap_or(0), Ordering::Relaxed);
    }

    /// Live-adjust `transferVerify`.
    pub fn set_verify(&self, on: bool) {
        self.verify.store(on, Ordering::Relaxed);
    }

    fn verify_enabled(&self) -> bool {
        self.verify.load(Ordering::Relaxed)
    }

    /// Max ranges per file and whether to auto-tune beyond it.
    fn segment_cap(&self) -> (usize, bool) {
        match self.segments.load(Ordering::Relaxed) {
            0 => (AUTO_SEGMENTS, true),
            n => (n, false),
        }
    }

    async fn ctl(self: &Arc<Self>, id: &str) -> Arc<dyn ranged::Ctl> {
        Arc::new(TransferCtl {
            mgr: Arc::clone(self),
            gate: self.pauses.lock().await.get(id).cloned(),
            live: self.live(id),
        })
    }

    fn resume_state(&self, id: &str) -> Option<ResumeState> {
        self.resumes.lock().expect("resume map").get(id).cloned()
    }

    /// The temp file for `target`, unless another running download already
    /// uses that name; then one tagged with this transfer's id.
    fn claim_part_path(&self, id: &str, target: &Path) -> PathBuf {
        let mut parts = self.parts.lock().expect("part map");
        let mut path = partfile::part_path_for(target);
        if parts.get(&path).is_some_and(|owner| owner != id) {
            let tag = id.split('-').next().unwrap_or(id);
            let mut name = target.file_name().map(|n| n.to_os_string()).unwrap_or_default();
            name.push(format!(".{tag}{}", partfile::PART_SUFFIX));
            path = target.with_file_name(name);
        }
        parts.insert(path.clone(), id.to_string());
        path
    }

    /// Record (or replace) a transfer's resume state, in memory and in
    /// `faro.db`. Called before the temp file is created, so a crash never
    /// leaves a `.faro-part` nothing knows about.
    async fn store_resume(&self, id: &str, state: ResumeState) {
        if let Some(db) = self.db.get() {
            if let Some(row) = self.resume_row(id, &state).await {
                if let Err(e) = db.resume_upsert(&row) {
                    tracing::warn!("saving resume state for {id}: {e:#}");
                }
            }
        }
        if let Some(p) = &state.part_path {
            self.parts
                .lock()
                .expect("part map")
                .insert(p.clone(), id.to_string());
        }
        self.resumes
            .lock()
            .expect("resume map")
            .insert(id.to_string(), state);
    }

    /// Update the ranges on disk. Call only after the data was synced (or
    /// acknowledged): the record must never claim bytes that aren't there.
    async fn save_ranges(&self, id: &str, ranges: ranged::Intervals) {
        if let Some(db) = self.db.get() {
            let json = serde_json::to_string(&ranges).unwrap_or_else(|_| "[]".into());
            if let Err(e) = db.resume_set_ranges(id, &json) {
                tracing::warn!("saving resume progress for {id}: {e:#}");
            }
        }
        if let Some(st) = self.resumes.lock().expect("resume map").get_mut(id) {
            st.ranges = ranges;
        }
    }

    /// Drop a download's resume state; `delete_part` also removes the temp
    /// (cancel, or a remote that changed).
    async fn forget_resume(&self, id: &str, delete_part: bool) {
        if let Some(db) = self.db.get() {
            if let Err(e) = db.resume_delete(id) {
                tracing::warn!("clearing resume state for {id}: {e:#}");
            }
        }
        self.restored.lock().await.remove(id);
        let st = self.resumes.lock().expect("resume map").remove(id);
        if let Some(path) = st.and_then(|st| st.part_path) {
            self.parts.lock().expect("part map").remove(&path);
            if delete_part {
                let _ = tokio::fs::remove_file(&path).await;
            }
        }
        // An unfinished multipart upload is aborted when its stash drops.
        self.object_uploads.lock().await.remove(id);
    }

    /// Checksum a finished download against the server when the
    /// `transferVerify` setting is on and the backend can produce one
    /// (Phase 6). Size and range coverage are checked regardless.
    async fn verify_download(
        &self,
        session: &Arc<Session>,
        remote_path: &str,
        part_path: &Path,
        finished: &partfile::Finished,
    ) -> Result<()> {
        if !self.verify_enabled() {
            return Ok(());
        }
        match &**session {
            Session::Ssh(ssh) => {
                let (Some(local), Some(remote)) =
                    (finished.sha256.as_deref(), verify::remote_sha256(ssh, remote_path).await)
                else {
                    tracing::info!("{remote_path}: no remote sha256; checked size only");
                    return Ok(());
                };
                if local != remote {
                    return Err(verify::mismatch("SHA-256", local, &remote));
                }
            }
            Session::Agent(agent) => {
                let remote = verify::agent_hash(agent, remote_path).await?;
                let local = verify::local_agent_hash(part_path).await?;
                if local != remote {
                    return Err(verify::mismatch("BLAKE3", &local, &remote));
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Checksum a finished upload against the server (Phase 6). Object-store
    /// uploads check their ETag inside [`Self::run_object_upload`]; delta
    /// uploads are hash-checked by the daemon already.
    async fn verify_upload(
        &self,
        id: &str,
        session: &Arc<Session>,
        local: &Path,
        remote_path: &str,
    ) -> Result<()> {
        if !self.verify_enabled() {
            return Ok(());
        }
        match &**session {
            Session::Ssh(ssh) => {
                let Some(remote) = verify::remote_sha256(ssh, remote_path).await else {
                    tracing::info!("{remote_path}: no remote sha256; checked size only");
                    return Ok(());
                };
                let local = verify::local_sha256(local).await?;
                if local != remote {
                    return Err(verify::mismatch("SHA-256", &local, &remote));
                }
            }
            Session::Agent(agent) => {
                if self.get(id).await.is_some_and(|t| t.delta.is_some()) {
                    return Ok(());
                }
                let remote = verify::agent_hash(agent, remote_path).await?;
                let local = verify::local_agent_hash(local).await?;
                if local != remote {
                    return Err(verify::mismatch("BLAKE3", &local, &remote));
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The live counters for `id`, created on first use.
    fn live(&self, id: &str) -> Arc<Live> {
        let mut map = self.live.lock().expect("live map poisoned");
        Arc::clone(map.entry(id.to_string()).or_default())
    }

    fn drop_live(&self, id: &str) {
        self.live.lock().expect("live map poisoned").remove(id);
    }

    /// A copy loop reached `total` bytes. Lock-free: the 250 ms tick turns
    /// it into a progress event.
    fn progress(&self, id: &str, total: u64) {
        self.live(id).set(total);
    }

    /// Start the progress tick (once): every 250 ms, fold the live counters
    /// into the rows, compute speed/ETA, and emit one
    /// `transfer://progress-batch` with every row that changed.
    pub fn start_ticker(self: &Arc<Self>) {
        if self.ticker.swap(true, Ordering::AcqRel) {
            return;
        }
        let weak = Arc::downgrade(self);
        tauri::async_runtime::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_millis(250));
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                every.tick().await;
                let Some(mgr) = weak.upgrade() else { break };
                let changed = mgr.tick().await;
                if !changed.is_empty() {
                    mgr.emit("transfer://progress-batch", &changed);
                }
            }
        });
    }

    /// One progress tick; returns the rows that changed.
    async fn tick(&self) -> Vec<Transfer> {
        let live: Vec<(String, Arc<Live>)> = self
            .live
            .lock()
            .expect("live map poisoned")
            .iter()
            .map(|(k, v)| (k.clone(), Arc::clone(v)))
            .collect();
        if live.is_empty() {
            return Vec::new();
        }
        let now = Instant::now();
        let mut changed = Vec::new();
        let mut transfers = self.transfers.lock().await;
        for (id, l) in live {
            let Some(t) = transfers.get_mut(&id) else { continue };
            if t.status != TransferStatus::Transferring {
                continue;
            }
            let bytes = l.get();
            let speed = l.ring.lock().expect("speed ring poisoned").sample(bytes, now);
            let segments = match l.segments.load(Ordering::Relaxed) {
                0 => None,
                n => Some(n as u32),
            };
            let stalled = l.stalled.load(Ordering::Relaxed);
            let eta = speed::eta_secs(t.size, bytes, speed);
            if t.transferred != bytes
                || t.bytes_per_sec != speed
                || t.segments != segments
                || t.stalled != stalled
            {
                t.transferred = bytes;
                t.bytes_per_sec = speed;
                t.eta_secs = eta;
                t.segments = segments;
                t.stalled = stalled;
                changed.push(t.clone());
            }
        }
        changed
    }

    /// Bind the app handle events are emitted through.
    pub fn set_app(&self, app: &AppHandle) {
        let _ = self.app.set(app.clone());
    }

    /// Emit a transfer event when an app is bound (always, outside tests).
    fn emit<S: Serialize + Clone>(&self, event: &str, payload: &S) {
        if let Some(app) = self.app.get() {
            let _ = app.emit(event, payload);
        }
    }

    pub async fn list(&self) -> Vec<Transfer> {
        let mut v: Vec<Transfer> = self.transfers.lock().await.values().cloned().collect();
        v.sort_by_key(|t| t.started_at);
        v
    }

    pub(crate) async fn get(&self, id: &str) -> Option<Transfer> {
        self.transfers.lock().await.get(id).cloned()
    }

    /// Public snapshot of a single transfer by id (used by the Agent Bridge so
    /// an agent can poll whether a download/upload it started has finished).
    pub async fn snapshot(&self, id: &str) -> Option<Transfer> {
        self.transfers.lock().await.get(id).cloned()
    }

    async fn update<F: FnOnce(&mut Transfer)>(&self, id: &str, f: F) {
        if let Some(t) = self.transfers.lock().await.get_mut(id) {
            f(t);
        }
    }

    async fn insert(&self, t: Transfer) {
        self.transfers.lock().await.insert(t.id.clone(), t);
    }

    // ---------- Queue scheduling (Plan 17) ----------

    fn build_queue_state(&self, waiting: &VecDeque<String>) -> QueueState {
        QueueState {
            waiting: waiting.iter().cloned().collect(),
            paused_all: self.pause_all.is_paused(),
            concurrency: self.concurrency.load(Ordering::Relaxed),
            throttle_kbps: self.bucket.rate_kbps(),
        }
    }

    /// Current queue snapshot for the panel's initial load.
    pub async fn queue_state(&self) -> QueueState {
        let w = self.waiting.lock().await;
        self.build_queue_state(&w)
    }

    /// Emit `transfer://queue` and bump the generation so admission waiters
    /// re-check whether it is their turn.
    async fn bump_queue(&self, app: &AppHandle) {
        self.set_app(app);
        self.bump_queue_quiet().await;
    }

    /// [`Self::bump_queue`] through the bound app handle.
    async fn bump_queue_quiet(&self) {
        let state = {
            let w = self.waiting.lock().await;
            self.build_queue_state(&w)
        };
        self.queue_gen.send_modify(|g| *g += 1);
        self.emit("transfer://queue", &state);
    }

    /// Wait until this transfer is at the front of the FIFO with the pause-all
    /// gate open, take a concurrency permit, and pop it from the queue.
    /// Returns `None` if the id left the queue (canceled while waiting).
    /// The permit is returned so the caller holds it for the transfer's life.
    async fn admit(&self, id: &str) -> Option<OwnedSemaphorePermit> {
        let mut rx = self.queue_gen.subscribe();
        loop {
            {
                let w = self.waiting.lock().await;
                if !w.iter().any(|x| x == id) {
                    return None;
                }
                if !self.is_my_turn(&w, id).await {
                    drop(w);
                    if rx.changed().await.is_err() {
                        return None;
                    }
                    continue;
                }
            }
            // My turn: take a permit, then pop.
            let permit = self.semaphore.clone().acquire_owned().await.ok()?;
            let mut w = self.waiting.lock().await;
            if self.is_my_turn(&w, id).await {
                if let Some(pos) = w.iter().position(|x| x == id) {
                    w.remove(pos);
                }
                return Some(permit);
            }
            // Lost a race (pause engaged mid-acquire): release, re-evaluate.
            drop(permit);
            if !w.iter().any(|x| x == id) {
                return None;
            }
            drop(w);
        }
    }

    /// Is `id` the first waiting transfer allowed to run? Strict FIFO except
    /// that per-transfer-paused rows are skipped (a paused row must not
    /// head-of-line block the queue); pause-all blocks everyone. Caller must
    /// hold the `waiting` lock; lock order is waiting → pauses.
    async fn is_my_turn(&self, w: &VecDeque<String>, id: &str) -> bool {
        if self.pause_all.is_paused() {
            return false;
        }
        let pauses = self.pauses.lock().await;
        let first_open = w
            .iter()
            .position(|x| pauses.get(x).is_none_or(|g| !g.is_paused()));
        first_open == w.iter().position(|x| x == id)
    }

    /// Reorder a waiting transfer (active transfers are untouched).
    pub async fn move_in_queue(&self, id: &str, up: bool, app: &AppHandle) -> Result<()> {
        {
            let mut w = self.waiting.lock().await;
            let Some(pos) = w.iter().position(|x| x == id) else {
                anyhow::bail!("transfer {id} is not waiting in the queue");
            };
            let swap_with = if up {
                pos.checked_sub(1)
            } else if pos + 1 < w.len() {
                Some(pos + 1)
            } else {
                None
            };
            if let Some(other) = swap_with {
                w.swap(pos, other);
            }
        }
        self.bump_queue(app).await;
        Ok(())
    }

    /// Pause admission of new transfers (running ones keep going until Phase
    /// 2's chunk checkpoints let them park too).
    pub async fn pause_all(&self, app: &AppHandle) {
        self.pause_all.set(true);
        self.bump_queue(app).await;
    }

    pub async fn resume_all(&self, app: &AppHandle) {
        self.pause_all.set(false);
        self.bump_queue(app).await;
    }

    pub fn is_paused_all(&self) -> bool {
        self.pause_all.is_paused()
    }

    /// Chunk-boundary checkpoint shared by every copy loop (Plan 17). Draws
    /// `bytes` from the global bandwidth bucket (Phase 4), then fails with
    /// [`Paused`] when the transfer (or the whole manager) is paused. The
    /// runner releases the concurrency slot and re-queues (Plan 24 Phase 1);
    /// parking here would hold the slot and stall the queue.
    async fn checkpoint(&self, id: &str, bytes: u64) -> Result<()> {
        self.bucket.acquire(bytes).await;
        if self.is_gated(id).await {
            return Err(Paused.into());
        }
        Ok(())
    }

    /// Is this transfer held back by its own pause gate or by pause-all?
    async fn is_gated(&self, id: &str) -> bool {
        if self.pause_all.is_paused() {
            return true;
        }
        self.pauses
            .lock()
            .await
            .get(id)
            .is_some_and(|g| g.is_paused())
    }

    /// A running transfer stopped at a checkpoint because of a pause: put it
    /// back at the front of the FIFO (so it is the first to run again once
    /// resumed) and show it as Paused, or Queued when only pause-all held it.
    async fn requeue_paused(&self, id: &str) {
        {
            let mut w = self.waiting.lock().await;
            if !w.iter().any(|x| x == id) {
                w.push_front(id.to_string());
            }
        }
        let own_pause = self
            .pauses
            .lock()
            .await
            .get(id)
            .is_some_and(|g| g.is_paused());
        self.update(id, |t| {
            t.status = if own_pause {
                TransferStatus::Paused
            } else {
                TransferStatus::Queued
            };
            t.settle();
        })
        .await;
        if let Some(t) = self.get(id).await {
            self.emit("transfer://updated", &t);
        }
        self.bump_queue_quiet().await;
    }

    /// Pause a queued or transferring transfer. A running one parks at the
    /// next chunk boundary; a queued one is skipped by admission until resumed.
    pub async fn pause(&self, id: &str, app: &AppHandle) -> Result<()> {
        match self.get(id).await.map(|t| t.status) {
            Some(TransferStatus::Transferring) | Some(TransferStatus::Queued) => {}
            _ => anyhow::bail!("transfer {id} is not running or queued"),
        }
        let gate = self
            .pauses
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("transfer {id} not found"))?;
        gate.set(true);
        self.update(id, |t| {
            t.status = TransferStatus::Paused;
            t.settle();
        })
        .await;
        if let Some(t) = self.get(id).await {
            let _ = app.emit("transfer://updated", &t);
        }
        Ok(())
    }

    /// Resume a paused transfer. A parked one re-runs its file from byte 0;
    /// a queued one re-enters FIFO admission.
    pub async fn resume(&self, id: &str, app: &AppHandle) -> Result<()> {
        if self.restored.lock().await.contains_key(id) {
            anyhow::bail!("transfer {id} needs its connection: use resume_restored");
        }
        if self.get(id).await.map(|t| t.status) != Some(TransferStatus::Paused) {
            anyhow::bail!("transfer {id} is not paused");
        }
        let still_queued = self.waiting.lock().await.iter().any(|x| x == id);
        let gate = self
            .pauses
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("transfer {id} not found"))?;
        self.update(id, |t| {
            t.status = if still_queued {
                TransferStatus::Queued
            } else {
                TransferStatus::Transferring
            };
        })
        .await;
        gate.set(false);
        if let Some(t) = self.get(id).await {
            let _ = app.emit("transfer://updated", &t);
        }
        // Wake admission waiters: a queued row may have become runnable.
        self.bump_queue(app).await;
        Ok(())
    }

    /// Re-enqueue a failed or canceled transfer with its original (already
    /// policy-resolved) source/destination. Same id — the panel row resets
    /// in place (Plan 17 Phase 3 manual retry).
    pub async fn retry(self: &Arc<Self>, id: &str, app: &AppHandle) -> Result<()> {
        match self.get(id).await.map(|t| t.status) {
            Some(TransferStatus::Error) | Some(TransferStatus::Canceled) => {}
            _ => anyhow::bail!("only failed or canceled transfers can be retried"),
        }
        let info = self
            .retry
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("transfer {id} cannot be retried"))?;
        if let Some(h) = self.tasks.lock().await.remove(id) {
            h.abort();
        }
        // A cancel-while-paused leaves the gate closed — reopen it.
        if let Some(g) = self.pauses.lock().await.get(id) {
            g.set(false);
        }
        self.update(id, |t| {
            t.status = TransferStatus::Queued;
            t.error = None;
            t.retry_attempt = None;
            t.notice = None;
        })
        .await;
        if let Some(t) = self.get(id).await {
            let _ = app.emit("transfer://updated", &t);
        }
        self.waiting.lock().await.push_back(id.to_string());
        self.bump_queue(app).await;
        let task = tokio::spawn(run_job(Arc::clone(self), id.to_string(), info));
        self.tasks.lock().await.insert(id.to_string(), task);
        Ok(())
    }

    /// Live-adjust the global bandwidth cap (KiB/s, 0 = unlimited). Takes
    /// effect on the next chunk of every active transfer.
    pub fn set_throttle_kbps(&self, kbps: u64) {
        self.bucket.set_rate_kbps(kbps);
    }

    /// Live-adjust the concurrency bound. Growing adds permits at once;
    /// shrinking forgets permits as running transfers release them, so
    /// in-flight transfers are never killed to satisfy the new bound.
    pub fn set_concurrency(&self, n: usize) {
        let n = n.clamp(1, 32);
        let old = self.concurrency.swap(n, Ordering::Relaxed);
        if n > old {
            self.semaphore.add_permits(n - old);
        } else if n < old {
            let sem = Arc::clone(&self.semaphore);
            tokio::spawn(async move {
                if let Ok(p) = sem.acquire_many((old - n) as u32).await {
                    p.forget();
                }
            });
        }
    }

    /// Live-adjust the delta-sync switch (the `deltaSync` setting, Plan 23
    /// Phase 3). Takes effect on the next transfer decision; `FARO_DELTA=0`
    /// still force-disables regardless.
    pub fn set_delta_enabled(&self, enabled: bool) {
        self.delta_enabled.store(enabled, Ordering::Relaxed);
    }

    /// Delta-sync master switch: the `deltaSync` setting (default on), with
    /// `FARO_DELTA=0` as a force-off escape hatch. Read once per transfer
    /// decision.
    fn delta_enabled(&self) -> bool {
        std::env::var("FARO_DELTA").ok().as_deref() != Some("0")
            && self.delta_enabled.load(Ordering::Relaxed)
    }

    pub async fn cancel(&self, id: &str, app: &AppHandle) -> Result<()> {
        {
            let mut w = self.waiting.lock().await;
            if let Some(pos) = w.iter().position(|x| x == id) {
                w.remove(pos);
            }
        }
        if let Some(h) = self.tasks.lock().await.remove(id) {
            h.abort();
        }
        self.drop_live(id);
        // Cancel discards the partial download (pause and error keep it).
        self.forget_resume(id, true).await;
        self.update(id, |t| {
            if matches!(
                t.status,
                TransferStatus::Transferring | TransferStatus::Queued | TransferStatus::Paused
            ) {
                t.status = TransferStatus::Canceled;
                t.settle();
            }
        })
        .await;
        // There is no `transfer://canceled` event — `updated` carries the row.
        if let Some(t) = self.get(id).await {
            let _ = app.emit("transfer://updated", &t);
        }
        self.bump_queue(app).await;
        Ok(())
    }

    pub async fn start_download(
        self: &Arc<Self>,
        session: Arc<Session>,
        remote_path: String,
        local_dir: String,
        policy: OverwritePolicy,
        app: AppHandle,
    ) -> Result<String> {
        let size = remote_size(&session, &remote_path).await.unwrap_or(0);

        let initial = PathBuf::from(&local_dir).join(basename(&remote_path));
        // Skip is decided now (no point downloading a file we'll drop) and
        // again at rename time; Rename shows its likely name now and picks a
        // free one at rename time; Overwrite only replaces the existing file
        // once the new one is complete.
        let (final_path, skip) = match policy {
            OverwritePolicy::Overwrite => (initial, false),
            OverwritePolicy::Skip => {
                let exists = initial.exists();
                (initial, exists)
            }
            OverwritePolicy::Rename => (resolve_local_rename(&initial), false),
        };

        let id = Uuid::new_v4().to_string();
        let transfer = Transfer {
            id: id.clone(),
            kind: TransferKind::Download,
            source: remote_path.clone(),
            destination: final_path.to_string_lossy().into_owned(),
            size,
            transferred: 0,
            status: if skip {
                TransferStatus::Skipped
            } else {
                TransferStatus::Queued
            },
            error: None,
            retry_attempt: None,
            delta: None,
            started_at: now_ts(),
            bytes_per_sec: None,
            eta_secs: None,
            segments: None,
            stalled: false,
            notice: None,
            restored: false,
        };
        self.insert(transfer.clone()).await;
        let _ = app.emit("transfer://added", &transfer);

        if skip {
            let _ = app.emit("transfer://done", &transfer);
            return Ok(id);
        }

        self.retry.lock().await.insert(
            id.clone(),
            RetryInfo::Download {
                session: Arc::clone(&session),
                remote_path: remote_path.clone(),
                target: final_path.clone(),
                policy,
            },
        );
        self.waiting.lock().await.push_back(id.clone());
        self.pauses.lock().await.insert(id.clone(), PauseGate::new());
        self.bump_queue(&app).await;

        let job = self
            .retry
            .lock()
            .await
            .get(&id)
            .cloned()
            .expect("retry info registered above");
        let task = tokio::spawn(run_job(Arc::clone(self), id.clone(), job));
        self.tasks.lock().await.insert(id.clone(), task);
        Ok(id)
    }

    pub async fn start_upload(
        self: &Arc<Self>,
        session: Arc<Session>,
        local_path: String,
        remote_dir: String,
        policy: OverwritePolicy,
        app: AppHandle,
    ) -> Result<String> {
        let local = PathBuf::from(&local_path);
        let size = tokio::fs::metadata(&local)
            .await
            .with_context(|| format!("stat {}", local.display()))?
            .len();

        // Join with the separator the destination already uses, and don't add a
        // second one. A Windows agent target spelled `C:\srv\` used to produce
        // `C:\srv\/file` — Win32 tolerates it, but it shows up in every error
        // message and audit line, and the mixed form trips path comparisons.
        let initial_remote = join_remote(&remote_dir, &basename(&local_path));

        let (final_remote, skip) = remote_resolve(&session, &initial_remote, policy).await?;

        let id = Uuid::new_v4().to_string();
        let transfer = Transfer {
            id: id.clone(),
            kind: TransferKind::Upload,
            source: local_path.clone(),
            destination: final_remote.clone(),
            size,
            transferred: 0,
            status: if skip {
                TransferStatus::Skipped
            } else {
                TransferStatus::Queued
            },
            error: None,
            retry_attempt: None,
            delta: None,
            started_at: now_ts(),
            bytes_per_sec: None,
            eta_secs: None,
            segments: None,
            stalled: false,
            notice: None,
            restored: false,
        };
        self.insert(transfer.clone()).await;
        let _ = app.emit("transfer://added", &transfer);

        if skip {
            let _ = app.emit("transfer://done", &transfer);
            return Ok(id);
        }

        self.retry.lock().await.insert(
            id.clone(),
            RetryInfo::Upload {
                session: Arc::clone(&session),
                local: local.clone(),
                final_remote: final_remote.clone(),
            },
        );
        self.waiting.lock().await.push_back(id.clone());
        self.pauses.lock().await.insert(id.clone(), PauseGate::new());
        self.bump_queue(&app).await;

        let job = self
            .retry
            .lock()
            .await
            .get(&id)
            .cloned()
            .expect("retry info registered above");
        let task = tokio::spawn(run_job(Arc::clone(self), id.clone(), job));
        self.tasks.lock().await.insert(id.clone(), task);
        Ok(id)
    }

    /// Stream an upload to a Faro Agent daemon by ranged `WriteChunk`s. The first
    /// chunk truncates/creates the file; subsequent chunks append at the offset.
    /// `app: None` (tests) skips the progress events — see
    /// [`Self::agent_download_core`].
    async fn agent_upload_core(
        &self,
        id: &str,
        session: &Arc<crate::session::AgentSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        use base64::Engine as _;
        use faro_agent_proto::msg::{Request, Response};
        self.update(id, |t| t.status = TransferStatus::Transferring).await;

        let mut local_file = tokio::fs::File::open(local_path)
            .await
            .with_context(|| format!("open {}", local_path.display()))?;
        // 128 KiB plaintext keeps each request comfortably under the daemon's
        // per-chunk cap while amortising the round-trip.
        let mut buf = vec![0u8; 128 * 1024];
        let mut offset: u64 = 0;
        let mut first = true;
        loop {
            let n = local_file.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            self.checkpoint(id, n as u64).await?;
            let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
            let resp = session
                .request(Request::WriteChunk {
                    path: remote_path.to_string(),
                    offset,
                    data,
                    truncate: first,
                    done: false,
                })
                .await?;
            match resp {
                Response::Written { .. } => {}
                Response::Error { message, .. } => {
                    return Err(anyhow::anyhow!("upload {remote_path}: {message}"))
                }
                other => return Err(anyhow::anyhow!("upload {remote_path}: unexpected {other:?}")),
            }
            offset += n as u64;
            first = false;
            self.progress(id, offset);
        }
        self.update(id, |t| t.transferred = offset).await;
        Ok(offset)
    }

    /// Agent upload entry point (delta-sync Phase 2): attempt a block-level
    /// delta when the switch is on, a remote basis exists, and the file is big
    /// enough — ANY delta error logs and falls back to the whole-file upload.
    async fn run_agent_upload_with_delta(
        &self,
        id: &str,
        session: Arc<crate::session::AgentSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        self.agent_upload_with_delta_core(id, &session, local_path, remote_path)
            .await
    }

    /// Gate + fallback logic behind [`Self::run_agent_upload_with_delta`];
    /// `app: None` (tests) skips progress events.
    async fn agent_upload_with_delta_core(
        &self,
        id: &str,
        session: &Arc<crate::session::AgentSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        let size = tokio::fs::metadata(local_path).await.map(|m| m.len()).unwrap_or(0);
        let (_basis_size, basis_exists) = agent_stat(session, remote_path).await;
        if self.delta_enabled() && faro_agent_proto::delta::should_attempt_delta(size, basis_exists, true)
        {
            match self
                .agent_delta_upload_core(id, session, local_path, remote_path)
                .await
            {
                Ok(n) => return Ok(n),
                Err(e) => {
                    tracing::warn!("delta upload fell back to whole-file copy: {e:#}");
                    self.update(id, |t| t.transferred = 0).await;
                }
            }
        }
        self.agent_upload_core(id, session, local_path, remote_path)
            .await
    }

    /// Upload to a Faro Agent daemon as a block-level delta: fetch the remote
    /// (old) file's chunk signature, plan locally, upload only the unmatched
    /// bytes as a patch temp via ordinary `WriteChunk`s, then ask the daemon to
    /// reassemble + hash-verify + atomically rename over the destination. Any
    /// error leaves the destination untouched; the caller falls back to a
    /// whole-file upload.
    async fn agent_delta_upload_core(
        &self,
        id: &str,
        session: &Arc<crate::session::AgentSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        use base64::Engine as _;
        use faro_agent_proto::delta;
        use faro_agent_proto::msg::{Request, Response};
        let started = Instant::now();

        // 1. The remote (old) file's chunk signature. A pre-delta daemon fails
        // this request, which sends the caller down the whole-file path.
        let remote_sig = match session
            .request(Request::Signature { path: remote_path.to_string() })
            .await?
        {
            Response::Signature { size, min, avg, max, chunks, whole_hash } => {
                delta::FileSignature { size, min, avg, max, chunks, whole_hash }
            }
            Response::Error { message, .. } => {
                anyhow::bail!("signature {remote_path}: {message}")
            }
            other => anyhow::bail!("signature {remote_path}: unexpected {other:?}"),
        };
        anyhow::ensure!(
            delta::params_match(&remote_sig),
            "daemon chunk params differ from ours — no delta"
        );

        // 2. Plan the delta locally (CPU-bound → blocking thread); the patch of
        // literal bytes lands in a temp next to the source file.
        let local_dir = local_path.parent().unwrap_or(Path::new("."));
        let local_patch = local_dir.join(format!(".faro-patch-{}", Uuid::new_v4()));
        let (local_owned, patch_owned) = (local_path.to_path_buf(), local_patch.clone());
        let plan = match tokio::task::spawn_blocking(move || {
            let patch = std::fs::File::create(&patch_owned)
                .with_context(|| format!("create {}", patch_owned.display()))?;
            delta::plan_delta(&remote_sig, &local_owned, patch)
        })
        .await
        {
            Ok(Ok(plan)) => plan,
            Ok(Err(e)) => {
                let _ = tokio::fs::remove_file(&local_patch).await;
                return Err(e.context("plan delta"));
            }
            Err(e) => {
                let _ = tokio::fs::remove_file(&local_patch).await;
                return Err(anyhow::anyhow!("plan delta task: {e}"));
            }
        };
        let size = plan.literal_bytes + plan.reused_bytes;
        if !delta::delta_worthwhile(&plan, size) {
            let _ = tokio::fs::remove_file(&local_patch).await;
            anyhow::bail!(
                "delta barely saves anything ({} of {size} bytes would still cross the wire)",
                plan.literal_bytes
            );
        }

        // 3.+4. Upload the patch (same WriteChunk style as a whole-file upload),
        // then ask the daemon to assemble. Any failure → best-effort remote
        // delete of the patch, local temp cleanup, and the caller falls back.
        let remote_patch = format!("{remote_path}.faro-patch-{}", Uuid::new_v4());
        let result: Result<()> = async {
            let mut patch_file = tokio::fs::File::open(&local_patch)
                .await
                .with_context(|| format!("open {}", local_patch.display()))?;
            let mut buf = vec![0u8; 128 * 1024];
            let mut offset: u64 = 0;
            let mut first = true;
            loop {
                let n = patch_file.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                self.checkpoint(id, n as u64).await?;
                let data = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                let resp = session
                    .request(Request::WriteChunk {
                        path: remote_patch.clone(),
                        offset,
                        data,
                        truncate: first,
                        done: false,
                    })
                    .await?;
                match resp {
                    Response::Written { .. } => {}
                    Response::Error { message, .. } => {
                        anyhow::bail!("upload patch {remote_patch}: {message}")
                    }
                    other => anyhow::bail!("upload patch {remote_patch}: unexpected {other:?}"),
                }
                offset += n as u64;
                first = false;
                self.progress(id, offset);
            }
            // Charge the reused bytes too so pause gates and the throttle
            // bucket see the same totals a whole-file copy would.
            self.checkpoint(id, plan.reused_bytes).await?;

            let resp = session
                .request(Request::DeltaAssemble {
                    basis: Some(remote_path.to_string()),
                    patch: remote_patch.clone(),
                    recipe: plan.recipe.clone(),
                    dest: remote_path.to_string(),
                    expected_hash: plan.whole_hash.clone(),
                })
                .await?;
            match resp {
                Response::DeltaDone { .. } => Ok(()),
                Response::Error { message, .. } => {
                    anyhow::bail!("delta assemble {remote_path}: {message}")
                }
                other => anyhow::bail!("delta assemble {remote_path}: unexpected {other:?}"),
            }
        }
        .await;
        if result.is_err() {
            let _ = session
                .request(Request::Delete { path: remote_patch.clone(), recursive: false })
                .await;
        }
        let _ = tokio::fs::remove_file(&local_patch).await;
        result?;

        tracing::info!(
            "delta upload {remote_path}: {} bytes, sent {} literal, reused {} in {:?}",
            size,
            plan.literal_bytes,
            plan.reused_bytes,
            started.elapsed()
        );
        self.update(id, |t| {
            t.transferred = t.size;
            t.delta = Some(DeltaStats { sent: plan.literal_bytes, reused: plan.reused_bytes });
        })
        .await;
        Ok(size)
    }

    /// Agent delta download (Plan 23), when the switch is on, a local basis
    /// exists and the file is big enough. `None` means "not attempted or
    /// failed": the caller downloads the whole file instead.
    async fn try_agent_delta_download(
        &self,
        id: &str,
        session: &Arc<crate::session::AgentSession>,
        remote_path: &str,
        local_path: &Path,
    ) -> Option<u64> {
        let (size, remote_exists) = agent_stat(session, remote_path).await;
        let basis_exists = tokio::fs::metadata(local_path).await.is_ok();
        if !(remote_exists
            && self.delta_enabled()
            && faro_agent_proto::delta::should_attempt_delta(size, basis_exists, true))
        {
            return None;
        }
        match self
            .agent_delta_download_core(id, session, remote_path, local_path)
            .await
        {
            Ok(n) => Some(n),
            Err(e) => {
                tracing::warn!("delta download fell back to whole-file copy: {e:#}");
                self.progress(id, 0);
                None
            }
        }
    }

    /// The download pipeline (Plan 24): bytes land in a preallocated
    /// `.faro-part` through the ranged engine, which is then synced and
    /// renamed over the target (the overwrite policy applies at that point).
    /// A remote that changed under a resumed or running download restarts
    /// once from byte 0 with a notice on the row.
    async fn run_download(
        self: &Arc<Self>,
        id: &str,
        session: &Arc<Session>,
        remote_path: &str,
        target: &Path,
        policy: OverwritePolicy,
    ) -> Result<u64> {
        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;
        if let Session::Agent(agent) = &**session {
            if policy == OverwritePolicy::Overwrite {
                if let Some(n) = self
                    .try_agent_delta_download(id, agent, remote_path, target)
                    .await
                {
                    return Ok(n);
                }
            }
        }
        let mut restarted = false;
        loop {
            match self
                .download_once(id, session, remote_path, target, policy)
                .await
            {
                Err(e) if !restarted && e.chain().any(|c| c.is::<retry::RemoteChanged>()) => {
                    restarted = true;
                    tracing::info!("{remote_path} changed during download; restarting");
                    self.forget_resume(id, true).await;
                    self.set_notice(id, "remote changed, restarted").await;
                }
                other => return other,
            }
        }
    }

    /// Agent download as the runner does it (tests drive this directly).
    #[cfg(test)]
    async fn agent_download_with_delta_core(
        self: &Arc<Self>,
        id: &str,
        session: &Arc<crate::session::AgentSession>,
        remote_path: &str,
        local_path: &Path,
    ) -> Result<u64> {
        let session = Arc::new(Session::Agent(Arc::clone(session)));
        self.run_download(id, &session, remote_path, local_path, OverwritePolicy::Overwrite)
            .await
    }

    async fn set_notice(&self, id: &str, notice: &str) {
        self.update(id, |t| t.notice = Some(notice.to_string())).await;
        if let Some(t) = self.get(id).await {
            self.emit("transfer://updated", &t);
        }
    }

    /// One pass of [`Self::run_download`].
    async fn download_once(
        self: &Arc<Self>,
        id: &str,
        session: &Arc<Session>,
        remote_path: &str,
        target: &Path,
        policy: OverwritePolicy,
    ) -> Result<u64> {
        use ranged::{DriverConfig, DriverState, Intervals, UNBOUNDED};
        let live = self.live(id);
        let ident = sources::remote_identity(session, remote_path).await?;
        let enqueued_size = self.get(id).await.map(|t| t.size).unwrap_or(0);
        let size = if sources::size_is_advisory(session) {
            None
        } else {
            ident.size.or((enqueued_size > 0).then_some(enqueued_size))
        };
        if let Some(s) = size {
            self.update(id, |t| t.size = s).await;
        }
        let source = sources::source_for(session, remote_path, &ident).await?;

        // Resume only onto the very same remote file, and only through a
        // source that can start mid-file.
        let prev = self.resume_state(id);
        let part_path = match prev.as_ref().and_then(|p| p.part_path.clone()) {
            Some(p) => p,
            None => self.claim_part_path(id, target),
        };
        let mut done = Intervals::default();
        if let Some(prev) = &prev {
            let on_disk = std::fs::metadata(&part_path).is_ok();
            if !prev.identity.matches(&ident) {
                if prev.ranges.total() > 0 {
                    self.set_notice(id, "remote changed, restarted").await;
                }
            } else if on_disk && source.seekable() {
                done = if size.is_some() {
                    prev.ranges.clone()
                } else {
                    let mut p = Intervals::default();
                    p.add(0, prev.ranges.prefix());
                    p
                };
            }
        }
        self.store_resume(
            id,
            ResumeState {
                ranges: done.clone(),
                identity: ident.clone(),
                part_path: Some(part_path.clone()),
                local: None,
            },
        )
        .await;
        let part = partfile::PartFile::open(&part_path, size, done.total() > 0, self.verify_enabled())
            .await?;

        let state = Arc::new(DriverState::default());
        state.seed(&done);
        live.set(done.total());
        let total = size.unwrap_or(UNBOUNDED);
        let todo = if total == UNBOUNDED {
            vec![(done.prefix(), UNBOUNDED)]
        } else {
            done.gaps(total)
        };
        let (cap, auto) = self.segment_cap();
        let driver = ranged::segmented_download(
            source,
            part.writer(),
            self.ctl(id).await,
            Arc::clone(&state),
            todo,
            DriverConfig::new(total, cap, auto),
        );
        tokio::pin!(driver);

        // Mirror the driver's live state onto the row, and checkpoint the
        // resume record every 8 MiB or 2 s: sync the file first, then record
        // only what was handed to the writer before that sync.
        let mut every = tokio::time::interval(Duration::from_millis(250));
        let mut saved = (Instant::now(), done.total());
        let res = loop {
            tokio::select! {
                r = &mut driver => break r,
                _ = every.tick() => {
                    live.segments.store(
                        match state.workers.load(Ordering::Relaxed) { 0 | 1 => 0, n => n },
                        Ordering::Relaxed,
                    );
                    live.stalled.store(state.stalled.load(Ordering::Relaxed), Ordering::Relaxed);
                    let snap = state.snapshot();
                    let moved = snap.total().saturating_sub(saved.1);
                    if moved >= RESUME_SAVE_BYTES || (moved > 0 && saved.0.elapsed() >= RESUME_SAVE_EVERY) {
                        if part.sync().await.is_ok() {
                            self.save_ranges(id, snap.clone()).await;
                        }
                        saved = (Instant::now(), snap.total());
                    }
                }
            }
        };
        live.segments.store(0, Ordering::Relaxed);
        live.stalled.store(false, Ordering::Relaxed);
        if let Err(e) = res {
            let snap = state.snapshot();
            if part.sync().await.is_ok() {
                self.save_ranges(id, snap).await;
            }
            return Err(e);
        }
        let written = state.snapshot().total();
        let finished = part.finish().await?;
        if size.is_none() && finished.len != written {
            anyhow::bail!(
                "download incomplete: wrote {written} bytes but the file holds {}",
                finished.len
            );
        }
        if let Err(e) = self
            .verify_download(session, remote_path, &part_path, &finished)
            .await
        {
            // Keep the temp for inspection, but never move it into place or
            // resume onto it.
            self.forget_resume(id, false).await;
            return Err(e);
        }
        let placed = partfile::place(&part_path, target, policy, ident.mtime_systime()).await?;
        self.forget_resume(id, false).await;
        match placed {
            partfile::Placed::At(dest) => {
                if dest != target {
                    let shown = dest.to_string_lossy().into_owned();
                    self.update(id, |t| t.destination = shown).await;
                }
                Ok(written)
            }
            partfile::Placed::Skipped => Err(SkippedAtPlace.into()),
        }
    }

    /// Download from a Faro Agent daemon as a block-level delta: fetch the
    /// remote (new) file's signature, chunk the local basis locally, download
    /// only the unmatched ranges via ordinary `ReadChunk`s, reassemble into a
    /// same-directory temp, hash-verify, and rename over the destination. Any
    /// error leaves the old local file untouched; the caller falls back to a
    /// whole-file download.
    async fn agent_delta_download_core(
        &self,
        id: &str,
        session: &Arc<crate::session::AgentSession>,
        remote_path: &str,
        local_path: &Path,
    ) -> Result<u64> {
        use base64::Engine as _;
        use faro_agent_proto::delta;
        use faro_agent_proto::msg::{Request, Response};
        let started = Instant::now();

        // 1. The remote (new) file's chunk signature.
        let target_sig = match session
            .request(Request::Signature { path: remote_path.to_string() })
            .await?
        {
            Response::Signature { size, min, avg, max, chunks, whole_hash } => {
                delta::FileSignature { size, min, avg, max, chunks, whole_hash }
            }
            Response::Error { message, .. } => {
                anyhow::bail!("signature {remote_path}: {message}")
            }
            other => anyhow::bail!("signature {remote_path}: unexpected {other:?}"),
        };
        anyhow::ensure!(
            delta::params_match(&target_sig),
            "daemon chunk params differ from ours — no delta"
        );

        // 2. Chunk the local basis (the old file). A missing basis is fine —
        // an empty signature makes every remote chunk a literal.
        let mut has_basis = false;
        let basis_sig = match tokio::fs::metadata(local_path).await {
            Ok(_) => {
                let basis_owned = local_path.to_path_buf();
                match tokio::task::spawn_blocking(move || {
                    delta::signature_of_file(&basis_owned)
                })
                .await
                {
                    Ok(Ok(sig)) => {
                        has_basis = true;
                        sig
                    }
                    Ok(Err(e)) => return Err(e.context("signature of local basis")),
                    Err(e) => return Err(anyhow::anyhow!("basis signature task: {e}")),
                }
            }
            Err(_) => delta::FileSignature {
                size: 0,
                min: delta::CHUNK_MIN,
                avg: delta::CHUNK_AVG,
                max: delta::CHUNK_MAX,
                chunks: Vec::new(),
                whole_hash: String::new(),
            },
        };

        // 3. Match the remote chunks against the local basis.
        let (plan, needed) = delta::plan_download(&basis_sig, &target_sig)?;
        let size = target_sig.size;
        if !delta::delta_worthwhile(&plan, size) {
            anyhow::bail!(
                "delta barely saves anything ({} of {size} bytes would still cross the wire)",
                plan.literal_bytes
            );
        }

        // 4. Fetch only the missing ranges into a local patch temp, then 5.
        // reassemble locally and rename over the destination. Any failure →
        // delete both temps; the old local file is untouched.
        let local_dir = local_path.parent().unwrap_or(Path::new("."));
        let patch_path = local_dir.join(format!(".faro-patch-{}", Uuid::new_v4()));
        let out_path = local_dir.join(format!(".faro-delta-{}.tmp", Uuid::new_v4()));
        let result: Result<()> = async {
            let mut patch_file = tokio::fs::File::create(&patch_path)
                .await
                .with_context(|| format!("create {}", patch_path.display()))?;
            let mut fetched: u64 = 0;
            for &(range_off, range_len) in &needed {
                let mut got: u64 = 0;
                while got < range_len {
                    let resp = session
                        .request(Request::ReadChunk {
                            path: remote_path.to_string(),
                            offset: range_off + got,
                            len: range_len - got,
                        })
                        .await?;
                    let data_b64 = match resp {
                        Response::Chunk { data, .. } => data,
                        Response::Error { message, .. } => {
                            anyhow::bail!("download {remote_path}: {message}")
                        }
                        other => {
                            anyhow::bail!("download {remote_path}: unexpected {other:?}")
                        }
                    };
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(&data_b64)
                        .context("decode chunk")?;
                    if bytes.is_empty() {
                        anyhow::bail!("download {remote_path}: short read (file changed?)");
                    }
                    self.checkpoint(id, bytes.len() as u64).await?;
                    patch_file.write_all(&bytes).await?;
                    got += bytes.len() as u64;
                    fetched += bytes.len() as u64;
                    self.progress(id, fetched);
                }
            }
            patch_file.flush().await?;
            drop(patch_file);
            // Charge the reused bytes too (same accounting as a full copy).
            self.checkpoint(id, plan.reused_bytes).await?;

            // 5. Reassemble + hash-verify into the temp, then atomically
            // rename over the destination.
            let (basis_owned, patch_owned, out_owned, expected) = (
                has_basis.then(|| local_path.to_path_buf()),
                patch_path.clone(),
                out_path.clone(),
                plan.whole_hash.clone(),
            );
            let recipe = plan.recipe.clone();
            tokio::task::spawn_blocking(move || {
                delta::apply_delta(
                    basis_owned.as_deref(),
                    &patch_owned,
                    &recipe,
                    &out_owned,
                    &expected,
                )
            })
            .await
            .map_err(|e| anyhow::anyhow!("apply delta task: {e}"))?
            .context("apply delta")?;
            tokio::fs::rename(&out_path, local_path)
                .await
                .with_context(|| format!("rename delta result over {}", local_path.display()))?;
            Ok(())
        }
        .await;
        let _ = tokio::fs::remove_file(&patch_path).await;
        if result.is_err() {
            let _ = tokio::fs::remove_file(&out_path).await;
        }
        result?;

        tracing::info!(
            "delta download {remote_path}: {} bytes, fetched {} literal, reused {} in {:?}",
            size,
            plan.literal_bytes,
            plan.reused_bytes,
            started.elapsed()
        );
        self.update(id, |t| {
            t.transferred = t.size;
            t.delta = Some(DeltaStats { sent: plan.literal_bytes, reused: plan.reused_bytes });
        })
        .await;
        Ok(size)
    }

    /// SFTP upload (Plan 24) on its own channel with up to 32 writes in
    /// flight, written in 256 KiB blocks. Resumes at the acknowledged offset
    /// when this transfer already wrote part of the remote file and the
    /// local source hasn't changed since.
    async fn run_ssh_upload(
        &self,
        id: &str,
        session: Arc<SshSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        use russh_sftp::protocol::OpenFlags;
        use tokio::io::AsyncSeekExt;
        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;
        let local = local_identity(local_path).await?;

        // A dedicated channel, or the shared browsing one if the server
        // won't open another (MaxSessions).
        let dedicated = match session.open_upload_sftp().await {
            Ok(s) => Some(s),
            Err(e) => {
                tracing::warn!("SFTP: no dedicated upload channel ({e:#}); using the shared one");
                None
            }
        };
        let shared = match dedicated {
            Some(_) => None,
            None => Some(session.ensure_sftp().await?),
        };
        let shared_guard = match &shared {
            Some(cell) => Some(cell.lock().await),
            None => None,
        };
        let sftp: &russh_sftp::client::SftpSession = match (&dedicated, &shared_guard) {
            (Some(s), _) => s,
            (None, Some(g)) => g,
            (None, None) => unreachable!("one SFTP session is always set"),
        };

        let prev = self.resume_state(id);
        if prev
            .as_ref()
            .is_some_and(|p| p.local != Some(local) && p.ranges.total() > 0)
        {
            self.set_notice(id, "local file changed, restarted").await;
        }
        let prev = prev.filter(|p| p.local == Some(local));
        let mut start = 0;
        if let Some(prev) = &prev {
            let acked = prev.ranges.prefix();
            if acked > 0 {
                if let Ok(meta) = sftp.metadata(remote_path).await {
                    if meta.size.unwrap_or(0) >= acked {
                        start = acked;
                    }
                }
            }
        }
        let mut remote_file = if start > 0 {
            let mut f = sftp
                .open_with_flags(remote_path, OpenFlags::WRITE)
                .await
                .with_context(|| format!("open remote {remote_path}"))?;
            f.seek(std::io::SeekFrom::Start(start)).await?;
            f
        } else {
            sftp.create(remote_path)
                .await
                .with_context(|| format!("create remote {remote_path}"))?
        };
        let mut done = ranged::Intervals::default();
        done.add(0, start);
        self.store_resume(
            id,
            ResumeState {
                ranges: done,
                local: Some(local),
                ..Default::default()
            },
        )
        .await;

        let mut local_file = tokio::fs::File::open(local_path)
            .await
            .with_context(|| format!("open {}", local_path.display()))?;
        if start > 0 {
            local_file.seek(std::io::SeekFrom::Start(start)).await?;
        }
        let mut buf = vec![0u8; 256 * 1024];
        let mut transferred = start;
        let mut saved = (Instant::now(), start);
        self.progress(id, transferred);
        let res: Result<()> = async {
            loop {
                let n = local_file.read(&mut buf).await?;
                if n == 0 {
                    return Ok(());
                }
                self.checkpoint(id, n as u64).await?;
                remote_file.write_all(&buf[..n]).await?;
                transferred += n as u64;
                self.progress(id, transferred);
                if transferred - saved.1 >= RESUME_SAVE_BYTES || saved.0.elapsed() >= RESUME_SAVE_EVERY {
                    // Wait for the server's acks before recording progress.
                    remote_file.flush().await?;
                    let mut iv = ranged::Intervals::default();
                    iv.add(0, transferred);
                    self.save_ranges(id, iv).await;
                    saved = (Instant::now(), transferred);
                }
            }
        }
        .await;
        if let Err(e) = res {
            if is_paused(&e) && remote_file.flush().await.is_ok() {
                let mut iv = ranged::Intervals::default();
                iv.add(0, transferred);
                self.save_ranges(id, iv).await;
            }
            return Err(e);
        }
        remote_file.shutdown().await?;
        self.forget_resume(id, false).await;
        Ok(transferred)
    }

    /// Object-store upload. Small files go up in one PUT; larger ones as a
    /// multipart upload with up to `transferSegments` parts in flight (the
    /// old loop sent one part at a time). Parts are at least 8 MiB and big
    /// enough to stay under S3's 10,000-part limit. A pause keeps the
    /// multipart upload open so resuming sends only the remaining parts; an
    /// error or cancel aborts it so no orphaned parts are left behind.
    async fn run_object_upload(
        &self,
        id: &str,
        session: Arc<ObjectSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        use futures::stream::{FuturesUnordered, StreamExt};
        use tokio::io::AsyncSeekExt;

        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;
        let key = remote_path.trim_start_matches('/').to_string();
        let p = object_store::path::Path::parse(key.as_str())?;
        let local = local_identity(local_path).await?;
        let size = local.size;
        let mut file = tokio::fs::File::open(local_path)
            .await
            .with_context(|| format!("open {}", local_path.display()))?;

        // S3-style ETags are MD5s of what was sent (Phase 6).
        let check_etag = self.verify_enabled() && session.profile.protocol == "s3";
        if size <= OBJECT_SINGLE_PUT_MAX {
            // object_store needs the body in memory; 16 MiB at most.
            self.checkpoint(id, size).await?;
            let mut buf = Vec::with_capacity(size as usize);
            file.read_to_end(&mut buf).await?;
            let want = check_etag.then(|| verify::hex(&verify::md5(&buf)));
            let put = session
                .store
                .put(&p, bytes::Bytes::from(buf).into())
                .await
                .with_context(|| format!("s3 put {key}"))?;
            if let (Some(want), Some(etag)) = (want, put.e_tag.as_deref()) {
                if verify::etag_matches(etag, &want) == Some(false) {
                    return Err(verify::mismatch("ETag", &want, etag));
                }
            }
            self.progress(id, size);
            return Ok(size);
        }

        let part_size = object_part_size(size);
        let (cap, _) = self.segment_cap();
        // Continue a paused multipart upload of the same, unchanged file.
        let stash = self
            .object_uploads
            .lock()
            .await
            .remove(id)
            .filter(|s| s.local == local && s.key == key);
        let (mut upload, mut offset, mut part_md5s) = match stash {
            Some(s) => (s.guard, s.offset, s.part_md5s),
            None => {
                let up = session
                    .store
                    .put_multipart(&p)
                    .await
                    .with_context(|| format!("s3 begin multipart {key}"))?;
                (MultipartGuard::new(up, key.clone()), 0, Vec::new())
            }
        };
        file.seek(std::io::SeekFrom::Start(offset)).await?;
        self.progress(id, offset);

        let mut inflight = FuturesUnordered::new();
        // Bytes read and handed to put_part, and bytes confirmed uploaded.
        let mut sent = offset;
        let res: Result<()> = async {
            loop {
                while inflight.len() < cap && sent < size {
                    let want = part_size.min(size - sent) as usize;
                    let mut buf = vec![0u8; want];
                    file.read_exact(&mut buf).await?;
                    self.checkpoint(id, want as u64).await?;
                    if check_etag {
                        part_md5s.push(verify::md5(&buf));
                    }
                    let part = upload.get().put_part(bytes::Bytes::from(buf).into());
                    sent += want as u64;
                    inflight.push(async move { part.await.map(|()| want as u64) });
                }
                self.live(id).segments.store(
                    if inflight.len() > 1 { inflight.len() } else { 0 },
                    Ordering::Relaxed,
                );
                match inflight.next().await {
                    None => return Ok(()),
                    Some(r) => {
                        offset += r.with_context(|| format!("s3 put_part {key}"))?;
                        self.progress(id, offset);
                    }
                }
            }
        }
        .await;
        self.live(id).segments.store(0, Ordering::Relaxed);
        if let Err(e) = res {
            if is_paused(&e) {
                // Let the parts already sent finish, then keep the upload.
                let mut drained = Ok(());
                while let Some(r) = inflight.next().await {
                    match r {
                        Ok(n) => offset += n,
                        Err(e) => drained = Err(e),
                    }
                }
                if drained.is_ok() && offset == sent {
                    self.progress(id, offset);
                    self.object_uploads.lock().await.insert(
                        id.to_string(),
                        ObjectStash {
                            guard: upload,
                            offset,
                            local,
                            key,
                            part_md5s,
                        },
                    );
                }
            }
            return Err(e);
        }
        let done = upload
            .complete()
            .await
            .with_context(|| format!("s3 complete multipart {key}"))?;
        if check_etag {
            if let Some(etag) = done.e_tag.as_deref() {
                let want = verify::multipart_etag(&part_md5s);
                if verify::etag_matches(etag, &want) == Some(false) {
                    return Err(verify::mismatch("multipart ETag", &want, etag));
                }
            }
        }
        Ok(offset)
    }
}

/// Largest object uploaded with a single PUT.
const OBJECT_SINGLE_PUT_MAX: u64 = 16 * 1024 * 1024;

/// Multipart part size: at least 8 MiB, and large enough that the file fits
/// in 9,000 parts (S3 allows 10,000).
fn object_part_size(size: u64) -> u64 {
    (8 * 1024 * 1024).max(size.div_ceil(9_000))
}

impl TransferManager {
    /// Walk a remote directory tree and queue a transfer per file. Uses the
    /// RemoteFs trait so it works for both SFTP and FTP.
    pub async fn start_directory_download(
        self: &Arc<Self>,
        session: Arc<Session>,
        remote_root: String,
        local_dir: String,
        policy: OverwritePolicy,
        app: AppHandle,
    ) -> Result<Vec<String>> {
        let root_name = basename(&remote_root);
        let local_root = PathBuf::from(&local_dir).join(&root_name);
        tokio::fs::create_dir_all(&local_root)
            .await
            .with_context(|| format!("mkdir -p {}", local_root.display()))?;

        let fs = fs_for_session(&session);

        let mut dirs_to_visit: Vec<String> = vec![remote_root.clone()];
        let mut files: Vec<(String, PathBuf)> = Vec::new();

        let mut ids = Vec::new();
        while let Some(d) = dirs_to_visit.pop() {
            // The root must list; an unreadable subfolder becomes an Error row
            // and the rest of the batch still runs (Plan 24 Phase 5).
            let entries = match fs.list_dir(&d).await {
                Ok(e) => e,
                Err(e) if d != remote_root => {
                    let local = local_root.join(
                        d.strip_prefix(&remote_root).unwrap_or(&d).trim_start_matches('/'),
                    );
                    let err = e.context(format!("read_dir {d}"));
                    ids.push(
                        self.failed_row(TransferKind::Download, &d, &local.to_string_lossy(), &err, &app)
                            .await,
                    );
                    continue;
                }
                Err(e) => return Err(e.context(format!("read_dir {d}"))),
            };
            for entry in entries {
                let remote_child = entry.path.clone();
                let rel = remote_child
                    .strip_prefix(&remote_root)
                    .unwrap_or(&remote_child)
                    .trim_start_matches('/');
                let local_child = local_root.join(rel);
                match entry.kind {
                    crate::remotefs::FileKind::Directory => {
                        tokio::fs::create_dir_all(&local_child).await.ok();
                        dirs_to_visit.push(remote_child);
                    }
                    crate::remotefs::FileKind::File => {
                        files.push((remote_child, local_child));
                    }
                    _ => {}
                }
            }
        }

        for (remote_path, local_path) in files {
            let parent_dir = local_path
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| ".".into());
            match self
                .start_download(
                    Arc::clone(&session),
                    remote_path.clone(),
                    parent_dir,
                    policy,
                    app.clone(),
                )
                .await
            {
                Ok(id) => ids.push(id),
                Err(e) => ids.push(
                    self.failed_row(
                        TransferKind::Download,
                        &remote_path,
                        &local_path.to_string_lossy(),
                        &e,
                        &app,
                    )
                    .await,
                ),
            }
        }
        Ok(ids)
    }

    /// A row for an item of a folder transfer that couldn't even be queued
    /// (unreadable folder, failed stat): it shows as an Error row while the
    /// rest of the batch runs.
    async fn failed_row(
        &self,
        kind: TransferKind,
        source: &str,
        destination: &str,
        err: &anyhow::Error,
        app: &AppHandle,
    ) -> String {
        self.set_app(app);
        let id = Uuid::new_v4().to_string();
        let t = Transfer {
            id: id.clone(),
            kind,
            source: source.to_string(),
            destination: destination.to_string(),
            size: 0,
            transferred: 0,
            status: TransferStatus::Error,
            error: Some(format!("{err:#}")),
            retry_attempt: None,
            delta: None,
            started_at: now_ts(),
            bytes_per_sec: None,
            eta_secs: None,
            segments: None,
            stalled: false,
            notice: None,
            restored: false,
        };
        self.insert(t.clone()).await;
        self.emit("transfer://added", &t);
        id
    }

    pub async fn start_directory_upload(
        self: &Arc<Self>,
        session: Arc<Session>,
        local_root: String,
        remote_dir: String,
        policy: OverwritePolicy,
        app: AppHandle,
    ) -> Result<Vec<String>> {
        let local_root_path = PathBuf::from(&local_root);
        let root_name = local_root_path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "upload".into());
        let remote_root = join_remote(&remote_dir, &root_name);

        let fs = fs_for_session(&session);

        // Best-effort: create the remote root.
        let _ = fs.create_dir(&remote_root).await;

        let mut dirs_to_visit: Vec<PathBuf> = vec![local_root_path.clone()];
        let mut files: Vec<(PathBuf, String)> = Vec::new();
        let mut subdirs: Vec<String> = Vec::new();
        let mut unreadable: Vec<(PathBuf, anyhow::Error)> = Vec::new();
        while let Some(d) = dirs_to_visit.pop() {
            let mut rd = match tokio::fs::read_dir(&d).await {
                Ok(rd) => rd,
                Err(e) if d != local_root_path => {
                    let err = anyhow::Error::new(e).context(format!("read_dir {}", d.display()));
                    unreadable.push((d, err));
                    continue;
                }
                Err(e) => {
                    return Err(anyhow::Error::new(e).context(format!("read_dir {}", d.display())))
                }
            };
            while let Some(entry) = rd.next_entry().await? {
                let p = entry.path();
                let meta = match entry.metadata().await {
                    Ok(m) => m,
                    Err(_) => continue,
                };
                let rel = p
                    .strip_prefix(&local_root_path)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/");
                let remote_child = format!("{remote_root}/{rel}");
                if meta.is_dir() {
                    subdirs.push(remote_child);
                    dirs_to_visit.push(p);
                } else if meta.is_file() {
                    files.push((p, remote_child));
                }
            }
        }

        let mut failed = Vec::new();
        for (d, err) in unreadable {
            let rel = d
                .strip_prefix(&local_root_path)
                .unwrap_or(&d)
                .to_string_lossy()
                .replace('\\', "/");
            let remote = format!("{remote_root}/{rel}");
            failed.push(
                self.failed_row(TransferKind::Upload, &d.to_string_lossy(), &remote, &err, &app)
                    .await,
            );
        }

        subdirs.sort_by_key(|s| s.matches('/').count());
        for sd in subdirs {
            let _ = fs.create_dir(&sd).await;
        }

        let mut ids = failed;
        for (local_path, remote_path) in files {
            let parent = remote_path
                .rsplit_once('/')
                .map(|(p, _)| p.to_string())
                .unwrap_or_else(|| remote_root.clone());
            match self
                .start_upload(
                    Arc::clone(&session),
                    local_path.to_string_lossy().into_owned(),
                    parent,
                    policy,
                    app.clone(),
                )
                .await
            {
                Ok(id) => ids.push(id),
                Err(e) => ids.push(
                    self.failed_row(
                        TransferKind::Upload,
                        &local_path.to_string_lossy(),
                        &remote_path,
                        &e,
                        &app,
                    )
                    .await,
                ),
            }
        }
        Ok(ids)
    }

    /// FTP upload: like the download, with `APPE` from the remote file's
    /// current size when resuming an upload that already started.
    async fn run_ftp_upload(
        &self,
        id: &str,
        session: Arc<FtpSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        use std::io::{Seek, SeekFrom};
        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;
        self.checkpoint(id, 0).await?;

        // Resume only an upload this transfer already started (it has a
        // resume record) of the same, unchanged local file.
        let local_id = local_identity(local_path).await?;
        let prev = self.resume_state(id);
        if prev
            .as_ref()
            .is_some_and(|p| p.local != Some(local_id) && p.ranges.total() > 0)
        {
            self.set_notice(id, "local file changed, restarted").await;
        }
        let resumable = prev.is_some_and(|p| p.local == Some(local_id));
        let (gate, rx, ack) = FtpGate::new();
        let local = local_path.to_path_buf();
        let remote = remote_path.to_string();
        let copy = session.with_transfer_stream(move |stream| {
            let mut file = std::fs::File::open(&local)
                .with_context(|| format!("open {}", local.display()))?;
            let local_len = file.metadata()?.len();
            // Resume only when the remote partial is a plausible prefix.
            let start = if resumable {
                match stream.size(&remote) {
                    Ok(n) if n > 0 && (n as u64) <= local_len => n as u64,
                    _ => 0,
                }
            } else {
                0
            };
            file.seek(SeekFrom::Start(start))?;
            let mut reader = GatedReader {
                inner: std::io::BufReader::new(file),
                gate,
                pending: 0,
            };
            // Record the upload as resumable only once STOR/APPE is accepted:
            // if the server refuses it, whatever already sits at `remote` is
            // not ours and a retry must not append to it.
            stream.upload(&remote, start > 0, &mut reader, |r| r.gate.start(start))?;
            reader.finish()?;
            Ok(())
        });
        let (res, (stop, done)) = tokio::join!(copy, self.ftp_pump(id, rx, ack, local_id));
        if let Some(e) = stop {
            return Err(e);
        }
        res?;
        self.forget_resume(id, false).await;
        Ok(done)
    }

    /// Async half of an FTP copy: for each chunk the blocking side reports,
    /// run the throttle/pause checkpoint, publish progress, then let the copy
    /// continue (or tell it to stop). Returns the checkpoint error that
    /// stopped the copy, if any ([`Paused`]), and the byte count reached.
    async fn ftp_pump(
        &self,
        id: &str,
        mut rx: tokio::sync::mpsc::Receiver<FtpProgress>,
        ack: std::sync::mpsc::SyncSender<bool>,
        local: LocalIdentity,
    ) -> (Option<anyhow::Error>, u64) {
        let mut done = 0u64;
        while let Some(msg) = rx.recv().await {
            match msg {
                FtpProgress::Start(offset) => {
                    // From here on the destination is this transfer's partial.
                    done = offset;
                    self.progress(id, offset);
                    let mut iv = ranged::Intervals::default();
                    iv.add(0, offset);
                    self.store_resume(
                        id,
                        ResumeState {
                            ranges: iv,
                            local: Some(local),
                            ..Default::default()
                        },
                    )
                    .await;
                    let _ = ack.send(true);
                }
                FtpProgress::Chunk(n) => {
                    if let Err(e) = self.checkpoint(id, n).await {
                        let _ = ack.send(false);
                        return (Some(e), done);
                    }
                    done += n;
                    self.progress(id, done);
                    let _ = ack.send(true);
                }
            }
        }
        self.update(id, |t| t.transferred = done).await;
        (None, done)
    }

    /// Upload via WebDAV `PUT`, streaming the file body straight off disk (no
    /// full-file buffering) with an explicit Content-Length so servers accept it.
    async fn run_webdav_upload(
        &self,
        id: &str,
        session: Arc<WebdavSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        use tokio_util::io::ReaderStream;

        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;

        let size = tokio::fs::metadata(local_path)
            .await
            .with_context(|| format!("stat {}", local_path.display()))?
            .len();
        let file = tokio::fs::File::open(local_path)
            .await
            .with_context(|| format!("open {}", local_path.display()))?;
        let body = reqwest::Body::wrap_stream(ReaderStream::new(file));
        self.checkpoint(id, size).await?;

        let url = session.url_for(remote_path, false);
        let resp = session
            .request(reqwest::Method::PUT, url)
            .header(reqwest::header::CONTENT_LENGTH, size)
            .body(body)
            .send()
            .await
            .with_context(|| format!("PUT {remote_path}"))?;
        if !resp.status().is_success() {
            return Err(anyhow::anyhow!(
                "upload {remote_path} failed: HTTP {}",
                resp.status().as_u16()
            ));
        }
        self.update(id, |t| t.transferred = size).await;
        Ok(size)
    }

    /// Upload a file to Dropbox via `/2/files/upload` (overwrite mode). Simple
    /// single-shot upload; Dropbox caps that at 150 MB, so larger files are
    /// refused with a clear message (chunked upload_session is a follow-up).
    async fn run_dropbox_upload(
        &self,
        id: &str,
        session: Arc<DropboxSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        use tokio_util::io::ReaderStream;

        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;

        let size = tokio::fs::metadata(local_path)
            .await
            .with_context(|| format!("stat {}", local_path.display()))?
            .len();
        const SIMPLE_UPLOAD_MAX: u64 = 150 * 1024 * 1024;
        if size > SIMPLE_UPLOAD_MAX {
            return Err(anyhow::anyhow!(
                "{} exceeds Dropbox's 150 MB single-request upload limit \
                 (chunked upload not yet implemented)",
                local_path.display()
            ));
        }

        let dbx = crate::remotefs::dropbox::dropbox_api_path(remote_path);
        let arg = serde_json::json!({
            "path": dbx, "mode": "overwrite", "autorename": false, "mute": true
        })
        .to_string();
        let url = format!("{}/2/files/upload", session.content_base);

        // Proactive refresh covers the common case; on a hard 401 we refresh and
        // retry once, re-opening the file for a fresh streamed body.
        self.checkpoint(id, size).await?;
        let mut attempt = 0;
        loop {
            let token = session.access_token().await?;
            let file = tokio::fs::File::open(local_path)
                .await
                .with_context(|| format!("open {}", local_path.display()))?;
            let body = reqwest::Body::wrap_stream(ReaderStream::new(file));
            let resp = session
                .client
                .post(&url)
                .bearer_auth(&token)
                .header("Dropbox-API-Arg", &arg)
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(body)
                .send()
                .await
                .with_context(|| format!("PUT {remote_path}"))?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                attempt += 1;
                session.force_refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                let code = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                return Err(anyhow::anyhow!("upload {remote_path} failed ({code}): {text}"));
            }
            break;
        }
        self.update(id, |t| t.transferred = size).await;
        Ok(size)
    }

    /// Upload a file as a Shopify theme asset (create and update are the same
    /// PUT; theme files are small, so a single-shot write is the whole story).
    async fn run_shopify_upload(
        &self,
        id: &str,
        session: Arc<ShopifySession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;

        let data = tokio::fs::read(local_path)
            .await
            .with_context(|| format!("read {}", local_path.display()))?;
        let size = data.len() as u64;
        self.checkpoint(id, size).await?;
        crate::remotefs::shopify::write_asset(&session, remote_path, &data).await?;
        self.update(id, |t| t.transferred = size).await;
        Ok(size)
    }

    /// Upload a file to the HubSpot Design Manager (create and update are the
    /// same multipart PUT; theme files are small, so a single-shot write is
    /// the whole story).
    async fn run_hubspot_upload(
        &self,
        id: &str,
        session: Arc<HubSpotSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;

        let data = tokio::fs::read(local_path)
            .await
            .with_context(|| format!("read {}", local_path.display()))?;
        let size = data.len() as u64;
        self.checkpoint(id, size).await?;
        crate::remotefs::hubspot::write_file(&session, remote_path, &data).await?;
        self.update(id, |t| t.transferred = size).await;
        Ok(size)
    }

    /// Upload a file as a Dataverse web resource (create or update by name
    /// lookup, then publish — save = deployed).
    async fn run_dynamics_upload(
        &self,
        id: &str,
        session: Arc<DynamicsSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;

        let data = tokio::fs::read(local_path)
            .await
            .with_context(|| format!("read {}", local_path.display()))?;
        let size = data.len() as u64;
        self.checkpoint(id, size).await?;
        crate::remotefs::dynamics::write_file(&session, remote_path, &data).await?;
        self.update(id, |t| t.transferred = size).await;
        Ok(size)
    }

    /// Upload to WordPress: a media library file (WordPress picks the
    /// year/month folder) or a REST resource saved back as JSON.
    async fn run_wordpress_upload(
        &self,
        id: &str,
        session: Arc<WordPressSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;

        let data = tokio::fs::read(local_path)
            .await
            .with_context(|| format!("read {}", local_path.display()))?;
        let size = data.len() as u64;
        self.checkpoint(id, size).await?;
        crate::remotefs::wordpress::write_file(&session, remote_path, &data).await?;
        self.update(id, |t| t.transferred = size).await;
        Ok(size)
    }

    /// Upload to OneDrive: a single `PUT …/content` for small files, or a
    /// chunked upload session for larger ones (Graph caps simple PUT at 4 MB).
    async fn run_onedrive_upload(
        &self,
        id: &str,
        session: Arc<OneDriveSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;

        let size = tokio::fs::metadata(local_path)
            .await
            .with_context(|| format!("stat {}", local_path.display()))?
            .len();
        // Graph's simple-upload ceiling is 4 MB; overridable for tests.
        let simple_max: u64 = std::env::var("FARO_ONEDRIVE_SIMPLE_MAX")
            .ok()
            .and_then(|s| s.parse().ok())
            .unwrap_or(4 * 1024 * 1024);

        if size <= simple_max {
            self.checkpoint(id, size).await?;
            self.onedrive_simple_upload(id, &session, local_path, remote_path)
                .await?;
        } else {
            self.onedrive_session_upload(id, &session, local_path, remote_path, size)
                .await?;
        }
        self.update(id, |t| t.transferred = size).await;
        Ok(size)
    }

    async fn onedrive_simple_upload(
        &self,
        _id: &str,
        session: &Arc<OneDriveSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<()> {
        use tokio_util::io::ReaderStream;
        let content = crate::remotefs::onedrive::content_ref(remote_path);
        let url = format!("{}{content}", session.graph_base);
        let mut attempt = 0;
        loop {
            let token = session.access_token().await?;
            let file = tokio::fs::File::open(local_path)
                .await
                .with_context(|| format!("open {}", local_path.display()))?;
            let body = reqwest::Body::wrap_stream(ReaderStream::new(file));
            let resp = session
                .client
                .put(&url)
                .bearer_auth(&token)
                .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
                .body(body)
                .send()
                .await
                .with_context(|| format!("PUT {remote_path}"))?;
            if resp.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
                attempt += 1;
                session.force_refresh().await?;
                continue;
            }
            if !resp.status().is_success() {
                let code = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                return Err(anyhow::anyhow!("upload {remote_path} failed ({code}): {text}"));
            }
            return Ok(());
        }
    }

    async fn onedrive_session_upload(
        &self,
        id: &str,
        session: &Arc<OneDriveSession>,
        local_path: &Path,
        remote_path: &str,
        size: u64,
    ) -> Result<()> {
        // Create the upload session.
        let item = crate::remotefs::onedrive::item_ref(remote_path);
        let create = format!("{item}/createUploadSession");
        let body = serde_json::json!({
            "item": { "@microsoft.graph.conflictBehavior": "replace" }
        });
        let sess = session
            .rpc(reqwest::Method::POST, &create, Some(&body))
            .await?;
        let upload_url = sess
            .get("uploadUrl")
            .and_then(|u| u.as_str())
            .ok_or_else(|| anyhow::anyhow!("createUploadSession returned no uploadUrl"))?
            .to_string();

        // Chunks must be a multiple of 320 KiB (except the last). ~6 MiB.
        const CHUNK: usize = 320 * 1024 * 20;
        let mut file = tokio::fs::File::open(local_path)
            .await
            .with_context(|| format!("open {}", local_path.display()))?;
        let mut buf = vec![0u8; CHUNK];
        let mut offset: u64 = 0;
        while offset < size {
            let mut filled = 0;
            while filled < buf.len() {
                let n = file.read(&mut buf[filled..]).await?;
                if n == 0 {
                    break;
                }
                filled += n;
            }
            if filled == 0 {
                break;
            }
            self.checkpoint(id, filled as u64).await?;
            let start = offset;
            let end = offset + filled as u64 - 1;
            let range = format!("bytes {start}-{end}/{size}");
            let resp = session
                .client
                .put(&upload_url)
                .header(reqwest::header::CONTENT_LENGTH, filled as u64)
                .header("Content-Range", range)
                .body(bytes::Bytes::copy_from_slice(&buf[..filled]))
                .send()
                .await
                .with_context(|| format!("upload chunk for {remote_path}"))?;
            if !resp.status().is_success() {
                let code = resp.status().as_u16();
                let text = resp.text().await.unwrap_or_default();
                return Err(anyhow::anyhow!("upload {remote_path} chunk failed ({code}): {text}"));
            }
            offset += filled as u64;
            self.progress(id, offset);
        }
        Ok(())
    }

    /// Upload to Google Drive: update the existing file's media if a same-named
    /// child exists, else create a new file via a multipart/related request.
    async fn run_gdrive_upload(
        &self,
        id: &str,
        session: Arc<GDriveSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        self.update(id, |t| t.status = TransferStatus::Transferring).await;
        let mut acknowledged = 0;
        let size = session.upload_file(local_path, remote_path, |offset| {
            let bytes = offset.saturating_sub(acknowledged);
            acknowledged = offset;
            async move {
                self.checkpoint(id, bytes).await?;
                self.progress(id, offset);
                Ok(())
            }
        }).await?;
        self.progress(id, size);
        Ok(size)
    }

    /// Upload to Box via multipart/form-data: a new file (`/files/content` with
    /// attributes) or a new version of an existing one (`/files/{id}/content`).
    async fn run_box_upload(
        &self,
        id: &str,
        session: Arc<BoxSession>,
        local_path: &Path,
        remote_path: &str,
    ) -> Result<u64> {
        use crate::session::boxdrive::{basename, normalize, parent_of};

        self.update(id, |t| t.status = TransferStatus::Transferring)
            .await;

        let size = tokio::fs::metadata(local_path)
            .await
            .with_context(|| format!("stat {}", local_path.display()))?
            .len();
        let norm = normalize(remote_path);
        let name = basename(&norm).to_string();
        let parent_id = session.folder_id(&parent_of(&norm)).await?;
        let existing = session.find_child(&parent_id, &name).await?;
        let bytes = tokio::fs::read(local_path)
            .await
            .with_context(|| format!("read {}", local_path.display()))?;
        let token = session.access_token().await?;
        self.checkpoint(id, size).await?;

        let file_part = reqwest::multipart::Part::bytes(bytes).file_name(name.clone());
        let (url, form) = match existing {
            Some((file_id, false)) => (
                format!("{}/files/{file_id}/content", session.upload_base),
                reqwest::multipart::Form::new().part("file", file_part),
            ),
            _ => {
                let attrs = serde_json::json!({ "name": name, "parent": { "id": parent_id } });
                (
                    format!("{}/files/content", session.upload_base),
                    reqwest::multipart::Form::new()
                        .text("attributes", attrs.to_string())
                        .part("file", file_part),
                )
            }
        };
        let resp = session
            .client
            .post(&url)
            .bearer_auth(&token)
            .multipart(form)
            .send()
            .await
            .with_context(|| format!("upload {remote_path}"))?;
        if !resp.status().is_success() {
            let code = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            return Err(anyhow::anyhow!("upload {remote_path} failed ({code}): {text}"));
        }
        session.clear_cache();
        self.update(id, |t| t.transferred = size).await;
        Ok(size)
    }
}

/// Owns an in-progress object-store multipart upload and aborts it unless
/// it completes. Dropping the guard (error, cancel, task abort) spawns a
/// best-effort `abort()` so the store discards the uploaded parts; S3 and GCS
/// would otherwise keep billing for them until a lifecycle rule runs.
struct MultipartGuard {
    upload: Option<Box<dyn object_store::MultipartUpload>>,
    key: String,
}

impl MultipartGuard {
    fn new(upload: Box<dyn object_store::MultipartUpload>, key: String) -> Self {
        Self {
            upload: Some(upload),
            key,
        }
    }

    fn get(&mut self) -> &mut Box<dyn object_store::MultipartUpload> {
        self.upload.as_mut().expect("multipart upload already finished")
    }

    /// Complete the upload; on failure the guard's drop aborts it.
    async fn complete(&mut self) -> object_store::Result<object_store::PutResult> {
        let res = self.get().complete().await;
        if res.is_ok() {
            self.upload = None;
        }
        res
    }
}

impl Drop for MultipartGuard {
    fn drop(&mut self) {
        let Some(mut upload) = self.upload.take() else {
            return;
        };
        let key = std::mem::take(&mut self.key);
        if let Ok(rt) = tokio::runtime::Handle::try_current() {
            rt.spawn(async move {
                match upload.abort().await {
                    Ok(()) => tracing::info!("aborted unfinished multipart upload {key}"),
                    Err(e) => tracing::warn!("abort multipart upload {key}: {e}"),
                }
            });
        }
    }
}

/// Build a RemoteFs handle for the right backend.
fn fs_for_session(session: &Arc<Session>) -> Box<dyn crate::remotefs::RemoteFs> {
    match &**session {
        Session::Ssh(ssh) => Box::new(crate::remotefs::sftp::SftpFs::new(ssh.clone())),
        Session::Ftp(ftp) => Box::new(crate::remotefs::ftp::FtpFs::new(ftp.clone())),
        Session::Object(obj) => {
            Box::new(crate::remotefs::object::ObjectFs::new(obj.clone()))
        }
        Session::Webdav(dav) => Box::new(crate::remotefs::webdav::WebdavFs::new(dav.clone())),
        Session::Http(http) => Box::new(crate::remotefs::http::HttpFs::new(http.clone())),
        Session::Dropbox(dbx) => Box::new(crate::remotefs::dropbox::DropboxFs::new(dbx.clone())),
        Session::OneDrive(od) => Box::new(crate::remotefs::onedrive::OneDriveFs::new(od.clone())),
        Session::GDrive(gd) => Box::new(crate::remotefs::gdrive::GDriveFs::new(gd.clone())),
        Session::Box(bx) => Box::new(crate::remotefs::boxdrive::BoxFs::new(bx.clone())),
        Session::Shopify(sh) => Box::new(crate::remotefs::shopify::ShopifyFs::new(sh.clone())),
        Session::HubSpot(hs) => Box::new(crate::remotefs::hubspot::HubSpotFs::new(hs.clone())),
        Session::Dynamics(dynm) => Box::new(crate::remotefs::dynamics::DynamicsFs::new(dynm.clone())),
        Session::WordPress(wp) => Box::new(crate::remotefs::wordpress::WordPressFs::new(wp.clone())),
        Session::Agent(agent) => Box::new(crate::remotefs::agent::AgentFs::new(agent.clone())),
    }
}

/// HEAD a WebDAV resource, returning its size (from Content-Length) and whether
/// it exists. Best-effort: a server that rejects HEAD reports (0, false).
async fn webdav_head(session: &Arc<WebdavSession>, path: &str) -> (u64, bool) {
    let url = session.url_for(path, false);
    match session.request(reqwest::Method::HEAD, url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let size = resp
                .headers()
                .get(reqwest::header::CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse::<u64>().ok())
                .unwrap_or(0);
            (size, true)
        }
        _ => (0, false),
    }
}

/// HEAD an HTTP-source file for its size. Best-effort (0 on any failure).
async fn http_size(session: &Arc<HttpSession>, path: &str) -> u64 {
    let url = session.url_for(path, false);
    match session.request(reqwest::Method::HEAD, url).send().await {
        Ok(resp) if resp.status().is_success() => resp
            .headers()
            .get(reqwest::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0),
        _ => 0,
    }
}

/// Delta sync exists only for the Faro Agent backend (Plan 23): it's the one
/// remote where we run code, so a chunk signature + server-side reassemble is
/// possible. Every other backend arm dispatches to a plain whole-file copy.
/// The dispatch matches below already route only `Session::Agent` to the
/// `*_with_delta` entry points — this helper pins that contract (and the test
/// at the bottom of the file exercises it).
fn supports_delta(session: &Session) -> bool {
    matches!(session, Session::Agent(_))
}

/// Stat a path on a Faro Agent daemon, returning its size and whether it exists.
async fn agent_stat(
    session: &Arc<crate::session::AgentSession>,
    path: &str,
) -> (u64, bool) {
    use faro_agent_proto::msg::{Request, Response};
    match session.request(Request::Stat { path: path.to_string() }).await {
        Ok(Response::Stat { entry }) => (entry.size, true),
        _ => (0, false),
    }
}

/// Lookup the size of a remote file using each backend's native API.
pub(crate) async fn remote_size(session: &Arc<Session>, path: &str) -> Result<u64> {
    match &**session {
        Session::Ssh(ssh) => {
            let cell = ssh.ensure_sftp().await?;
            let sftp = cell.lock().await;
            Ok(sftp
                .metadata(path)
                .await
                .with_context(|| format!("stat {path}"))?
                .size
                .unwrap_or(0))
        }
        Session::Ftp(ftp) => {
            let path = path.to_string();
            let sz = ftp.with_stream(move |s| s.size(&path)).await?;
            Ok(sz as u64)
        }
        Session::Object(obj) => {
            let key = path.trim_start_matches('/').to_string();
            let p = object_store::path::Path::parse(key.as_str())?;
            let meta = obj
                .store
                .head(&p)
                .await
                .with_context(|| format!("object head {key}"))?;
            Ok(meta.size as u64)
        }
        Session::Webdav(dav) => Ok(webdav_head(dav, path).await.0),
        Session::Http(http) => Ok(http_size(http, path).await),
        Session::Dropbox(dbx) => {
            Ok(dbx.size(&crate::remotefs::dropbox::dropbox_api_path(path)).await)
        }
        Session::OneDrive(od) => Ok(od.size(&crate::remotefs::onedrive::item_ref(path)).await),
        Session::GDrive(gd) => gd.size(path).await,
        Session::Box(bx) => Ok(bx.size(path).await),
        Session::Shopify(sh) => Ok(crate::remotefs::shopify::asset_size(sh, path).await),
        Session::HubSpot(hs) => Ok(crate::remotefs::hubspot::file_size(hs, path).await),
        Session::Dynamics(dynm) => Ok(crate::remotefs::dynamics::file_size(dynm, path).await),
        Session::WordPress(wp) => Ok(crate::remotefs::wordpress::file_size(wp, path).await),
        Session::Agent(agent) => Ok(agent_stat(agent, path).await.0),
    }
}

/// Apply the overwrite policy on the remote side; returns (final_path, skip).
async fn remote_resolve(
    session: &Arc<Session>,
    initial_remote: &str,
    policy: OverwritePolicy,
) -> Result<(String, bool)> {
    match &**session {
        Session::Ssh(ssh) => {
            let cell = ssh.ensure_sftp().await?;
            let sftp = cell.lock().await;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => {
                    let exists = sftp.metadata(initial_remote).await.is_ok();
                    (initial_remote.to_string(), exists)
                }
                OverwritePolicy::Rename => {
                    let renamed = resolve_remote_rename(&sftp, initial_remote).await;
                    (renamed, false)
                }
            })
        }
        Session::Ftp(ftp) => {
            let probe = initial_remote.to_string();
            let exists = ftp.with_stream(move |s| Ok(s.size(&probe).is_ok())).await?;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    let mut candidate = initial_remote.to_string();
                    let session = ftp.clone();
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        candidate = format!("{stem}_{i}{ext}");
                        let probe = candidate.clone();
                        let found = session
                            .with_stream(move |s| Ok(s.size(&probe).is_ok()))
                            .await?;
                        if !found {
                            break;
                        }
                    }
                    (candidate, false)
                }
            })
        }
        Session::Object(obj) => {
            let key = initial_remote.trim_start_matches('/').to_string();
            let probe = object_store::path::Path::parse(key.as_str())?;
            if matches!(policy, OverwritePolicy::Overwrite) {
                return Ok((initial_remote.to_string(), false));
            }
            let exists = match obj.store.head(&probe).await {
                Ok(_) => true,
                Err(object_store::Error::NotFound { .. }) => false,
                Err(e) => return Err(e.into()),
            };
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        let candidate = format!("{stem}_{i}{ext}");
                        let key = candidate.trim_start_matches('/');
                        let p = object_store::path::Path::parse(key)?;
                        match obj.store.head(&p).await {
                            Err(object_store::Error::NotFound { .. }) => return Ok((candidate, false)),
                            Err(e) => return Err(e.into()),
                            Ok(_) => {},
                        }
                    }
                    anyhow::bail!("no unused object name found after 999 attempts")
                }
            })
        }
        Session::Webdav(dav) => {
            let (_, exists) = webdav_head(dav, initial_remote).await;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    let mut candidate = initial_remote.to_string();
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        candidate = format!("{stem}_{i}{ext}");
                        if !webdav_head(dav, &candidate).await.1 {
                            break;
                        }
                    }
                    (candidate, false)
                }
            })
        }
        Session::Http(_) => {
            // Read-only: no upload will actually run (run_http_upload errors), so
            // resolution is a no-op that just echoes the target back.
            Ok((initial_remote.to_string(), false))
        }
        Session::Dropbox(dbx) => {
            let dbx_path = crate::remotefs::dropbox::dropbox_api_path(initial_remote);
            let exists = dbx.exists(&dbx_path).await;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    let mut candidate = initial_remote.to_string();
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        candidate = format!("{stem}_{i}{ext}");
                        let p = crate::remotefs::dropbox::dropbox_api_path(&candidate);
                        if !dbx.exists(&p).await {
                            break;
                        }
                    }
                    (candidate, false)
                }
            })
        }
        Session::OneDrive(od) => {
            let exists = od.exists(&crate::remotefs::onedrive::item_ref(initial_remote)).await;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    let mut candidate = initial_remote.to_string();
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        candidate = format!("{stem}_{i}{ext}");
                        if !od
                            .exists(&crate::remotefs::onedrive::item_ref(&candidate))
                            .await
                        {
                            break;
                        }
                    }
                    (candidate, false)
                }
            })
        }
        Session::GDrive(gd) => {
            let exists = gd.exists(initial_remote).await?;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        let candidate = format!("{stem}_{i}{ext}");
                        if !gd.exists(&candidate).await? {
                            return Ok((candidate, false));
                        }
                    }
                    anyhow::bail!("no unused destination name available")
                }
            })
        }
        Session::Box(bx) => {
            let exists = bx.exists(initial_remote).await;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    let mut candidate = initial_remote.to_string();
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        candidate = format!("{stem}_{i}{ext}");
                        if !bx.exists(&candidate).await {
                            break;
                        }
                    }
                    (candidate, false)
                }
            })
        }
        Session::Shopify(sh) => {
            let exists = crate::remotefs::shopify::asset_exists(sh, initial_remote).await;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    let mut candidate = initial_remote.to_string();
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        candidate = format!("{stem}_{i}{ext}");
                        if !crate::remotefs::shopify::asset_exists(sh, &candidate).await {
                            break;
                        }
                    }
                    (candidate, false)
                }
            })
        }
        Session::HubSpot(hs) => {
            let exists = crate::remotefs::hubspot::file_exists(hs, initial_remote).await;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    let mut candidate = initial_remote.to_string();
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        candidate = format!("{stem}_{i}{ext}");
                        if !crate::remotefs::hubspot::file_exists(hs, &candidate).await {
                            break;
                        }
                    }
                    (candidate, false)
                }
            })
        }
        Session::Dynamics(dynm) => {
            let exists = crate::remotefs::dynamics::file_exists(dynm, initial_remote).await;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    let mut candidate = initial_remote.to_string();
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        candidate = format!("{stem}_{i}{ext}");
                        if !crate::remotefs::dynamics::file_exists(dynm, &candidate).await {
                            break;
                        }
                    }
                    (candidate, false)
                }
            })
        }
        Session::WordPress(wp) => {
            let exists = crate::remotefs::wordpress::file_exists(wp, initial_remote).await;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    let mut candidate = initial_remote.to_string();
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        candidate = format!("{stem}_{i}{ext}");
                        if !crate::remotefs::wordpress::file_exists(wp, &candidate).await {
                            break;
                        }
                    }
                    (candidate, false)
                }
            })
        }
        Session::Agent(agent) => {
            let (_, exists) = agent_stat(agent, initial_remote).await;
            Ok(match policy {
                OverwritePolicy::Overwrite => (initial_remote.to_string(), false),
                OverwritePolicy::Skip => (initial_remote.to_string(), exists),
                OverwritePolicy::Rename if !exists => (initial_remote.to_string(), false),
                OverwritePolicy::Rename => {
                    let mut candidate = initial_remote.to_string();
                    for i in 1..=999 {
                        let (stem, ext) = split_ext(initial_remote);
                        candidate = format!("{stem}_{i}{ext}");
                        if !agent_stat(agent, &candidate).await.1 {
                            break;
                        }
                    }
                    (candidate, false)
                }
            })
        }
    }
}
fn split_ext(path: &str) -> (&str, &str) {
    match path.rfind('.') {
        Some(dot) if dot > path.rfind('/').unwrap_or(0) => (&path[..dot], &path[dot..]),
        _ => (path, ""),
    }
}

/// Shared runner (Plan 17, Plan 24): admission → attempt loop → finalize →
/// wake the queue. A pause gives the concurrency slot back and re-enters
/// admission (Phase 1); the next run resumes from what is on disk (Phase 4).
/// Retryable errors back off with full jitter on a budget that refills
/// whenever bytes moved since the last failure (Phase 5). Downloads retry
/// each range inside the engine, so what reaches here is mostly setup
/// trouble (connecting, stat).
async fn run_job(mgr: Arc<TransferManager>, id: String, job: RetryInfo) {
    let mut budget = retry::Budget::new();
    let res = 'admit: loop {
        let Some(permit) = mgr.admit(&id).await else {
            return;
        };
        loop {
            {
                let live = mgr.live(&id);
                live.set(0);
                live.ring.lock().expect("speed ring poisoned").reset();
            }
            let attempt = match &job {
                RetryInfo::Download {
                    session,
                    remote_path,
                    target,
                    policy,
                } => mgr.run_download(&id, session, remote_path, target, *policy).await,
                RetryInfo::Upload {
                    session,
                    local,
                    final_remote,
                } => dispatch_upload(&mgr, &id, session, local, final_remote).await,
                #[cfg(test)]
                RetryInfo::Test(f) => f(Arc::clone(&mgr), id.clone()).await,
            };
            let err = match attempt {
                Ok(n) => break 'admit Ok(n),
                Err(e) => e,
            };
            if is_paused(&err) {
                drop(permit);
                mgr.requeue_paused(&id).await;
                continue 'admit;
            }
            if retry::classify(&err) == retry::Verdict::Fatal {
                break 'admit Err(err);
            }
            let server_wait = retry::retry_after(&err);
            let attempt_no = match server_wait {
                Some(_) => Some(budget.attempts().max(1)),
                None => budget.fail(mgr.live(&id).get()),
            };
            let Some(attempt_no) = attempt_no else {
                break 'admit Err(err);
            };
            let delay = server_wait.unwrap_or_else(|| retry::backoff(attempt_no));
            tracing::warn!("transfer {id} failed (attempt {attempt_no}), retrying in {delay:?}: {err:#}");
            let secs = delay.as_secs_f64().ceil() as u64;
            mgr.update(&id, |t| {
                t.retry_attempt = Some(attempt_no);
                t.error = Some(format!(
                    "retrying in {secs}s (attempt {}/{})",
                    attempt_no + 1,
                    retry::MAX_ATTEMPTS + 1
                ));
                t.settle();
            })
            .await;
            if let Some(t) = mgr.get(&id).await {
                mgr.emit("transfer://updated", &t);
            }
            tokio::time::sleep(delay).await;
            mgr.update(&id, |t| t.error = None).await;
        }
    };
    finalize(&mgr, &id, res).await;
    mgr.bump_queue_quiet().await;
}

/// Backend dispatch for a single-file upload.
async fn dispatch_upload(
    mgr: &Arc<TransferManager>,
    id: &str,
    session: &Arc<Session>,
    local: &Path,
    final_remote: &str,
) -> Result<u64> {
    let n = upload_by_backend(mgr, id, session, local, final_remote).await?;
    mgr.verify_upload(id, session, local, final_remote).await?;
    Ok(n)
}

async fn upload_by_backend(
    mgr: &Arc<TransferManager>,
    id: &str,
    session: &Arc<Session>,
    local: &Path,
    final_remote: &str,
) -> Result<u64> {
    match &**session {
        Session::Ssh(ssh) => {
            mgr.run_ssh_upload(id, ssh.clone(), local, final_remote)
                .await
        }
        Session::Ftp(ftp) => {
            mgr.run_ftp_upload(id, ftp.clone(), local, final_remote)
                .await
        }
        Session::Object(obj) => {
            mgr.run_object_upload(id, obj.clone(), local, final_remote)
                .await
        }
        Session::Webdav(dav) => {
            mgr.run_webdav_upload(id, dav.clone(), local, final_remote)
                .await
        }
        Session::Http(_) => Err(anyhow::anyhow!(
            "HTTP source is read-only — upload not supported"
        )),
        Session::Dropbox(dbx) => {
            mgr.run_dropbox_upload(id, dbx.clone(), local, final_remote)
                .await
        }
        Session::OneDrive(od) => {
            mgr.run_onedrive_upload(id, od.clone(), local, final_remote)
                .await
        }
        Session::GDrive(gd) => {
            mgr.run_gdrive_upload(id, gd.clone(), local, final_remote)
                .await
        }
        Session::Box(bx) => {
            mgr.run_box_upload(id, bx.clone(), local, final_remote)
                .await
        }
        Session::Shopify(sh) => {
            mgr.run_shopify_upload(id, sh.clone(), local, final_remote)
                .await
        }
        Session::HubSpot(hs) => {
            mgr.run_hubspot_upload(id, hs.clone(), local, final_remote)
                .await
        }
        Session::Dynamics(dynm) => {
            mgr.run_dynamics_upload(id, dynm.clone(), local, final_remote)
                .await
        }
        Session::WordPress(wp) => {
            mgr.run_wordpress_upload(id, wp.clone(), local, final_remote)
                .await
        }
        Session::Agent(agent) => {
            debug_assert!(supports_delta(session));
            mgr.run_agent_upload_with_delta(id, agent.clone(), local, final_remote)
                .await
        }
    }
}

/// Settle a finished run. Success needs the bytes actually written to match
/// the size known at enqueue (Plan 24 Phase 1) — a short copy is an error,
/// never "done". A size that was unknown at enqueue (0) takes the written
/// count.
async fn finalize(mgr: &Arc<TransferManager>, id: &str, result: Result<u64>) {
    let result = match result {
        Ok(written) => {
            let expected = mgr.get(id).await.map(|t| t.size).unwrap_or(0);
            if expected == 0 || written == expected {
                Ok(written)
            } else {
                Err(anyhow::anyhow!(
                    "size mismatch: expected {expected} bytes, transferred {written}                      (the file changed or the connection dropped mid-transfer)"
                ))
            }
        }
        Err(e) => Err(e),
    };
    let skipped = matches!(&result, Err(e) if e.is::<SkippedAtPlace>());
    match result {
        Ok(written) => {
            mgr.update(id, |t| {
                t.status = TransferStatus::Done;
                t.settle();
                t.size = written;
                t.transferred = written;
                t.error = None;
                t.retry_attempt = None;
            })
            .await;
            if let Some(t) = mgr.get(id).await {
                mgr.emit("transfer://done", &t);
            }
        }
        Err(_) if skipped => {
            mgr.update(id, |t| {
                t.status = TransferStatus::Skipped;
                t.settle();
                t.error = None;
                t.retry_attempt = None;
            })
            .await;
            if let Some(t) = mgr.get(id).await {
                mgr.emit("transfer://done", &t);
            }
        }
        Err(e) => {
            mgr.update(id, |t| {
                t.status = TransferStatus::Error;
                t.settle();
                t.retry_attempt = None;
                t.error = Some(e.to_string());
            })
            .await;
            if let Some(t) = mgr.get(id).await {
                mgr.emit("transfer://error", &t);
            }
        }
    }
    mgr.tasks.lock().await.remove(id);
    mgr.drop_live(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    // ---------- TokenBucket (Phase 4) ----------

    #[tokio::test(start_paused = true)]
    async fn token_bucket_caps_throughput() {
        let bucket = TokenBucket::new();
        bucket.set_rate_kbps(512); // 512 KiB/s
        let start = tokio::time::Instant::now();
        // 1 MiB at 512 KiB/s must take ~2s of (virtual) time, charged in full.
        bucket.acquire(1024 * 1024).await;
        let elapsed = start.elapsed();
        assert!(elapsed >= Duration::from_millis(1900), "too fast: {elapsed:?}");
        assert!(elapsed <= Duration::from_millis(2600), "too slow: {elapsed:?}");
    }

    #[tokio::test(start_paused = true)]
    async fn token_bucket_unlimited_is_instant() {
        let bucket = TokenBucket::new(); // rate 0 = unlimited
        let start = tokio::time::Instant::now();
        bucket.acquire(10 * 1024 * 1024).await;
        assert_eq!(start.elapsed(), Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn token_bucket_tiny_file_skips_full_window() {
        let bucket = TokenBucket::new();
        bucket.set_rate_kbps(64); // 64 KiB/s
        let start = tokio::time::Instant::now();
        bucket.acquire(1024).await; // 1 KiB → ~16ms, not a whole window
        assert!(start.elapsed() < Duration::from_millis(100));
    }

    // ---------- checkpoint + pause releasing the slot (Plan 24 Phase 1) ----------

    #[tokio::test]
    async fn checkpoint_fails_fast_when_paused() {
        let mgr = Arc::new(TransferManager::new());
        mgr.pauses.lock().await.insert("t1".into(), PauseGate::new());
        // Not paused → passes straight through.
        mgr.checkpoint("t1", 128).await.unwrap();
        // Paused → returns at once (no parking while holding a slot).
        mgr.pauses.lock().await.get("t1").unwrap().set(true);
        let err = mgr.checkpoint("t1", 128).await.unwrap_err();
        assert!(is_paused(&err));
        // Pause-all trips it too.
        mgr.pauses.lock().await.get("t1").unwrap().set(false);
        mgr.pause_all.set(true);
        assert!(is_paused(&mgr.checkpoint("t1", 0).await.unwrap_err()));
    }

    /// Register a queued row + gate + a fake copy loop that runs until its
    /// checkpoint trips (pause) or `release` flips.
    async fn spawn_fake(
        mgr: &Arc<TransferManager>,
        id: &str,
        release: Arc<AtomicBool>,
        running: Arc<AtomicUsize>,
    ) {
        mgr.insert(Transfer {
            id: id.into(),
            kind: TransferKind::Download,
            source: id.into(),
            destination: id.into(),
            size: 10,
            transferred: 0,
            status: TransferStatus::Queued,
            error: None,
            retry_attempt: None,
            delta: None,
            started_at: 0,
            bytes_per_sec: None,
            eta_secs: None,
            segments: None,
            stalled: false,
            notice: None,
            restored: false,
        })
        .await;
        mgr.pauses.lock().await.insert(id.into(), PauseGate::new());
        mgr.waiting.lock().await.push_back(id.into());
        let job = RetryInfo::Test(Arc::new(move |mgr: Arc<TransferManager>, id: String| {
            let release = release.clone();
            let running = running.clone();
            Box::pin(async move {
                mgr.update(&id, |t| t.status = TransferStatus::Transferring).await;
                running.fetch_add(1, Ordering::SeqCst);
                let res = loop {
                    if let Err(e) = mgr.checkpoint(&id, 1).await {
                        break Err(e);
                    }
                    if release.load(Ordering::SeqCst) {
                        break Ok(10);
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                };
                running.fetch_sub(1, Ordering::SeqCst);
                res
            })
        }));
        let task = tokio::spawn(run_job(Arc::clone(mgr), id.to_string(), job));
        mgr.tasks.lock().await.insert(id.to_string(), task);
    }

    async fn wait_for(cond: impl Fn() -> bool) {
        for _ in 0..400 {
            if cond() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("condition never became true");
    }

    /// With 3 slots, pausing the 3 running transfers lets the 4th start, and
    /// resuming them brings them back once slots free up.
    #[tokio::test]
    async fn pause_releases_the_concurrency_slot() {
        let mgr = Arc::new(TransferManager::new());
        let release = Arc::new(AtomicBool::new(false));
        let running = Arc::new(AtomicUsize::new(0));
        for id in ["a", "b", "c", "d"] {
            spawn_fake(&mgr, id, release.clone(), running.clone()).await;
        }
        let r = running.clone();
        wait_for(move || r.load(Ordering::SeqCst) == 3).await;
        assert_eq!(mgr.get("d").await.unwrap().status, TransferStatus::Queued);

        for id in ["a", "b", "c"] {
            mgr.pauses.lock().await.get(id).unwrap().set(true);
        }
        let m = Arc::clone(&mgr);
        wait_for(move || {
            m.transfers
                .try_lock()
                .map(|t| t.get("d").unwrap().status == TransferStatus::Transferring)
                .unwrap_or(false)
        })
        .await;
        for id in ["a", "b", "c"] {
            assert_eq!(mgr.get(id).await.unwrap().status, TransferStatus::Paused);
            assert!(mgr.waiting.lock().await.iter().any(|x| x == id));
        }

        // Resume everything and let all four finish.
        for id in ["a", "b", "c"] {
            mgr.pauses.lock().await.get(id).unwrap().set(false);
        }
        mgr.bump_queue_quiet().await;
        release.store(true, Ordering::SeqCst);
        let m = Arc::clone(&mgr);
        wait_for(move || {
            m.transfers
                .try_lock()
                .map(|t| t.values().all(|t| t.status == TransferStatus::Done))
                .unwrap_or(false)
        })
        .await;
    }

    #[tokio::test]
    async fn short_transfer_is_an_error_not_done() {
        let mgr = Arc::new(TransferManager::new());
        for (id, size) in [("short", 100u64), ("unknown", 0)] {
            mgr.insert(Transfer {
                id: id.into(),
                kind: TransferKind::Download,
                source: id.into(),
                destination: id.into(),
                size,
                transferred: 0,
                status: TransferStatus::Transferring,
                error: None,
                retry_attempt: None,
                delta: None,
                started_at: 0,
                bytes_per_sec: None,
                eta_secs: None,
                segments: None,
                stalled: false,
                notice: None,
                restored: false,
            })
            .await;
        }
        finalize(&mgr, "short", Ok(60)).await;
        let t = mgr.get("short").await.unwrap();
        assert_eq!(t.status, TransferStatus::Error);
        assert!(t.error.unwrap().contains("size mismatch"));
        // Unknown size at enqueue: the written count becomes the size.
        finalize(&mgr, "unknown", Ok(42)).await;
        let t = mgr.get("unknown").await.unwrap();
        assert_eq!((t.status, t.size, t.transferred), (TransferStatus::Done, 42, 42));
    }

    // ---------- FIFO admission (Phase 1) ----------

    #[tokio::test]
    async fn fifo_skips_paused_and_pause_all_blocks_everyone() {
        let mgr = TransferManager::new();
        {
            let mut w = mgr.waiting.lock().await;
            w.push_back("a".to_string());
            w.push_back("b".to_string());
            w.push_back("c".to_string());
        }
        mgr.pauses.lock().await.insert("a".into(), PauseGate::new());
        mgr.pauses.lock().await.insert("b".into(), PauseGate::new());
        {
            let w = mgr.waiting.lock().await;
            assert!(mgr.is_my_turn(&w, "a").await);
            assert!(!mgr.is_my_turn(&w, "b").await);
        }
        // A paused front row never head-of-line blocks the queue.
        mgr.pauses.lock().await.get("a").unwrap().set(true);
        {
            let w = mgr.waiting.lock().await;
            assert!(!mgr.is_my_turn(&w, "a").await);
            assert!(mgr.is_my_turn(&w, "b").await);
            assert!(!mgr.is_my_turn(&w, "c").await);
        }
        // Pause-all blocks everyone, runnable or not.
        mgr.pause_all.set(true);
        {
            let w = mgr.waiting.lock().await;
            assert!(!mgr.is_my_turn(&w, "b").await);
        }
    }

    #[tokio::test(start_paused = true)]
    async fn concurrency_grows_and_shrinks() {
        let mgr = TransferManager::new();
        assert_eq!(mgr.semaphore.available_permits(), DEFAULT_CONCURRENCY);
        mgr.set_concurrency(5);
        assert_eq!(mgr.semaphore.available_permits(), 5);
        mgr.set_concurrency(2);
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
        assert_eq!(mgr.semaphore.available_permits(), 2);
    }

    // ---------- Retry classification (Phase 3) ----------

    #[test]
    fn remote_join_follows_the_destination_style() {
        // POSIX destinations keep forward slashes, with or without a trailing one.
        assert_eq!(join_remote("/var/www", "a.txt"), "/var/www/a.txt");
        assert_eq!(join_remote("/var/www/", "a.txt"), "/var/www/a.txt");
        // A Windows agent target keeps backslashes instead of going mixed.
        assert_eq!(join_remote(r"C:\srv", "a.txt"), r"C:\srv\a.txt");
        assert_eq!(join_remote(r"C:\srv\", "a.txt"), r"C:\srv\a.txt");
        // Forward-slashed Windows paths are already unambiguous — leave them be.
        assert_eq!(join_remote("C:/srv", "a.txt"), "C:/srv/a.txt");
        assert_eq!(join_remote("", "a.txt"), "a.txt");
    }

    // ---------- Delta sync (Phase 2) ----------

    /// Deterministic pseudo-random bytes (xorshift64*), so tests need no
    /// fixtures or extra dev-deps.
    fn det_bytes(seed: u64, n: usize) -> Vec<u8> {
        let mut x = seed;
        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            out.extend_from_slice(&x.wrapping_mul(0x2545_F491_4F6C_DD1D).to_le_bytes());
        }
        out.truncate(n);
        out
    }

    fn test_dirs(tag: &str) -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "faro-transfer-delta-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(dir.join("local")).unwrap();
        std::fs::create_dir_all(dir.join("remote")).unwrap();
        dir
    }

    /// An AgentSession wired over localhost TCP to an in-process daemon
    /// request loop (`faro_agentd::ops::handle`, writes allowed). With
    /// `reject_signature`, `Signature` requests error out — simulating a
    /// pre-delta-sync daemon for the fallback tests.
    async fn delta_test_session(reject_signature: bool) -> Arc<crate::session::AgentSession> {
        use faro_agent_proto::identity::Identity;
        use faro_agent_proto::msg::{Hello, Request, Response, PROTOCOL_VERSION};
        use faro_agent_proto::{Auth, Role, SecureChannel};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let daemon_id = Identity::generate().unwrap();
        let daemon_pub = daemon_id.public_bytes().unwrap();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else { break };
                let sk = match daemon_id.private_bytes() {
                    Ok(sk) => sk,
                    Err(_) => break,
                };
                tokio::spawn(async move {
                    let jobs = faro_agentd::jobs::JobStore::new();
                    let policy =
                        faro_agentd::Policy { allow_exec: false, allow_write: true };
                    let mut ch = SecureChannel::establish(
                        stream,
                        Role::Responder,
                        &sk,
                        Auth::Paired { expect_remote: None },
                    )
                    .await?;
                    let _hello: Hello = ch.recv().await?;
                    loop {
                        let req: Request = match ch.recv().await {
                            Ok(r) => r,
                            Err(_) => break,
                        };
                        let resp = if reject_signature
                            && matches!(req, Request::Signature { .. })
                        {
                            Response::error("unknown op")
                        } else {
                            faro_agentd::ops::handle(req, policy, &jobs).await
                        };
                        if ch.send(&resp).await.is_err() {
                            break;
                        }
                    }
                    Ok::<(), anyhow::Error>(())
                });
            }
        });

        let ctrl_id = Identity::generate().unwrap();
        let stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let mut ch = SecureChannel::establish(
            stream,
            Role::Initiator,
            &ctrl_id.private_bytes().unwrap(),
            Auth::Paired { expect_remote: Some(daemon_pub) },
        )
        .await
        .unwrap();
        ch.send(&Hello {
            protocol_version: PROTOCOL_VERSION,
            client_name: "transfer-test".into(),
        })
        .await
        .unwrap();
        Arc::new(crate::session::AgentSession::for_test(ch))
    }

    /// A manager with one transfer row registered, so the delta arms' update /
    /// checkpoint / emit calls have a row to work on.
    async fn delta_test_manager(
        id: &str,
        kind: TransferKind,
        source: &str,
        destination: &str,
        size: u64,
    ) -> Arc<TransferManager> {
        let mgr = Arc::new(TransferManager::new());
        mgr.insert(Transfer {
            id: id.to_string(),
            kind,
            source: source.to_string(),
            destination: destination.to_string(),
            size,
            transferred: 0,
            status: TransferStatus::Queued,
            error: None,
            retry_attempt: None,
            delta: None,
            started_at: 0,
            bytes_per_sec: None,
            eta_secs: None,
            segments: None,
            stalled: false,
            notice: None,
            restored: false,
        })
        .await;
        mgr
    }

    // ---------- Delta sync (Phase 3): setting switch + cross-backend gate ----------

    /// The `deltaSync` setting drives the switch; `FARO_DELTA=0` force-off
    /// wins over it either way.
    #[test]
    fn delta_switch_follows_the_setting() {
        let mgr = TransferManager::new();
        assert!(mgr.delta_enabled(), "default on");
        mgr.set_delta_enabled(false);
        assert!(!mgr.delta_enabled());
        mgr.set_delta_enabled(true);
        let env_off = std::env::var("FARO_DELTA").ok().as_deref() == Some("0");
        assert_eq!(mgr.delta_enabled(), !env_off);
    }

    fn delta_gate_profile(protocol: &str) -> crate::profiles::ConnectionProfile {
        crate::profiles::ConnectionProfile {
            id: "t".into(),
            name: "t".into(),
            protocol: protocol.into(),
            host: "127.0.0.1".into(),
            port: 22,
            username: "u".into(),
            auth: crate::profiles::AuthMethod::Agent,
            default_remote_path: None,
            color: None,
            auto_connect: None,
            bucket: None,
            region: None,
            endpoint: None,
            account: None,
            agent_key: None,
            group: None,
            sort_order: None,
            icon: None,
            jump_host: None,
            jump_port: None,
            jump_username: None,
            ftp_encoding: None,
            ftp_active_mode: None,
            ftp_max_connections: None,
            ftp_segments: None,
        }
    }

    /// Cross-backend contract: `supports_delta` is true ONLY for
    /// `Session::Agent` — every other backend must take the whole-file path.
    /// One table row per variant constructible without a live connection;
    /// Ssh/Ftp (live sockets) and the OAuth/API-token cloud sessions (private
    /// connect-time state) can't be built in a unit test — for those the
    /// exhaustive `matches!` in `supports_delta` is the compile-time
    /// guarantee, and dispatch routes them to plain `run_*` arms.
    #[tokio::test]
    async fn supports_delta_only_for_agent_sessions() {
        use crate::session::http::{HttpAuth, HttpMode};
        use crate::session::webdav::WebdavAuth;
        use crate::session::{HttpSession, ObjectSession, WebdavSession};

        let client = reqwest::Client::new();
        let base = url::Url::parse("https://example.com/dav/").unwrap();
        let table: Vec<(&str, Session, bool)> = vec![
            (
                "webdav",
                Session::Webdav(Arc::new(WebdavSession {
                    id: "t".into(),
                    profile: delta_gate_profile("webdav"),
                    client: client.clone(),
                    base: base.clone(),
                    auth: WebdavAuth::None,
                })),
                false,
            ),
            (
                "http",
                Session::Http(Arc::new(HttpSession {
                    id: "t".into(),
                    profile: delta_gate_profile("http"),
                    client,
                    base,
                    auth: HttpAuth::None,
                    mode: HttpMode::Listing,
                })),
                false,
            ),
            (
                "object",
                Session::Object(Arc::new(ObjectSession {
                    id: "t".into(),
                    profile: delta_gate_profile("s3"),
                    container: "b".into(),
                    store: Arc::new(object_store::memory::InMemory::new()),
                })),
                false,
            ),
            (
                "agent",
                Session::Agent(delta_test_session(false).await),
                true,
            ),
        ];
        for (name, session, expected) in &table {
            assert_eq!(supports_delta(session), *expected, "{name} backend");
        }
    }

    /// Delta upload: 20 MiB up whole-file, mutate 1 KiB, up again — the second
    /// run must reassemble a byte-equal remote file with < 10% of the bytes
    /// crossing the wire (the patch is the ONLY WriteChunk traffic).
    #[tokio::test]
    async fn delta_upload_reuses_unchanged_blocks() {
        let dir = test_dirs("up");
        let local = dir.join("local/file.bin");
        let remote = dir.join("remote/file.bin");
        let remote_s = remote.to_string_lossy().into_owned();
        let size = 20 * 1024 * 1024;
        std::fs::write(&local, det_bytes(0xAAAA, size)).unwrap();

        let session = delta_test_session(false).await;
        // First upload: no remote basis → whole-file.
        let mgr = delta_test_manager("t", TransferKind::Upload, &local.to_string_lossy(), &remote_s, size as u64).await;
        mgr.agent_upload_with_delta_core("t", &session, &local, &remote_s)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&remote).unwrap(), std::fs::read(&local).unwrap());
        assert!(mgr.get("t").await.unwrap().delta.is_none(), "no basis → whole-file");

        // Mutate 1 KiB in the middle and upload again → delta.
        let mut content = std::fs::read(&local).unwrap();
        content[10 * 1024 * 1024..10 * 1024 * 1024 + 1024]
            .copy_from_slice(&det_bytes(0xBBBB, 1024));
        std::fs::write(&local, &content).unwrap();
        mgr.update("t", |t| t.transferred = 0).await;
        mgr.agent_upload_with_delta_core("t", &session, &local, &remote_s)
            .await
            .unwrap();

        assert_eq!(std::fs::read(&remote).unwrap(), content);
        let t = mgr.get("t").await.unwrap();
        let stats = t.delta.expect("second upload must run as a delta");
        assert!(
            stats.sent * 10 < size as u64,
            "1 KiB edit sent {} bytes (>= 10% of {size})",
            stats.sent
        );
        assert_eq!(stats.sent + stats.reused, size as u64);
        // No temp litter on either side.
        for side in ["local", "remote"] {
            let litter: Vec<_> = std::fs::read_dir(dir.join(side))
                .unwrap()
                .filter_map(|e| e.ok())
                .filter(|e| {
                    let n = e.file_name().to_string_lossy().into_owned();
                    n.contains(".faro-patch-") || n.contains(".faro-new-") || n.contains(".faro-delta-")
                })
                .collect();
            assert!(litter.is_empty(), "{side} litter: {litter:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Delta download: same shape as the upload test, other direction.
    #[tokio::test]
    async fn delta_download_reuses_unchanged_blocks() {
        let dir = test_dirs("down");
        let local = dir.join("local/file.bin");
        let remote = dir.join("remote/file.bin");
        let remote_s = remote.to_string_lossy().into_owned();
        let size = 20 * 1024 * 1024;
        std::fs::write(&remote, det_bytes(0xCCCC, size)).unwrap();

        let session = delta_test_session(false).await;
        // First download: no local basis → whole-file.
        let mgr = delta_test_manager("t", TransferKind::Download, &remote_s, &local.to_string_lossy(), size as u64).await;
        mgr.agent_download_with_delta_core("t", &session, &remote_s, &local)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&local).unwrap(), std::fs::read(&remote).unwrap());
        assert!(mgr.get("t").await.unwrap().delta.is_none());

        // Mutate 1 KiB remotely and download again → delta.
        let mut content = std::fs::read(&remote).unwrap();
        content[5 * 1024 * 1024..5 * 1024 * 1024 + 1024]
            .copy_from_slice(&det_bytes(0xDDDD, 1024));
        std::fs::write(&remote, &content).unwrap();
        mgr.update("t", |t| t.transferred = 0).await;
        mgr.agent_download_with_delta_core("t", &session, &remote_s, &local)
            .await
            .unwrap();

        assert_eq!(std::fs::read(&local).unwrap(), content);
        let t = mgr.get("t").await.unwrap();
        let stats = t.delta.expect("second download must run as a delta");
        assert!(
            stats.sent * 10 < size as u64,
            "1 KiB edit fetched {} bytes (>= 10% of {size})",
            stats.sent
        );
        assert_eq!(stats.sent + stats.reused, size as u64);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Old daemon (Signature unsupported) ⇒ the delta attempt fails and the
    /// wrapper silently completes a correct whole-file copy, both directions.
    #[tokio::test]
    async fn delta_falls_back_when_daemon_lacks_signature() {
        let dir = test_dirs("old");
        let local = dir.join("local/file.bin");
        let remote = dir.join("remote/file.bin");
        let remote_s = remote.to_string_lossy().into_owned();
        let size = 20 * 1024 * 1024;
        std::fs::write(&remote, det_bytes(0xEEEE, size)).unwrap();
        std::fs::write(&local, std::fs::read(&remote).unwrap()).unwrap();

        let session = delta_test_session(true).await; // Signature → error
        // Upload direction: remote basis exists and file is big enough, so the
        // delta is attempted, fails at Signature, and falls back.
        let mut content = std::fs::read(&local).unwrap();
        content[1024..2048].copy_from_slice(&det_bytes(0xFFFF, 1024));
        std::fs::write(&local, &content).unwrap();
        let mgr = delta_test_manager("u", TransferKind::Upload, &local.to_string_lossy(), &remote_s, size as u64).await;
        mgr.agent_upload_with_delta_core("u", &session, &local, &remote_s)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&remote).unwrap(), content);
        assert!(mgr.get("u").await.unwrap().delta.is_none(), "fallback → no delta stats");

        // Download direction.
        content[4096..5120].copy_from_slice(&det_bytes(0x1234, 1024));
        std::fs::write(&remote, &content).unwrap();
        let mgr = delta_test_manager("d", TransferKind::Download, &remote_s, &local.to_string_lossy(), size as u64).await;
        mgr.agent_download_with_delta_core("d", &session, &remote_s, &local)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&local).unwrap(), content);
        assert!(mgr.get("d").await.unwrap().delta.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ≥ 60% literal ⇒ the worthwhile heuristic aborts the delta before any
    /// patch byte is sent and the wrapper falls back to a correct whole-file
    /// copy.
    #[tokio::test]
    async fn delta_falls_back_when_mostly_changed() {
        let dir = test_dirs("churn");
        let local = dir.join("local/file.bin");
        let remote = dir.join("remote/file.bin");
        let remote_s = remote.to_string_lossy().into_owned();
        let size = 20 * 1024 * 1024;
        std::fs::write(&remote, det_bytes(0x7777, size)).unwrap();
        // Same size, ~completely different content ⇒ ~100% literal.
        std::fs::write(&local, det_bytes(0x8888, size)).unwrap();

        let session = delta_test_session(false).await;
        let mgr = delta_test_manager("u", TransferKind::Upload, &local.to_string_lossy(), &remote_s, size as u64).await;
        mgr.agent_upload_with_delta_core("u", &session, &local, &remote_s)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&remote).unwrap(), std::fs::read(&local).unwrap());
        assert!(mgr.get("u").await.unwrap().delta.is_none(), "≥60% literal → whole-file");

        // Download direction, same setup reversed.
        std::fs::write(&remote, det_bytes(0x9999, size)).unwrap();
        let mgr = delta_test_manager("d", TransferKind::Download, &remote_s, &local.to_string_lossy(), size as u64).await;
        mgr.agent_download_with_delta_core("d", &session, &remote_s, &local)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&local).unwrap(), std::fs::read(&remote).unwrap());
        assert!(mgr.get("d").await.unwrap().delta.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---------- Download pipeline + resume (Plan 24 Phases 2–4) ----------

    /// An object-store session over object_store's in-memory backend, which
    /// serves ranged GETs and honours `if_match` like a real store.
    fn memory_session(store: Arc<object_store::memory::InMemory>) -> Arc<Session> {
        Arc::new(Session::Object(Arc::new(crate::session::ObjectSession {
            id: "mem".into(),
            profile: delta_gate_profile("s3"),
            container: "b".into(),
            store,
        })))
    }

    async fn put_object(store: &object_store::memory::InMemory, key: &str, data: &[u8]) {
        use object_store::ObjectStore;
        store
            .put(&object_store::path::Path::parse(key).unwrap(), bytes::Bytes::copy_from_slice(data).into())
            .await
            .unwrap();
    }

    /// Register a queued download the way `start_download` does.
    async fn queue_download(
        mgr: &Arc<TransferManager>,
        id: &str,
        session: &Arc<Session>,
        key: &str,
        target: &Path,
        size: u64,
    ) -> RetryInfo {
        mgr.insert(Transfer {
            id: id.into(),
            kind: TransferKind::Download,
            source: key.into(),
            destination: target.to_string_lossy().into_owned(),
            size,
            transferred: 0,
            status: TransferStatus::Queued,
            error: None,
            retry_attempt: None,
            delta: None,
            started_at: 0,
            bytes_per_sec: None,
            eta_secs: None,
            segments: None,
            stalled: false,
            notice: None,
            restored: false,
        })
        .await;
        let job = RetryInfo::Download {
            session: Arc::clone(session),
            remote_path: key.into(),
            target: target.to_path_buf(),
            policy: OverwritePolicy::Overwrite,
        };
        mgr.retry.lock().await.insert(id.into(), job.clone());
        mgr.pauses.lock().await.insert(id.into(), PauseGate::new());
        mgr.waiting.lock().await.push_back(id.into());
        job
    }

    async fn wait_status(mgr: &Arc<TransferManager>, id: &str, want: TransferStatus) {
        for _ in 0..2000 {
            if mgr.get(id).await.map(|t| t.status) == Some(want) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("{id} never reached {want:?}: {:?}", mgr.get(id).await);
    }

    #[tokio::test]
    async fn download_lands_via_part_file_and_keeps_the_original_until_done() {
        let dir = test_dirs("pipe");
        let store = Arc::new(object_store::memory::InMemory::new());
        let data = det_bytes(0x51, 20 * 1024 * 1024 + 5);
        put_object(&store, "f.bin", &data).await;
        let session = memory_session(store);
        let target = dir.join("local/f.bin");
        std::fs::write(&target, b"the old file").unwrap();

        let mgr = Arc::new(TransferManager::new());
        let job = queue_download(&mgr, "d", &session, "f.bin", &target, data.len() as u64).await;
        run_job(Arc::clone(&mgr), "d".into(), job).await;
        let t = mgr.get("d").await.unwrap();
        assert_eq!(t.status, TransferStatus::Done, "{:?}", t.error);
        assert_eq!(std::fs::read(&target).unwrap(), data);
        assert!(!partfile::part_path_for(&target).exists());
        assert!(mgr.resume_state("d").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Pause at ~40 %, "restart the app" (a fresh manager on the same
    /// faro.db), resume: the run continues from the saved ranges and the
    /// result is byte-identical. Then the same with a remote that changed in
    /// between: it restarts from 0 with a notice and never stitches.
    #[tokio::test]
    async fn resume_survives_a_restart_and_rejects_a_changed_remote() {
        let dir = test_dirs("resume");
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let store = Arc::new(object_store::memory::InMemory::new());
        let data = det_bytes(0x52, 24 * 1024 * 1024);
        put_object(&store, "big.bin", &data).await;
        let session = memory_session(Arc::clone(&store));
        let target = dir.join("local/big.bin");
        let size = data.len() as u64;

        for changed in [false, true] {
            let _ = std::fs::remove_file(&target);
            let mgr = Arc::new(TransferManager::new());
            mgr.set_db(Arc::clone(&db));
            mgr.set_throttle_kbps(16 * 1024);
            let job = queue_download(&mgr, "r", &session, "big.bin", &target, size).await;
            let task = tokio::spawn(run_job(Arc::clone(&mgr), "r".into(), job));
            while mgr.live("r").get() < size * 2 / 5 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            mgr.pauses.lock().await.get("r").unwrap().set(true);
            wait_status(&mgr, "r", TransferStatus::Paused).await;
            let saved = mgr.resume_state("r").unwrap().ranges.total();
            assert!(saved >= size / 4, "saved {saved}");
            assert!(partfile::part_path_for(&target).exists(), "pause keeps the temp");
            task.abort(); // the app quits

            let expect = if changed {
                let fresh = det_bytes(0x53, size as usize);
                put_object(&store, "big.bin", &fresh).await;
                fresh
            } else {
                data.clone()
            };

            // Relaunch: the row comes back Paused, restored, at its progress.
            let mgr = Arc::new(TransferManager::new());
            mgr.set_db(Arc::clone(&db));
            mgr.restore().await;
            let t = mgr.get("r").await.unwrap();
            assert_eq!((t.status, t.restored), (TransferStatus::Paused, true));
            assert_eq!(t.transferred, saved);
            assert_eq!(mgr.restored_connection("r").await.as_deref(), Some("t"));

            mgr.requeue_restored("r", Arc::clone(&session)).await.unwrap();
            let mut first = None;
            loop {
                let b = mgr.live("r").get();
                if first.is_none() && b > 0 {
                    first = Some(b);
                }
                if mgr.get("r").await.unwrap().status == TransferStatus::Done {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let t = mgr.get("r").await.unwrap();
            assert_eq!(std::fs::read(&target).unwrap(), expect, "changed={changed}");
            if changed {
                assert_eq!(t.notice.as_deref(), Some("remote changed, restarted"));
            } else {
                assert!(first.unwrap() >= saved, "resumed from {first:?}, saved {saved}");
                assert!(t.notice.is_none());
            }
            assert!(db.resume_list().unwrap().is_empty(), "Done clears the record");
            assert!(!partfile::part_path_for(&target).exists());
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `transferVerify` (Phase 6): an Agent download checks the daemon's
    /// BLAKE3 hash; a temp that doesn't match fails, is kept, and is never
    /// moved into place.
    #[tokio::test]
    async fn verify_checks_the_agent_hash_and_keeps_a_bad_temp() {
        let dir = test_dirs("verify");
        let remote = dir.join("remote/v.bin");
        let remote_s = remote.to_string_lossy().into_owned();
        std::fs::write(&remote, det_bytes(0x61, 3 * 1024 * 1024)).unwrap();
        let session = delta_test_session(false).await;
        let local = dir.join("local/v.bin");

        let mgr = delta_test_manager("v", TransferKind::Download, &remote_s, &local.to_string_lossy(), 0).await;
        mgr.set_verify(true);
        mgr.agent_download_with_delta_core("v", &session, &remote_s, &local)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&local).unwrap(), std::fs::read(&remote).unwrap());

        // A temp whose bytes don't match the server's hash.
        let part = dir.join("local/bad.bin.faro-part");
        std::fs::write(&part, b"not the same bytes").unwrap();
        let finished = partfile::Finished {
            len: 18,
            sha256: None,
        };
        let agent = Arc::new(Session::Agent(Arc::clone(&session)));
        let err = mgr
            .verify_download(&agent, &remote_s, &part, &finished)
            .await
            .unwrap_err();
        assert!(err.is::<verify::VerifyFailed>(), "{err:#}");
        assert_eq!(retry::classify(&err), retry::Verdict::Fatal);
        assert!(part.exists(), "kept for inspection");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Cancel discards the temp and the record; an error keeps both.
    #[tokio::test]
    async fn cancel_discards_the_partial_download() {
        let dir = test_dirs("cancel");
        let db = Arc::new(crate::db::Db::open_in_memory().unwrap());
        let store = Arc::new(object_store::memory::InMemory::new());
        let data = det_bytes(0x54, 8 * 1024 * 1024);
        put_object(&store, "c.bin", &data).await;
        let session = memory_session(store);
        let target = dir.join("local/c.bin");
        let mgr = Arc::new(TransferManager::new());
        mgr.set_db(Arc::clone(&db));
        // The in-memory store hands over a range as one chunk, which the
        // throttle then holds back for minutes: the run is mid-flight.
        mgr.set_throttle_kbps(16);
        let job = queue_download(&mgr, "c", &session, "c.bin", &target, data.len() as u64).await;
        let task = tokio::spawn(run_job(Arc::clone(&mgr), "c".into(), job));
        mgr.tasks.lock().await.insert("c".into(), task);
        let part = partfile::part_path_for(&target);
        while db.resume_list().unwrap().is_empty() || !part.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(db.resume_list().unwrap().len(), 1);
        // `cancel` needs an AppHandle only to bind it; do its work directly.
        if let Some(h) = mgr.tasks.lock().await.remove("c") {
            h.abort();
        }
        mgr.forget_resume("c", true).await;
        assert!(db.resume_list().unwrap().is_empty());
        assert!(!partfile::part_path_for(&target).exists());
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
