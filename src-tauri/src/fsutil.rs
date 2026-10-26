//! Crash-safe writes and reads for Faro's JSON config files (profiles,
//! folder sync pairs, bridge and agent-host settings).

use serde::de::DeserializeOwned;
use std::io::Write;
use std::path::{Path, PathBuf};

/// Write `bytes` to `path` via a sibling temp file and a rename, so a crash
/// mid-write leaves either the old file or the new one, never a truncated mix.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = sibling(path, "tmp");
    let result = (|| {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// Read a JSON config file. Missing → `T::default()`. Unparseable → the file is
/// moved aside to `<name>.bad-<unix secs>` (so the next save can't overwrite the
/// user's data with an empty default) and `T::default()` is returned.
pub fn read_json_or_quarantine<T: DeserializeOwned + Default>(path: &Path) -> T {
    let Ok(bytes) = std::fs::read(path) else {
        return T::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let bad = sibling(path, &format!("bad-{secs}"));
            let moved = std::fs::rename(path, &bad);
            tracing::error!(
                "{} could not be read ({e}); kept it as {} ({moved:?}) and started empty",
                path.display(),
                bad.display()
            );
            T::default()
        }
    }
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{suffix}"));
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_json_is_kept_aside_not_lost() {
        let dir = std::env::temp_dir().join(format!("faro-fsutil-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("profiles.json");
        std::fs::write(&path, b"[{\"truncated").unwrap();

        let got: Vec<u32> = read_json_or_quarantine(&path);
        assert!(got.is_empty());
        assert!(!path.exists());
        let kept: Vec<_> = std::fs::read_dir(&dir).unwrap().flatten().collect();
        assert_eq!(kept.len(), 1);
        assert_eq!(std::fs::read(kept[0].path()).unwrap(), b"[{\"truncated");

        write_atomic(&path, b"[1,2]").unwrap();
        assert_eq!(read_json_or_quarantine::<Vec<u32>>(&path), vec![1, 2]);
        write_atomic(&path, b"[3]").unwrap();
        assert_eq!(read_json_or_quarantine::<Vec<u32>>(&path), vec![3]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
