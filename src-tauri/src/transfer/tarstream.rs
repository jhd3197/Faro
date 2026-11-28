//! Folder transfers as one tar stream over SSH (Plan 37 Phase 4).
//!
//! A folder of thousands of small files pays an SFTP open / write / close
//! round trip per file. Over an SSH exec channel the same bytes travel as a
//! single stream: `tar -x` on the host for an upload, `tar -c` for a download.
//! The archive is built and unpacked here in Rust, so nothing touches the
//! local disk but the files themselves.
//!
//! The stream is one row in the transfer queue. It honours the bandwidth
//! limit, pause and cancel through the same checkpoint every copy loop uses;
//! a paused stream starts over when it resumes. When a stream fails for good
//! the folder is handed to the per-file path, which finishes the job.

use super::manifest;
use super::{TransferManager, TransferStatus};
use crate::scp::quote_path;
use crate::session::SshSession;
use anyhow::{anyhow, bail, Context, Result};
use russh::ChannelMsg;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, UNIX_EPOCH};
use tokio::sync::mpsc;

/// A folder is streamed when it has at least this many files…
pub const MIN_FILES: usize = 50;
/// …and they average no more than this. Big files gain nothing from tar and
/// lose resume, which the per-file path has.
pub const MAX_AVERAGE_BYTES: u64 = 1024 * 1024;

pub fn worth_streaming(files: usize, bytes: u64) -> bool {
    files >= MIN_FILES && bytes / files as u64 <= MAX_AVERAGE_BYTES
}

/// What the host's `tar` can do.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TarSupport {
    /// `--skip-old-files`: leave existing files alone without failing. Without
    /// it, a "skip existing" upload uses the per-file path.
    pub skip_old: bool,
}

const PROBE: &str = "command -v tar >/dev/null 2>&1 || exit 3; \
    if tar --help 2>&1 | grep -q -- '--skip-old-files'; then echo skip; else echo basic; fi";

/// `None` when the host has no usable `tar` (or isn't a POSIX shell at all).
pub async fn probe(ssh: &Arc<SshSession>) -> Option<TarSupport> {
    let out = ssh
        .exec_bounded(PROBE, 256, Duration::from_secs(15), None)
        .await
        .ok()?;
    if out.exit_code != Some(0) {
        return None;
    }
    match out.stdout.trim() {
        "skip" => Some(TarSupport { skip_old: true }),
        "basic" => Some(TarSupport { skip_old: false }),
        _ => None,
    }
}

/// Unpack a stream into `dest` (created if missing). `-o`: files belong to
/// whoever runs tar, not to the ids in the archive.
pub fn extract_command(dest: &str, skip_existing: bool) -> String {
    let dest = quote_path(dest);
    let skip = if skip_existing { " --skip-old-files" } else { "" };
    format!("mkdir -p {dest} && tar -xof - -C {dest}{skip}")
}

/// Stream `src`'s contents (not the folder itself) to stdout.
pub fn create_command(src: &str) -> String {
    format!("tar -cf - -C {} .", quote_path(src))
}

/// File count and size (KiB, from `du`) of a remote folder, in one exec.
pub fn inventory_command(dir: &str) -> String {
    format!(
        "cd {} && find . -type f | wc -l && du -sk . | cut -f1",
        quote_path(dir)
    )
}

/// `(files, bytes)` from [`inventory_command`]'s two lines.
pub fn parse_inventory(stdout: &str) -> Option<(usize, u64)> {
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    let files: usize = lines.next()?.parse().ok()?;
    let kib: u64 = lines.next()?.parse().ok()?;
    Some((files, kib.saturating_mul(1024)))
}

pub async fn remote_inventory(ssh: &Arc<SshSession>, dir: &str) -> Option<(usize, u64)> {
    let out = ssh
        .exec_bounded(&inventory_command(dir), 256, Duration::from_secs(60), None)
        .await
        .ok()?;
    (out.exit_code == Some(0))
        .then(|| parse_inventory(&out.stdout))
        .flatten()
}

/// An archive entry's path as a safe relative path, or `None` when it must
/// not be written: absolute, climbing out with `..`, or with a component a
/// local file can't be called. `.` (the folder itself) is `Some("")`.
pub fn safe_entry_path(path: &Path) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            Component::Normal(name) => {
                let name = name.to_str()?;
                if !super::is_plain_local_name(name) {
                    return None;
                }
                out.push(name);
            }
            // RootDir, Prefix, ParentDir.
            _ => return None,
        }
    }
    Some(out)
}

/// Sends what is written to it over a channel, in chunks. The receiving end
/// applies backpressure: `blocking_send` waits while the network is slower
/// than the disk.
struct ChannelWriter {
    tx: mpsc::Sender<Vec<u8>>,
    buf: Vec<u8>,
}

const CHUNK: usize = 256 * 1024;

impl ChannelWriter {
    fn new(tx: mpsc::Sender<Vec<u8>>) -> Self {
        Self {
            tx,
            buf: Vec::with_capacity(CHUNK),
        }
    }
    fn send(&mut self) -> std::io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let chunk = std::mem::replace(&mut self.buf, Vec::with_capacity(CHUNK));
        self.tx
            .blocking_send(chunk)
            .map_err(|_| std::io::Error::new(std::io::ErrorKind::BrokenPipe, "transfer stopped"))
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= CHUNK {
            self.send()?;
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.send()
    }
}

/// The other direction: reads what arrives on a channel.
struct ChannelReader {
    rx: mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}

impl Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        while self.pos >= self.buf.len() {
            match self.rx.blocking_recv() {
                Some(chunk) => {
                    self.buf = chunk;
                    self.pos = 0;
                }
                None => return Ok(0),
            }
        }
        let n = out.len().min(self.buf.len() - self.pos);
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

/// Counts the file bytes read through it, so the row's progress is in file
/// bytes (which is what its size is), not archive bytes.
struct Counted<R, F: Fn(u64)> {
    inner: R,
    count: F,
}

impl<R: Read, F: Fn(u64)> Read for Counted<R, F> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        (self.count)(n as u64);
        Ok(n)
    }
}

fn mtime_secs(meta: &std::fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(unix)]
fn file_mode(meta: &std::fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode() & 0o777
}
#[cfg(not(unix))]
fn file_mode(_meta: &std::fs::Metadata) -> u32 {
    0o644
}

/// Archive `root`'s directories and files (paths relative to `root`) into
/// `out`. `on_bytes` is told how many file bytes went in.
pub fn write_archive(
    root: &Path,
    directories: &[PathBuf],
    files: &[PathBuf],
    out: impl Write,
    on_bytes: impl Fn(u64),
) -> Result<()> {
    let mut builder = tar::Builder::new(out);
    let rel = |path: &Path| -> Result<String> {
        Ok(path
            .strip_prefix(root)
            .with_context(|| format!("{} is outside {}", path.display(), root.display()))?
            .to_string_lossy()
            .replace('\\', "/"))
    };
    for dir in directories {
        let name = rel(dir)?;
        if name.is_empty() {
            continue; // the root itself: `tar -C dest` already is it
        }
        let meta = std::fs::metadata(dir).with_context(|| format!("stat {}", dir.display()))?;
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Directory);
        header.set_size(0);
        header.set_mode(0o755);
        header.set_mtime(mtime_secs(&meta));
        builder
            .append_data(&mut header, format!("{name}/"), std::io::empty())
            .with_context(|| format!("archive {name}/"))?;
    }
    for file in files {
        let name = rel(file)?;
        let handle = std::fs::File::open(file).with_context(|| format!("open {}", file.display()))?;
        let meta = handle.metadata().with_context(|| format!("stat {}", file.display()))?;
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(meta.len());
        header.set_mode(file_mode(&meta));
        header.set_mtime(mtime_secs(&meta));
        // Exactly `size` bytes, even if the file grew since it was measured.
        let body = Counted {
            inner: handle.take(meta.len()),
            count: &on_bytes,
        };
        builder
            .append_data(&mut header, &name, body)
            .with_context(|| format!("archive {name}"))?;
    }
    builder.into_inner().context("finish the archive")?.flush()?;
    Ok(())
}

/// What unpacking produced.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Unpacked {
    pub files: usize,
    pub bytes: u64,
    /// Existing files left alone (skip policy).
    pub kept: usize,
    /// Entries not written: links, devices, unsafe paths.
    pub ignored: usize,
}

/// Unpack an archive stream under `root`. Files are written to a part file
/// and renamed into place, so an interrupted stream never leaves a truncated
/// file under a real name. Links and special files are not created.
pub fn read_archive(
    input: impl Read,
    root: &Path,
    skip_existing: bool,
    on_bytes: impl Fn(u64),
) -> Result<Unpacked> {
    let mut done = Unpacked::default();
    let mut archive = tar::Archive::new(input);
    for entry in archive.entries().context("read the archive")? {
        let mut entry = entry.context("read an archive entry")?;
        let raw = entry.path().context("read an entry's path")?.into_owned();
        let Some(rel) = safe_entry_path(&raw) else {
            done.ignored += 1;
            continue;
        };
        let dest = root.join(&rel);
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            std::fs::create_dir_all(&dest).with_context(|| format!("mkdir {}", dest.display()))?;
            continue;
        }
        if !kind.is_file() || rel.as_os_str().is_empty() {
            done.ignored += 1;
            continue;
        }
        if skip_existing && dest.exists() {
            done.kept += 1;
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).with_context(|| format!("mkdir {}", parent.display()))?;
        }
        let mut part = dest.clone().into_os_string();
        part.push(".faro-part");
        let part = PathBuf::from(part);
        let mtime = entry.header().mtime().ok();
        let written = {
            let mut file = std::fs::File::create(&part)
                .with_context(|| format!("create {}", part.display()))?;
            let mut body = Counted {
                inner: &mut entry,
                count: &on_bytes,
            };
            let n = std::io::copy(&mut body, &mut file)
                .with_context(|| format!("write {}", dest.display()))?;
            if let Some(secs) = mtime {
                let _ = file.set_modified(UNIX_EPOCH + Duration::from_secs(secs));
            }
            n
        };
        if let Err(e) = std::fs::rename(&part, &dest) {
            let _ = std::fs::remove_file(&part);
            return Err(anyhow!(e).context(format!("move {} into place", dest.display())));
        }
        done.files += 1;
        done.bytes += written;
    }
    Ok(done)
}

/// Does tar's stderr say files were missed, as opposed to a warning?
fn stderr_is_fatal(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    ["cannot open", "permission denied", "no such file", "not found", "cannot stat"]
        .iter()
        .any(|needle| s.contains(needle))
}

fn tail(stderr: &str) -> String {
    let lines: Vec<&str> = stderr.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(3)..].join("; ")
}

/// Upload `local_root` as `remote_root` in one stream. Returns the file bytes
/// sent.
pub async fn upload(
    mgr: &Arc<TransferManager>,
    id: &str,
    ssh: &Arc<SshSession>,
    local_root: &Path,
    remote_root: &str,
    skip_existing: bool,
) -> Result<u64> {
    mgr.update(id, |t| t.status = TransferStatus::Transferring).await;
    mgr.checkpoint(id, 0).await?;

    let inventory = manifest::inventory(local_root).await?;
    let total = inventory.bytes;
    let file_count = inventory.files.len() as u32;
    mgr.update(id, |t| {
        t.size = total;
        t.files = Some(file_count);
    })
    .await;

    let mut channel = {
        let h = ssh.handle.lock().await;
        h.channel_open_session().await.context("open a channel")?
    };
    channel
        .exec(true, extract_command(remote_root, skip_existing).as_bytes())
        .await
        .context("start tar on the server")?;

    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(8);
    let live = mgr.live(id);
    let root = local_root.to_path_buf();
    let packer = tokio::task::spawn_blocking(move || {
        write_archive(
            &root,
            &inventory.directories,
            &inventory.files,
            ChannelWriter::new(tx),
            |n| live.add(n),
        )
    });

    let mut stderr = String::new();
    let mut exit: Option<u32> = None;
    let mut sending = true;
    loop {
        tokio::select! {
            chunk = rx.recv(), if sending => match chunk {
                Some(bytes) => {
                    mgr.checkpoint(id, bytes.len() as u64).await?;
                    channel.data(&bytes[..]).await.context("send to the server")?;
                }
                None => {
                    sending = false;
                    channel.eof().await.context("finish the stream")?;
                }
            },
            msg = channel.wait() => match msg {
                Some(ChannelMsg::ExtendedData { ref data, .. }) | Some(ChannelMsg::Data { ref data }) => {
                    if stderr.len() < 16 * 1024 {
                        stderr.push_str(&String::from_utf8_lossy(data));
                    }
                }
                Some(ChannelMsg::ExitStatus { exit_status }) => exit = Some(exit_status),
                Some(ChannelMsg::Close) | None => break,
                Some(_) => {}
            },
        }
    }
    drop(rx);
    packer.await.context("archive task")??;
    match exit {
        Some(0) => {}
        Some(code) => bail!("tar on the server failed (exit {code}): {}", tail(&stderr)),
        None => bail!("the connection closed before the server finished unpacking"),
    }
    Ok(total)
}

/// Download `remote_root`'s contents into `local_root` in one stream. Returns
/// the file bytes written.
pub async fn download(
    mgr: &Arc<TransferManager>,
    id: &str,
    ssh: &Arc<SshSession>,
    remote_root: &str,
    local_root: &Path,
    skip_existing: bool,
) -> Result<u64> {
    mgr.update(id, |t| t.status = TransferStatus::Transferring).await;
    mgr.checkpoint(id, 0).await?;
    tokio::fs::create_dir_all(local_root)
        .await
        .with_context(|| format!("mkdir -p {}", local_root.display()))?;

    let mut channel = {
        let h = ssh.handle.lock().await;
        h.channel_open_session().await.context("open a channel")?
    };
    channel
        .exec(true, create_command(remote_root).as_bytes())
        .await
        .context("start tar on the server")?;

    let (tx, rx) = mpsc::channel::<Vec<u8>>(8);
    let live = mgr.live(id);
    let root = local_root.to_path_buf();
    let unpacker = tokio::task::spawn_blocking(move || {
        read_archive(
            ChannelReader {
                rx,
                buf: Vec::new(),
                pos: 0,
            },
            &root,
            skip_existing,
            |n| live.add(n),
        )
    });

    let mut tx = Some(tx);
    let mut stderr = String::new();
    let mut exit: Option<u32> = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => {
                mgr.checkpoint(id, data.len() as u64).await?;
                let Some(sender) = tx.as_ref() else { continue };
                if sender.send(data.to_vec()).await.is_err() {
                    // The unpacker stopped: its error is the one to report.
                    tx = None;
                }
            }
            ChannelMsg::ExtendedData { ref data, .. } => {
                if stderr.len() < 16 * 1024 {
                    stderr.push_str(&String::from_utf8_lossy(data));
                }
            }
            ChannelMsg::ExitStatus { exit_status } => exit = Some(exit_status),
            ChannelMsg::Eof => tx = None,
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    drop(tx);
    let unpacked = unpacker.await.context("unpack task")??;
    match exit {
        Some(0) => {}
        // GNU tar exits 1 for "file changed as we read it": what arrived is
        // complete. Anything that names a file it couldn't read is a failure.
        Some(1) if !stderr_is_fatal(&stderr) => {}
        Some(code) => bail!("tar on the server failed (exit {code}): {}", tail(&stderr)),
        None => bail!("the connection closed before the folder finished downloading"),
    }
    let count = unpacked.files as u32;
    let note = match (unpacked.kept, unpacked.ignored) {
        (0, 0) => None,
        (kept, 0) => Some(format!("{kept} existing files kept")),
        (0, ignored) => Some(format!("{ignored} links or special files not copied")),
        (kept, ignored) => Some(format!(
            "{kept} existing files kept, {ignored} links or special files not copied"
        )),
    };
    mgr.update(id, |t| {
        t.size = unpacked.bytes;
        t.files = Some(count);
        if let Some(note) = note {
            t.notice = Some(note);
        }
    })
    .await;
    Ok(unpacked.bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("faro-tar-{tag}-{:08x}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn only_folders_of_many_small_files_are_streamed() {
        assert!(worth_streaming(50, 50 * 1024));
        assert!(worth_streaming(5000, 5000 * 200 * 1024));
        assert!(!worth_streaming(49, 49), "too few files");
        assert!(!worth_streaming(60, 60 * 2 * 1024 * 1024), "files too large on average");
        assert!(!worth_streaming(0, 0));
    }

    #[test]
    fn commands_quote_paths_and_inventory_parses() {
        assert_eq!(
            extract_command("/srv/my site", false),
            "mkdir -p '/srv/my site' && tar -xof - -C '/srv/my site'"
        );
        assert!(extract_command("/srv/a", true).ends_with(" --skip-old-files"));
        assert_eq!(create_command("/srv/it's"), r"tar -cf - -C '/srv/it'\''s' .");
        assert_eq!(parse_inventory("  2431\n18244\n"), Some((2431, 18244 * 1024)));
        assert_eq!(parse_inventory("0\n4\n"), Some((0, 4096)));
        assert_eq!(parse_inventory("oops\n"), None);
        assert_eq!(parse_inventory(""), None);
    }

    #[test]
    fn unsafe_entry_paths_are_refused() {
        assert_eq!(safe_entry_path(Path::new("./a/b.txt")), Some(PathBuf::from("a").join("b.txt")));
        assert_eq!(safe_entry_path(Path::new(".")), Some(PathBuf::new()));
        assert_eq!(safe_entry_path(Path::new("../evil")), None);
        assert_eq!(safe_entry_path(Path::new("a/../../evil")), None);
        assert_eq!(safe_entry_path(Path::new("/etc/passwd")), None);
        #[cfg(windows)]
        assert_eq!(safe_entry_path(Path::new(r"C:\Windows\x")), None);
    }

    /// A folder with nesting, an empty directory, awkward names and a binary
    /// file comes out the other end byte for byte.
    #[test]
    fn a_folder_round_trips_through_an_archive() {
        let src = temp_dir("src");
        std::fs::create_dir_all(src.join("assets/deep/er")).unwrap();
        std::fs::create_dir_all(src.join("empty dir")).unwrap();
        std::fs::write(src.join("index.html"), "<h1>hi</h1>").unwrap();
        std::fs::write(src.join("assets/app é.js"), "console.log(1)").unwrap();
        std::fs::write(src.join("assets/deep/er/data.bin"), (0..=255u8).cycle().take(70_000).collect::<Vec<_>>()).unwrap();
        std::fs::write(src.join("assets/empty"), "").unwrap();

        let rt = tokio::runtime::Runtime::new().unwrap();
        let inv = rt.block_on(manifest::inventory(&src)).unwrap();
        let mut archive = Vec::new();
        let sent = std::sync::atomic::AtomicU64::new(0);
        write_archive(&src, &inv.directories, &inv.files, &mut archive, |n| {
            sent.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
        })
        .unwrap();
        assert_eq!(sent.into_inner(), inv.bytes, "progress counts file bytes");

        let dest = temp_dir("dest");
        let got = std::sync::atomic::AtomicU64::new(0);
        let out = read_archive(&archive[..], &dest, false, |n| {
            got.fetch_add(n, std::sync::atomic::Ordering::Relaxed);
        })
        .unwrap();
        assert_eq!(out.files, 4);
        assert_eq!(out.bytes, inv.bytes);
        assert_eq!(got.into_inner(), inv.bytes);
        assert_eq!(std::fs::read_to_string(dest.join("index.html")).unwrap(), "<h1>hi</h1>");
        assert_eq!(std::fs::read_to_string(dest.join("assets/app é.js")).unwrap(), "console.log(1)");
        assert_eq!(
            std::fs::read(dest.join("assets/deep/er/data.bin")).unwrap(),
            std::fs::read(src.join("assets/deep/er/data.bin")).unwrap()
        );
        assert!(dest.join("empty dir").is_dir(), "empty directories are kept");
        assert_eq!(std::fs::metadata(dest.join("assets/empty")).unwrap().len(), 0);
        let leftovers: Vec<_> = walk(&dest).into_iter().filter(|p| p.to_string_lossy().ends_with(".faro-part")).collect();
        assert!(leftovers.is_empty(), "no part files remain: {leftovers:?}");
        let _ = std::fs::remove_dir_all(&src);
        let _ = std::fs::remove_dir_all(&dest);
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p);
            }
        }
        out
    }

    #[test]
    fn skip_keeps_existing_files_and_hostile_entries_are_not_written() {
        // An archive with a normal file, a path that climbs out, a symlink
        // and a file that already exists at the destination.
        let mut archive = Vec::new();
        {
            let mut b = tar::Builder::new(&mut archive);
            let mut add = |name: &str, body: &[u8]| {
                let mut h = tar::Header::new_gnu();
                h.set_entry_type(tar::EntryType::Regular);
                h.set_size(body.len() as u64);
                h.set_mode(0o644);
                // `set_path` refuses `..`; write the raw name the way a
                // hostile archive would.
                h.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
                h.set_cksum();
                b.append(&h, body).unwrap();
            };
            add("./ok.txt", b"fresh");
            add("../escaped.txt", b"evil");
            add("./kept.txt", b"from the server");
            let mut link = tar::Header::new_gnu();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_size(0);
            link.set_path("./link").unwrap();
            link.set_link_name("/etc/passwd").unwrap();
            link.set_cksum();
            b.append(&link, std::io::empty()).unwrap();
            b.finish().unwrap();
        }
        let dest = temp_dir("skip");
        std::fs::write(dest.join("kept.txt"), "mine").unwrap();

        let out = read_archive(&archive[..], &dest, true, |_| {}).unwrap();
        assert_eq!(out.files, 1);
        assert_eq!(out.kept, 1);
        assert_eq!(out.ignored, 2, "the escaping path and the link");
        assert_eq!(std::fs::read_to_string(dest.join("ok.txt")).unwrap(), "fresh");
        assert_eq!(std::fs::read_to_string(dest.join("kept.txt")).unwrap(), "mine");
        assert!(!dest.join("link").exists());
        assert!(!dest.parent().unwrap().join("escaped.txt").exists(), "nothing written outside");

        // Without skip, the existing file is replaced.
        let out = read_archive(&archive[..], &dest, false, |_| {}).unwrap();
        assert_eq!(out.files, 2);
        assert_eq!(std::fs::read_to_string(dest.join("kept.txt")).unwrap(), "from the server");
        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn tar_warnings_are_told_from_failures() {
        assert!(!stderr_is_fatal("tar: ./log: file changed as we read it\n"));
        assert!(stderr_is_fatal("tar: ./secret: Cannot open: Permission denied\n"));
        assert!(stderr_is_fatal("tar: /nope: Cannot stat: No such file or directory"));
        assert_eq!(tail("a\n\nb\nc\nd\n"), "b; c; d");
    }
}
