//! Safe local writes for downloads (Plan 24 Phase 2).
//!
//! Every download lands in `<name>.faro-part` next to its target, never in
//! the target itself. The temp is preallocated to the final size, written at
//! explicit offsets (so parallel ranges can fill it in any order), and only
//! renamed over the target once it is complete and synced. An existing file
//! under Overwrite is therefore replaced only by a finished download, and a
//! failed or canceled one leaves the original untouched.
//!
//! One writer task owns the file. Producers send `(offset, bytes)` over a
//! bounded channel (the bound is the backpressure); the writer merges
//! adjacent writes into one positioned write of up to 4 MiB (or whatever has
//! gathered within 1 s) and runs it on the blocking pool.

use anyhow::{anyhow, Context, Result};
use bytes::{Bytes, BytesMut};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};
use tokio::sync::{mpsc, oneshot};
use tokio::time::Instant;

/// Extension of an in-progress download.
pub const PART_SUFFIX: &str = ".faro-part";
/// Largest merged write.
const COALESCE_MAX: usize = 4 * 1024 * 1024;
/// Oldest a merged write may get before it is flushed.
const COALESCE_AGE: Duration = Duration::from_secs(1);
/// Queued writes before producers wait (the backpressure bound).
const CHANNEL_DEPTH: usize = 64;

/// `C:\dl\movie.mkv` → `C:\dl\movie.mkv.faro-part`.
pub fn part_path_for(target: &Path) -> PathBuf {
    let mut name = target
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(PART_SUFFIX);
    target.with_file_name(name)
}

/// Is this file name an in-progress download?
pub fn is_part_file(name: &str) -> bool {
    name.ends_with(PART_SUFFIX)
}

enum Msg {
    Write(u64, Bytes),
    Sync(oneshot::Sender<Result<(), String>>),
    Finish(oneshot::Sender<Result<Finished, String>>),
}

/// What the writer reports once the file is complete and synced.
#[derive(Debug)]
pub struct Finished {
    /// Final length of the temp file.
    pub len: u64,
    /// SHA-256 of the whole file (hex), when hashing was requested.
    pub sha256: Option<String>,
}

/// The first I/O error the writer hit; it stops at that point.
type ErrSlot = Arc<Mutex<Option<String>>>;

fn writer_error(slot: &ErrSlot) -> anyhow::Error {
    let msg = slot
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| "local file writer stopped".into());
    anyhow!(msg)
}

/// A cloneable handle producers use to send bytes to the writer.
#[derive(Clone)]
pub struct PartWriter {
    tx: mpsc::Sender<Msg>,
    err: ErrSlot,
}

impl PartWriter {
    /// Queue `data` for the file at `offset`. Waits when the writer is
    /// behind; fails once the writer has hit an I/O error.
    pub async fn write(&self, offset: u64, data: Bytes) -> Result<()> {
        if data.is_empty() {
            return Ok(());
        }
        self.tx
            .send(Msg::Write(offset, data))
            .await
            .map_err(|_| writer_error(&self.err))
    }

    /// Write out everything queued so far (by any handle) and `sync_data`.
    pub async fn sync(&self) -> Result<()> {
        let (ack, rx) = oneshot::channel();
        self.tx
            .send(Msg::Sync(ack))
            .await
            .map_err(|_| writer_error(&self.err))?;
        rx.await
            .map_err(|_| writer_error(&self.err))?
            .map_err(|e| anyhow!(e))
    }
}

/// An open `.faro-part` file and its writer task.
pub struct PartFile {
    writer: PartWriter,
}

impl PartFile {
    /// Open the temp at `path`. `resume` keeps what an earlier run wrote;
    /// otherwise the file starts empty. With a known `size` the file is
    /// preallocated (after checking there is room for it). `hash` makes the
    /// writer compute a SHA-256 of the finished file.
    pub async fn open(path: &Path, size: Option<u64>, resume: bool, hash: bool) -> Result<Self> {
        let p = path.to_path_buf();
        let file = tokio::task::spawn_blocking(move || -> Result<File> {
            if let Some(dir) = p.parent() {
                std::fs::create_dir_all(dir).ok();
            }
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(!resume)
                .open(&p)
                .with_context(|| format!("create {}", p.display()))?;
            if let Some(size) = size.filter(|&s| s > 0) {
                let have = file.metadata().map(|m| m.len()).unwrap_or(0);
                if size > have {
                    ensure_space(&p, size - have)?;
                }
                mark_sparse(&file);
                if have != size {
                    file.set_len(size)
                        .with_context(|| format!("preallocate {}", p.display()))?;
                }
            }
            Ok(file)
        })
        .await
        .map_err(|e| anyhow!("open temp file task: {e}"))??;

        let (tx, rx) = mpsc::channel(CHANNEL_DEPTH);
        let err: ErrSlot = Arc::new(Mutex::new(None));
        tokio::spawn(run_writer(Arc::new(file), rx, err.clone(), hash));
        Ok(Self {
            writer: PartWriter { tx, err },
        })
    }

    pub fn writer(&self) -> PartWriter {
        self.writer.clone()
    }

    /// Write out everything queued so far and `sync_data` it. Bytes sent
    /// before this call are on disk once it returns — the resume record is
    /// written only after this (Plan 24 Phase 4).
    pub async fn sync(&self) -> Result<()> {
        self.writer.sync().await
    }

    /// Flush, `sync_all` and close the file. Every producer must be done.
    pub async fn finish(self) -> Result<Finished> {
        let (ack, rx) = oneshot::channel();
        self.writer
            .tx
            .send(Msg::Finish(ack))
            .await
            .map_err(|_| writer_error(&self.writer.err))?;
        rx.await
            .map_err(|_| writer_error(&self.writer.err))?
            .map_err(|e| anyhow!(e))
    }
}

/// Write `buf` at `offset` without moving a shared cursor.
fn write_all_at(file: &File, mut buf: &[u8], mut offset: u64) -> std::io::Result<()> {
    while !buf.is_empty() {
        #[cfg(windows)]
        let n = std::os::windows::fs::FileExt::seek_write(file, buf, offset)?;
        #[cfg(unix)]
        let n = std::os::unix::fs::FileExt::write_at(file, buf, offset)?;
        if n == 0 {
            return Err(std::io::ErrorKind::WriteZero.into());
        }
        buf = &buf[n..];
        offset += n as u64;
    }
    Ok(())
}

fn read_at(file: &File, buf: &mut [u8], offset: u64) -> std::io::Result<usize> {
    #[cfg(windows)]
    return std::os::windows::fs::FileExt::seek_read(file, buf, offset);
    #[cfg(unix)]
    return std::os::unix::fs::FileExt::read_at(file, buf, offset);
}

/// Running SHA-256 over the file's prefix that arrived in order. Segmented
/// downloads write out of order; whatever the in-order pass missed is read
/// back from disk at the end.
struct Hasher {
    sha: Sha256,
    upto: u64,
}

struct Writer {
    file: Arc<File>,
    pending: Option<(u64, BytesMut, Instant)>,
    hasher: Option<Hasher>,
}

impl Writer {
    async fn flush(&mut self) -> Result<(), String> {
        let Some((start, buf, _)) = self.pending.take() else {
            return Ok(());
        };
        let buf = buf.freeze();
        let file = self.file.clone();
        let data = buf.clone();
        tokio::task::spawn_blocking(move || write_all_at(&file, &data, start))
            .await
            .map_err(|e| format!("write task: {e}"))?
            .map_err(describe_io)?;
        if let Some(h) = self.hasher.as_mut() {
            if h.upto == start {
                h.sha.update(&buf);
                h.upto += buf.len() as u64;
            }
        }
        Ok(())
    }

    async fn push(&mut self, offset: u64, data: Bytes) -> Result<(), String> {
        if let Some((start, buf, _)) = self.pending.as_mut() {
            if *start + buf.len() as u64 == offset && buf.len() + data.len() <= COALESCE_MAX {
                buf.extend_from_slice(&data);
                if buf.len() >= COALESCE_MAX {
                    self.flush().await?;
                }
                return Ok(());
            }
            self.flush().await?;
        }
        self.pending = Some((offset, BytesMut::from(&data[..]), Instant::now()));
        if data.len() >= COALESCE_MAX {
            self.flush().await?;
        }
        Ok(())
    }

    async fn sync_data(&self) -> Result<(), String> {
        let file = self.file.clone();
        tokio::task::spawn_blocking(move || file.sync_data())
            .await
            .map_err(|e| format!("sync task: {e}"))?
            .map_err(describe_io)
    }

    async fn finish(mut self) -> Result<Finished, String> {
        self.flush().await?;
        let file = self.file.clone();
        let hasher = self.hasher.take();
        tokio::task::spawn_blocking(move || -> Result<Finished, String> {
            file.sync_all().map_err(describe_io)?;
            let len = file.metadata().map_err(describe_io)?.len();
            let sha256 = match hasher {
                None => None,
                Some(mut h) => {
                    // Hash whatever didn't arrive in order (segmented runs,
                    // or a prefix written by an earlier, resumed run).
                    let mut buf = vec![0u8; 1024 * 1024];
                    while h.upto < len {
                        let want = buf.len().min((len - h.upto) as usize);
                        let n = read_at(&file, &mut buf[..want], h.upto).map_err(describe_io)?;
                        if n == 0 {
                            break;
                        }
                        h.sha.update(&buf[..n]);
                        h.upto += n as u64;
                    }
                    Some(super::verify::hex(&h.sha.finalize()))
                }
            };
            Ok(Finished { len, sha256 })
        })
        .await
        .map_err(|e| format!("finish task: {e}"))?
    }
}

async fn run_writer(file: Arc<File>, mut rx: mpsc::Receiver<Msg>, err: ErrSlot, hash: bool) {
    let mut w = Writer {
        file,
        pending: None,
        hasher: hash.then(|| Hasher {
            sha: Sha256::new(),
            upto: 0,
        }),
    };
    let fail = |e: String| {
        if let Ok(mut slot) = err.lock() {
            slot.get_or_insert(e);
        }
    };
    loop {
        let msg = match w.pending.as_ref().map(|p| p.2 + COALESCE_AGE) {
            Some(deadline) => tokio::select! {
                m = rx.recv() => m,
                _ = tokio::time::sleep_until(deadline) => {
                    if let Err(e) = w.flush().await {
                        fail(e);
                        return;
                    }
                    continue;
                }
            },
            None => rx.recv().await,
        };
        match msg {
            // Every handle dropped (pause, error, cancel): keep what arrived.
            None => {
                if let Err(e) = w.flush().await {
                    fail(e);
                }
                return;
            }
            Some(Msg::Write(off, data)) => {
                if let Err(e) = w.push(off, data).await {
                    fail(e);
                    return;
                }
            }
            Some(Msg::Sync(ack)) => {
                let res = match w.flush().await {
                    Ok(()) => w.sync_data().await,
                    Err(e) => Err(e),
                };
                let failed = res.as_ref().err().cloned();
                let _ = ack.send(res);
                if let Some(e) = failed {
                    fail(e);
                    return;
                }
            }
            Some(Msg::Finish(ack)) => {
                let res = w.finish().await;
                if let Err(e) = &res {
                    fail(e.clone());
                }
                let _ = ack.send(res);
                return;
            }
        }
    }
}

fn describe_io(e: std::io::Error) -> String {
    if super::retry::is_no_space(&e) {
        format!("not enough disk space: {e}")
    } else {
        e.to_string()
    }
}

/// Fail fast with a clear message when the volume can't hold `need` more
/// bytes. Best-effort: an unknown free-space figure lets the copy try.
fn ensure_space(path: &Path, need: u64) -> Result<()> {
    let dir = path.parent().unwrap_or(Path::new("."));
    if let Some(free) = free_space(dir) {
        if free < need {
            anyhow::bail!(
                "not enough disk space in {}: need {} more bytes, {} free (ENOSPC)",
                dir.display(),
                need,
                free
            );
        }
    }
    Ok(())
}

#[cfg(windows)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let wide: Vec<u16> = dir.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut avail = 0u64;
    // SAFETY: `wide` is a NUL-terminated path; the out pointers are valid.
    let ok = unsafe {
        GetDiskFreeSpaceExW(wide.as_ptr(), &mut avail, std::ptr::null_mut(), std::ptr::null_mut())
    };
    (ok != 0).then_some(avail)
}

#[cfg(unix)]
fn free_space(dir: &Path) -> Option<u64> {
    use std::os::unix::ffi::OsStrExt;
    let c = std::ffi::CString::new(dir.as_os_str().as_bytes()).ok()?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `c` is NUL-terminated and `st` is a valid out pointer.
    if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
        return None;
    }
    Some(st.f_bavail as u64 * st.f_frsize as u64)
}

/// NTFS zero-fills everything between the valid-data length and a write's
/// offset, so a segmented download that writes the back half first would
/// stall on gigabytes of zeros. A sparse file skips that. Elsewhere
/// `set_len` already makes a sparse file. Best-effort.
#[cfg(windows)]
fn mark_sparse(file: &File) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Ioctl::FSCTL_SET_SPARSE;
    use windows_sys::Win32::System::IO::DeviceIoControl;
    let mut returned = 0u32;
    // SAFETY: the handle is open for writing; no in/out buffers are passed.
    unsafe {
        DeviceIoControl(
            file.as_raw_handle() as _,
            FSCTL_SET_SPARSE,
            std::ptr::null(),
            0,
            std::ptr::null_mut(),
            0,
            &mut returned,
            std::ptr::null_mut(),
        );
    }
}

#[cfg(unix)]
fn mark_sparse(_file: &File) {}

/// Where a finished temp ended up.
#[derive(Debug, PartialEq)]
pub enum Placed {
    /// Renamed to this path (the target, or a free `_N` name under Rename).
    At(PathBuf),
    /// Skip policy and the target exists: the temp was discarded.
    Skipped,
}

/// Move a finished temp into place. The overwrite policy is applied here,
/// at rename time, so an existing file is only ever replaced by a complete
/// one. The rename is atomic (`MoveFileEx` with replace on Windows) and is
/// retried briefly because antivirus scanners often hold a fresh file open
/// for a moment. `mtime` (the remote file's) is copied when known.
pub async fn place(
    part: &Path,
    target: &Path,
    policy: super::OverwritePolicy,
    mtime: Option<SystemTime>,
) -> Result<Placed> {
    use super::OverwritePolicy;
    let dest = match policy {
        OverwritePolicy::Overwrite => target.to_path_buf(),
        OverwritePolicy::Skip if target.exists() => {
            let _ = tokio::fs::remove_file(part).await;
            return Ok(Placed::Skipped);
        }
        OverwritePolicy::Skip => target.to_path_buf(),
        OverwritePolicy::Rename => super::resolve_local_rename(target),
    };
    let mut delay = Duration::from_millis(50);
    for attempt in 0.. {
        match tokio::fs::rename(part, &dest).await {
            Ok(()) => break,
            Err(e) if attempt < 6 && e.kind() == std::io::ErrorKind::PermissionDenied => {
                tokio::time::sleep(delay).await;
                delay *= 2;
            }
            Err(e) => {
                return Err(e).with_context(|| {
                    format!("move {} into place as {}", part.display(), dest.display())
                })
            }
        }
    }
    if let Some(mtime) = mtime {
        let d = dest.clone();
        let _ = tokio::task::spawn_blocking(move || {
            std::fs::OpenOptions::new()
                .write(true)
                .open(&d)
                .and_then(|f| f.set_modified(mtime))
        })
        .await;
    }
    Ok(Placed::At(dest))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transfer::OverwritePolicy;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "faro-partfile-{tag}-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn pattern(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i * 7 % 251) as u8).collect()
    }

    #[test]
    fn part_names() {
        assert_eq!(
            part_path_for(Path::new("/dl/a.tar.gz")),
            PathBuf::from("/dl/a.tar.gz.faro-part")
        );
        assert!(is_part_file("a.tar.gz.faro-part"));
        assert!(!is_part_file("a.tar.gz"));
    }

    /// Out-of-order, chunked, coalescible writes all land at their offsets,
    /// and the hash covers the whole file even though it arrived out of order.
    #[tokio::test]
    async fn out_of_order_writes_and_finish() {
        let dir = scratch("ooo");
        let path = dir.join("f.bin.faro-part");
        let data = pattern(10 * 1024 * 1024 + 123);
        let part = PartFile::open(&path, Some(data.len() as u64), false, true)
            .await
            .unwrap();
        let w = part.writer();
        // Back half first in 64 KiB pieces, then the front half.
        let mid = data.len() / 2;
        let mut chunks: Vec<(usize, usize)> = Vec::new();
        for start in (mid..data.len()).step_by(65536) {
            chunks.push((start, (start + 65536).min(data.len())));
        }
        for start in (0..mid).step_by(65536) {
            chunks.push((start, (start + 65536).min(mid)));
        }
        for (a, b) in chunks {
            w.write(a as u64, Bytes::copy_from_slice(&data[a..b])).await.unwrap();
        }
        drop(w);
        part.sync().await.unwrap();
        let done = part.finish().await.unwrap();
        assert_eq!(done.len, data.len() as u64);
        assert_eq!(std::fs::read(&path).unwrap(), data);
        assert_eq!(done.sha256.unwrap(), super::super::verify::hex(&Sha256::digest(&data)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A resumed temp keeps the bytes an earlier run wrote.
    #[tokio::test]
    async fn resume_keeps_existing_bytes() {
        let dir = scratch("resume");
        let path = dir.join("f.bin.faro-part");
        let data = pattern(300_000);
        let part = PartFile::open(&path, Some(data.len() as u64), false, false).await.unwrap();
        part.writer().write(0, Bytes::copy_from_slice(&data[..100_000])).await.unwrap();
        part.sync().await.unwrap();
        drop(part);
        let part = PartFile::open(&path, Some(data.len() as u64), true, true).await.unwrap();
        part.writer()
            .write(100_000, Bytes::copy_from_slice(&data[100_000..]))
            .await
            .unwrap();
        let done = part.finish().await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), data);
        assert_eq!(done.sha256.unwrap(), super::super::verify::hex(&Sha256::digest(&data)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Overwrite only replaces the original once the new file is finished;
    /// a run that never finishes leaves it untouched.
    #[tokio::test]
    async fn original_survives_until_place() {
        let dir = scratch("place");
        let target = dir.join("f.txt");
        std::fs::write(&target, b"original").unwrap();
        let part_path = part_path_for(&target);
        let part = PartFile::open(&part_path, Some(5), false, false).await.unwrap();
        part.writer().write(0, Bytes::from_static(b"new!!")).await.unwrap();
        // "Failure": drop without finishing. The target is still the original.
        drop(part);
        assert_eq!(std::fs::read(&target).unwrap(), b"original");

        let part = PartFile::open(&part_path, Some(5), true, false).await.unwrap();
        part.finish().await.unwrap();
        let placed = place(&part_path, &target, OverwritePolicy::Overwrite, None).await.unwrap();
        assert_eq!(placed, Placed::At(target.clone()));
        assert_eq!(std::fs::read(&target).unwrap(), b"new!!");
        assert!(!part_path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn place_skip_and_rename() {
        let dir = scratch("policy");
        let target = dir.join("f.txt");
        std::fs::write(&target, b"original").unwrap();
        let part_path = part_path_for(&target);

        std::fs::write(&part_path, b"new").unwrap();
        assert_eq!(
            place(&part_path, &target, OverwritePolicy::Skip, None).await.unwrap(),
            Placed::Skipped
        );
        assert!(!part_path.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");

        std::fs::write(&part_path, b"new").unwrap();
        let mtime = SystemTime::UNIX_EPOCH + Duration::from_secs(1_600_000_000);
        let placed = place(&part_path, &target, OverwritePolicy::Rename, Some(mtime))
            .await
            .unwrap();
        let renamed = dir.join("f_1.txt");
        assert_eq!(placed, Placed::At(renamed.clone()));
        assert_eq!(std::fs::read(&renamed).unwrap(), b"new");
        assert_eq!(std::fs::metadata(&renamed).unwrap().modified().unwrap(), mtime);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn refuses_impossible_preallocation() {
        let dir = scratch("space");
        let err = ensure_space(&dir.join("x"), u64::MAX / 2).unwrap_err();
        assert!(format!("{err}").contains("not enough disk space"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
