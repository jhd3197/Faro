//! Windows Cloud Filter provider for on-demand virtual folders (Plan 9).
//!
//! Built on the safe `cloud-filter` wrapper over `cldapi.dll`, so the unsafe
//! minifilter surface stays in a vetted crate rather than hand-rolled FFI —
//! important for code that can only be verified manually in Explorer.
//!
//! Per on-demand pair we:
//!   1. Register a **per-pair sync root** (`Faro.<pair-id>` + the user's SID) so
//!      each folder is its own registration and orphan cleanup is exact.
//!   2. Eagerly create top-level placeholders from a `RemoteFs::list_dir` walk.
//!   3. Connect a [`FaroFilter`] whose `fetch_data` **hydrates** on access by
//!      downloading through the same `TransferManager` path the UI uses, and
//!      whose `fetch_placeholders` lazily populates subdirectories on expand.
//!
//! The `SyncFilter` callbacks are synchronous and run on OS threads, so they
//! bridge to Faro's async backends via a captured `tokio::runtime::Handle` and
//! `block_on` — safe here because these are cldapi-owned threads, never tokio
//! workers.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{anyhow, Result};
use tokio::runtime::Handle;

use cloud_filter::error::{CResult, CloudErrorKind};
use cloud_filter::filter::{info, ticket, Request, SyncFilter};
use cloud_filter::metadata::Metadata;
use cloud_filter::placeholder_file::PlaceholderFile;
use cloud_filter::root::{Connection, Session};
use cloud_filter::utility::{FileTime, WriteAt};

use windows::core::{GUID, PCWSTR};
use windows::Win32::Storage::CloudFilters::{
    CfGetSyncRootInfoByPath, CfRegisterSyncRoot, CF_POPULATION_POLICY, CF_POPULATION_POLICY_FULL, CfUnregisterSyncRoot, CF_REGISTER_FLAG_UPDATE,
    CF_SYNC_POLICIES, CF_SYNC_REGISTRATION, CF_SYNC_ROOT_BASIC_INFO, CF_SYNC_ROOT_INFO_BASIC,
};

use super::{plan_refresh, Hydrator, LocalEntry, RootConfig};
use crate::remotefs::FileKind;

/// Cloud Filter reads/writes must be 4 KiB-aligned except the final chunk.
const CHUNK: usize = 64 * 1024;

/// Stable provider identity shared by every Faro on-demand root — Win32
/// registration keys a sync root by its *path*, so one provider id covers all
/// pairs and each folder is its own registration.
const FARO_PROVIDER_ID: GUID = GUID::from_u128(0xFA504F61_726F_4661_726F_0DE0_0DE00001u128);

/// On-demand virtual folders are available when the Cloud Filter API is present
/// (Windows 10 1709+). `is_supported()` is the OS-level probe.
pub fn supported() -> bool {
    cloud_filter::root::is_supported().unwrap_or(false)
}

/// A NUL-terminated UTF-16 buffer for a `PCWSTR` argument. Keep the returned
/// `Vec` alive for the duration of the call.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Register `local_root` as a Cloud Filter sync root via the **Win32**
/// `CfRegisterSyncRoot` (not the WinRT `StorageProviderSyncRootManager`, which
/// needs package identity). Idempotent — `CF_REGISTER_FLAG_UPDATE` updates an
/// existing registration instead of failing. Policies default to Partial
/// hydration + Partial population = fully on-demand (fetch on open, populate
/// subdirs lazily via `fetch_placeholders`).
fn register_root(local_root: &Path) -> Result<()> {
    let path = wide(&local_root.to_string_lossy());
    let name = wide("Faro");
    let version = wide(env!("CARGO_PKG_VERSION"));
    let registration = CF_SYNC_REGISTRATION {
        StructSize: std::mem::size_of::<CF_SYNC_REGISTRATION>() as u32,
        ProviderName: PCWSTR(name.as_ptr()),
        ProviderVersion: PCWSTR(version.as_ptr()),
        ProviderId: FARO_PROVIDER_ID,
        ..Default::default()
    };
    // Population must be FULL: with the default (PARTIAL, documented as "not
    // supported") the platform never calls FETCH_PLACEHOLDERS, so subfolders
    // stay empty. FULL asks us once per directory, on first enumeration.
    let policies = CF_SYNC_POLICIES {
        StructSize: std::mem::size_of::<CF_SYNC_POLICIES>() as u32,
        Population: CF_POPULATION_POLICY {
            Primary: CF_POPULATION_POLICY_FULL,
            ..Default::default()
        },
        ..Default::default()
    };
    unsafe {
        CfRegisterSyncRoot(
            PCWSTR(path.as_ptr()),
            &registration,
            &policies,
            CF_REGISTER_FLAG_UPDATE,
        )
        .map_err(|e| anyhow!("CfRegisterSyncRoot {}: {e}", local_root.display()))?;
    }
    Ok(())
}

/// Whether `local_root` is currently a registered sync root (Win32 probe).
fn is_registered(local_root: &Path) -> bool {
    let path = wide(&local_root.to_string_lossy());
    let mut info = CF_SYNC_ROOT_BASIC_INFO::default();
    let mut returned = 0u32;
    unsafe {
        CfGetSyncRootInfoByPath(
            PCWSTR(path.as_ptr()),
            CF_SYNC_ROOT_INFO_BASIC,
            &mut info as *mut _ as *mut std::ffi::c_void,
            std::mem::size_of::<CF_SYNC_ROOT_BASIC_INFO>() as u32,
            Some(&mut returned),
        )
        .is_ok()
    }
}

/// A live on-demand root: the Cloud Filter connection plus its registration id.
/// Dropping `connection` disconnects (leaving the folder present-but-offline);
/// full removal additionally calls [`unregister_root`].
pub struct Provider {
    connection: Connection<FaroFilter>,
    local_root: PathBuf,
    /// The top-level refresh poll; aborted on stop.
    refresh: Option<tokio::task::JoinHandle<()>>,
}

impl Provider {
    pub async fn start(config: RootConfig, hydrator: Arc<dyn Hydrator>) -> Result<Provider> {
        let RootConfig { local_root, remote_root, refresh_secs } = config;
        // Register the sync root (idempotent). Keyed by path via the Win32 API.
        register_root(&local_root)?;

        // Seed the top level from the remote listing so the folder isn't empty
        // before the first Explorer-driven population. Best-effort per entry.
        refresh_top_level(&local_root, &remote_root, hydrator.as_ref()).await;

        let filter = FaroFilter {
            hydrator: hydrator.clone(),
            runtime: Handle::current(),
            remote_root: remote_root.clone(),
            local_root: local_root.clone(),
        };
        let connection = Session::new()
            .connect(&local_root, filter)
            .map_err(|e| anyhow!("connect sync root {}: {e:?}", local_root.display()))?;

        // Placeholders below the top level are listed fresh whenever Explorer
        // expands a folder; the top level is seeded once, so re-list it on a
        // timer to pick up files added or removed on the remote after start.
        let refresh = (refresh_secs > 0).then(|| {
            let (root, remote) = (local_root.clone(), remote_root.clone());
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(refresh_secs));
                tick.tick().await; // the first tick fires immediately; seeded above
                loop {
                    tick.tick().await;
                    refresh_top_level(&root, &remote, hydrator.as_ref()).await;
                }
            })
        });

        Ok(Provider { connection, local_root, refresh })
    }

    /// Explorer-style "Free up space": mark every hydrated placeholder Unpinned,
    /// which asks the platform to dehydrate it (our `dehydrate` callback allows
    /// it). Returns how many files we marked. Best-effort; non-placeholders and
    /// already-dehydrated files are skipped.
    pub async fn free_up_space(&self) -> Result<u32> {
        Ok(dehydrate_tree(&self.local_root))
    }

    /// Paths (relative, `/`-separated) of files edited in the folder that the
    /// remote doesn't have: placeholders marked not-in-sync, plus plain files
    /// created locally. These stay on this PC until write-back uploads them.
    pub fn local_changes(&self) -> Vec<String> {
        let mut out = Vec::new();
        collect_local_changes(&self.local_root, &self.local_root, &mut out);
        out.sort();
        out
    }

    /// Disconnect (keep the registration + placeholders on disk).
    pub fn stop(self) {
        if let Some(r) = &self.refresh {
            r.abort();
        }
        drop(self.connection);
    }
}

/// `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS`: the file's bytes are not on disk.
const RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
/// `FILE_ATTRIBUTE_RECALL_ON_OPEN`: a directory whose children were never listed.
const RECALL_ON_OPEN: u32 = 0x0004_0000;

/// Whether `path` is a placeholder with nothing local in it: a file whose bytes
/// aren't (fully) on disk and that was never edited, or a directory never
/// populated. Uses the recall attribute, not `CF_PLACEHOLDER_STANDARD_INFO`'s
/// size fields — those report the full logical size for a fresh placeholder.
fn untouched_placeholder(path: &Path, is_dir: bool) -> bool {
    use std::os::windows::fs::MetadataExt;
    let Ok(meta) = std::fs::symlink_metadata(path) else { return false };
    let attrs = meta.file_attributes();
    if is_dir {
        return attrs & RECALL_ON_OPEN != 0;
    }
    if attrs & RECALL_ON_DATA_ACCESS == 0 {
        return false;
    }
    placeholder_in_sync(path) == Some(true)
}

/// A placeholder's in-sync state, read through a plain attributes-only handle.
/// `None` when `path` isn't a placeholder. Deliberately not
/// `cloud_filter::Placeholder::open`: its oplock open makes the platform
/// re-hydrate a freed file, undoing "Free up space".
fn placeholder_in_sync(path: &Path) -> Option<bool> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::CloudFilters::{
        CfGetPlaceholderInfo, CF_IN_SYNC_STATE_IN_SYNC, CF_PLACEHOLDER_BASIC_INFO,
        CF_PLACEHOLDER_INFO_BASIC,
    };
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000; // lets a directory open too
    let file = std::fs::OpenOptions::new()
        .access_mode(FILE_READ_ATTRIBUTES)
        .share_mode(0x7)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .ok()?;
    // Basic info is followed by the file identity blob (our remote path).
    let mut buf = vec![0u8; std::mem::size_of::<CF_PLACEHOLDER_BASIC_INFO>() + 4096];
    let mut returned = 0u32;
    unsafe {
        CfGetPlaceholderInfo(
            HANDLE(file.as_raw_handle()),
            CF_PLACEHOLDER_INFO_BASIC,
            buf.as_mut_ptr() as *mut std::ffi::c_void,
            buf.len() as u32,
            Some(&mut returned),
        )
        .ok()?;
        let info = &*(buf.as_ptr() as *const CF_PLACEHOLDER_BASIC_INFO);
        Some(info.InSyncState == CF_IN_SYNC_STATE_IN_SYNC)
    }
}

fn collect_local_changes(root: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for entry in rd.flatten() {
        let path = entry.path();
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect_local_changes(root, &path, out);
            continue;
        }
        if !ft.is_file() {
            continue;
        }
        // Not a placeholder at all (None) means it was created here.
        let changed = placeholder_in_sync(&path) != Some(true);
        if changed {
            let rel = path.strip_prefix(root).unwrap_or(&path);
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// Remove every untouched placeholder under `root` (and folders left empty by
/// that), keeping anything that holds local data. Called when a root is torn
/// down, so the folder doesn't keep icons that can never open. Returns the
/// number of files removed.
pub fn clear_placeholders(root: &Path) -> u32 {
    fn walk(dir: &Path) -> u32 {
        let mut n = 0;
        let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
        for entry in rd.flatten() {
            let path = entry.path();
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                let never_listed = untouched_placeholder(&path, true);
                n += walk(&path);
                // Only an empty folder goes; one holding local files stays.
                if never_listed || std::fs::read_dir(&path).map(|mut d| d.next().is_none()).unwrap_or(false) {
                    let _ = std::fs::remove_dir(&path);
                }
            } else if ft.is_file() && untouched_placeholder(&path, false) && std::fs::remove_file(&path).is_ok() {
                n += 1;
            }
        }
        n
    }
    walk(root)
}

/// Unregister a sync root by path — the orphan-safety primitive. The live
/// `Provider` (if any) is dropped by the caller first (disconnect), then this
/// removes the OS registration. Works from just the persisted `local_root`, so a
/// root left over from a crash or config wipe still gets cleaned up.
pub fn unregister_root(_pair_id: &str, local_root: Option<&Path>) -> Result<()> {
    let Some(root) = local_root else {
        return Ok(()); // nothing to key off — can't have registered it
    };
    if !is_registered(root) {
        return Ok(());
    }
    let path = wide(&root.to_string_lossy());
    unsafe {
        CfUnregisterSyncRoot(PCWSTR(path.as_ptr()))
            .map_err(|e| anyhow!("CfUnregisterSyncRoot {}: {e}", root.display()))?;
    }
    Ok(())
}

/// Bring the top level of `local_root` in line with the remote listing: create
/// placeholders for new remote entries, drop untouched placeholders whose remote
/// is gone, and recreate untouched placeholders whose size changed. Entries
/// holding local data are never removed (see [`plan_refresh`]).
async fn refresh_top_level(local_root: &Path, remote_root: &str, hydrator: &dyn Hydrator) {
    let remote = match hydrator.list_dir(remote_root).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("virtualfs: refresh list_dir {remote_root}: {e:#}");
            return;
        }
    };
    let local: Vec<LocalEntry> = std::fs::read_dir(local_root)
        .map(|rd| {
            rd.flatten()
                .filter_map(|e| {
                    let ft = e.file_type().ok()?;
                    let path = e.path();
                    Some(LocalEntry {
                        name: e.file_name().to_string_lossy().into_owned(),
                        is_dir: ft.is_dir(),
                        size: e.metadata().map(|m| m.len()).unwrap_or(0),
                        untouched_placeholder: untouched_placeholder(&path, ft.is_dir()),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let plan = plan_refresh(&local, &remote);

    for name in plan.remove.iter().chain(plan.replace.iter()) {
        let path = local_root.join(name);
        let res = if path.is_dir() { std::fs::remove_dir(&path) } else { std::fs::remove_file(&path) };
        if let Err(e) = res {
            tracing::warn!("virtualfs: drop stale placeholder {name}: {e}");
        }
    }
    for entry in remote
        .iter()
        .filter(|e| plan.create.contains(&e.name) || plan.replace.contains(&e.name))
    {
        let is_dir = matches!(entry.kind, FileKind::Directory);
        let mut pf = PlaceholderFile::new(&entry.name)
            .metadata(metadata_for(is_dir, entry.size, entry.modified))
            .mark_in_sync()
            .blob(entry.path.clone().into_bytes());
        if !is_dir {
            pf = pf.has_no_children();
        }
        // `create`'s phantom generic `P` is unused in its args, so it must be
        // named explicitly (crate quirk in 0.0.6).
        if let Err(e) = pf.create::<&Path>(local_root) {
            tracing::warn!("virtualfs: placeholder {}: {e:?}", entry.name);
        }
    }
}

fn metadata_for(is_dir: bool, size: u64, modified: Option<i64>) -> Metadata {
    let mut m = if is_dir { Metadata::directory() } else { Metadata::file() };
    m = m.size(size);
    if let Some(raw) = modified {
        // Faro reports mtime in ms on some backends, seconds on others — detect.
        let secs = if raw > 1_000_000_000_000 { raw / 1000 } else { raw };
        if let Ok(ft) = FileTime::from_unix_time(secs) {
            m = m.written(ft);
        }
    }
    m
}

/// Recursively mark files Unpinned (request dehydration). Returns the count.
fn dehydrate_tree(dir: &Path) -> u32 {
    let mut n = 0;
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    for entry in rd.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(ft) if ft.is_dir() => n += dehydrate_tree(&path),
            Ok(ft) if ft.is_file() => {
                if dehydrate_file(&path).is_ok() {
                    n += 1;
                }
            }
            _ => {}
        }
    }
    n
}

/// Free one file's local bytes now, as Explorer's "Free up space" does.
///
/// `CfUpdatePlaceholder(DEHYDRATE)` needs a handle with WRITE_DATA *or*
/// WRITE_DAC. A WRITE_DATA handle makes the platform hydrate the file straight
/// back (an open-for-write needs the bytes), so open with WRITE_DAC only. It
/// fails for a file edited locally (not in sync), so local work is never lost.
fn dehydrate_file(path: &Path) -> Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::CloudFilters::{CfUpdatePlaceholder, CF_UPDATE_FLAG_DEHYDRATE};
    const WRITE_DAC: u32 = 0x0004_0000;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    let file = std::fs::OpenOptions::new()
        .access_mode(WRITE_DAC | FILE_READ_ATTRIBUTES)
        .share_mode(0x7) // read | write | delete
        .open(path)?;
    unsafe {
        CfUpdatePlaceholder(
            HANDLE(file.as_raw_handle()),
            None,
            None,
            0,
            None,
            CF_UPDATE_FLAG_DEHYDRATE,
            None,
            None,
        )
    }
    .map_err(|e| anyhow!("dehydrate {}: {e}", path.display()))
}

/// The Cloud Filter callback surface for one on-demand root.
struct FaroFilter {
    hydrator: Arc<dyn Hydrator>,
    /// Bridge from the sync OS callback threads into Faro's async backends.
    runtime: Handle,
    remote_root: String,
    local_root: PathBuf,
}

impl FaroFilter {
    /// Map an absolute local directory path back to its remote counterpart.
    fn remote_dir_for(&self, absolute: &Path) -> String {
        let rel = absolute.strip_prefix(&self.local_root).unwrap_or(absolute);
        let rel = rel.to_string_lossy().replace('\\', "/");
        if rel.is_empty() {
            self.remote_root.clone()
        } else {
            format!("{}/{}", self.remote_root.trim_end_matches('/'), rel)
        }
    }

    /// Hydrate `[start, end)` of `remote_path` into the OS via the ticket, by
    /// downloading the file through the shared transfer path and streaming it in
    /// 4 KiB-aligned chunks.
    fn hydrate(
        &self,
        remote_path: &str,
        ticket: &ticket::FetchData,
        start: u64,
        end: u64,
    ) -> CResult<()> {
        // Security: only ever serve paths inside this pair's remote root
        // (callbacks are OS-supplied; validate before touching the backend).
        if !remote_path.starts_with(self.remote_root.trim_end_matches('/')) {
            return Err(CloudErrorKind::ValidationFailed);
        }

        let temp_dir = std::env::temp_dir()
            .join("faro-vfs")
            .join(uuid::Uuid::new_v4().to_string());
        let hydrator = self.hydrator.clone();
        let rp = remote_path.to_string();
        let td = temp_dir.clone();
        let downloaded = self
            .runtime
            .block_on(async move { hydrator.download_to(&rp, &td).await });

        let result = (|| -> CResult<()> {
            let path = downloaded.map_err(|e| {
                tracing::warn!("virtualfs: hydrate {remote_path}: {e:#}");
                CloudErrorKind::InvalidRequest
            })?;
            let mut file = File::open(&path).map_err(|_| CloudErrorKind::InvalidRequest)?;
            // We already hold the whole file, so hand the OS everything from
            // the (4 KiB-aligned) requested start to EOF rather than just the
            // required range — a later read of another range then needs no
            // second download.
            let len = file.metadata().map(|m| m.len()).unwrap_or(end);
            let start = start - start % 4096;
            let end = len;
            file.seek(SeekFrom::Start(start))
                .map_err(|_| CloudErrorKind::InvalidRequest)?;

            let mut position = start;
            let mut buffer = vec![0u8; CHUNK];
            while position < end {
                let mut read = file
                    .read(&mut buffer)
                    .map_err(|_| CloudErrorKind::InvalidRequest)?;
                if read == 0 {
                    break;
                }
                // Keep writes 4 KiB-aligned unless this is the final chunk.
                let unaligned = read % 4096;
                if unaligned != 0 && position + (read as u64) < end {
                    read -= unaligned;
                    file.seek(SeekFrom::Current(-(unaligned as i64)))
                        .map_err(|_| CloudErrorKind::InvalidRequest)?;
                }
                if read == 0 {
                    continue;
                }
                ticket
                    .write_at(&buffer[..read], position)
                    .map_err(|_| CloudErrorKind::InvalidRequest)?;
                position += read as u64;
                let _ = ticket.report_progress(end, position);
            }
            Ok(())
        })();

        let _ = std::fs::remove_dir_all(&temp_dir);
        result
    }
}

impl SyncFilter for FaroFilter {
    fn fetch_data(
        &self,
        request: Request,
        ticket: ticket::FetchData,
        info: info::FetchData,
    ) -> CResult<()> {
        let remote_path = String::from_utf8_lossy(request.file_blob()).into_owned();
        let range = info.required_file_range();
        self.hydrate(&remote_path, &ticket, range.start, range.end)
    }

    fn fetch_placeholders(
        &self,
        request: Request,
        ticket: ticket::FetchPlaceholders,
        _info: info::FetchPlaceholders,
    ) -> CResult<()> {
        let absolute = request.path();
        let remote_dir = self.remote_dir_for(&absolute);
        let hydrator = self.hydrator.clone();
        let entries = self
            .runtime
            .block_on(async move { hydrator.list_dir(&remote_dir).await })
            .map_err(|_| CloudErrorKind::InvalidRequest)?;

        let mut placeholders = entries
            .into_iter()
            .filter(|e| !absolute.join(&e.name).exists())
            .map(|e| {
                let is_dir = matches!(e.kind, FileKind::Directory);
                let mut pf = PlaceholderFile::new(&e.name)
                    .metadata(metadata_for(is_dir, e.size, e.modified))
                    .mark_in_sync()
                    .overwrite()
                    .blob(e.path.into_bytes());
                if !is_dir {
                    pf = pf.has_no_children();
                }
                pf
            })
            .collect::<Vec<_>>();

        ticket
            .pass_with_placeholder(&mut placeholders)
            .map_err(|_| CloudErrorKind::InvalidRequest)?;
        Ok(())
    }

    /// Allow dehydration ("free up space"): turn the file back into a placeholder.
    fn dehydrate(
        &self,
        _request: Request,
        ticket: ticket::Dehydrate,
        _info: info::Dehydrate,
    ) -> CResult<()> {
        ticket.pass().map_err(|_| CloudErrorKind::InvalidRequest)?;
        Ok(())
    }

    /// On-demand folders are a live view of the remote: a local delete removes
    /// only the placeholder, never the backend file. Allow the local op.
    fn delete(&self, _request: Request, ticket: ticket::Delete, _info: info::Delete) -> CResult<()> {
        ticket.pass().map_err(|_| CloudErrorKind::InvalidRequest)?;
        Ok(())
    }

    /// Likewise a local rename stays local — we don't mutate the backend.
    fn rename(&self, _request: Request, ticket: ticket::Rename, _info: info::Rename) -> CResult<()> {
        ticket.pass().map_err(|_| CloudErrorKind::InvalidRequest)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The orphan-safety primitive, against the real Cloud Filter API: a sync
    /// root registers (Win32, no package identity needed), reports registered,
    /// and unregisters cleanly — leaving no dangling registration on disk. This
    /// is exactly the round-trip `VirtualFs::reconcile` relies on to clean up
    /// orphaned roots, so verifying it end-to-end on real `cldapi` from an
    /// unpackaged test process is the highest-value check we can run without
    /// Explorer. Full hydration still needs manual Explorer testing.
    #[test]
    fn sync_root_register_unregister_round_trips() {
        assert!(supported(), "Cloud Filter API should be present on this box");

        let dir = std::env::temp_dir().join(format!("faro-vfs-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create temp sync root");

        // Clean slate even if a prior run aborted mid-test.
        let _ = unregister_root("", Some(&dir));
        assert!(!is_registered(&dir), "should start unregistered");

        register_root(&dir).expect("CfRegisterSyncRoot should succeed unpackaged");
        let was_registered = is_registered(&dir);

        // Unregister BEFORE asserting, so a failed assertion can't leave an
        // orphaned sync root on the developer's disk.
        unregister_root("", Some(&dir)).expect("unregister");
        let still_registered = is_registered(&dir);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(was_registered, "register should have taken effect (CfGetSyncRootInfoByPath)");
        assert!(!still_registered, "unregister should have cleared it — no orphan");
    }

    /// An in-memory remote: `path -> bytes` for files, plus explicit dirs.
    struct FakeRemote {
        files: std::sync::Mutex<std::collections::BTreeMap<String, Vec<u8>>>,
        dirs: Vec<String>,
        downloads: std::sync::atomic::AtomicU32,
    }

    #[async_trait::async_trait]
    impl Hydrator for FakeRemote {
        async fn list_dir(&self, remote_path: &str) -> Result<Vec<crate::remotefs::DirEntry>> {
            let prefix = format!("{}/", remote_path.trim_end_matches('/'));
            let child = |p: &str| p.strip_prefix(&prefix).filter(|r| !r.contains('/')).map(str::to_string);
            let mut out = Vec::new();
            for (p, bytes) in self.files.lock().unwrap().iter() {
                if let Some(name) = child(p) {
                    out.push(entry(&name, p, bytes.len() as u64, false));
                }
            }
            for d in &self.dirs {
                if let Some(name) = child(d) {
                    out.push(entry(&name, d, 0, true));
                }
            }
            Ok(out)
        }

        async fn download_to(&self, remote_path: &str, dest_dir: &Path) -> Result<PathBuf> {
            self.downloads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let bytes = self.files.lock().unwrap().get(remote_path).cloned().ok_or_else(|| anyhow!("404"))?;
            std::fs::create_dir_all(dest_dir)?;
            let dest = dest_dir.join(remote_path.rsplit('/').next().unwrap());
            std::fs::write(&dest, bytes)?;
            Ok(dest)
        }
    }

    fn entry(name: &str, path: &str, size: u64, dir: bool) -> crate::remotefs::DirEntry {
        crate::remotefs::DirEntry {
            name: name.into(),
            path: path.into(),
            kind: if dir { FileKind::Directory } else { FileKind::File },
            size,
            modified: Some(1_700_000_000),
            mode: None,
            etag: None,
            link_dir: false,
        }
    }

    async fn read(path: PathBuf) -> std::io::Result<Vec<u8>> {
        tokio::task::spawn_blocking(move || std::fs::read(path)).await.unwrap()
    }

    /// Plan 34 Phase 0: the provider end-to-end against the real Cloud Filter
    /// driver, without Explorer. Opening a placeholder hydrates it through the
    /// `Hydrator`; a subfolder populates on first access; free-up-space returns
    /// a file to a placeholder; the refresh poll adds new remote files and drops
    /// vanished ones; and a local edit shows up as a local change.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn provider_hydrates_refreshes_and_tracks_edits() {
        let big: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        use anyhow::Context as _;
        let remote = Arc::new(FakeRemote {
            files: std::sync::Mutex::new(
                [
                    ("/r/big.bin".to_string(), big.clone()),
                    ("/r/d/inner.txt".to_string(), b"inside".to_vec()),
                ]
                .into_iter()
                .collect(),
            ),
            dirs: vec!["/r/d".into()],
            downloads: Default::default(),
        });

        let dir = std::env::temp_dir().join(format!("faro-vfs-e2e-{}", std::process::id()));
        let _ = unregister_root("", Some(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let provider = Provider::start(
            RootConfig { local_root: dir.clone(), remote_root: "/r".into(), refresh_secs: 0 },
            remote.clone(),
        )
        .await
        .expect("provider starts");

        let outcome: Result<()> = async {
            let big_path = dir.join("big.bin");
            anyhow::ensure!(big_path.exists(), "top-level placeholder seeded");
            anyhow::ensure!(untouched_placeholder(&big_path, false), "starts with no local bytes");

            // Hydrate on open, across several 64 KiB chunks.
            anyhow::ensure!(read(big_path.clone()).await.context("read big")? == big, "hydrated bytes match");
            anyhow::ensure!(!untouched_placeholder(&big_path, false), "now holds local bytes");
            let after_first = remote.downloads.load(std::sync::atomic::Ordering::SeqCst);
            anyhow::ensure!(read(big_path.clone()).await.context("read big again")? == big, "second read");
            anyhow::ensure!(
                remote.downloads.load(std::sync::atomic::Ordering::SeqCst) == after_first,
                "a second read is served locally"
            );

            // Lazy subfolder population + hydration.
            // Windows doesn't send FETCH_PLACEHOLDERS for the provider's own
            // enumerations, so list the subfolder from another process the way
            // Explorer would.
            let sub = dir.join("d");
            let out = tokio::task::spawn_blocking(move || {
                std::process::Command::new("cmd").args(["/C", "dir", "/B"]).arg(&sub).output()
            })
            .await
            .unwrap()?;
            let listing = String::from_utf8_lossy(&out.stdout).to_string();
            anyhow::ensure!(listing.contains("inner.txt"), "subfolder populates on first listing: {listing:?}");
            anyhow::ensure!(read(dir.join("d").join("inner.txt")).await.context("read inner")? == b"inside", "subfolder file");

            // Free up space → back to a placeholder (may settle asynchronously).
            provider.free_up_space().await?;
            let mut freed = false;
            for _ in 0..30 {
                if untouched_placeholder(&big_path, false) {
                    freed = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            anyhow::ensure!(freed, "free up space dehydrates");

            // Remote gains new.txt and loses big.bin → refresh mirrors both.
            {
                let mut f = remote.files.lock().unwrap();
                f.insert("/r/new.txt".into(), b"new".to_vec());
                f.remove("/r/big.bin");
            }
            refresh_top_level(&dir, "/r", remote.as_ref()).await;
            anyhow::ensure!(dir.join("new.txt").exists(), "refresh adds new remote file");
            anyhow::ensure!(!big_path.exists(), "refresh drops vanished untouched placeholder");

            // A local edit is reported, a pristine hydrated file is not.
            let edited = dir.join("d").join("inner.txt");
            tokio::task::spawn_blocking(move || std::fs::write(edited, b"changed here"))
                .await
                .unwrap()?;
            let changes = provider.local_changes();
            anyhow::ensure!(changes == vec!["d/inner.txt".to_string()], "local changes: {changes:?}");
            Ok(())
        }
        .await;

        provider.stop();
        // Unmount: untouched placeholders go, the locally edited file stays.
        let cleared = clear_placeholders(&dir);
        let kept_edit = dir.join("d").join("inner.txt").exists();
        let dropped_new = !dir.join("new.txt").exists();
        let _ = unregister_root("", Some(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        outcome.expect("on-demand provider end-to-end");
        assert!(cleared >= 1 && dropped_new, "untouched placeholders cleared ({cleared})");
        assert!(kept_edit, "a file with local edits survives unmount");
    }
}
