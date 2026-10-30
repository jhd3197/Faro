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

    struct TempDir(std::path::PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_root(tag: &str) -> TempDir {
        let root = std::env::temp_dir().join(format!(
            "faro-local-links-{tag}-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        TempDir(root)
    }

    /// A link to a folder that does not need extra privileges: a junction on
    /// Windows, a symlink elsewhere.
    fn link_dir(target: &Path, link: &Path) {
        #[cfg(windows)]
        mklink(Some("/J"), link, target);
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[cfg(unix)]
    fn link_file(target: &Path, link: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    #[cfg(unix)]
    fn link_broken(link: &Path) {
        std::os::unix::fs::symlink("missing-target", link).unwrap();
    }

    #[cfg(windows)]
    fn mklink(flag: Option<&str>, link: &Path, target: &Path) {
        let mut cmd = std::process::Command::new("cmd");
        cmd.arg("/C").arg("mklink");
        if let Some(flag) = flag {
            cmd.arg(flag);
        }
        let out = cmd.arg(link).arg(target).output().expect("run mklink");
        assert!(
            out.status.success(),
            "mklink {flag:?} {} -> {} failed: {}{}",
            link.display(),
            target.display(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn entry<'a>(entries: &'a [DirEntry], name: &str) -> &'a DirEntry {
        entries.iter().find(|e| e.name == name).unwrap_or_else(|| {
            panic!("missing {name} in {}", entries.iter().map(|e| e.name.as_str()).collect::<Vec<_>>().join(", "))
        })
    }

    fn is_link(path: &Path) -> bool {
        std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink())
    }

    #[tokio::test]
    async fn directory_file_and_broken_links_keep_their_kind() {
        let root = temp_root("kinds");
        let target = root.0.join("real");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("inside.txt"), b"x").unwrap();
        std::fs::write(root.0.join("plain.txt"), b"y").unwrap();
        link_dir(&target, &root.0.join("linked"));
        #[cfg(unix)]
        {
            link_file(&target.join("inside.txt"), &root.0.join("file-link"));
            link_broken(&root.0.join("broken"));
        }

        let fs = LocalFs;
        let entries = fs.list_dir(root.0.to_str().unwrap()).await.unwrap();
        let linked = entry(&entries, "linked");
        assert_eq!(linked.kind, FileKind::Symlink);
        assert!(linked.link_dir, "a directory link opens like a folder");
        let through = fs.list_dir(&linked.path).await.unwrap();
        assert_eq!(through[0].name, "inside.txt");

        #[cfg(unix)]
        {
            let file_link = entry(&entries, "file-link");
            assert_eq!(file_link.kind, FileKind::Symlink);
            assert!(!file_link.link_dir, "a file link is not a folder");

            let broken = entry(&entries, "broken");
            assert_eq!(broken.kind, FileKind::Symlink);
            assert!(!broken.link_dir, "a missing target stays a plain link");
        }

        assert_eq!(entry(&entries, "real").kind, FileKind::Directory);
        assert!(!entry(&entries, "real").link_dir);
        assert_eq!(entry(&entries, "plain.txt").kind, FileKind::File);
        assert!(!entry(&entries, "plain.txt").link_dir);
    }

    #[tokio::test]
    async fn copying_a_directory_link_copies_the_folder_and_delete_removes_only_the_link() {
        let root = temp_root("copy-delete");
        let target = root.0.join("real");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("inside.txt"), b"payload").unwrap();
        std::fs::write(root.0.join("note.txt"), b"note").unwrap();
        link_dir(&target, &root.0.join("linked"));
        #[cfg(unix)]
        {
            link_file(&root.0.join("note.txt"), &root.0.join("file-link"));
            link_broken(&root.0.join("broken"));
        }

        let linked = root.0.join("linked");
        crate::commands::duplicate_local(linked.to_str().unwrap()).unwrap();
        let copied = root.0.join("linked copy");
        assert!(copied.is_dir(), "the copy is a real folder");
        assert!(!is_link(&copied), "the copy is not another link");
        assert_eq!(std::fs::read(copied.join("inside.txt")).unwrap(), b"payload");
        assert!(is_link(&linked), "the original link is still there");
        assert_eq!(std::fs::read(target.join("inside.txt")).unwrap(), b"payload");

        #[cfg(unix)]
        {
            crate::commands::duplicate_local(root.0.join("file-link").to_str().unwrap()).unwrap();
            let file_copy = root.0.join("file-link copy");
            assert!(!is_link(&file_copy));
            assert_eq!(std::fs::read(&file_copy).unwrap(), b"note");
            assert!(is_link(&root.0.join("file-link")));
            assert_eq!(std::fs::read(root.0.join("note.txt")).unwrap(), b"note");

            assert!(crate::commands::duplicate_local(root.0.join("broken").to_str().unwrap()).is_err());
            assert!(is_link(&root.0.join("broken")));
        }

        let fs = LocalFs;
        // Recursive delete of a link still must not walk into the target.
        fs.delete(linked.to_str().unwrap(), true).await.unwrap();
        assert!(!is_link(&linked));
        assert!(target.join("inside.txt").is_file());
        assert!(copied.join("inside.txt").is_file());

        #[cfg(unix)]
        {
            fs.delete(root.0.join("file-link").to_str().unwrap(), false).await.unwrap();
            assert!(root.0.join("note.txt").is_file());
            fs.delete(root.0.join("broken").to_str().unwrap(), true).await.unwrap();
            assert!(std::fs::symlink_metadata(root.0.join("broken")).is_err());
        }
    }

    /// Real Windows directory symlinks (`mklink /D`) plus a junction. Creating
    /// the symlink needs Developer Mode or an elevated token; GitHub-hosted
    /// Windows runners have that, a typical desktop may not. The junction case
    /// always runs. CI today is Ubuntu-only, so this test runs when the suite
    /// itself is on Windows.
    #[cfg(windows)]
    #[tokio::test]
    async fn windows_directory_symlink_and_junction() {
        let root = temp_root("win-links");
        let target = root.0.join("real");
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("inside.txt"), b"payload").unwrap();

        let junction = root.0.join("junction");
        mklink(Some("/J"), &junction, &target);

        let symlink = root.0.join("dir-symlink");
        let mut cmd = std::process::Command::new("cmd");
        let out = cmd
            .arg("/C")
            .arg("mklink")
            .arg("/D")
            .arg(&symlink)
            .arg(&target)
            .output()
            .expect("run mklink /D");
        let symlink_ok = out.status.success();
        if !symlink_ok && std::env::var_os("CI").is_some() {
            panic!(
                "Windows CI should be able to create a directory symlink (mklink /D): {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        }
        if !symlink_ok {
            eprintln!(
                "skipping mklink /D (no symlink privilege); the junction is still checked: {}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            );
        } else {
            std::fs::write(root.0.join("note.txt"), b"note").unwrap();
            mklink(None, &root.0.join("file-link"), &root.0.join("note.txt"));
            mklink(Some("/D"), &root.0.join("broken"), &root.0.join("missing-target"));
        }

        let fs = LocalFs;
        let entries = fs.list_dir(root.0.to_str().unwrap()).await.unwrap();
        for name in ["junction"].into_iter().chain(symlink_ok.then_some("dir-symlink")) {
            let e = entry(&entries, name);
            assert_eq!(e.kind, FileKind::Symlink, "{name}");
            assert!(e.link_dir, "{name} leads to a folder");
            let through = fs.list_dir(&e.path).await.unwrap();
            assert!(through.iter().any(|c| c.name == "inside.txt"), "{name} opens");

            crate::commands::duplicate_local(&e.path).unwrap();
            let copied = root.0.join(format!("{name} copy"));
            assert!(copied.join("inside.txt").is_file(), "copying {name} copies the folder");
            assert!(!is_link(&copied));
            assert!(is_link(&root.0.join(name)));
            assert!(target.join("inside.txt").is_file());

            fs.delete(&e.path, true).await.unwrap();
            assert!(!is_link(&root.0.join(name)), "deleting {name} removes only the link");
            assert_eq!(std::fs::read(target.join("inside.txt")).unwrap(), b"payload");
            assert_eq!(std::fs::read(copied.join("inside.txt")).unwrap(), b"payload");
        }

        if symlink_ok {
            let entries = fs.list_dir(root.0.to_str().unwrap()).await.unwrap();
            let file_link = entry(&entries, "file-link");
            assert_eq!(file_link.kind, FileKind::Symlink);
            assert!(!file_link.link_dir);
            let broken = entry(&entries, "broken");
            assert_eq!(broken.kind, FileKind::Symlink);
            assert!(!broken.link_dir, "a directory symlink with no target stays a plain link");

            crate::commands::duplicate_local(&file_link.path).unwrap();
            assert_eq!(std::fs::read(root.0.join("file-link copy")).unwrap(), b"note");
            assert!(is_link(&root.0.join("file-link")));
            fs.delete(&file_link.path, false).await.unwrap();
            assert!(root.0.join("note.txt").is_file());

            fs.delete(&broken.path, true).await.unwrap();
            assert!(std::fs::symlink_metadata(&broken.path).is_err());
        }
    }
}
