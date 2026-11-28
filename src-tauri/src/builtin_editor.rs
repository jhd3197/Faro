//! Backend of the built-in text editor (Plan 37 Phase 3).
//!
//! Two operations on any backend, or on a local file: read a text file with a
//! stamp of the version that was read, and write it back unless the file has
//! changed since. The stamp (size, modified time, ETag) is the same one the
//! external edit flow uses to hold back a save over someone else's change.
//!
//! Only UTF-8 text up to [`MAX_BYTES`] opens here. Anything else is refused
//! with a reason, so a binary or a file in another encoding is never rewritten
//! as something it wasn't.

use crate::editor::{download_to, edits_root, remote_stamp, upload_from};
use crate::error::{ErrorKind, FaroError};
use crate::session::Session;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;

/// The largest file the built-in editor opens.
pub const MAX_BYTES: u64 = 5 * 1024 * 1024;

/// Identifies one version of a file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStamp {
    pub size: u64,
    pub modified: Option<i64>,
    pub etag: Option<String>,
}

impl From<(u64, Option<i64>, Option<String>)> for FileStamp {
    fn from((size, modified, etag): (u64, Option<i64>, Option<String>)) -> Self {
        Self {
            size,
            modified,
            etag,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFile {
    pub text: String,
    /// The version that was read. `None` when the backend can't tell versions
    /// apart; saves are then not conflict-checked.
    pub stamp: Option<FileStamp>,
}

fn too_large(size: u64) -> FaroError {
    FaroError::new(
        ErrorKind::Unsupported,
        format!(
            "This file is {:.1} MB. The built-in editor opens files up to {} MB; use your own editor for this one.",
            size as f64 / (1024.0 * 1024.0),
            MAX_BYTES / (1024 * 1024)
        ),
    )
}

/// Bytes → text, or why not. A NUL byte early on means a binary file.
pub fn decode_text(bytes: Vec<u8>) -> Result<String, FaroError> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(too_large(bytes.len() as u64));
    }
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(FaroError::new(
            ErrorKind::Unsupported,
            "This looks like a binary file, so it can't be edited as text.",
        ));
    }
    String::from_utf8(bytes).map_err(|_| {
        FaroError::new(
            ErrorKind::Unsupported,
            "This file isn't UTF-8 text. Open it in your own editor to keep its encoding.",
        )
    })
}

fn local_stamp(path: &Path) -> Option<FileStamp> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        // Nanoseconds: two saves in the same second are still two versions.
        .map(|d| d.as_nanos() as i64);
    Some(FileStamp {
        size: meta.len(),
        modified,
        etag: None,
    })
}

async fn stamp_of(session: Option<&Arc<Session>>, path: &str) -> Option<FileStamp> {
    match session {
        None => {
            let path = PathBuf::from(path);
            tokio::task::spawn_blocking(move || local_stamp(&path))
                .await
                .ok()
                .flatten()
        }
        Some(session) => remote_stamp(session, path).await.map(FileStamp::from),
    }
}

/// A scratch file for one read or write, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self, FaroError> {
        let dir = edits_root().join(format!("builtin-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir)
            .map_err(|e| FaroError::other(format!("create a temp folder: {e}")))?;
        Ok(Self(dir))
    }
    fn file(&self) -> PathBuf {
        self.0.join("buffer")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The largest image the viewer loads.
pub const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

/// A whole file's bytes, for the image viewer. Refuses anything over
/// [`MAX_IMAGE_BYTES`] rather than returning a truncated image.
pub async fn read_image(session: Option<Arc<Session>>, path: &str) -> Result<Vec<u8>, FaroError> {
    // One byte past the limit tells "exactly at the limit" from "larger".
    let bytes = crate::preview::read_head(session.as_deref(), path, MAX_IMAGE_BYTES + 1)
        .await
        .map_err(FaroError::from)?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(FaroError::new(
            ErrorKind::Unsupported,
            format!(
                "This image is larger than {} MB. Download it to view it.",
                MAX_IMAGE_BYTES / (1024 * 1024)
            ),
        ));
    }
    Ok(bytes)
}

/// Read `path` as text. `session` is `None` for a local file.
pub async fn read(session: Option<Arc<Session>>, path: &str) -> Result<EditorFile, FaroError> {
    let stamp = stamp_of(session.as_ref(), path).await;
    if let Some(s) = &stamp {
        if s.size > MAX_BYTES {
            return Err(too_large(s.size));
        }
    }
    let bytes = match &session {
        None => tokio::fs::read(path)
            .await
            .map_err(|e| FaroError::from(anyhow::Error::new(e).context(format!("read {path}"))))?,
        Some(session) => {
            let scratch = Scratch::new()?;
            let local = scratch.file();
            download_to(session, path, &local)
                .await
                .map_err(FaroError::from)?;
            tokio::fs::read(&local)
                .await
                .map_err(|e| FaroError::other(format!("read the downloaded copy: {e}")))?
        }
    };
    Ok(EditorFile {
        text: decode_text(bytes)?,
        stamp,
    })
}

/// Write `text` to `path`. With `expected` set, the write is refused (kind
/// `conflict`) when the file is no longer the version that was read, unless
/// `force`. Returns the stamp of what was written.
pub async fn write(
    session: Option<Arc<Session>>,
    path: &str,
    text: String,
    expected: Option<FileStamp>,
    force: bool,
) -> Result<Option<FileStamp>, FaroError> {
    if text.len() as u64 > MAX_BYTES {
        return Err(too_large(text.len() as u64));
    }
    if !force {
        if let (Some(expected), Some(now)) = (&expected, stamp_of(session.as_ref(), path).await) {
            if *expected != now {
                return Err(FaroError::new(
                    ErrorKind::Conflict,
                    "The file changed since you opened it.",
                ));
            }
        }
    }
    match &session {
        None => {
            tokio::fs::write(path, text.as_bytes()).await.map_err(|e| {
                FaroError::from(anyhow::Error::new(e).context(format!("write {path}")))
            })?;
        }
        Some(session) => {
            let scratch = Scratch::new()?;
            let local = scratch.file();
            tokio::fs::write(&local, text.as_bytes())
                .await
                .map_err(|e| FaroError::other(format!("stage the save: {e}")))?;
            upload_from(session, &local.to_string_lossy(), path)
                .await
                .map_err(FaroError::from)?;
        }
    }
    Ok(stamp_of(session.as_ref(), path).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("faro-editor-test-{:08x}", rand::random::<u32>()));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join(name)
    }

    #[test]
    fn only_utf8_text_within_the_limit_decodes() {
        assert_eq!(decode_text("héllo\n".as_bytes().to_vec()).unwrap(), "héllo\n");
        assert_eq!(decode_text(Vec::new()).unwrap(), "");
        let binary = decode_text(vec![b'a', 0, b'b']).unwrap_err();
        assert_eq!(binary.kind, ErrorKind::Unsupported);
        assert!(binary.message.contains("binary"));
        let latin1 = decode_text(vec![b'c', b'a', b'f', 0xE9]).unwrap_err();
        assert!(latin1.message.contains("UTF-8"));
        let big = decode_text(vec![b'x'; MAX_BYTES as usize + 1]).unwrap_err();
        assert!(big.message.contains("up to 5 MB"), "{}", big.message);
    }

    #[tokio::test]
    async fn a_local_file_round_trips_and_a_changed_file_is_not_overwritten() {
        let path = temp_file("notes.txt");
        let p = path.to_string_lossy().into_owned();
        std::fs::write(&path, "one\n").unwrap();

        let opened = read(None, &p).await.unwrap();
        assert_eq!(opened.text, "one\n");
        let stamp = opened.stamp.clone().expect("a local file has a stamp");

        // Saving the version that was read works and returns the new stamp.
        let saved = write(None, &p, "one\ntwo\n".into(), Some(stamp.clone()), false)
            .await
            .unwrap()
            .unwrap();
        assert_ne!(saved, stamp);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "one\ntwo\n");

        // Someone else changes it. The old stamp no longer matches.
        std::fs::write(&path, "theirs, and longer\n").unwrap();
        let err = write(None, &p, "mine\n".into(), Some(saved.clone()), false)
            .await
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            "theirs, and longer\n",
            "their change is still there"
        );

        // Overwriting is an explicit choice.
        write(None, &p, "mine\n".into(), Some(saved), true).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine\n");

        // With no stamp there is nothing to compare, so the save goes through.
        write(None, &p, "unchecked\n".into(), None, false).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "unchecked\n");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[tokio::test]
    async fn binary_and_oversized_local_files_are_refused() {
        let bin = temp_file("image.bin");
        std::fs::write(&bin, [0u8, 1, 2, 3]).unwrap();
        let err = read(None, &bin.to_string_lossy()).await.unwrap_err();
        assert_eq!(err.kind, ErrorKind::Unsupported);

        let big = temp_file("big.log");
        std::fs::write(&big, vec![b'a'; MAX_BYTES as usize + 10]).unwrap();
        let err = read(None, &big.to_string_lossy()).await.unwrap_err();
        assert!(err.message.contains("up to 5 MB"));

        let missing = read(None, &temp_file("nope.txt").to_string_lossy()).await.unwrap_err();
        assert_eq!(missing.kind, ErrorKind::NotFound);
        let _ = std::fs::remove_dir_all(bin.parent().unwrap());
        let _ = std::fs::remove_dir_all(big.parent().unwrap());
    }
}

/// Against a real SSH host: `FARO_LIVE_SFTP=host:port:user:pass cargo test -p
/// faro --lib builtin_editor::live_tests -- --ignored --nocapture`.
#[cfg(test)]
mod live_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn a_remote_file_round_trips_and_a_server_side_change_blocks_the_save() {
        let session = crate::transfer::live_tests::sftp_session()
            .await
            .expect("FARO_LIVE_SFTP");
        let Session::Ssh(ssh) = &*session else {
            unreachable!()
        };
        let path = format!("/tmp/faro-editor-{:08x}.conf", rand::random::<u32>());
        ssh.exec(&format!("printf 'listen 80;\\n' > {path} && chmod 640 {path}"))
            .await
            .unwrap();

        let opened = read(Some(session.clone()), &path).await.unwrap();
        assert_eq!(opened.text, "listen 80;\n");
        let stamp = opened.stamp.expect("sftp reports a stamp");

        let saved = write(
            Some(session.clone()),
            &path,
            "listen 8080;\nserver_name example.com;\n".into(),
            Some(stamp),
            false,
        )
        .await
        .unwrap()
        .expect("stamp after save");
        let check = ssh.exec(&format!("cat {path}; stat -c '%a' {path}")).await.unwrap();
        assert_eq!(
            check.stdout, "listen 8080;\nserver_name example.com;\n640\n",
            "content saved, mode kept"
        );

        // A change made on the server after the save.
        ssh.exec(&format!("printf 'changed on the server, longer than before\\n' > {path}"))
            .await
            .unwrap();
        let err = write(
            Some(session.clone()),
            &path,
            "mine\n".into(),
            Some(saved.clone()),
            false,
        )
        .await
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Conflict);
        let still = ssh.exec(&format!("cat {path}")).await.unwrap();
        assert_eq!(still.stdout, "changed on the server, longer than before\n");

        write(Some(session.clone()), &path, "mine\n".into(), Some(saved), true)
            .await
            .unwrap();
        let after = ssh.exec(&format!("cat {path}; rm -f {path}")).await.unwrap();
        assert_eq!(after.stdout, "mine\n");
    }
}
