//! Durable publication intent. A per-entry OS lock excludes live publishers
//! across processes. Recovery restores the previous version only when the new
//! version is still staged and the destination is absent.
use super::recovery::{self, StagedReplacement};
use crate::remotefs::RemoteFs;
use anyhow::{Context, Result};
use std::{fs::{File, OpenOptions}, path::{Path, PathBuf}};

fn directory() -> Result<PathBuf> {
    Ok(crate::credential_refs::config_path()?.with_file_name("sync-publications"))
}

pub struct Guard { file: File, path: PathBuf }
impl Guard {
    pub fn complete(self) -> Result<()> {
        std::fs::remove_file(&self.path)?;
        drop(self.file);
        let _ = std::fs::remove_file(self.path.with_extension("lock"));
        Ok(())
    }
}

pub fn begin(stage: &StagedReplacement) -> Result<Option<Guard>> {
    if stage.destination_key.is_none() { return Ok(None); }
    begin_in(&directory()?, stage).map(Some)
}

fn begin_in(dir: &Path, stage: &StagedReplacement) -> Result<Guard> {
    recovery::validate_relative(&stage.batch)?;
    anyhow::ensure!(!stage.batch.contains('/'), "Invalid publication batch");
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{}.json", stage.batch));
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path.with_extension("lock"))?;
    file.try_lock().context("Publication is already active")?;
    crate::fsutil::write_atomic(&path, &serde_json::to_vec(stage)?)?;
    Ok(Guard { file, path })
}

pub async fn recover(fs: &dyn RemoteFs, key: &str, root: &str) -> Result<usize> {
    recover_in(&directory()?, fs, key, root).await
}

async fn recover_in(dir: &Path, fs: &dyn RemoteFs, key: &str, root: &str) -> Result<usize> {
    if !dir.exists() { return Ok(0); }
    recovery::validate_root(root)?;
    let mut restored = 0;
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") { continue; }
        let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(path.with_extension("lock"))?;
        if file.try_lock().is_err() { continue; }
        let bytes = match std::fs::read(&path) { Ok(b) => b, Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue, Err(e) => return Err(e.into()) };
        let stage: StagedReplacement = serde_json::from_slice(&bytes).context("Invalid sync publication journal; inspect before continuing")?;
        if stage.destination_key.as_deref() != Some(key) || stage.root != root { continue; }
        recovery::validate_relative(&stage.relative)?;
        recovery::validate_relative(&stage.batch)?;
        anyhow::ensure!(!stage.batch.contains('/'), "Invalid publication batch");
        if recovery::current_state(fs, root, &stage.relative).await?.is_some() {
            Guard { file, path }.complete()?;
            continue;
        }
        let staged = recovery::current_state(fs, root, &stage.staging_relative()).await?;
        let backup = format!("{}/{}/{}", recovery::DIRECTORY, stage.batch, stage.relative);
        let previous = recovery::current_state(fs, root, &backup).await?;
        if staged.as_ref().is_some_and(|s| s.size == stage.size) && previous.as_ref() == Some(&stage.expected) {
            fs.rename_no_replace(&super::join(root, &backup), &super::join(root, &stage.relative)).await?;
            Guard { file, path }.complete()?;
            restored += 1;
        } else {
            anyhow::bail!("Interrupted sync publication needs inspection: {}. Recovery and staging files were left untouched.", stage.relative);
        }
    }
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remotefs::local::LocalFs;
    #[tokio::test]
    async fn crash_recovery_skips_live_publisher_then_restores_old_version() {
        let root = std::env::temp_dir().join(format!("faro-journal-{}", uuid::Uuid::new_v4()));
        let journals = root.join("journals");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("file"), b"old").unwrap();
        let root_str = root.to_string_lossy().to_string();
        let expected = recovery::current_state(&LocalFs, &root_str, "file").await.unwrap().unwrap();
        let stage = StagedReplacement { root: root_str.clone(), batch: recovery::new_batch(), relative: "file".into(), expected, size: 3, destination_key: Some("test".into()) };
        stage.prepare(&LocalFs).await.unwrap();
        std::fs::write(stage.path(), b"new").unwrap();
        let guard = begin_in(&journals, &stage).unwrap();
        recovery::preserve(&LocalFs, &root_str, &stage.batch, &stage.relative, &stage.expected).await.unwrap();
        assert_eq!(recover_in(&journals, &LocalFs, "test", &root_str).await.unwrap(), 0);
        drop(guard); // Simulate process exit releasing the OS lock.
        assert_eq!(recover_in(&journals, &LocalFs, "test", &root_str).await.unwrap(), 1);
        assert_eq!(std::fs::read(root.join("file")).unwrap(), b"old");
        assert_eq!(std::fs::read(stage.path()).unwrap(), b"new");
        assert_eq!(recover_in(&journals, &LocalFs, "test", &root_str).await.unwrap(), 0);
        assert_eq!(root.parent(), Some(std::env::temp_dir().as_path()));
        std::fs::remove_dir_all(root).unwrap();
    }
}

pub fn cleanup_lock(batch: &str) -> Result<File> {
    let dir = directory()?;
    std::fs::create_dir_all(&dir)?;
    let file = OpenOptions::new().create(true).truncate(false).read(true).write(true).open(dir.join(format!("{batch}.lock")))?;
    file.try_lock().context("This sync file is in use; pause sync before cleanup")?;
    anyhow::ensure!(!dir.join(format!("{batch}.json")).exists(), "This batch has an unfinished publication; run sync recovery before cleanup");
    Ok(file)
}
