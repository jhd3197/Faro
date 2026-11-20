//! On-demand virtual folders — OneDrive-style placeholders that show in a local
//! folder, download on open ("hydrate"), and free-up-space to evict (see
//! `docs/plans/9_on-demand-virtual-folders.md`).
//!
//! This is the cross-platform *subsystem*: it owns the registration bookkeeping
//! (which OS sync roots we've stood up), reconciles orphans on startup, and
//! exposes `status` / `free_up_space` to the UI. The native provider that talks
//! to the OS filesystem-driver lives behind a platform module:
//!
//! - **Windows** (`platform = windows`): the Cloud Filter API (`cldapi.dll`),
//!   compiled only under `--features virtualfs`.
//! - **everything else** (`platform = unsupported`): inert stubs so the default
//!   build compiles unchanged and an on-demand pair degrades to a clear "not
//!   available in this build" rather than an error.
//!
//! Structure mirrors `agent_host.rs` / `foldersync.rs`: a `Mutex`-guarded
//! settings blob persisted as JSON under the app data dir, a map of running
//! providers, `load` / `auto_start` (via `reconcile`) / `stop`, and
//! `virtualfs://changed` events so the UI can refresh.
//!
//! ## Orphan safety
//! A registered Cloud Filter sync root outlives the process — if we crashed
//! without unregistering, the folder would keep rendering placeholders with no
//! provider behind them. So we persist every root we register and, on every
//! config change (and at startup), diff the persisted set against the live set
//! of enabled on-demand pairs and `unregister` the difference. See
//! [`plan_reconcile`], which is pure and unit-tested.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use crate::remotefs::DirEntry;
use crate::AppState;

#[cfg(all(windows, feature = "virtualfs"))]
#[path = "windows.rs"]
mod platform;

#[cfg(not(all(windows, feature = "virtualfs")))]
#[path = "unsupported.rs"]
mod platform;

/// The subset of a folder-sync `SyncPair` the provider needs to stand up an
/// on-demand root. Kept as its own struct so the provider doesn't depend on
/// foldersync's full config shape.
#[derive(Debug, Clone)]
pub struct OnDemandPair {
    pub id: String,
    pub name: String,
    pub local_root: String,
    pub profile_id: String,
    pub remote_root: String,
}

/// A connection (or a folder of it) shown as an on-demand Windows folder,
/// independent of folder sync (Plan 34 Phase 2). Persisted in
/// `virtualfs.json`. Several can run side by side, each its own sync root.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    pub id: String,
    pub name: String,
    pub profile_id: String,
    pub remote_root: String,
    pub local_root: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    /// Upload files saved in the folder back to the connection (Phase 6).
    /// Off = edits stay on this PC and show as local changes.
    #[serde(default)]
    pub write_back: bool,
    /// With write-back on, also apply deletes and renames to the connection.
    #[serde(default)]
    pub allow_deletes: bool,
    /// Keep a searchable index (dates, camera, thumbnails) of this folder.
    #[serde(default)]
    pub index: bool,
    /// A Settings › Rules rule set whose view rules show as extra folders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rule_set: Option<String>,
}

fn yes() -> bool {
    true
}

impl Mount {
    fn as_pair(&self) -> OnDemandPair {
        OnDemandPair {
            id: self.id.clone(),
            name: self.name.clone(),
            local_root: self.local_root.clone(),
            profile_id: self.profile_id.clone(),
            remote_root: self.remote_root.clone(),
        }
    }
}

/// A mount merged with its live state — the shape the UI consumes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountView {
    #[serde(flatten)]
    pub mount: Mount,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Files edited or created in the folder that the connection doesn't have.
    pub local_changes: Vec<String>,
}

/// `C:\Users\<me>\Faro\<name>` — the default folder for a new mount.
pub fn default_mount_root(name: &str) -> PathBuf {
    let clean: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') { c } else { '-' })
        .collect();
    let clean = clean.trim().trim_matches('.').to_string();
    let clean = if clean.is_empty() { "Connection".to_string() } else { clean };
    dirs::home_dir().unwrap_or_else(std::env::temp_dir).join("Faro").join(clean)
}

/// Pulls bytes and listings from the pair's backend for the provider's callback
/// worker. Implemented by [`SessionHydrator`] over the live `Session` +
/// `TransferManager`, so hydration reuses the exact per-backend download path.
// The methods are only *called* by the Windows Cloud Filter provider, so the
// default (feature-off) build sees them as dead — expected, not a smell.
#[allow(dead_code)]
#[async_trait]
pub trait Hydrator: Send + Sync {
    /// List a remote directory (absolute remote path).
    async fn list_dir(&self, remote_path: &str) -> Result<Vec<DirEntry>>;
    /// Download a whole remote file into `dest_dir`; returns the written path.
    async fn download_to(&self, remote_path: &str, dest_dir: &Path) -> Result<PathBuf>;
}

/// Everything the platform provider needs to stand up one on-demand root.
#[cfg_attr(not(all(windows, feature = "virtualfs")), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct RootConfig {
    pub local_root: PathBuf,
    pub remote_root: String,
    /// How often to re-list the remote top level and add/remove placeholders
    /// for files that appeared or vanished after start. `0` disables it.
    pub refresh_secs: u64,
}

/// Default cadence for the top-level refresh poll.
pub const DEFAULT_REFRESH_SECS: u64 = 60;

// ---------- refresh planning (pure) ----------

/// One entry already in a root's local folder, as the refresh poll sees it.
#[cfg_attr(not(all(windows, feature = "virtualfs")), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct LocalEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    /// The entry is still an untouched placeholder (no local bytes, never
    /// edited, never populated) — the only kind the poll may delete or replace.
    /// Anything holding local data is left alone so a refresh never loses work.
    pub untouched_placeholder: bool,
}

/// What a refresh pass should change, by entry name.
#[cfg_attr(not(all(windows, feature = "virtualfs")), allow(dead_code))]
#[derive(Debug, Default, PartialEq, Eq)]
pub struct RefreshPlan {
    /// On the remote, missing locally → create a placeholder.
    pub create: Vec<String>,
    /// Untouched placeholder whose remote file is gone → remove it.
    pub remove: Vec<String>,
    /// Untouched placeholder whose remote size changed → remove + recreate, so
    /// a later hydration doesn't serve a stale length.
    pub replace: Vec<String>,
}

/// Diff a root's local entries against the remote listing. Pure so the
/// "never delete local data" rule is unit-tested without touching the OS.
#[cfg_attr(not(all(windows, feature = "virtualfs")), allow(dead_code))]
pub fn plan_refresh(local: &[LocalEntry], remote: &[DirEntry]) -> RefreshPlan {
    let mut plan = RefreshPlan::default();
    for r in remote {
        let r_dir = matches!(r.kind, crate::remotefs::FileKind::Directory);
        match local.iter().find(|l| l.name == r.name) {
            None => plan.create.push(r.name.clone()),
            Some(l) if l.untouched_placeholder && !l.is_dir && !r_dir && l.size != r.size => {
                plan.replace.push(r.name.clone())
            }
            Some(_) => {}
        }
    }
    for l in local {
        if l.untouched_placeholder && !remote.iter().any(|r| r.name == l.name) {
            plan.remove.push(l.name.clone());
        }
    }
    plan
}

// ---------- persisted config ----------

/// One sync root we've registered with the OS. Persisted so a startup reconcile
/// can `unregister` roots whose pair no longer exists (orphan cleanup).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegisteredRoot {
    pub pair_id: String,
    pub local_root: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    /// Sync roots believed to be registered with the OS.
    registered: Vec<RegisteredRoot>,
    /// Connections shown as folders (Plan 34 Phase 2).
    mounts: Vec<Mount>,
}

// ---------- live status ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RootStatus {
    pub pair_id: String,
    pub local_root: String,
    /// A provider is connected and serving hydration callbacks right now.
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

// ---------- subsystem ----------

pub struct VirtualFs {
    settings_path: PathBuf,
    settings: Mutex<Settings>,
    /// Live providers keyed by pair id (present only on a supported build).
    running: Mutex<HashMap<String, platform::Provider>>,
    errors: Mutex<HashMap<String, String>>,
    /// The enabled on-demand sync pairs, as folder sync last reported them;
    /// mounts are added to these on every reconcile.
    sync_pairs: Mutex<Vec<OnDemandPair>>,
}

impl VirtualFs {
    pub fn load(app: &AppHandle) -> Result<Self> {
        let dir = app.path().app_data_dir().context("resolving app_data_dir")?;
        std::fs::create_dir_all(&dir).ok();
        let settings_path = dir.join("virtualfs.json");
        let settings: Settings = std::fs::read(&settings_path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Ok(Self {
            settings_path,
            settings: Mutex::new(settings),
            running: Mutex::new(HashMap::new()),
            errors: Mutex::new(HashMap::new()),
            sync_pairs: Mutex::new(Vec::new()),
        })
    }

    /// Whether on-demand virtual folders are available in this build/OS.
    pub fn supported(&self) -> bool {
        platform::supported()
    }

    async fn persist(&self) -> Result<()> {
        let settings = self.settings.lock().await.clone();
        std::fs::write(&self.settings_path, serde_json::to_vec_pretty(&settings)?)
            .with_context(|| format!("write {}", self.settings_path.display()))?;
        Ok(())
    }

    /// Reconcile the live set of enabled on-demand pairs against what we've
    /// registered: unregister roots that no longer have a pair (orphan cleanup),
    /// and register/connect any pair that isn't running yet. Idempotent — safe
    /// to call on startup and after every foldersync mutation.
    pub async fn reconcile(&self, app: &AppHandle, pairs: Vec<OnDemandPair>) {
        *self.sync_pairs.lock().await = pairs;
        self.reconcile_all(app).await;
    }

    /// Reconcile sync pairs + enabled mounts against the registered roots.
    async fn reconcile_all(&self, app: &AppHandle) {
        let mut pairs = self.sync_pairs.lock().await.clone();
        pairs.extend(
            self.settings.lock().await.mounts.iter().filter(|m| m.enabled).map(Mount::as_pair),
        );
        let persisted: Vec<RegisteredRoot> = self.settings.lock().await.registered.clone();
        let live_ids: Vec<String> = pairs.iter().map(|p| p.id.clone()).collect();
        let Plan { to_unregister, to_start } = plan_reconcile(&persisted, &live_ids);

        // 1) Tear down orphans first — the safety-critical half.
        for pair_id in &to_unregister {
            let root = persisted
                .iter()
                .find(|r| &r.pair_id == pair_id)
                .map(|r| PathBuf::from(&r.local_root));
            self.teardown(pair_id, root.as_deref()).await;
        }

        // 2) Stand up any pair not already running.
        for pair in pairs.iter().filter(|p| to_start.contains(&p.id)) {
            if let Err(e) = self.start_pair(app, pair).await {
                tracing::warn!("virtualfs '{}': {e:#}", pair.name);
                self.errors.lock().await.insert(pair.id.clone(), format!("{e:#}"));
            }
        }

        // 3) Persist the new registered set = the live pairs we didn't tear down.
        {
            let mut s = self.settings.lock().await;
            s.registered = pairs
                .iter()
                .map(|p| RegisteredRoot { pair_id: p.id.clone(), local_root: p.local_root.clone() })
                .collect();
        }
        let _ = self.persist().await;
        let _ = app.emit("virtualfs://changed", ());
    }

    /// Disconnect + unregister one root, dropping its running provider. Its
    /// untouched placeholders go too (they could never open again); files
    /// holding local data stay where they are.
    async fn teardown(&self, pair_id: &str, local_root: Option<&Path>) {
        if let Some(p) = self.running.lock().await.remove(pair_id) {
            p.stop();
        }
        self.errors.lock().await.remove(pair_id);
        if let Some(root) = local_root {
            let removed = platform::clear_placeholders(root);
            tracing::info!("virtualfs: cleared {removed} placeholders from {}", root.display());
        }
        if let Err(e) = platform::unregister_root(pair_id, local_root) {
            tracing::warn!("virtualfs: unregister '{pair_id}': {e:#}");
        }
    }

    async fn start_pair(&self, app: &AppHandle, pair: &OnDemandPair) -> Result<()> {
        if self.running.lock().await.contains_key(&pair.id) {
            return Ok(());
        }
        if !platform::supported() {
            anyhow::bail!(
                "on-demand virtual folders need a Windows build with --features virtualfs"
            );
        }
        let local_root = PathBuf::from(&pair.local_root);
        std::fs::create_dir_all(&local_root)
            .with_context(|| format!("create sync root {}", local_root.display()))?;

        let hydrator: Arc<dyn Hydrator> =
            Arc::new(SessionHydrator::new(app.clone(), pair.profile_id.clone()));
        let provider = platform::Provider::start(
            RootConfig {
                local_root,
                remote_root: pair.remote_root.clone(),
                refresh_secs: DEFAULT_REFRESH_SECS,
            },
            hydrator,
        )
        .await?;
        self.running.lock().await.insert(pair.id.clone(), provider);
        self.errors.lock().await.remove(&pair.id);
        Ok(())
    }

    /// Explorer's "Free up space" over the whole pair — turn every hydrated file
    /// back into a placeholder, reclaiming disk while it still shows in the
    /// folder. Returns how many files were dehydrated.
    pub async fn free_up_space(&self, pair_id: &str) -> Result<u32> {
        let running = self.running.lock().await;
        match running.get(pair_id) {
            Some(p) => p.free_up_space().await,
            None => anyhow::bail!("on-demand folder is not active"),
        }
    }

    // ---------- mounts (Plan 34 Phase 2) ----------

    pub async fn mounts(&self) -> Vec<MountView> {
        let mounts = self.settings.lock().await.mounts.clone();
        let running = self.running.lock().await;
        let errors = self.errors.lock().await;
        mounts
            .into_iter()
            .map(|m| MountView {
                running: running.contains_key(&m.id),
                last_error: errors.get(&m.id).cloned(),
                local_changes: running.get(&m.id).map(|p| p.local_changes()).unwrap_or_default(),
                mount: m,
            })
            .collect()
    }

    /// The mount with `id`, if configured.
    pub async fn mount(&self, id: &str) -> Option<Mount> {
        self.settings.lock().await.mounts.iter().find(|m| m.id == id).cloned()
    }

    /// Add or replace a mount, then restart it so a changed folder, remote
    /// path or option takes effect.
    pub async fn save_mount(&self, app: &AppHandle, mut mount: Mount) -> Result<Mount> {
        if mount.id.is_empty() {
            mount.id = uuid::Uuid::new_v4().to_string();
        }
        if mount.local_root.trim().is_empty() {
            mount.local_root = default_mount_root(&mount.name).to_string_lossy().into_owned();
        }
        if mount.remote_root.trim().is_empty() {
            mount.remote_root = "/".into();
        }
        let (previous, clash) = {
            let s = self.settings.lock().await;
            let prev = s.mounts.iter().find(|m| m.id == mount.id).cloned();
            let same_folder = |a: &str, b: &str| {
                Path::new(a.trim_end_matches(['\\', '/'])).eq(Path::new(b.trim_end_matches(['\\', '/'])))
            };
            let clash = s
                .mounts
                .iter()
                .filter(|m| m.id != mount.id)
                .map(|m| m.local_root.clone())
                .chain(s.registered.iter().filter(|r| r.pair_id != mount.id).map(|r| r.local_root.clone()))
                .any(|other| same_folder(&other, &mount.local_root));
            (prev, clash)
        };
        if clash {
            anyhow::bail!("{} is already an on-demand folder", mount.local_root);
        }
        // Only an empty (or new) folder can become a mount: registering a
        // sync root over someone's files would turn them into placeholders.
        let moved = previous.as_ref().map(|p| p.local_root != mount.local_root).unwrap_or(true);
        if moved {
            let root = Path::new(&mount.local_root);
            if root.exists() && std::fs::read_dir(root).map(|mut d| d.next().is_some()).unwrap_or(true) {
                anyhow::bail!("Choose an empty folder: {} already has files in it", mount.local_root);
            }
        }
        // Restart: tear the old root down (clearing its placeholders) first.
        if let Some(prev) = &previous {
            if prev != &mount {
                self.teardown(&prev.id, Some(Path::new(&prev.local_root))).await;
                self.settings.lock().await.registered.retain(|r| r.pair_id != prev.id);
            }
        }
        {
            let mut s = self.settings.lock().await;
            match s.mounts.iter_mut().find(|m| m.id == mount.id) {
                Some(existing) => *existing = mount.clone(),
                None => s.mounts.push(mount.clone()),
            }
        }
        self.persist().await?;
        self.reconcile_all(app).await;
        Ok(mount)
    }

    pub async fn remove_mount(&self, app: &AppHandle, id: &str) -> Result<()> {
        self.settings.lock().await.mounts.retain(|m| m.id != id);
        self.persist().await?;
        self.reconcile_all(app).await;
        Ok(())
    }

    pub async fn set_mount_enabled(&self, app: &AppHandle, id: &str, enabled: bool) -> Result<()> {
        {
            let mut s = self.settings.lock().await;
            let m = s.mounts.iter_mut().find(|m| m.id == id).ok_or_else(|| anyhow::anyhow!("no such mount"))?;
            m.enabled = enabled;
        }
        self.persist().await?;
        self.reconcile_all(app).await;
        Ok(())
    }

    pub async fn status(&self) -> Vec<RootStatus> {
        let registered = self.settings.lock().await.registered.clone();
        let running = self.running.lock().await;
        let errors = self.errors.lock().await;
        registered
            .into_iter()
            .map(|r| RootStatus {
                running: running.contains_key(&r.pair_id),
                last_error: errors.get(&r.pair_id).cloned(),
                pair_id: r.pair_id,
                local_root: r.local_root,
            })
            .collect()
    }
}

/// Result of [`plan_reconcile`].
#[derive(Debug, PartialEq, Eq)]
struct Plan {
    to_unregister: Vec<String>,
    to_start: Vec<String>,
}

/// Pure set-math for reconcile: given the roots we believe are registered and
/// the live set of enabled on-demand pair ids, decide which to unregister
/// (registered but no longer live) and which to (re)start (live). Kept separate
/// so the orphan-cleanup logic is unit-tested without touching the OS.
fn plan_reconcile(persisted: &[RegisteredRoot], live_ids: &[String]) -> Plan {
    let to_unregister = persisted
        .iter()
        .map(|r| r.pair_id.clone())
        .filter(|id| !live_ids.contains(id))
        .collect();
    // Every live pair is a (re)start candidate; start_pair is a no-op if it's
    // already running.
    let to_start = live_ids.to_vec();
    Plan { to_unregister, to_start }
}

// ---------- Hydrator over a live Session ----------

/// Reuses foldersync's connect-lazily pattern: caches a session id, reconnecting
/// the profile on demand, and downloads through `TransferManager` so every
/// backend's streaming download path is reused verbatim.
// Fields/methods are exercised only by the Windows provider (see above).
#[allow(dead_code)]
pub struct SessionHydrator {
    app: AppHandle,
    profile_id: String,
    session_id: Mutex<Option<String>>,
}

#[allow(dead_code)]
impl SessionHydrator {
    pub fn new(app: AppHandle, profile_id: String) -> Self {
        Self { app, profile_id, session_id: Mutex::new(None) }
    }

    async fn session(&self) -> Result<Arc<crate::session::Session>> {
        let state = self.app.state::<AppState>();
        {
            let cached = self.session_id.lock().await.clone();
            if let Some(id) = cached {
                if let Some(s) = state.sessions.get(&id).await {
                    return Ok(s);
                }
            }
        }
        let profile = state
            .profiles
            .get(&self.profile_id)
            .await
            .context("loading the on-demand connection")?
            .ok_or_else(|| anyhow::anyhow!("connection for this on-demand folder no longer exists"))?;
        let id = state
            .sessions
            .connect(profile, self.app.clone())
            .await
            .context("connecting the on-demand backend")?;
        let session = state
            .sessions
            .get(&id)
            .await
            .ok_or_else(|| anyhow::anyhow!("session vanished right after connect"))?;
        *self.session_id.lock().await = Some(id);
        Ok(session)
    }
}

#[async_trait]
impl Hydrator for SessionHydrator {
    async fn list_dir(&self, remote_path: &str) -> Result<Vec<DirEntry>> {
        let session = self.session().await?;
        let fs = crate::commands::fs_for_session(&session);
        fs.list_dir(remote_path).await
    }

    async fn download_to(&self, remote_path: &str, dest_dir: &Path) -> Result<PathBuf> {
        use crate::transfer::{OverwritePolicy, TransferStatus};
        let session = self.session().await?;
        let state = self.app.state::<AppState>();
        std::fs::create_dir_all(dest_dir)
            .with_context(|| format!("create {}", dest_dir.display()))?;
        let id = state
            .transfers
            .start_download(
                session,
                remote_path.to_string(),
                dest_dir.to_string_lossy().into_owned(),
                OverwritePolicy::Overwrite,
                self.app.clone(),
            )
            .await
            .with_context(|| format!("start download {remote_path}"))?;

        // Block until the download reaches a terminal state.
        let dest = loop {
            let snap = state.transfers.snapshot(&id).await;
            match snap {
                Some(t) => match t.status {
                    TransferStatus::Done => break PathBuf::from(t.destination),
                    TransferStatus::Skipped => break PathBuf::from(t.destination),
                    TransferStatus::Error => {
                        anyhow::bail!("hydration download failed: {}", t.error.unwrap_or_default())
                    }
                    TransferStatus::Canceled => anyhow::bail!("hydration download canceled"),
                    TransferStatus::Queued | TransferStatus::Transferring | TransferStatus::Paused => {
                        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                    }
                },
                None => anyhow::bail!("hydration download vanished"),
            }
        };
        Ok(dest)
    }
}

// ---------- Tauri commands ----------

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn virtualfs_supported(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.virtualfs.supported())
}

#[tauri::command]
pub async fn virtualfs_status(state: State<'_, AppState>) -> Result<Vec<RootStatus>, String> {
    Ok(state.virtualfs.status().await)
}

#[tauri::command]
pub async fn virtualfs_mounts(state: State<'_, AppState>) -> Result<Vec<MountView>, String> {
    Ok(state.virtualfs.mounts().await)
}

#[tauri::command]
pub async fn virtualfs_mount_save(
    mount: Mount,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<MountView>, String> {
    state.virtualfs.save_mount(&app, mount).await.map_err(|e| format!("{e:#}"))?;
    Ok(state.virtualfs.mounts().await)
}

#[tauri::command]
pub async fn virtualfs_mount_remove(
    id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<MountView>, String> {
    state.virtualfs.remove_mount(&app, &id).await.map_err(err)?;
    Ok(state.virtualfs.mounts().await)
}

#[tauri::command]
pub async fn virtualfs_mount_set_enabled(
    id: String,
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<MountView>, String> {
    state.virtualfs.set_mount_enabled(&app, &id, enabled).await.map_err(err)?;
    Ok(state.virtualfs.mounts().await)
}

/// The folder a new mount named `name` would use by default.
#[tauri::command]
pub async fn virtualfs_default_mount_root(name: String) -> Result<String, String> {
    Ok(default_mount_root(&name).to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn virtualfs_free_up_space(
    pair_id: String,
    state: State<'_, AppState>,
) -> Result<u32, String> {
    state.virtualfs.free_up_space(&pair_id).await.map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root(id: &str) -> RegisteredRoot {
        RegisteredRoot { pair_id: id.into(), local_root: format!("C:/x/{id}") }
    }

    #[test]
    fn reconcile_unregisters_orphans_and_starts_live() {
        let persisted = vec![root("a"), root("b"), root("c")];
        let live = vec!["b".to_string(), "d".to_string()];
        let plan = plan_reconcile(&persisted, &live);
        // a and c are registered but no longer live → orphans to unregister.
        assert_eq!(plan.to_unregister, vec!["a".to_string(), "c".to_string()]);
        // Every live pair is a start candidate (start is a no-op if running).
        assert_eq!(plan.to_start, vec!["b".to_string(), "d".to_string()]);
    }

    #[test]
    fn reconcile_empty_live_unregisters_everything() {
        let persisted = vec![root("a"), root("b")];
        let plan = plan_reconcile(&persisted, &[]);
        assert_eq!(plan.to_unregister, vec!["a".to_string(), "b".to_string()]);
        assert!(plan.to_start.is_empty());
    }

    fn remote(name: &str, size: u64, dir: bool) -> DirEntry {
        DirEntry {
            name: name.into(),
            path: format!("/r/{name}"),
            kind: if dir { crate::remotefs::FileKind::Directory } else { crate::remotefs::FileKind::File },
            size,
            modified: None,
            mode: None,
            etag: None,
            link_dir: false,
        }
    }

    fn local(name: &str, size: u64, dir: bool, untouched: bool) -> LocalEntry {
        LocalEntry { name: name.into(), is_dir: dir, size, untouched_placeholder: untouched }
    }

    #[test]
    fn refresh_creates_new_and_removes_vanished_placeholders() {
        let plan = plan_refresh(
            &[local("old.jpg", 5, false, true), local("keep.jpg", 5, false, true)],
            &[remote("keep.jpg", 5, false), remote("new.jpg", 9, false), remote("dir", 0, true)],
        );
        assert_eq!(plan.create, vec!["new.jpg".to_string(), "dir".to_string()]);
        assert_eq!(plan.remove, vec!["old.jpg".to_string()]);
        assert!(plan.replace.is_empty());
    }

    #[test]
    fn refresh_never_touches_local_data() {
        // Hydrated or edited files and populated dirs are not "untouched":
        // a vanished or resized remote must never delete them.
        let plan = plan_refresh(
            &[local("edited.txt", 5, false, false), local("dir", 0, true, false)],
            &[remote("edited.txt", 99, false)],
        );
        assert_eq!(plan, RefreshPlan::default());
    }

    #[test]
    fn refresh_replaces_resized_placeholder() {
        let plan = plan_refresh(&[local("a.bin", 5, false, true)], &[remote("a.bin", 6, false)]);
        assert_eq!(plan.replace, vec!["a.bin".to_string()]);
    }

    #[test]
    fn default_mount_root_is_a_safe_folder_name() {
        let p = default_mount_root("R2: media/2024");
        assert_eq!(p.file_name().unwrap(), "R2- media-2024");
        assert_eq!(p.parent().unwrap().file_name().unwrap(), "Faro");
        assert_eq!(default_mount_root("..").file_name().unwrap(), "Connection");
    }

    #[test]
    fn old_settings_without_mounts_still_load() {
        let s: Settings = serde_json::from_str(r#"{"registered":[{"pairId":"a","localRoot":"C:/x"}]}"#).unwrap();
        assert!(s.mounts.is_empty());
        let m: Mount = serde_json::from_str(
            r#"{"id":"m","name":"n","profileId":"p","remoteRoot":"/","localRoot":"C:/m"}"#,
        )
        .unwrap();
        assert!(m.enabled && !m.write_back && !m.index);
    }

    #[test]
    fn reconcile_nothing_persisted_starts_all() {
        let plan = plan_reconcile(&[], &["a".to_string()]);
        assert!(plan.to_unregister.is_empty());
        assert_eq!(plan.to_start, vec!["a".to_string()]);
    }
}
