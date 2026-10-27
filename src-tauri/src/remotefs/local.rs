use super::{Capabilities, ChangeSignal, DirEntry, FileKind, RemoteFs};
use anyhow::{anyhow, Context};
use async_trait::async_trait;
use std::path::Path;

pub struct LocalFs;

#[async_trait]
impl RemoteFs for LocalFs {
    async fn list_dir(&self, path: &str) -> anyhow::Result<Vec<DirEntry>> {
        let p = Path::new(path).to_path_buf();
        let mut rd = tokio::fs::read_dir(&p)
            .await
            .with_context(|| format!("read_dir {}", p.display()))?;
        let mut out = Vec::new();
        while let Some(entry) = rd.next_entry().await? {
            let meta = entry.metadata().await
                .with_context(|| format!("stat {}", entry.path().display()))?;
            let kind = if meta.is_dir() {
                FileKind::Directory
            } else if meta.file_type().is_symlink() {
                FileKind::Symlink
            } else if meta.is_file() {
                FileKind::File
            } else {
                FileKind::Other
            };
            // Where a link leads: a folder is opened like one. A broken link
            // stays a plain link.
            let link_dir = kind == FileKind::Symlink
                && tokio::fs::metadata(entry.path()).await.is_ok_and(|m| m.is_dir());
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64);
            out.push(DirEntry {
                link_dir,
                name: entry.file_name().to_string_lossy().into_owned(),
                path: entry.path().to_string_lossy().into_owned(),
                kind,
                size: meta.len(),
                modified,
                mode: None,
                etag: None,
            });
        }
        Ok(out)
    }

    async fn rename(&self, from: &str, to: &str) -> anyhow::Result<()> {
        tokio::fs::rename(from, to)
            .await
            .with_context(|| format!("rename {from} -> {to}"))?;
        Ok(())
    }

    async fn delete(&self, path: &str, recursive: bool) -> anyhow::Result<()> {
        let meta = tokio::fs::symlink_metadata(path)
            .await
            .with_context(|| format!("stat {path}"))?;
        if meta.file_type().is_symlink() {
            // Only the link goes, never what it points at. Windows needs
            // remove_dir for a directory link or junction.
            #[cfg(windows)]
            {
                use std::os::windows::fs::FileTypeExt;
                if meta.file_type().is_symlink_dir() {
                    tokio::fs::remove_dir(path).await.with_context(|| format!("remove link {path}"))?;
                    return Ok(());
                }
            }
            tokio::fs::remove_file(path).await.with_context(|| format!("remove link {path}"))?;
        } else if meta.is_dir() {
            if recursive {
                tokio::fs::remove_dir_all(path).await?;
            } else {
                tokio::fs::remove_dir(path).await?;
            }
        } else {
            tokio::fs::remove_file(path).await?;
        }
        Ok(())
    }

    async fn create_dir(&self, path: &str) -> anyhow::Result<()> {
        tokio::fs::create_dir(path)
            .await
            .with_context(|| format!("create_dir {path}"))?;
        Ok(())
    }

    async fn chmod(&self, path: &str, mode: u32) -> anyhow::Result<()> {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let perms = std::fs::Permissions::from_mode(mode);
            tokio::fs::set_permissions(path, perms)
                .await
                .with_context(|| format!("chmod {path}"))?;
            Ok(())
        }
        #[cfg(not(unix))]
        {
            let _ = (path, mode);
            Err(anyhow!("chmod is not supported on this platform"))
        }
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            can_chmod: cfg!(unix),
            can_symlink: true,
            can_rename: true,
            has_directories: true,
            has_shell: false,
            has_commands: false,
            change_signal: ChangeSignal::MtimeSize,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A link to a folder: a junction on Windows (no admin rights needed,
    /// unlike a symlink), a symlink elsewhere.
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(windows)]
        {
            let ok = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "mklink /J failed");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[tokio::test]
    async fn a_link_to_a_folder_opens_like_one_and_deletes_alone() {
        let root = std::env::temp_dir().join(format!("faro-local-links-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let target = root.join("real");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("inside.txt"), b"x").unwrap();
        std::fs::write(root.join("plain.txt"), b"y").unwrap();
        link_dir(&target, &root.join("linked"));

        let fs = LocalFs;
        let entries = fs.list_dir(root.to_str().unwrap()).await.unwrap();
        let get = |n: &str| entries.iter().find(|e| e.name == n).unwrap();
        assert_eq!(get("linked").kind, FileKind::Symlink);
        assert!(get("linked").link_dir, "the link leads to a folder");
        assert!(!get("plain.txt").link_dir && !get("real").link_dir);
        let through = fs.list_dir(get("linked").path.as_str()).await.unwrap();
        assert_eq!(through[0].name, "inside.txt");

        // Deleting the link (even "recursively") leaves the folder it points at.
        fs.delete(get("linked").path.as_str(), true).await.unwrap();
        assert!(!root.join("linked").exists());
        assert!(target.join("inside.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
