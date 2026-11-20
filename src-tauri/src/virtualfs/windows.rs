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

use super::{plan_refresh, Hydrator, LocalEntry, RootConfig, VIEWS_DIR};
use crate::remotefs::DirEntry;
use std::collections::{BTreeMap, HashSet};
use std::sync::Mutex as StdMutex;
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
    /// Background tasks (top-level refresh, write-back); aborted on stop.
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

/// State shared by the callbacks and the background tasks of one root.
struct Shared {
    hydrator: Arc<dyn Hydrator>,
    local_root: PathBuf,
    remote_root: String,
    allow_deletes: bool,
    /// View folder name → entries (real remote files).
    views: StdMutex<BTreeMap<String, Vec<DirEntry>>>,
    /// Local paths Faro itself is renaming/deleting: callbacks leave the
    /// connection alone for these.
    suppress: StdMutex<HashSet<PathBuf>>,
}

impl Shared {
    fn views_dir(&self) -> PathBuf {
        self.local_root.join(VIEWS_DIR)
    }
    fn in_views(&self, p: &Path) -> bool {
        !self.views.lock().unwrap().is_empty() && p.starts_with(self.views_dir())
    }
    fn remote_for(&self, absolute: &Path) -> String {
        remote_for(&self.local_root, &self.remote_root, absolute)
    }
}

/// Map an absolute local path to its remote counterpart.
fn remote_for(local_root: &Path, remote_root: &str, absolute: &Path) -> String {
    let rel = absolute.strip_prefix(local_root).unwrap_or(absolute);
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel.is_empty() {
        remote_root.to_string()
    } else {
        format!("{}/{}", remote_root.trim_end_matches('/'), rel)
    }
}

impl Provider {
    pub async fn start(config: RootConfig, hydrator: Arc<dyn Hydrator>) -> Result<Provider> {
        let RootConfig { local_root, remote_root, refresh_secs, write_back, allow_deletes } = config;
        // Register the sync root (idempotent). Keyed by path via the Win32 API.
        register_root(&local_root)?;

        let views = hydrator.views().await.unwrap_or_else(|e| {
            tracing::warn!("virtualfs: view folders: {e:#}");
            BTreeMap::new()
        });
        let shared = Arc::new(Shared {
            hydrator: hydrator.clone(),
            local_root: local_root.clone(),
            remote_root: remote_root.clone(),
            allow_deletes,
            views: StdMutex::new(views),
            suppress: StdMutex::new(HashSet::new()),
        });

        // Seed the top level from the remote listing so the folder isn't empty
        // before the first Explorer-driven population. Best-effort per entry.
        refresh_top_level(&shared).await;

        let filter = FaroFilter { shared: shared.clone(), runtime: Handle::current() };
        let connection = Session::new()
            .connect(&local_root, filter)
            .map_err(|e| anyhow!("connect sync root {}: {e:?}", local_root.display()))?;

        let mut tasks = Vec::new();
        // Placeholders below the top level are listed fresh whenever Explorer
        // expands a folder; the top level is seeded once, so re-list it on a
        // timer to pick up files added or removed on the remote after start.
        if refresh_secs > 0 {
            let shared = shared.clone();
            tasks.push(tokio::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(refresh_secs));
                tick.tick().await; // the first tick fires immediately; seeded above
                loop {
                    tick.tick().await;
                    if let Ok(v) = shared.hydrator.views().await {
                        *shared.views.lock().unwrap() = v;
                    }
                    refresh_top_level(&shared).await;
                }
            }));
        }
        if write_back {
            let shared = shared.clone();
            tasks.push(tokio::spawn(async move {
                let mut tick = tokio::time::interval(WRITE_BACK_EVERY);
                loop {
                    tick.tick().await;
                    write_back_pass(&shared).await;
                }
            }));
        }

        Ok(Provider { connection, local_root, tasks })
    }

    /// Run one write-back pass now (tests; the worker runs on a timer).
    #[cfg(test)]
    async fn write_back_now(&self) {
        write_back_pass(&self.connection.filter().shared).await;
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
        for t in &self.tasks {
            t.abort();
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

/// A placeholder blob: the remote path, then the remote's `size:modified` at
/// the time the placeholder was made — the baseline write-back compares
/// against to spot a remote edit (a conflict).
fn blob_for(e: &DirEntry) -> Vec<u8> {
    format!("{}\n{}", e.path, remote_token(e)).into_bytes()
}

fn remote_token(e: &DirEntry) -> String {
    format!("{}:{}", e.size, e.modified.unwrap_or(0))
}

/// `(remote path, baseline token)` from a blob; older blobs hold just the path.
fn parse_blob(b: &[u8]) -> (String, Option<String>) {
    let text = String::from_utf8_lossy(b);
    match text.split_once('\n') {
        Some((path, token)) => (path.to_string(), Some(token.to_string())),
        None => (text.into_owned(), None),
    }
}

/// A placeholder's in-sync state, read through a plain attributes-only handle.
/// `None` when `path` isn't a placeholder. Deliberately not
/// `cloud_filter::Placeholder::open`: its oplock open makes the platform
/// re-hydrate a freed file, undoing "Free up space".
fn placeholder_in_sync(path: &Path) -> Option<bool> {
    placeholder_state(path).map(|(in_sync, _)| in_sync)
}

/// A placeholder's in-sync state and blob, or `None` if it isn't one.
fn placeholder_state(path: &Path) -> Option<(bool, Vec<u8>)> {
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
        let len = (info.FileIdentityLength as usize).min(4096);
        let start = std::mem::offset_of!(CF_PLACEHOLDER_BASIC_INFO, FileIdentity);
        let blob = buf.get(start..start + len).map(<[u8]>::to_vec).unwrap_or_default();
        Some((info.InSyncState == CF_IN_SYNC_STATE_IN_SYNC, blob))
    }
}

/// A WRITE_DAC handle: enough for the placeholder-update calls, and unlike a
/// WRITE_DATA handle it never makes the platform hydrate the file.
fn dac_handle(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;
    const WRITE_DAC: u32 = 0x0004_0000;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    std::fs::OpenOptions::new()
        .access_mode(WRITE_DAC | FILE_READ_ATTRIBUTES)
        .share_mode(0x7)
        .open(path)
}

/// After an upload: point the file at its remote copy and mark it in sync.
/// A plain file (created here) becomes a placeholder; one that already is
/// gets its blob (and baseline) updated.
fn settle_uploaded(path: &Path, blob: &[u8]) -> Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::CloudFilters::{
        CfConvertToPlaceholder, CfUpdatePlaceholder, CF_CONVERT_FLAG_MARK_IN_SYNC, CF_UPDATE_FLAG_MARK_IN_SYNC,
    };
    let file = dac_handle(path)?;
    let h = HANDLE(file.as_raw_handle());
    unsafe {
        if placeholder_state(path).is_some() {
            CfUpdatePlaceholder(
                h,
                None,
                Some(blob.as_ptr() as *const _),
                blob.len() as u32,
                None,
                CF_UPDATE_FLAG_MARK_IN_SYNC,
                None,
                None,
            )
        } else {
            CfConvertToPlaceholder(h, Some(blob.as_ptr() as *const _), blob.len() as u32, CF_CONVERT_FLAG_MARK_IN_SYNC, None, None)
        }
    }
    .map_err(|e| anyhow!("mark {} uploaded: {e}", path.display()))
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
async fn refresh_top_level(shared: &Shared) {
    let (local_root, remote_root) = (&shared.local_root, &shared.remote_root);
    let mut remote = match shared.hydrator.list_dir(remote_root).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!("virtualfs: refresh list_dir {remote_root}: {e:#}");
            return;
        }
    };
    // The Views folder is Faro's, not the connection's: keep it listed so it
    // isn't created or dropped by the diff below.
    let has_views = !shared.views.lock().unwrap().is_empty();
    if has_views && !remote.iter().any(|e| e.name.eq_ignore_ascii_case(VIEWS_DIR)) {
        remote.push(DirEntry {
            name: VIEWS_DIR.into(),
            path: format!("faro-views:{VIEWS_DIR}"),
            kind: FileKind::Directory,
            size: 0,
            modified: None,
            mode: None,
            etag: None,
            link_dir: false,
        });
    }
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
        shared.suppress.lock().unwrap().insert(path.clone());
        let res = if path.is_dir() { std::fs::remove_dir(&path) } else { std::fs::remove_file(&path) };
        shared.suppress.lock().unwrap().remove(&path);
        if let Err(e) = res {
            tracing::warn!("virtualfs: drop stale placeholder {name}: {e}");
        }
    }
    for entry in remote
        .iter()
        .filter(|e| plan.create.contains(&e.name) || plan.replace.contains(&e.name))
    {
        if let Err(e) = placeholder_for(entry).create::<&Path>(local_root) {
            tracing::warn!("virtualfs: placeholder {}: {e:?}", entry.name);
        }
    }
}

/// A placeholder for a remote entry.
fn placeholder_for(entry: &DirEntry) -> PlaceholderFile {
    let is_dir = matches!(entry.kind, FileKind::Directory);
    let pf = PlaceholderFile::new(&entry.name)
        .metadata(metadata_for(is_dir, entry.size, entry.modified))
        .mark_in_sync()
        .blob(blob_for(entry));
    if is_dir {
        pf
    } else {
        pf.has_no_children()
    }
}

// ---------- write-back (Plan 34 Phase 6) ----------

/// How often the folder is checked for saved files to upload.
const WRITE_BACK_EVERY: std::time::Duration = std::time::Duration::from_secs(3);
/// A file must be this long unchanged before it uploads (editors write in
/// several steps).
const SETTLE: std::time::Duration = std::time::Duration::from_secs(2);

/// Editor lock files, temp files and partial downloads never upload.
fn skip_write_back(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.starts_with("~$")
        || lower.starts_with(".~")
        || lower.ends_with(".tmp")
        || lower.ends_with(".crdownload")
        || lower.ends_with(".part")
        || lower == "desktop.ini"
        || lower == "thumbs.db"
        || crate::transfer::is_part_file(name)
}

/// `photo.jpg` → `photo (conflict PC 2026-11-20 1405).jpg`.
fn conflict_name(name: &str) -> String {
    let host = std::env::var("COMPUTERNAME").unwrap_or_else(|_| "this PC".into());
    let stamp = chrono::Local::now().format("%Y-%m-%d %H%M");
    match name.rfind('.').filter(|&i| i > 0) {
        Some(i) => format!("{} (conflict {host} {stamp}){}", &name[..i], &name[i..]),
        None => format!("{name} (conflict {host} {stamp})"),
    }
}

/// Upload every file saved in the folder since the last pass. A file whose
/// remote copy changed since it was downloaded isn't overwritten: it goes up
/// as a conflict copy next to it, and the original comes back as a
/// placeholder of the remote version.
async fn write_back_pass(shared: &Shared) {
    let mut changed = Vec::new();
    collect_local_changes(&shared.local_root, &shared.local_root, &mut changed);
    for rel in changed {
        let path = shared.local_root.join(rel.replace('/', "\\"));
        let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        if skip_write_back(&name) || shared.in_views(&path) {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        let fresh = meta.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|age| age < SETTLE);
        if fresh {
            continue;
        }
        // Still open in an editor: try again next pass.
        if std::fs::OpenOptions::new().read(true).share_mode_exclusive().is_err_for(&path) {
            continue;
        }
        if let Err(e) = write_back_one(shared, &path, &name, &meta).await {
            tracing::warn!("virtualfs: upload {}: {e:#}", path.display());
        }
    }
}

trait ExclusiveProbe {
    fn share_mode_exclusive(&mut self) -> &mut Self;
    fn is_err_for(&self, path: &Path) -> bool;
}

impl ExclusiveProbe for std::fs::OpenOptions {
    fn share_mode_exclusive(&mut self) -> &mut Self {
        use std::os::windows::fs::OpenOptionsExt;
        self.share_mode(0)
    }
    fn is_err_for(&self, path: &Path) -> bool {
        self.open(path).is_err()
    }
}

async fn write_back_one(shared: &Shared, path: &Path, name: &str, before: &std::fs::Metadata) -> Result<()> {
    // The file's place in the folder is its remote path (a rename moves the
    // file but not its blob). The blob's baseline counts only while it still
    // describes that same remote path.
    let remote_path = shared.remote_for(path);
    let baseline = match placeholder_state(path) {
        Some((_, blob)) if !blob.is_empty() => match parse_blob(&blob) {
            (p, token) if p == remote_path => token,
            _ => None,
        },
        _ => None,
    };
    let remote_dir = remote_path.rsplit_once('/').map(|(d, _)| if d.is_empty() { "/" } else { d }).unwrap_or("/").to_string();
    let current = shared.hydrator.stat(&remote_path).await?;
    let conflict = match (&baseline, &current) {
        (Some(base), Some(cur)) => &remote_token(cur) != base,
        _ => false,
    };

    if conflict {
        let cur = current.expect("checked above");
        // Upload a copy under the conflict name, then swap it in locally.
        let cname = conflict_name(name);
        let staging = std::env::temp_dir().join("faro-vfs-conflict").join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&staging)?;
        let staged = staging.join(&cname);
        std::fs::copy(path, &staged)?;
        let up = shared.hydrator.upload(&staged, &remote_dir).await;
        let _ = std::fs::remove_dir_all(&staging);
        up?;
        let remote_conflict = format!("{}/{cname}", remote_dir.trim_end_matches('/'));
        let landed = shared.hydrator.stat(&remote_conflict).await?.ok_or_else(|| anyhow!("conflict copy didn't land"))?;
        let local_conflict = path.with_file_name(&cname);
        {
            let mut sup = shared.suppress.lock().unwrap();
            sup.insert(path.to_path_buf());
            sup.insert(local_conflict.clone());
        }
        let moved = std::fs::rename(path, &local_conflict);
        if moved.is_ok() {
            settle_uploaded(&local_conflict, &blob_for(&landed))?;
            if let Some(parent) = path.parent() {
                let _ = placeholder_for(&cur).create::<&Path>(parent);
            }
        }
        {
            let mut sup = shared.suppress.lock().unwrap();
            sup.remove(path);
            sup.remove(&local_conflict);
        }
        moved?;
        tracing::info!("virtualfs: {} changed on both sides; kept {cname}", remote_path);
        return Ok(());
    }

    shared.hydrator.upload(path, &remote_dir).await?;
    // Edited again while uploading: leave it changed for the next pass.
    let after = std::fs::metadata(path)?;
    if after.modified().ok() != before.modified().ok() || after.len() != before.len() {
        return Ok(());
    }
    let landed = shared.hydrator.stat(&remote_path).await?.ok_or_else(|| anyhow!("upload didn't land"))?;
    settle_uploaded(path, &blob_for(&landed))
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
    shared: Arc<Shared>,
    /// Bridge from the sync OS callback threads into Faro's async backends.
    runtime: Handle,
}

impl FaroFilter {
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
        if !remote_path.starts_with(self.shared.remote_root.trim_end_matches('/')) {
            return Err(CloudErrorKind::ValidationFailed);
        }

        let temp_dir = std::env::temp_dir()
            .join("faro-vfs")
            .join(uuid::Uuid::new_v4().to_string());
        let hydrator = self.shared.hydrator.clone();
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
        let (remote_path, _) = parse_blob(request.file_blob());
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
        let views_dir = self.shared.views_dir();
        let entries: Vec<DirEntry> = if self.shared.in_views(&absolute) {
            // Views/ lists the view folders; Views/<name>/ the files in it.
            let views = self.shared.views.lock().unwrap();
            if absolute == views_dir {
                views
                    .keys()
                    .map(|v| DirEntry {
                        name: v.clone(),
                        path: format!("faro-views:{v}"),
                        kind: FileKind::Directory,
                        size: 0,
                        modified: None,
                        mode: None,
                        etag: None,
                        link_dir: false,
                    })
                    .collect()
            } else {
                let name = absolute.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                views.get(&name).cloned().unwrap_or_default()
            }
        } else {
            let remote_dir = self.shared.remote_for(&absolute);
            let hydrator = self.shared.hydrator.clone();
            self.runtime
                .block_on(async move { hydrator.list_dir(&remote_dir).await })
                .map_err(|_| CloudErrorKind::InvalidRequest)?
        };

        let mut placeholders = entries
            .iter()
            .filter(|e| !absolute.join(&e.name).exists())
            .map(|e| placeholder_for(e).overwrite())
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

    /// A local delete removes only the placeholder — unless the mount applies
    /// deletes (write-back with deletes on), then the connection's copy moves
    /// to its recovery area first. View folders can't be changed.
    fn delete(&self, request: Request, ticket: ticket::Delete, _info: info::Delete) -> CResult<()> {
        let path = request.path();
        if self.shared.in_views(&path) {
            return Err(CloudErrorKind::AccessDenied);
        }
        let (blob_path, _) = parse_blob(request.file_blob());
        let remote = self.shared.remote_for(&path);
        let ours = self.shared.suppress.lock().unwrap().contains(&path);
        if self.shared.allow_deletes && !ours && !blob_path.is_empty() && !blob_path.starts_with("faro-views:") {
            let hydrator = self.shared.hydrator.clone();
            self.runtime.block_on(async move { hydrator.remove(&remote).await }).map_err(|e| {
                tracing::warn!("virtualfs: delete on the connection: {e:#}");
                CloudErrorKind::Unsuccessful
            })?;
        }
        ticket.pass().map_err(|_| CloudErrorKind::InvalidRequest)?;
        Ok(())
    }

    /// Likewise a rename: local only, or applied to the connection when the
    /// mount allows it. Moving a file out of the folder counts as a delete.
    fn rename(&self, request: Request, ticket: ticket::Rename, info: info::Rename) -> CResult<()> {
        let path = request.path();
        let target = info.target_path();
        if self.shared.in_views(&path) || self.shared.in_views(&target) {
            return Err(CloudErrorKind::AccessDenied);
        }
        let (blob_path, _) = parse_blob(request.file_blob());
        let remote = self.shared.remote_for(&path);
        let ours = self.shared.suppress.lock().unwrap().contains(&path);
        if self.shared.allow_deletes && !ours && !blob_path.is_empty() && !blob_path.starts_with("faro-views:") {
            let hydrator = self.shared.hydrator.clone();
            let to = info.target_in_scope().then(|| self.shared.remote_for(&target));
            self.runtime
                .block_on(async move {
                    match to {
                        Some(to) => hydrator.rename(&remote, &to).await,
                        None => hydrator.remove(&remote).await,
                    }
                })
                .map_err(|e| {
                    tracing::warn!("virtualfs: rename on the connection: {e:#}");
                    CloudErrorKind::Unsuccessful
                })?;
        }
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

    /// An in-memory remote: `path -> (bytes, modified)` for files, plus dirs.
    struct FakeRemote {
        files: std::sync::Mutex<std::collections::BTreeMap<String, (Vec<u8>, i64)>>,
        dirs: Vec<String>,
        downloads: std::sync::atomic::AtomicU32,
        views: std::sync::Mutex<BTreeMap<String, Vec<DirEntry>>>,
        clock: std::sync::atomic::AtomicI64,
    }

    impl FakeRemote {
        fn new(files: &[(&str, &[u8])], dirs: &[&str]) -> Self {
            Self {
                files: std::sync::Mutex::new(
                    files.iter().map(|(p, b)| (p.to_string(), (b.to_vec(), 1_700_000_000))).collect(),
                ),
                dirs: dirs.iter().map(|d| d.to_string()).collect(),
                downloads: Default::default(),
                views: Default::default(),
                clock: std::sync::atomic::AtomicI64::new(1_700_000_100),
            }
        }
        fn put(&self, path: &str, bytes: &[u8]) {
            let t = self.clock.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.files.lock().unwrap().insert(path.into(), (bytes.to_vec(), t));
        }
        fn get(&self, path: &str) -> Option<Vec<u8>> {
            self.files.lock().unwrap().get(path).map(|f| f.0.clone())
        }
    }

    #[async_trait::async_trait]
    impl Hydrator for FakeRemote {
        async fn list_dir(&self, remote_path: &str) -> Result<Vec<DirEntry>> {
            let prefix = format!("{}/", remote_path.trim_end_matches('/'));
            let child = |p: &str| p.strip_prefix(&prefix).filter(|r| !r.contains('/')).map(str::to_string);
            let mut out = Vec::new();
            for (p, (bytes, m)) in self.files.lock().unwrap().iter() {
                if let Some(name) = child(p) {
                    out.push(entry(&name, p, bytes.len() as u64, *m, false));
                }
            }
            for d in &self.dirs {
                if let Some(name) = child(d) {
                    out.push(entry(&name, d, 0, 0, true));
                }
            }
            Ok(out)
        }

        async fn download_to(&self, remote_path: &str, dest_dir: &Path) -> Result<PathBuf> {
            self.downloads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let bytes = self.get(remote_path).ok_or_else(|| anyhow!("404"))?;
            std::fs::create_dir_all(dest_dir)?;
            let dest = dest_dir.join(remote_path.rsplit('/').next().unwrap());
            std::fs::write(&dest, bytes)?;
            Ok(dest)
        }

        async fn upload(&self, local: &Path, remote_dir: &str) -> Result<()> {
            let name = local.file_name().unwrap().to_string_lossy().into_owned();
            let bytes = std::fs::read(local)?;
            self.put(&format!("{}/{name}", remote_dir.trim_end_matches('/')), &bytes);
            Ok(())
        }

        async fn remove(&self, remote_path: &str) -> Result<()> {
            self.files.lock().unwrap().remove(remote_path).map(|_| ()).ok_or_else(|| anyhow!("404"))
        }

        async fn rename(&self, from: &str, to: &str) -> Result<()> {
            let mut f = self.files.lock().unwrap();
            let v = f.remove(from).ok_or_else(|| anyhow!("404"))?;
            f.insert(to.into(), v);
            Ok(())
        }

        async fn views(&self) -> Result<BTreeMap<String, Vec<DirEntry>>> {
            Ok(self.views.lock().unwrap().clone())
        }
    }

    fn entry(name: &str, path: &str, size: u64, modified: i64, dir: bool) -> DirEntry {
        DirEntry {
            name: name.into(),
            path: path.into(),
            kind: if dir { FileKind::Directory } else { FileKind::File },
            size,
            modified: Some(modified),
            mode: None,
            etag: None,
            link_dir: false,
        }
    }

    async fn read(path: PathBuf) -> std::io::Result<Vec<u8>> {
        tokio::task::spawn_blocking(move || std::fs::read(path)).await.unwrap()
    }

    /// Run a `cmd /C …` from another process, the way Explorer or an editor
    /// would act on the folder (the platform skips some callbacks for the
    /// provider's own process).
    async fn cmd(args: &[&str]) -> (bool, String) {
        let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        let out = tokio::task::spawn_blocking(move || std::process::Command::new("cmd").arg("/C").args(&args).output())
            .await
            .unwrap()
            .unwrap();
        (out.status.success(), format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
    }

    fn temp_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("faro-vfs-{tag}-{}", std::process::id()));
        let _ = unregister_root("", Some(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn config(dir: &Path, write_back: bool) -> RootConfig {
        RootConfig {
            local_root: dir.to_path_buf(),
            remote_root: "/r".into(),
            refresh_secs: 0,
            write_back,
            allow_deletes: write_back,
        }
    }

    /// Plan 34 Phase 0: the provider end-to-end against the real Cloud Filter
    /// driver, without Explorer. Opening a placeholder hydrates it through the
    /// `Hydrator`; a subfolder populates on first access; free-up-space returns
    /// a file to a placeholder; the refresh poll adds new remote files and drops
    /// vanished ones; and a local edit shows up as a local change.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn provider_hydrates_refreshes_and_tracks_edits() {
        use anyhow::Context as _;
        let big: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let remote = Arc::new(FakeRemote::new(&[("/r/big.bin", &big), ("/r/d/inner.txt", b"inside")], &["/r/d"]));
        let dir = temp_root("e2e");
        let provider = Provider::start(config(&dir, false), remote.clone()).await.expect("provider starts");
        let shared = provider.connection.filter().shared.clone();

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

            // Lazy subfolder population (from another process) + hydration.
            let (_, listing) = cmd(&["dir", "/B", &dir.join("d").to_string_lossy()]).await;
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
            remote.put("/r/new.txt", b"new");
            remote.files.lock().unwrap().remove("/r/big.bin");
            refresh_top_level(&shared).await;
            anyhow::ensure!(dir.join("new.txt").exists(), "refresh adds new remote file");
            anyhow::ensure!(!big_path.exists(), "refresh drops vanished untouched placeholder");

            // A local edit is reported, a pristine hydrated file is not.
            let edited = dir.join("d").join("inner.txt");
            tokio::task::spawn_blocking(move || std::fs::write(edited, b"changed here")).await.unwrap()?;
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

    /// Plan 34 Phases 5–6: view folders show real files and can't be changed;
    /// a file saved in the folder uploads and is marked in sync; a remote edit
    /// in the meantime keeps both copies; deletes and renames reach the
    /// connection when the mount allows them.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn write_back_uploads_keeps_conflicts_and_applies_deletes() {
        use anyhow::Context as _;
        let remote = Arc::new(FakeRemote::new(&[("/r/a.txt", b"remote v1"), ("/r/d/inner.txt", b"inside")], &["/r/d"]));
        remote
            .views
            .lock()
            .unwrap()
            .insert("Hero".into(), vec![entry("inner.txt", "/r/d/inner.txt", 6, 1_700_000_000, false)]);
        let dir = temp_root("wb");
        let provider = Provider::start(config(&dir, true), remote.clone()).await.expect("provider starts");
        let settle = || tokio::time::sleep(SETTLE + std::time::Duration::from_millis(300));

        let outcome: Result<()> = async {
            // Views/Hero shows the real file, read-only.
            let hero = dir.join(VIEWS_DIR).join("Hero");
            let (_, listing) = cmd(&["dir", "/B", &dir.join(VIEWS_DIR).to_string_lossy()]).await;
            anyhow::ensure!(listing.contains("Hero"), "views folder lists the view: {listing:?}");
            let (_, listing) = cmd(&["dir", "/B", &hero.to_string_lossy()]).await;
            anyhow::ensure!(listing.contains("inner.txt"), "view lists its file: {listing:?}");
            anyhow::ensure!(read(hero.join("inner.txt")).await.context("read view file")? == b"inside", "view file hydrates");
            cmd(&["del", "/Q", &hero.join("inner.txt").to_string_lossy()]).await;
            anyhow::ensure!(hero.join("inner.txt").exists(), "a view file can't be deleted");
            anyhow::ensure!(remote.get("/r/d/inner.txt").is_some(), "…and the real file is untouched");

            // A new file saved in the folder uploads and becomes in sync.
            let notes = dir.join("notes.txt");
            let n2 = notes.clone();
            tokio::task::spawn_blocking(move || std::fs::write(n2, b"my notes")).await.unwrap()?;
            settle().await;
            provider.write_back_now().await;
            anyhow::ensure!(remote.get("/r/notes.txt").as_deref() == Some(&b"my notes"[..]), "new file uploaded");
            anyhow::ensure!(provider.local_changes().is_empty(), "uploaded file is in sync: {:?}", provider.local_changes());

            // Edit a.txt here while the remote copy changes too → conflict copy.
            let a = dir.join("a.txt");
            anyhow::ensure!(read(a.clone()).await? == b"remote v1", "a.txt hydrates");
            remote.put("/r/a.txt", b"remote v2");
            let a2 = a.clone();
            tokio::task::spawn_blocking(move || std::fs::write(a2, b"local edit")).await.unwrap()?;
            settle().await;
            provider.write_back_now().await;
            anyhow::ensure!(remote.get("/r/a.txt").as_deref() == Some(&b"remote v2"[..]), "remote edit not overwritten");
            let conflicts: Vec<String> = remote
                .files
                .lock()
                .unwrap()
                .keys()
                .filter(|k| k.starts_with("/r/a (conflict "))
                .cloned()
                .collect();
            anyhow::ensure!(conflicts.len() == 1, "one conflict copy on the connection: {conflicts:?}");
            anyhow::ensure!(remote.get(&conflicts[0]).as_deref() == Some(&b"local edit"[..]), "conflict copy has the local edit");
            anyhow::ensure!(read(a.clone()).await? == b"remote v2", "a.txt is the remote version again");
            anyhow::ensure!(provider.local_changes().is_empty(), "nothing left to upload: {:?}", provider.local_changes());

            // Rename then delete from another process reach the connection.
            let (ok, out) = cmd(&["ren", &notes.to_string_lossy(), "renamed.txt"]).await;
            anyhow::ensure!(ok, "rename: {out}");
            anyhow::ensure!(remote.get("/r/renamed.txt").is_some() && remote.get("/r/notes.txt").is_none(), "rename applied remotely");
            let (ok, out) = cmd(&["del", "/Q", &dir.join("renamed.txt").to_string_lossy()]).await;
            anyhow::ensure!(ok, "delete: {out}");
            anyhow::ensure!(remote.get("/r/renamed.txt").is_none(), "delete applied remotely");
            Ok(())
        }
        .await;

        provider.stop();
        clear_placeholders(&dir);
        let _ = unregister_root("", Some(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        outcome.expect("write-back end-to-end");
    }
}
