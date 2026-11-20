use super::{Capabilities, ChangeSignal, DirEntry, FileKind, RemoteFs};
use crate::session::ObjectSession;
use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use futures::StreamExt;
use object_store::path::Path as ObjPath;
use object_store::ObjectStore;
use std::sync::Arc;

/// RemoteFs implementation for any object_store-backed session (S3, R2, B2,
/// Azure Blob, …). S3 and Azure directories retain exact marker keys;
/// rename completes every copy before deleting source keys.
pub struct ObjectFs {
    session: Arc<ObjectSession>,
}

impl ObjectFs {
    pub fn new(session: Arc<ObjectSession>) -> Self {
        Self { session }
    }

    /// Tags stored in the object's metadata (Plan 34 Phase 4). `Ok(None)` when
    /// this store can't hold them (only S3-compatible and Azure can).
    pub async fn object_tags(&self, path: &str) -> Result<Option<Vec<String>>> {
        if !crate::session::object::namespace::Namespace::supported(&self.session.profile.protocol) {
            return Ok(None);
        }
        let api = self.session.namespace()?;
        let key = normalize_prefix(path);
        let meta = api.get_metadata(&key).await?;
        Ok(Some(
            meta.iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(api.tags_key()))
                .map(|(_, v)| decode_tags(v))
                .unwrap_or_default(),
        ))
    }

    /// Write `tags` into the object's metadata, keeping its other metadata.
    /// Server-side; no bytes move. `Ok(false)` when the store can't hold tags.
    pub async fn set_object_tags(&self, path: &str, tags: &[String]) -> Result<bool> {
        if !crate::session::object::namespace::Namespace::supported(&self.session.profile.protocol) {
            return Ok(false);
        }
        let api = self.session.namespace()?;
        let key = normalize_prefix(path);
        let mut meta: Vec<(String, String)> = api
            .get_metadata(&key)
            .await?
            .into_iter()
            .filter(|(k, _)| !k.eq_ignore_ascii_case(api.tags_key()))
            .collect();
        if !tags.is_empty() {
            meta.push((api.tags_key().to_string(), encode_tags(tags)));
        }
        // S3 caps user metadata at 2 KiB in total.
        let total: usize = meta.iter().map(|(k, v)| k.len() + v.len()).sum();
        if total > 2000 {
            anyhow::bail!("too many tags for this file: object metadata is limited to 2 KB");
        }
        api.set_metadata(&key, &meta).await?;
        Ok(true)
    }

    /// Copy one object to another key in the same bucket/container, server
    /// side — no bytes pass through Faro (Copy to… within one connection).
    pub async fn server_copy(&self, from: &str, to: &str) -> Result<()> {
        let src = normalize_prefix(from);
        let dst = normalize_prefix(to);
        if src.is_empty() || dst.is_empty() {
            anyhow::bail!("cannot copy the bucket root");
        }
        if crate::session::object::namespace::Namespace::supported(&self.session.profile.protocol) {
            return self.session.namespace()?.copy(&src, &dst).await;
        }
        self.session
            .store
            .copy(&ObjPath::parse(&src)?, &ObjPath::parse(&dst)?)
            .await
            .with_context(|| format!("object copy {src} -> {dst}"))
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod tag_encoding_tests {
    #[test]
    fn tags_round_trip_through_a_header_value() {
        let tags = vec!["café".to_string(), "50%".to_string(), "client x".to_string()];
        let raw = super::encode_tags(&tags);
        assert!(raw.is_ascii(), "{raw}");
        assert_eq!(super::decode_tags(&raw), vec!["50%", "café", "client x"]);
    }
}

/// Tags as one metadata value: comma-separated, percent-encoded so non-ASCII
/// survives HTTP headers.
pub fn encode_tags(tags: &[String]) -> String {
    // Non-ASCII bytes are always escaped; `%` too, so decoding is exact.
    const SET: &percent_encoding::AsciiSet = &percent_encoding::CONTROLS.add(b'%');
    percent_encoding::utf8_percent_encode(&tags.join(","), SET).to_string()
}

pub fn decode_tags(raw: &str) -> Vec<String> {
    let text = percent_encoding::percent_decode_str(raw).decode_utf8_lossy().into_owned();
    crate::fileindex::normalize_tags(&[text])
}

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
        link_dir: false,
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
        link_dir: false,
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
        if crate::session::object::namespace::Namespace::supported(&self.session.profile.protocol) {
            let api = self.session.namespace()?;
            let prefix = if prefix.is_empty() { prefix } else { format!("{prefix}/") };
            let listing = api.list(&prefix, true).await?;
            if !prefix.is_empty() && listing.objects.is_empty() && listing.prefixes.is_empty() {
                return Err(std::io::Error::new(std::io::ErrorKind::NotFound, format!("Object prefix {prefix} does not exist")).into());
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
        if crate::session::object::namespace::Namespace::supported(&self.session.profile.protocol) {
            let api = self.session.namespace()?;
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
                let relative = o.key.strip_prefix(&src).context("Object listing returned a key outside the requested prefix")?;
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
        if crate::session::object::namespace::Namespace::supported(&self.session.profile.protocol) {
            let api = self.session.namespace()?;
            if !key.is_empty() && !path.ends_with('/') && api.exists(&key).await? {
                return api.delete(&key).await;
            }
            if !recursive { anyhow::bail!("{path} is a directory or missing; use recursive for directories"); }
            let prefix = if key.is_empty() { key } else { format!("{key}/") };
            let listing = api.list(&prefix, false).await?;
            // Complete the listing before deleting: list errors cannot silently
            // produce an incomplete successful deletion.
            for o in listing.objects {
                if !o.key.starts_with(&prefix) { anyhow::bail!("Object listing returned a key outside the requested prefix"); }
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
        if crate::session::object::namespace::Namespace::supported(&self.session.profile.protocol) {
            let key = normalize_prefix(path);
            if !key.is_empty() {
                return self.session.namespace()?
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
            has_directories: crate::session::object::namespace::Namespace::supported(&self.session.profile.protocol),
            has_shell: false,
            has_commands: false,
            // Object stores expose an ETag per object — an opaque change token
            // (not necessarily an MD5 for multipart uploads). See ChangeSignal.
            change_signal: ChangeSignal::Etag,
        }
    }
}
