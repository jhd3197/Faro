//! Inventory is completed before any remote mutation. Links/reparse points are
//! rejected explicitly: following junctions can escape the selection or loop.
use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct Manifest {
    pub directories: Vec<PathBuf>,
    pub files: Vec<PathBuf>,
    pub bytes: u64,
    pub fingerprint: String,
}

pub async fn inventory(root: &Path) -> Result<Manifest> {
    let mut result = Manifest { directories: Vec::new(), files: Vec::new(), bytes: 0, fingerprint: String::new() };
    let mut identities = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(path) = pending.pop() {
        let name = path.file_name().and_then(|name| name.to_str())
            .with_context(|| format!("Upload requires a named UTF-8 path: {}", path.display()))?;
        if name.contains(['\\', '/', '\r', '\n']) {
            bail!("Filename cannot be represented safely on the remote server: {}", path.display());
        }
        let meta = tokio::fs::symlink_metadata(&path).await
            .with_context(|| format!("inspect {}", path.display()))?;
        // `is_symlink` covers Windows symlinks and junctions (name-surrogate
        // reparse points) but not OneDrive/cloud placeholders, which are
        // reparse points too and must upload like regular files.
        if meta.file_type().is_symlink() {
            if path == root {
                bail!("Links and reparse points are not uploaded: {}", path.display());
            }
            tracing::warn!("upload skips link {}", path.display());
            continue;
        }
        let modified = meta.modified()?.duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos()).unwrap_or(0);
        identities.push((path.clone(), meta.len(), modified, meta.is_dir()));
        if meta.is_dir() {
            result.directories.push(path.clone());
            let mut entries = tokio::fs::read_dir(&path).await
                .with_context(|| format!("read directory {}", path.display()))?;
            while let Some(entry) = entries.next_entry().await
                .with_context(|| format!("read entry in {}", path.display()))? {
                pending.push(entry.path());
            }
        } else if meta.is_file() {
            result.bytes = result.bytes.checked_add(meta.len()).context("upload size overflow")?;
            result.files.push(path);
        } else {
            bail!("Unsupported upload item: {}", path.display());
        }
    }
    result.directories.sort_by_key(|p| p.components().count());
    result.files.sort();
    identities.sort();
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    for (path, size, modified, directory) in identities {
        let name = path.to_string_lossy();
        digest.update((name.len() as u64).to_le_bytes());
        digest.update(name.as_bytes());
        digest.update(size.to_le_bytes());
        digest.update(modified.to_le_bytes());
        digest.update([directory as u8]);
    }
    result.fingerprint = super::verify::hex(&digest.finalize());
    Ok(result)
}

/// Test convenience over `prepare_destination_checked` with no expected
/// fingerprint. All directories are prepared, parent first, before a single
/// file can enter the queue.
#[cfg(test)]
pub async fn prepare_destination(
    root: &Path, remote_root: &str, fs: &dyn crate::remotefs::RemoteFs,
) -> Result<Vec<(PathBuf, String)>> {
    prepare_destination_checked(root, remote_root, fs, None).await
}

pub async fn prepare_destination_checked(
    root: &Path, remote_root: &str, fs: &dyn crate::remotefs::RemoteFs,
    expected_fingerprint: Option<&str>,
) -> Result<Vec<(PathBuf, String)>> {
    let manifest = inventory(root).await?;
    if expected_fingerprint.is_some_and(|expected| expected != manifest.fingerprint) {
        bail!("Upload selection changed since inventory: {}. Build the selection again.", root.display());
    }
    if manifest.directories.is_empty() { bail!("Expected an upload directory: {}", root.display()); }
    let remote_path = |path: &Path| -> Result<String> {
        let relative = path.strip_prefix(root)?.to_string_lossy().replace('\\', "/");
        Ok(if relative.is_empty() { remote_root.to_string() }
            else { format!("{}/{relative}", remote_root.trim_end_matches('/')) })
    };
    for path in &manifest.directories {
        let remote = remote_path(path)?;
        if let Err(create_error) = fs.create_dir(&remote).await {
            fs.list_dir(&remote).await.with_context(||
                format!("create/verify directory {remote}: {create_error:#}"))?;
        } else if fs.capabilities().has_directories {
            fs.list_dir(&remote).await.with_context(|| format!("verify directory {remote}"))?;
        }
    }
    manifest.files.iter().map(|path| Ok((path.clone(), remote_path(path)?))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn assets_hidden_empty_unicode_and_deep_directories_are_preserved() {
        let root = std::env::temp_dir().join(format!("faro-manifest-{}", uuid::Uuid::new_v4()));
        let assets = root.join("dist/assets");
        tokio::fs::create_dir_all(assets.join("vide é")).await.unwrap();
        let deep = assets.join((0..12).map(|_| "level").collect::<Vec<_>>().join("/"));
        tokio::fs::create_dir_all(&deep).await.unwrap();
        for i in 0..350 { tokio::fs::write(assets.join(format!("asset {i}.js")), b"abc").await.unwrap(); }
        tokio::fs::write(root.join("dist/.hidden"), b"").await.unwrap();
        tokio::fs::write(deep.join("sans extension"), b"abc").await.unwrap();
        let m = inventory(&root.join("dist")).await.unwrap();
        assert_eq!(m.files.len(), 352);
        assert_eq!(m.directories.len(), 15);
        assert_eq!(m.bytes, 1053);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }
    #[tokio::test]
    async fn missing_source_fails_inventory() {
        assert!(inventory(&std::env::temp_dir().join(uuid::Uuid::new_v4().to_string())).await.is_err());
    }

    #[tokio::test]
    async fn single_zero_byte_and_large_files_use_metadata_only() {
        let root = std::env::temp_dir().join(format!("faro-files-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let file = root.join("fichier été sans extension");
        tokio::fs::write(&file, b"").await.unwrap();
        let zero = inventory(&file).await.unwrap();
        assert_eq!((zero.files.len(), zero.directories.len(), zero.bytes), (1, 0, 0));
        let large = tokio::fs::File::create(root.join("large.bin")).await.unwrap();
        large.set_len(64 * 1024 * 1024).await.unwrap();
        drop(large);
        let tree = inventory(&root).await.unwrap();
        assert_eq!(tree.files.len(), 2);
        assert_eq!(tree.bytes, 64 * 1024 * 1024);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn prepares_all_directories_before_returning_files_and_preserves_empty_folders() {
        let root = std::env::temp_dir().join(format!("faro-prepare-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let destination = root.join("remote");
        std::fs::create_dir_all(source.join("assets/images/empty")).unwrap();
        std::fs::write(source.join("assets/main.js"), b"script").unwrap();
        std::fs::write(source.join("index.html"), b"html").unwrap();
        let remote = destination.to_string_lossy().replace('\\', "/");
        let files = prepare_destination(&source, &remote, &crate::remotefs::local::LocalFs).await.unwrap();
        assert_eq!(files.len(), 2);
        assert!(destination.join("assets/images/empty").is_dir());
        let before = inventory(&source).await.unwrap();
        std::fs::rename(source.join("assets/main.js"), source.join("assets/replaced.js")).unwrap();
        assert!(prepare_destination_checked(&source, &remote, &crate::remotefs::local::LocalFs,
            Some(&before.fingerprint)).await.is_err(), "same-count selection changes must be detected");
        // Reusing existing folders is safe.
        assert_eq!(prepare_destination(&source, &remote, &crate::remotefs::local::LocalFs).await.unwrap().len(), 2);
        // A file where a directory is expected is never swallowed.
        std::fs::remove_dir_all(&destination).unwrap();
        std::fs::write(&destination, b"collision").unwrap();
        assert!(prepare_destination(&source, &remote, &crate::remotefs::local::LocalFs).await.is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn junction_loop_is_skipped_instead_of_followed() {
        let root = std::env::temp_dir().join(format!("faro-junction-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let junction = root.join("loop");
        let output = std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"]).arg(&junction).arg(&root).output().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        let tree = inventory(&root).await;
        let direct = inventory(&junction).await;
        // Remove just the junction, never recursively walk its target.
        std::fs::remove_dir(&junction).unwrap();
        std::fs::remove_dir(&root).unwrap();
        let tree = tree.unwrap();
        assert_eq!((tree.directories.len(), tree.files.len()), (1, 0), "nested junction is skipped");
        assert!(direct.unwrap_err().to_string().contains("reparse"));
    }
}
