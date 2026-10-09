use super::{Capabilities, ChangeSignal, DirEntry, FileKind, RemoteFs};
use crate::session::ObjectSession;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use futures::StreamExt;
use object_store::path::Path as ObjPath;
use object_store::ObjectStore;
use std::sync::Arc;

/// RemoteFs implementation for any object_store-backed session (S3, R2, B2,
/// Azure Blob, …). S3 directories use exact trailing-slash marker keys;
/// rename is copy then delete. Other stores retain their implicit prefixes.
pub struct ObjectFs {
    session: Arc<ObjectSession>,
}

impl ObjectFs {
    pub fn new(session: Arc<ObjectSession>) -> Self {
        Self { session }
    }
}

#[cfg(test)]
mod tests;

fn normalize_prefix(raw: &str) -> String {
    let trimmed = raw.trim_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        String::new()
    } else {
        trimmed.to_string()
    }
}

fn entry_for_object(
    key: &str,
    size: u64,
    modified_secs: Option<i64>,
    etag: Option<String>,
) -> DirEntry {
    let name = key.rsplit('/').next().unwrap_or(key).to_string();
    DirEntry {
        name,
        path: format!("/{key}"),
        kind: FileKind::File,
        size,
        modified: modified_secs,
        mode: None,
        etag,
    }
}

fn entry_for_prefix(prefix: &str) -> DirEntry {
    let trimmed = prefix.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed).to_string();
    DirEntry {
        name,
        path: format!("/{trimmed}"),
        kind: FileKind::Directory,
        size: 0,
        modified: None,
        mode: None,
        etag: None,
    }
}

#[async_trait]
impl RemoteFs for ObjectFs {
    async fn list_dir(&self, path: &str) -> Result<Vec<DirEntry>> {
        let prefix = normalize_prefix(path);
        if self.session.profile.protocol == "s3" {
            let api = crate::session::object::s3_namespace::S3Namespace::new(&self.session.profile)?;
            let prefix = if prefix.is_empty() { prefix } else { format!("{prefix}/") };
            let listing = api.list(&prefix, true).await?;
            if !prefix.is_empty() && listing.objects.is_empty() && listing.prefixes.is_empty() {
                return Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("S3 prefix {prefix} does not exist")).into());
            }
            let mut entries = Vec::new();
            for p in listing.prefixes {
                let mut entry = entry_for_prefix(&p.prefix);
                // Keep the slash to distinguish a directory from a same-named file.
                entry.path.push('/');
                entries.push(entry);
            }
            for o in listing.objects {
                if o.key == prefix { continue; }
                if o.key.ends_with('/') {
                    let mut entry = entry_for_prefix(&o.key);
                    entry.path.push('/');
                    entries.push(entry);
                } else {
                    entries.push(entry_for_object(&o.key, o.size,
                        Some(chrono::DateTime::parse_from_rfc3339(&o.last_modified)?.timestamp()), o.etag));
                }
            }
            return Ok(entries);
        }
        let prefix_path = if prefix.is_empty() {
            None
        } else {
            Some(ObjPath::parse(prefix.as_str())?)
        };

        let listing = self
            .session
            .store
            .list_with_delimiter(prefix_path.as_ref())
            .await
            .with_context(|| format!("list {}/{prefix}", self.session.container))?;

        let mut out =
            Vec::with_capacity(listing.objects.len() + listing.common_prefixes.len());
        for cp in listing.common_prefixes {
            out.push(entry_for_prefix(cp.as_ref()));
        }
        for obj in listing.objects {
            // ListObjects(prefix="dir/", delimiter="/") can include the
            // directory marker "dir/" itself. object_store::Path removes its
            // trailing slash, so it arrives as "dir". It is not a child file:
            // queuing it would HEAD "dir" and fail (issue #33).
            if prefix_path.as_ref() == Some(&obj.location) {
                continue;
            }
            let modified = obj.last_modified.timestamp();
            out.push(entry_for_object(
                obj.location.as_ref(),
                obj.size as u64,
                Some(modified),
                obj.e_tag.clone(),
            ));
        }
        Ok(out)
    }

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        if self.session.profile.protocol == "s3" {
            let api = crate::session::object::s3_namespace::S3Namespace::new(&self.session.profile)?;
            let src = normalize_prefix(from);
            let dst = normalize_prefix(to);
            if src.is_empty() || dst.is_empty() { anyhow::bail!("cannot rename the bucket root"); }
            if src == dst { return Ok(()); }
            if !from.ends_with('/') && api.exists(&src).await? {
                api.copy(&src, &dst).await?;
                return api.delete(&src).await;
            }
            let src = format!("{src}/");
            let dst = format!("{dst}/");
            if dst.starts_with(&src) || src.starts_with(&dst) { anyhow::bail!("directory rename paths overlap"); }
            let listing = api.list(&src, false).await?;
            if listing.objects.is_empty() { anyhow::bail!("source directory does not exist: {src}"); }
            if !api.list(&dst, false).await?.objects.is_empty() { anyhow::bail!("destination directory already exists: {dst}"); }
            // Finish all copies before deleting any source key. A failed copy
            // leaves the originals available for recovery.
            for o in &listing.objects {
                let relative = o.key.strip_prefix(&src).context("S3 returned a key outside the requested prefix")?;
                api.copy(&o.key, &format!("{dst}{relative}")).await?;
            }
            for o in listing.objects { api.delete(&o.key).await?; }
            return Ok(());
        }
        let src = ObjPath::parse(normalize_prefix(from))?;
        let dst = ObjPath::parse(normalize_prefix(to))?;
        self.session
            .store
            .rename(&src, &dst)
            .await
            .with_context(|| format!("object rename {src} -> {dst}"))?;
        Ok(())
    }

    async fn delete(&self, path: &str, recursive: bool) -> Result<()> {
        let key = normalize_prefix(path);
        if self.session.profile.protocol == "s3" {
            let api = crate::session::object::s3_namespace::S3Namespace::new(&self.session.profile)?;
            if !key.is_empty() && !path.ends_with('/') && api.exists(&key).await? {
                return api.delete(&key).await;
            }
            if !recursive { anyhow::bail!("{path} is a directory or missing; use recursive for directories"); }
            let prefix = if key.is_empty() { key } else { format!("{key}/") };
            let listing = api.list(&prefix, false).await?;
            // Complete the listing before deleting: list errors cannot silently
            // produce an incomplete successful deletion.
            for o in listing.objects {
                if !o.key.starts_with(&prefix) { anyhow::bail!("S3 returned a key outside the requested prefix"); }
                api.delete(&o.key).await?;
            }
            return Ok(());
        }
        let target = ObjPath::parse(key.as_str())?;
        let is_object = match self.session.store.head(&target).await {
            Ok(_) => true,
            Err(object_store::Error::NotFound { .. }) => false,
            Err(e) => return Err(e.into()),
        };

        if is_object {
            self.session
                .store
                .delete(&target)
                .await
                .with_context(|| format!("delete {target}"))?;
            return Ok(());
        }
        if !recursive {
            return Err(anyhow!(
                "{target} is a prefix; pass recursive=true to remove all objects under it"
            ));
        }
        let mut stream = self.session.store.list(Some(&target));
        while let Some(meta) = stream.next().await {
            let meta = meta.with_context(|| format!("list under {target}"))?;
            self.session
                .store
                .delete(&meta.location)
                .await
                .with_context(|| format!("delete {}", meta.location))?;
        }
        Ok(())
    }

    async fn create_dir(&self, path: &str) -> Result<()> {
        if self.session.profile.protocol == "s3" {
            let key = normalize_prefix(path);
            if !key.is_empty() {
                return crate::session::object::s3_namespace::S3Namespace::new(&self.session.profile)?
                    .mkdir(&format!("{key}/")).await;
            }
        }
        // Object stores have no folders. Accepted as a no-op so the UI's
        // mkdir flow doesn't error; the prefix appears once the first
        // object lands in it.
        Ok(())
    }

    async fn chmod(&self, _path: &str, _mode: u32) -> Result<()> {
        Err(anyhow!("object stores have no POSIX permissions"))
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            can_chmod: false,
            can_symlink: false,
            can_rename: true,
            has_directories: self.session.profile.protocol == "s3",
            has_shell: false,
            has_commands: false,
            // Object stores expose an ETag per object — an opaque change token
            // (not necessarily an MD5 for multipart uploads). See ChangeSignal.
            change_signal: ChangeSignal::Etag,
        }
    }
}
