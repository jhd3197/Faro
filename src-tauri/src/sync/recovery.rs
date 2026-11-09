//! Recoverable sync changes. Versions stay on the destination, in a reserved
//! tree that sync never traverses. No automatic expiry or permanent-delete fallback.
use super::{join, SyncPlan, SyncReason};
use crate::remotefs::{FileKind, RemoteFs};
use anyhow::{bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};

pub const DIRECTORY: &str = ".faro-sync-recovery";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileState {
    pub size: u64,
    pub modified: i64,
    pub etag: Option<String>,
}

impl From<&crate::scan::ScanEntry> for FileState {
    fn from(e: &crate::scan::ScanEntry) -> Self {
        Self {
            size: e.size,
            modified: e.modified,
            etag: e.etag.clone(),
        }
    }
}

pub fn validate_root(root: &str) -> Result<()> {
    ensure!(
        !root
            .split(['/', '\\'])
            .any(|s| s.eq_ignore_ascii_case(DIRECTORY)),
        "A recovery folder cannot be used as a sync root"
    );
    Ok(())
}

fn validate_relative(relative: &str) -> Result<()> {
    ensure!(
        !relative.is_empty()
            && !relative.contains(['\\', ':'])
            && relative.split('/').all(|p| !p.is_empty()
                && p != "."
                && p != ".."
                && !p.eq_ignore_ascii_case(DIRECTORY)),
        "Invalid sync recovery path"
    );
    Ok(())
}

pub fn destination_root(plan: &SyncPlan) -> &str {
    match plan.direction {
        super::SyncDirection::LocalToRemote => &plan.remote_root,
        super::SyncDirection::RemoteToLocal => &plan.local_root,
    }
}

/// Refuse stale/legacy plans before making any changes. Recheck individual
/// files immediately before moving them as well. Metadata checks are not an
/// atomic compare-and-swap on backends that do not provide one.
pub async fn validate_plan(fs: &dyn RemoteFs, plan: &SyncPlan) -> Result<()> {
    let root = destination_root(plan);
    validate_root(root)?;
    let tree = crate::scan::sync_tree(fs, root, true).await?;
    let mut changes_existing = !plan.deletes.is_empty();
    for c in &plan.copies {
        validate_relative(&c.relative)?;
        ensure!(
            c.destination_path == join(root, &c.relative),
            "Invalid sync destination; re-plan"
        );
        ensure!(
            matches!(c.reason, SyncReason::Missing) || c.destination_state.is_some(),
            "This sync preview is missing conflict information; re-plan"
        );
        let current = tree.files.get(&c.relative).map(FileState::from);
        ensure!(
            current == c.destination_state && !tree.directories.contains(&c.relative),
            "Destination changed since preview: {}. Re-plan before syncing.",
            c.relative
        );
        // A differently cased alias may be the same file on Windows/FTP.
        ensure!(
            !tree
                .files
                .keys()
                .any(|p| p != &c.relative && p.eq_ignore_ascii_case(&c.relative)),
            "Destination has a differently cased name for {}; rename it before syncing",
            c.relative
        );
        changes_existing |= c.destination_state.is_some();
    }
    for d in &plan.deletes {
        validate_relative(&d.relative)?;
        ensure!(
            d.path.replace('\\', "/") == join(root, &d.relative).replace('\\', "/"),
            "Invalid sync deletion path; re-plan"
        );
        ensure!(
            d.destination_state.is_some()
                && tree.files.get(&d.relative).map(FileState::from) == d.destination_state,
            "Destination changed since preview: {}. Re-plan before syncing.",
            d.relative
        );
    }
    ensure!(!changes_existing || fs.capabilities().can_rename,
        "This destination cannot move files into recovery. Sync replacements and deletes were refused.");
    Ok(())
}

pub fn new_batch() -> String {
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{seconds}-{}", uuid::Uuid::new_v4())
}

// Inspect each parent instead of blindly following symlinks into another tree.
async fn ensure_parents(fs: &dyn RemoteFs, root: &str, relative: &str, create: bool) -> Result<()> {
    let mut parent = root.to_string();
    let parts: Vec<_> = relative.split('/').collect();
    for part in &parts[..parts.len().saturating_sub(1)] {
        let entries = fs.list_dir(&parent).await?;
        match entries.iter().find(|e| e.name.eq_ignore_ascii_case(part)) {
            Some(e) => ensure!(
                e.kind == FileKind::Directory,
                "Recovery parent is not a directory: {}",
                e.path
            ),
            None if create => fs.create_dir(&join(&parent, part)).await?,
            None if !fs.capabilities().has_directories => {}
            None => bail!("Recovery parent no longer exists: {parent}/{part}"),
        }
        parent = join(&parent, part);
    }
    Ok(())
}

async fn current_state(fs: &dyn RemoteFs, root: &str, relative: &str) -> Result<Option<FileState>> {
    ensure_parents(fs, root, relative, false).await?;
    let parent = relative
        .rsplit_once('/')
        .map(|(p, _)| join(root, p))
        .unwrap_or_else(|| root.to_string());
    let name = relative.rsplit('/').next().unwrap();
    let entries = fs.list_dir(&parent).await?;
    let Some(e) = entries.iter().find(|e| e.name.eq_ignore_ascii_case(name)) else {
        return Ok(None);
    };
    ensure!(
        e.kind == FileKind::File,
        "Destination is no longer a regular file: {}",
        e.path
    );
    Ok(Some(FileState {
        size: e.size,
        modified: e.modified.unwrap_or(0),
        etag: e.etag.clone(),
    }))
}

pub async fn check_missing(fs: &dyn RemoteFs, root: &str, relative: &str) -> Result<()> {
    validate_relative(relative)?;
    ensure!(
        current_state(fs, root, relative).await?.is_none(),
        "Destination appeared since preview: {relative}. Re-plan before syncing."
    );
    Ok(())
}

/// Move the previous version intact. If this fails, callers must not overwrite
/// or delete the original. A failed subsequent transfer leaves it recoverable.
pub async fn preserve(
    fs: &dyn RemoteFs,
    root: &str,
    batch: &str,
    relative: &str,
    expected: &FileState,
) -> Result<String> {
    validate_root(root)?;
    validate_relative(relative)?;
    validate_relative(batch)?;
    ensure!(!batch.contains('/'), "Invalid recovery batch");
    ensure!(
        fs.capabilities().can_rename,
        "Destination does not support recoverable sync changes"
    );
    ensure!(
        current_state(fs, root, relative).await?.as_ref() == Some(expected),
        "Destination changed since preview: {relative}. Re-plan before syncing."
    );
    let stored_relative = format!("{DIRECTORY}/{batch}/{relative}");
    ensure_parents(fs, root, &stored_relative, true).await?;
    ensure!(
        current_state(fs, root, &stored_relative).await?.is_none(),
        "Recovery version already exists"
    );
    let stored = join(root, &stored_relative);
    ensure!(
        current_state(fs, root, relative).await?.as_ref() == Some(expected),
        "Destination changed while preparing recovery: {relative}. Re-plan before syncing."
    );
    fs.rename(&join(root, relative), &stored)
        .await
        .with_context(|| {
            format!("Could not preserve {relative}; the original was not intentionally deleted")
        })?;
    Ok(stored)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub batch: String,
    pub relative: String,
    pub size: u64,
    pub state: FileState,
}

pub async fn list(fs: &dyn RemoteFs, root: &str) -> Result<Vec<RecoveryEntry>> {
    validate_root(root)?;
    let entries = fs.list_dir(root).await?;
    let Some(dir) = entries
        .iter()
        .find(|e| e.name.eq_ignore_ascii_case(DIRECTORY))
    else {
        return Ok(vec![]);
    };
    ensure!(
        dir.kind == FileKind::Directory,
        "Recovery path is not a directory"
    );
    let tree = crate::scan::walk_tree(fs, &join(root, DIRECTORY)).await?;
    let mut out = Vec::new();
    for (path, entry) in tree.files {
        if let Some((batch, relative)) = path.split_once('/') {
            validate_relative(batch)?;
            validate_relative(relative)?;
            out.push(RecoveryEntry {
                batch: batch.into(),
                relative: relative.into(),
                size: entry.size,
                state: FileState::from(&entry),
            });
        }
    }
    out.sort_by(|a, b| b.batch.cmp(&a.batch).then(a.relative.cmp(&b.relative)));
    Ok(out)
}

/// Restore without replacing an existing file: retain both under a fresh name.
pub async fn restore(fs: &dyn RemoteFs, root: &str, entry: &RecoveryEntry) -> Result<String> {
    validate_root(root)?;
    validate_relative(&entry.relative)?;
    validate_relative(&entry.batch)?;
    ensure!(!entry.batch.contains('/'), "Invalid recovery batch");
    let stored_relative = format!("{DIRECTORY}/{}/{}", entry.batch, entry.relative);
    ensure!(
        current_state(fs, root, &stored_relative).await?.as_ref() == Some(&entry.state),
        "Recovery file changed; refresh the list"
    );
    ensure_parents(fs, root, &entry.relative, true).await?;
    let parent = entry
        .relative
        .rsplit_once('/')
        .map(|(p, _)| join(root, p))
        .unwrap_or_else(|| root.to_string());
    let name = entry.relative.rsplit('/').next().unwrap();
    let occupied = fs
        .list_dir(&parent)
        .await?
        .iter()
        .any(|e| e.name.eq_ignore_ascii_case(name));
    let target = if occupied {
        join(
            &parent,
            &format!("{name}.restored-{}", uuid::Uuid::new_v4()),
        )
    } else {
        join(root, &entry.relative)
    };
    fs.rename(&join(root, &stored_relative), &target).await?;
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remotefs::local::LocalFs;
    use crate::sync::{plan, SyncDirection, SyncStrategy};

    #[tokio::test]
    async fn flat_object_store_recovery_needs_no_physical_directories() {
        use object_store::ObjectStore;
        let store = std::sync::Arc::new(object_store::memory::InMemory::new());
        store
            .put(
                &object_store::path::Path::from("file"),
                bytes::Bytes::from_static(b"old").into(),
            )
            .await
            .unwrap();
        let profile = serde_json::from_value(serde_json::json!({
            "id": "recovery-test", "name": "Recovery test", "protocol": "gcs",
            "host": "", "port": 0, "username": "", "auth": {"kind": "password", "password": ""}
        }))
        .unwrap();
        let session = crate::session::ObjectSession {
            id: "test".into(),
            profile,
            container: "test".into(),
            store: store.clone(),
            namespace: std::sync::OnceLock::new(),
        };
        let fs = crate::remotefs::object::ObjectFs::new(std::sync::Arc::new(session));
        let expected = current_state(&fs, "/", "file").await.unwrap().unwrap();
        preserve(&fs, "/", &new_batch(), "file", &expected)
            .await
            .unwrap();
        let entries = list(&fs, "/").await.unwrap();
        assert_eq!(entries.len(), 1);
        restore(&fs, "/", &entries[0]).await.unwrap();
        assert_eq!(
            store
                .get(&object_store::path::Path::from("file"))
                .await
                .unwrap()
                .bytes()
                .await
                .unwrap()
                .as_ref(),
            b"old"
        );
    }

    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("faro-recovery-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &std::path::Path {
            &self.0
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            assert_eq!(self.0.parent(), Some(std::env::temp_dir().as_path()));
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[tokio::test]
    async fn delete_and_replacement_versions_restore_without_clobbering() {
        let src = Scratch::new();
        let dst = Scratch::new();
        std::fs::write(src.path().join("keep"), b"replacement").unwrap();
        std::fs::write(dst.path().join("keep"), b"old").unwrap();
        std::fs::create_dir(dst.path().join("nested")).unwrap();
        std::fs::write(dst.path().join("nested/deleted"), b"recover me").unwrap();
        let root = dst.path().to_str().unwrap();
        let p = plan(
            &LocalFs,
            &LocalFs,
            src.path().to_str().unwrap(),
            root,
            SyncDirection::LocalToRemote,
            SyncStrategy::Mirror,
        )
        .await
        .unwrap();
        validate_plan(&LocalFs, &p).await.unwrap();
        let batch = new_batch();
        for c in &p.copies {
            preserve(
                &LocalFs,
                root,
                &batch,
                &c.relative,
                c.destination_state.as_ref().unwrap(),
            )
            .await
            .unwrap();
            std::fs::write(&c.destination_path, b"replacement").unwrap();
        }
        for d in &p.deletes {
            preserve(
                &LocalFs,
                root,
                &batch,
                &d.relative,
                d.destination_state.as_ref().unwrap(),
            )
            .await
            .unwrap();
        }
        let versions = list(&LocalFs, root).await.unwrap();
        assert_eq!(versions.len(), 2);
        assert!(!dst.path().join("nested/deleted").exists());
        for version in &versions {
            let target = restore(&LocalFs, root, version).await.unwrap();
            if version.relative == "keep" {
                assert_ne!(target, dst.path().join("keep").to_string_lossy());
                assert_eq!(std::fs::read(target).unwrap(), b"old");
                assert_eq!(
                    std::fs::read(dst.path().join("keep")).unwrap(),
                    b"replacement"
                );
            } else {
                assert_eq!(std::fs::read(target).unwrap(), b"recover me");
            }
        }
        assert!(list(&LocalFs, root).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn stale_destinations_and_new_collisions_are_refused() {
        let src = Scratch::new();
        let dst = Scratch::new();
        std::fs::write(src.path().join("file"), b"new content").unwrap();
        std::fs::write(dst.path().join("file"), b"old").unwrap();
        let root = dst.path().to_str().unwrap();
        let p = plan(
            &LocalFs,
            &LocalFs,
            src.path().to_str().unwrap(),
            root,
            SyncDirection::LocalToRemote,
            SyncStrategy::Additive,
        )
        .await
        .unwrap();
        std::fs::write(dst.path().join("file"), b"someone else's edit").unwrap();
        assert!(validate_plan(&LocalFs, &p).await.is_err());
        assert!(preserve(
            &LocalFs,
            root,
            &new_batch(),
            "file",
            p.copies[0].destination_state.as_ref().unwrap()
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read(dst.path().join("file")).unwrap(),
            b"someone else's edit"
        );
        assert!(check_missing(&LocalFs, root, "file").await.is_err());
    }

    #[tokio::test]
    async fn recovery_is_excluded_on_both_sides_and_in_nested_roots() {
        let src = Scratch::new();
        let dst = Scratch::new();
        for root in [src.path(), dst.path()] {
            std::fs::write(root.join("keep"), b"same").unwrap();
            std::fs::create_dir_all(root.join(format!("nested/{DIRECTORY}/batch"))).unwrap();
            std::fs::write(
                root.join(format!("nested/{DIRECTORY}/batch/file")),
                b"saved",
            )
            .unwrap();
        }
        std::fs::create_dir_all(dst.path().join(format!("{DIRECTORY}/batch"))).unwrap();
        std::fs::write(
            dst.path().join(format!("{DIRECTORY}/batch/extra")),
            b"saved",
        )
        .unwrap();
        let p = plan(
            &LocalFs,
            &LocalFs,
            src.path().to_str().unwrap(),
            dst.path().to_str().unwrap(),
            SyncDirection::LocalToRemote,
            SyncStrategy::Mirror,
        )
        .await
        .unwrap();
        assert!(p.deletes.is_empty());
        assert!(p.copies.iter().all(|c| !c.relative.contains(DIRECTORY)));
        assert!(p.directories.iter().all(|d| !d.contains(DIRECTORY)));
        assert!(plan(
            &LocalFs,
            &LocalFs,
            dst.path().join(DIRECTORY).to_str().unwrap(),
            src.path().to_str().unwrap(),
            SyncDirection::LocalToRemote,
            SyncStrategy::Mirror
        )
        .await
        .is_err());
    }

    #[tokio::test]
    async fn blocked_recovery_folder_keeps_original_intact() {
        let dst = Scratch::new();
        let root = dst.path().to_str().unwrap();
        std::fs::write(dst.path().join("file"), b"original").unwrap();
        std::fs::write(dst.path().join(DIRECTORY), b"not a directory").unwrap();
        let state = current_state(&LocalFs, root, "file")
            .await
            .unwrap()
            .unwrap();
        assert!(preserve(&LocalFs, root, &new_batch(), "file", &state)
            .await
            .is_err());
        assert_eq!(std::fs::read(dst.path().join("file")).unwrap(), b"original");
        assert!(preserve(&LocalFs, root, &new_batch(), "../file", &state)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn repeated_versions_have_distinct_batches_and_survive_failed_copy() {
        let dst = Scratch::new();
        let root = dst.path().to_str().unwrap();
        for content in ["first", "second"] {
            std::fs::write(dst.path().join("file"), content).unwrap();
            let state = current_state(&LocalFs, root, "file")
                .await
                .unwrap()
                .unwrap();
            preserve(&LocalFs, root, &new_batch(), "file", &state)
                .await
                .unwrap();
        }
        // Simulate an upload failure after the old file was moved aside.
        assert!(!dst.path().join("file").exists());
        let entries = list(&LocalFs, root).await.unwrap();
        assert_eq!(entries.len(), 2);
        assert_ne!(entries[0].batch, entries[1].batch);
        let target = restore(&LocalFs, root, &entries[0]).await.unwrap();
        assert!(std::fs::metadata(target).unwrap().len() > 0);
    }
}
