//! Pasting an image into a terminal (Plan 36 Phase 3).
//!
//! A shell can't take image bytes, so the image is written to a file where the
//! shell runs and its path is typed instead. Tools on that machine (an AI
//! coding assistant, `scp`, an uploader) can then use the path.
//!
//! Remote files go to `~/.cache/faro/pastes`, readable by the owner only, and
//! pastes older than a day are removed on the next paste.

use crate::session::SshSession;
use anyhow::{bail, Context, Result};
use russh_sftp::protocol::FileAttributes;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::AsyncWriteExt;

pub const MAX_PASTE_BYTES: usize = 20 * 1024 * 1024;
const KEEP_FOR: Duration = Duration::from_secs(24 * 60 * 60);

/// Only image extensions a clipboard produces; anything else becomes `png`.
pub fn safe_ext(ext: &str) -> &'static str {
    match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => "jpg",
        "gif" => "gif",
        "webp" => "webp",
        "bmp" => "bmp",
        _ => "png",
    }
}

pub fn file_name(ext: &str) -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("paste-{ms}-{:04x}.{}", rand::random::<u16>(), safe_ext(ext))
}

fn check_size(bytes: &[u8]) -> Result<()> {
    if bytes.is_empty() {
        bail!("The clipboard image is empty.");
    }
    if bytes.len() > MAX_PASTE_BYTES {
        bail!(
            "The image is {} MB. Pasted images can be at most {} MB.",
            bytes.len() / (1024 * 1024),
            MAX_PASTE_BYTES / (1024 * 1024)
        );
    }
    Ok(())
}

fn local_dir() -> PathBuf {
    std::env::temp_dir().join("faro-pastes")
}

/// Save for a local terminal; returns the file's path.
pub async fn save_local(bytes: Vec<u8>, ext: &str) -> Result<String> {
    check_size(&bytes)?;
    let dir = local_dir();
    let name = file_name(ext);
    tokio::task::spawn_blocking(move || -> Result<String> {
        std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
        prune_local(&dir, KEEP_FOR);
        let path = dir.join(name);
        std::fs::write(&path, bytes).with_context(|| format!("write {}", path.display()))?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .context("paste task")?
}

/// Best-effort: drop pastes older than `keep`.
fn prune_local(dir: &std::path::Path, keep: Duration) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    for entry in entries.flatten() {
        let old = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .is_some_and(|age| age > keep);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Prepares the remote paste folder and prints its absolute path. `find` may
/// be missing or lack `-mmin` on a small host; cleanup is best-effort.
const REMOTE_PREPARE: &str = r#"d="${XDG_CACHE_HOME:-$HOME/.cache}/faro/pastes"; mkdir -p "$d" && chmod 700 "$d" && { find "$d" -type f -mmin +1440 -exec rm -f {} + 2>/dev/null; printf '%s' "$d"; }"#;

/// Save on the host of an SSH terminal; returns the remote path.
pub async fn save_remote(ssh: &Arc<SshSession>, bytes: Vec<u8>, ext: &str) -> Result<String> {
    check_size(&bytes)?;
    let out = ssh
        .exec_bounded(REMOTE_PREPARE, 4096, Duration::from_secs(20), None)
        .await
        .context("prepare the paste folder")?;
    let dir = out.stdout.trim().to_string();
    if out.exit_code != Some(0) || !dir.starts_with('/') {
        bail!(
            "Couldn't create the paste folder on the server: {}",
            out.stderr.trim()
        );
    }
    let path = format!("{dir}/{}", file_name(ext));
    let bytes = Arc::new(bytes);
    let path_ref = path.as_str();
    ssh.with_sftp(|cell| {
        let bytes = bytes.clone();
        async move {
            let sftp = cell.lock().await;
            let mut file = sftp
                .create(path_ref)
                .await
                .with_context(|| format!("create {path_ref}"))?;
            file.write_all(&bytes).await.context("write the image")?;
            file.shutdown().await.context("finish the image")?;
            let attrs = FileAttributes {
                permissions: Some(0o600),
                ..Default::default()
            };
            sftp.set_metadata(path_ref, attrs)
                .await
                .with_context(|| format!("chmod {path_ref}"))?;
            Ok(())
        }
    })
    .await?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extensions_are_limited_to_images() {
        assert_eq!(safe_ext("PNG"), "png");
        assert_eq!(safe_ext(".jpeg"), "jpg");
        assert_eq!(safe_ext("webp"), "webp");
        assert_eq!(safe_ext("sh"), "png");
        assert_eq!(safe_ext("../../x"), "png");
        let name = file_name("exe");
        assert!(name.starts_with("paste-") && name.ends_with(".png"), "{name}");
        assert!(!name.contains('/') && !name.contains('\\'));
    }

    #[test]
    fn size_limits_are_enforced() {
        assert!(check_size(&[]).is_err());
        assert!(check_size(&[1, 2, 3]).is_ok());
        assert!(check_size(&vec![0u8; MAX_PASTE_BYTES + 1]).is_err());
    }

    #[tokio::test]
    async fn local_paste_writes_the_bytes_and_prunes_old_files() {
        let path = save_local(vec![9, 8, 7], "png").await.unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), vec![9, 8, 7]);

        let dir = std::env::temp_dir().join(format!("faro-paste-test-{:08x}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        let old = dir.join("old.png");
        let fresh = dir.join("fresh.png");
        std::fs::write(&old, b"x").unwrap();
        std::fs::write(&fresh, b"y").unwrap();
        // "Older than zero seconds" removes everything written before now.
        std::thread::sleep(Duration::from_millis(30));
        prune_local(&dir, Duration::from_millis(1));
        assert!(!old.exists() && !fresh.exists());
        std::fs::write(&fresh, b"y").unwrap();
        prune_local(&dir, KEEP_FOR);
        assert!(fresh.exists(), "a recent paste is kept");
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_file(path);
    }
}
