//! Local crash log. Everything `tracing` prints also goes to
//! `<app data>/logs/faro.log`; the two previous sessions are kept as
//! `faro.1.log` and `faro.2.log`. A panic is written there with its location
//! and a backtrace before the default hook runs, and the frontend reports its
//! uncaught errors through [`app_log_write`].
//!
//! Nothing is uploaded. The file is what a bug report can attach: Settings ›
//! About › Feedback and Help › Show log file open its folder. Like
//! `diagnostics.rs`, we never log secrets on purpose, but backend errors can
//! name hosts and paths, so the user decides what to share.

use std::backtrace::Backtrace;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use tracing_subscriber::fmt::MakeWriter;

/// Sessions kept: the current one plus `KEEP - 1` older files.
const KEEP: usize = 3;
/// A runaway loop shouldn't fill the disk: past this, the session stops writing.
const MAX_BYTES: u64 = 20 * 1024 * 1024;

struct Sink {
    file: File,
    written: u64,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);
static PATH: OnceLock<PathBuf> = OnceLock::new();

/// The current session's log file, once [`open`] has run.
pub fn path() -> Option<&'static Path> {
    PATH.get().map(PathBuf::as_path)
}

fn rotated(dir: &Path, n: usize) -> PathBuf {
    if n == 0 {
        dir.join("faro.log")
    } else {
        dir.join(format!("faro.{n}.log"))
    }
}

/// chrono is built without its clock feature; go through SystemTime.
fn now_utc() -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::<chrono::Utc>::from(std::time::SystemTime::now())
}

/// Rotate the previous sessions and start a new `faro.log` in `<data_dir>/logs`.
pub fn open(data_dir: &Path) -> io::Result<PathBuf> {
    let dir = data_dir.join("logs");
    fs::create_dir_all(&dir)?;
    for n in (0..KEEP - 1).rev() {
        let from = rotated(&dir, n);
        if from.exists() {
            let _ = fs::rename(&from, rotated(&dir, n + 1));
        }
    }
    let path = rotated(&dir, 0);
    let mut file = OpenOptions::new().create(true).write(true).truncate(true).open(&path)?;
    let header = format!(
        "Faro {} on {} {} — session started {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        now_utc().format("%Y-%m-%d %H:%M:%S UTC"),
    );
    file.write_all(header.as_bytes())?;
    *SINK.lock().unwrap_or_else(|p| p.into_inner()) = Some(Sink { file, written: header.len() as u64 });
    let _ = PATH.set(path.clone());
    Ok(path)
}

/// Append raw text to the log (no-op before [`open`] or past the size cap).
fn append(bytes: &[u8]) {
    let mut guard = SINK.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(sink) = guard.as_mut() {
        if sink.written >= MAX_BYTES {
            return;
        }
        if sink.file.write_all(bytes).is_ok() {
            sink.written += bytes.len() as u64;
            if sink.written >= MAX_BYTES {
                let _ = sink.file.write_all(b"\n[log size limit reached; later lines are not saved]\n");
            }
            let _ = sink.file.flush();
        }
    }
}

/// `tracing` writer for the file layer.
#[derive(Clone, Copy, Default)]
pub struct FileWriter;

impl Write for FileWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        append(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for FileWriter {
    type Writer = FileWriter;
    fn make_writer(&'a self) -> Self::Writer {
        FileWriter
    }
}

/// Write every panic (message, thread, location, backtrace) to the log, then
/// run the previous hook so the console still shows it.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed");
        let backtrace = Backtrace::force_capture();
        let text = format!(
            "\n=== PANIC {} on thread '{name}' ===\n{info}\n\nBacktrace:\n{backtrace}\n=== end of panic ===\n\n",
            now_utc().format("%Y-%m-%d %H:%M:%S UTC"),
        );
        append(text.as_bytes());
        previous(info);
    }));
}

/// The log file's path, for "Show log file".
#[tauri::command]
pub fn app_log_path() -> Option<String> {
    path().map(|p| p.to_string_lossy().into_owned())
}

/// Uncaught frontend errors (window.onerror, unhandled rejections, the error
/// boundary) land in the same file.
#[tauri::command]
pub fn app_log_write(level: String, message: String) {
    // Keep one entry readable even if the UI sends something huge.
    let message: String = message.chars().take(8_000).collect();
    match level.as_str() {
        "error" => tracing::error!(target: "frontend", "{message}"),
        "warn" => tracing::warn!(target: "frontend", "{message}"),
        _ => tracing::info!(target: "frontend", "{message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_sessions_and_records_panics() {
        let dir = std::env::temp_dir().join(format!("faro-applog-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        for session in 0..4 {
            open(&dir).unwrap();
            append(format!("session {session}\n").as_bytes());
        }
        let logs = dir.join("logs");
        let read = |n| fs::read_to_string(rotated(&logs, n)).unwrap();
        assert!(read(0).contains("session 3"));
        assert!(read(1).contains("session 2"));
        assert!(read(2).contains("session 1"));
        assert!(!rotated(&logs, 3).exists());

        // A panic on another thread is written with its message and location.
        install_panic_hook();
        let _ = std::thread::Builder::new()
            .name("crash-test".into())
            .spawn(|| panic!("applog test panic"))
            .unwrap()
            .join();
        let current = read(0);
        assert!(current.contains("=== PANIC"), "{current}");
        assert!(current.contains("thread 'crash-test'"));
        assert!(current.contains("applog test panic"));
        assert!(current.contains("applog.rs"));
        let _ = fs::remove_dir_all(&dir);
    }
}
