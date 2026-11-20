//! Copy to… — copy files and folders from one connection to another (Plan 34
//! Phase 1).
//!
//! Two halves, like folder sync:
//!
//! - [`plan`] is pure: given the source and destination trees (from the Plan 3
//!   scan engine) it decides, per file, copy / overwrite / skip, applies an
//!   optional rename function (Settings › Rules, Phase 5), and resolves name
//!   collisions. Shared with `faro-cli cp` so the CLI and the app agree.
//! - [`CopyJobs`] runs an accepted plan in the app. Each file goes through the
//!   existing `TransferManager` download and upload paths (so every backend
//!   pair works, with the queue's retry, resume, throttle and pause), staged
//!   through a per-job temp folder that's removed as each file lands. When both
//!   ends are the same connection, the backend's own copy is used instead
//!   (object-store server-side copy, `cp -a` over SSH, local disk).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::scan::{ScanEntry, ScanTree};

// ---------- options + plan types ----------

/// What to do when a destination file already exists.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Overwrite {
    /// Leave existing files alone (the default; makes a re-run resume).
    #[default]
    Skip,
    /// Replace only when the source is newer.
    Newer,
    /// Always replace.
    Always,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CopyOptions {
    pub overwrite: Overwrite,
    /// After each file lands, check the destination's size matches.
    pub verify: bool,
    /// A Settings › Rules rule set to rename files on the way (Phase 5).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rule_set: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemAction {
    /// Not at the destination yet.
    Copy,
    /// Exists and will be replaced (policy Newer/Always).
    Overwrite,
    /// Exists; left alone.
    Skip,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyItem {
    /// Absolute source path.
    pub source: String,
    /// Absolute destination path.
    pub dest: String,
    /// Destination path relative to the destination folder (after renames).
    pub rel_dest: String,
    pub size: u64,
    pub action: ItemAction,
    /// The destination name differs from the source name (a rule renamed it,
    /// or a collision got a `-1` suffix).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub renamed: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyPlan {
    pub dest_root: String,
    pub items: Vec<CopyItem>,
    /// Absolute destination folders to create, parents first.
    pub directories: Vec<String>,
    pub files_to_copy: u64,
    pub bytes_to_copy: u64,
    pub skipped: u64,
    pub renamed: u64,
    /// Two source files that wanted the same destination name; all but the
    /// first got a numeric suffix.
    pub collisions: u64,
}

/// One source to copy: a folder (its whole tree) or a single file.
#[derive(Debug, Clone)]
pub struct Source {
    /// The source's own name — the folder or file name created under the
    /// destination.
    pub name: String,
    /// Its tree, keyed relative to the source itself. For a single file use
    /// [`ScanTree`] with one entry keyed by the file name.
    pub tree: ScanTree,
    pub is_dir: bool,
}

/// Maps a destination-relative path (`photos/2024/a.jpg`) and its scan entry to
/// the path it should have. Identity when no rule set is attached.
pub type Namer<'a> = dyn Fn(&str, &ScanEntry) -> String + Send + Sync + 'a;

// ---------- planning (pure) ----------

/// Normalise an mtime to milliseconds (backends report s or ms).
fn as_ms(t: i64) -> i64 {
    if t != 0 && t.abs() < 100_000_000_000 {
        t * 1000
    } else {
        t
    }
}

fn join(dir: &str, rel: &str) -> String {
    if rel.is_empty() {
        return dir.to_string();
    }
    let sep = if dir.contains('\\') && !dir.contains('/') { "\\" } else { "/" };
    let rel = if sep == "\\" { rel.replace('/', "\\") } else { rel.to_string() };
    format!("{}{sep}{rel}", dir.trim_end_matches(['/', '\\']))
}

fn parent_rel(rel: &str) -> &str {
    rel.rfind('/').map(|i| &rel[..i]).unwrap_or("")
}

/// `name.ext` → `name-N.ext` (suffix before the last extension).
fn with_suffix(rel: &str, n: u32) -> String {
    let (dir, file) = match rel.rfind('/') {
        Some(i) => (&rel[..=i], &rel[i + 1..]),
        None => ("", rel),
    };
    match file.rfind('.').filter(|&i| i > 0) {
        Some(i) => format!("{dir}{}-{n}{}", &file[..i], &file[i..]),
        None => format!("{dir}{file}-{n}"),
    }
}

/// Build the copy plan. `dest_tree` is the destination folder's current tree
/// (empty if it doesn't exist yet).
pub fn plan(
    sources: &[Source],
    dest_root: &str,
    dest_tree: &ScanTree,
    opts: &CopyOptions,
    namer: &Namer<'_>,
) -> CopyPlan {
    let mut out = CopyPlan { dest_root: dest_root.to_string(), ..Default::default() };
    let mut taken: BTreeSet<String> = BTreeSet::new();
    let mut dirs: BTreeSet<String> = BTreeSet::new();

    for src in sources {
        for (rel, entry) in &src.tree.files {
            let natural = if src.is_dir { format!("{}/{rel}", src.name) } else { src.name.clone() };
            let wanted = namer(&natural, entry);
            let wanted = wanted.trim_matches('/').to_string();
            let wanted = if wanted.is_empty() { natural.clone() } else { wanted };

            // Two sources mapping to one name: suffix all but the first.
            let mut rel_dest = wanted.clone();
            let mut n = 1;
            while taken.contains(&rel_dest) {
                rel_dest = with_suffix(&wanted, n);
                n += 1;
            }
            if rel_dest != wanted {
                out.collisions += 1;
            }
            taken.insert(rel_dest.clone());

            let action = match dest_tree.files.get(&rel_dest) {
                None => ItemAction::Copy,
                Some(existing) => match opts.overwrite {
                    Overwrite::Skip => ItemAction::Skip,
                    Overwrite::Always => ItemAction::Overwrite,
                    // A 2 s slack absorbs FAT/FTP mtime rounding.
                    Overwrite::Newer if as_ms(entry.modified) > as_ms(existing.modified) + 2000 => {
                        ItemAction::Overwrite
                    }
                    Overwrite::Newer => ItemAction::Skip,
                },
            };
            let renamed = rel_dest != natural;
            if renamed {
                out.renamed += 1;
            }
            if action == ItemAction::Skip {
                out.skipped += 1;
            } else {
                out.files_to_copy += 1;
                out.bytes_to_copy += entry.size;
                // Every ancestor folder that doesn't exist yet.
                let mut p = parent_rel(&rel_dest);
                while !p.is_empty() {
                    if !dest_tree.directories.contains(p) {
                        dirs.insert(p.to_string());
                    }
                    p = parent_rel(p);
                }
            }
            out.items.push(CopyItem {
                source: entry.absolute.clone(),
                dest: join(dest_root, &rel_dest),
                rel_dest,
                size: entry.size,
                action,
                renamed,
            });
        }
        // Keep empty source folders (no renames apply to folders).
        if src.is_dir {
            for d in &src.tree.directories {
                let rel = if d.is_empty() { src.name.clone() } else { format!("{}/{d}", src.name) };
                if !dest_tree.directories.contains(&rel) {
                    dirs.insert(rel);
                }
            }
        }
    }
    // BTreeSet order puts "a" before "a/b": parents first.
    out.directories = dirs.into_iter().map(|d| join(dest_root, &d)).collect();
    out
}

/// A one-file [`ScanTree`] for copying a single file.
pub fn single_file_tree(name: &str, absolute: &str, size: u64, modified: i64, etag: Option<String>) -> ScanTree {
    let mut tree = ScanTree::default();
    tree.files.insert(
        name.to_string(),
        ScanEntry { absolute: absolute.to_string(), size, modified, etag },
    );
    tree
}

/// The plan's items as a CSV report (`action,source,destination,size,result`).
pub fn report_csv(items: &[CopyItem], results: &HashMap<String, String>) -> String {
    fn q(s: &str) -> String {
        format!("\"{}\"", s.replace('"', "\"\""))
    }
    let mut out = String::from("action,source,destination,size,result\n");
    for it in items {
        let action = match it.action {
            ItemAction::Copy => "copy",
            ItemAction::Overwrite => "overwrite",
            ItemAction::Skip => "skip",
        };
        let result = results.get(&it.dest).map(String::as_str).unwrap_or(if it.action == ItemAction::Skip {
            "skipped"
        } else {
            "not run"
        });
        out.push_str(&format!("{action},{},{},{},{}\n", q(&it.source), q(&it.dest), it.size, q(result)));
    }
    out
}

// ---------- running a plan in the app ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum JobState {
    Running,
    Done,
    Failed,
    Canceled,
}

/// The live view of one Copy to… run (`copyto://progress` payload).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobView {
    pub id: String,
    pub state: JobState,
    pub source_label: String,
    pub dest_label: String,
    pub total: u64,
    pub done: u64,
    pub failed: u64,
    pub skipped: u64,
    pub bytes_total: u64,
    pub bytes_done: u64,
    /// The file being copied right now, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    /// Where the CSV report was written once the run ended.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub report: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

struct Job {
    view: JobView,
    cancel: crate::scan::CancelToken,
}

/// Running and finished Copy to… jobs. Ephemeral (the transfers themselves are
/// persisted by the queue; a re-run of the same plan skips what landed).
#[derive(Default)]
pub struct CopyJobs {
    jobs: Mutex<BTreeMap<String, Job>>,
}

impl CopyJobs {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn list(&self) -> Vec<JobView> {
        self.jobs.lock().await.values().map(|j| j.view.clone()).collect()
    }

    pub async fn cancel(&self, id: &str) {
        if let Some(j) = self.jobs.lock().await.get(id) {
            j.cancel.cancel();
        }
    }

    /// Forget finished jobs.
    pub async fn clear_finished(&self) {
        self.jobs.lock().await.retain(|_, j| j.view.state == JobState::Running);
    }

    async fn update<F: FnOnce(&mut JobView)>(&self, app: &tauri::AppHandle, id: &str, f: F) {
        use tauri::Emitter;
        let view = {
            let mut jobs = self.jobs.lock().await;
            let Some(j) = jobs.get_mut(id) else { return };
            f(&mut j.view);
            j.view.clone()
        };
        let _ = app.emit("copyto://progress", view);
    }
}

/// Wait for a queued transfer to finish; returns its final destination.
async fn wait_transfer(
    transfers: &crate::transfer::TransferManager,
    app: &tauri::AppHandle,
    id: &str,
    cancel: &crate::scan::CancelToken,
) -> Result<String> {
    use crate::transfer::TransferStatus;
    loop {
        if cancel.is_cancelled() {
            let _ = transfers.cancel(id, app).await;
            anyhow::bail!("canceled");
        }
        match transfers.snapshot(id).await {
            Some(t) => match t.status {
                TransferStatus::Done | TransferStatus::Skipped => return Ok(t.destination),
                TransferStatus::Error => anyhow::bail!(t.error.unwrap_or_else(|| "transfer failed".into())),
                TransferStatus::Canceled => anyhow::bail!("canceled"),
                _ => tokio::time::sleep(std::time::Duration::from_millis(150)).await,
            },
            None => anyhow::bail!("transfer vanished"),
        }
    }
}

fn remote_parent(path: &str) -> String {
    match path.rfind(['/', '\\']) {
        Some(0) => path[..1].to_string(),
        Some(i) => path[..i].to_string(),
        None => String::new(),
    }
}

fn remote_name(path: &str) -> String {
    path.rsplit(['/', '\\']).next().unwrap_or(path).to_string()
}

/// Copy one item within the same connection, when the backend can do it
/// without moving bytes through Faro. `Ok(false)` = not supported, stage it.
async fn same_connection_copy(session: &crate::session::Session, item: &CopyItem) -> Result<bool> {
    use crate::session::Session;
    match session {
        Session::Object(obj) => {
            crate::remotefs::object::ObjectFs::new(obj.clone()).server_copy(&item.source, &item.dest).await?;
            Ok(true)
        }
        // `cp -a` refuses an existing target; overwrites go the staged way.
        Session::Ssh(ssh) if item.action == ItemAction::Copy => {
            crate::commands::copy_ssh(ssh, &item.source, &item.dest).await.map_err(anyhow::Error::msg)?;
            Ok(true)
        }
        _ => Ok(false),
    }
}

pub struct RunSpec {
    /// `None` = the local disk (an upload, renamed on the way if rules apply).
    pub source: Option<Arc<crate::session::Session>>,
    pub dest: Arc<crate::session::Session>,
    pub same_connection: bool,
    pub plan: CopyPlan,
    pub opts: CopyOptions,
    pub source_label: String,
    pub dest_label: String,
}

impl CopyJobs {
    /// Start running `spec` in the background; returns the job id.
    pub async fn start(self: &Arc<Self>, app: tauri::AppHandle, spec: RunSpec) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let cancel = crate::scan::CancelToken::new();
        let todo: Vec<&CopyItem> = spec.plan.items.iter().filter(|i| i.action != ItemAction::Skip).collect();
        let view = JobView {
            id: id.clone(),
            state: JobState::Running,
            source_label: spec.source_label.clone(),
            dest_label: spec.dest_label.clone(),
            total: todo.len() as u64,
            done: 0,
            failed: 0,
            skipped: spec.plan.skipped,
            bytes_total: spec.plan.bytes_to_copy,
            bytes_done: 0,
            current: None,
            report: None,
            error: None,
        };
        self.jobs.lock().await.insert(id.clone(), Job { view, cancel: cancel.clone() });
        let this = self.clone();
        let job_id = id.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = this.run(&app, &job_id, spec, cancel.clone()).await;
            let (state, error) = match outcome {
                Ok(_) if cancel.is_cancelled() => (JobState::Canceled, None),
                Ok(0) => (JobState::Done, None),
                Ok(n) => (JobState::Failed, Some(format!("{n} file(s) failed — see the report"))),
                Err(e) => (JobState::Failed, Some(format!("{e:#}"))),
            };
            this.update(&app, &job_id, |v| {
                v.state = state;
                v.error = error;
                v.current = None;
            })
            .await;
        });
        id
    }

    /// Returns the number of failed files.
    async fn run(
        &self,
        app: &tauri::AppHandle,
        id: &str,
        spec: RunSpec,
        cancel: crate::scan::CancelToken,
    ) -> Result<u64> {
        use tauri::Manager;
        let state = app.state::<crate::AppState>();
        let transfers = state.transfers.clone();
        let dest_fs = crate::commands::fs_for_session(&spec.dest);

        for dir in &spec.plan.directories {
            // An existing folder is fine; a real failure surfaces on upload.
            let _ = dest_fs.create_dir(dir).await;
        }

        let data_dir = tauri::Manager::path(app).app_data_dir().context("app data dir")?;
        let staging = data_dir.join("copy-staging").join(id);
        let mut results: HashMap<String, String> = HashMap::new();
        let mut failed = 0u64;

        for item in spec.plan.items.iter().filter(|i| i.action != ItemAction::Skip) {
            if cancel.is_cancelled() {
                break;
            }
            self.update(app, id, |v| v.current = Some(item.rel_dest.clone())).await;
            let res = self.copy_one(&spec, &transfers, app, &staging, item, &cancel, dest_fs.as_ref()).await;
            match &res {
                Ok(()) => {
                    results.insert(item.dest.clone(), "ok".into());
                }
                Err(e) => {
                    failed += 1;
                    results.insert(item.dest.clone(), format!("error: {e:#}"));
                }
            }
            let ok = res.is_ok();
            let size = item.size;
            self.update(app, id, |v| {
                if ok {
                    v.done += 1;
                    v.bytes_done += size;
                } else {
                    v.failed += 1;
                }
            })
            .await;
        }
        let _ = std::fs::remove_dir_all(&staging);

        // The report lives beside the transfer log, one CSV per run.
        let reports = data_dir.join("copy-reports");
        std::fs::create_dir_all(&reports).ok();
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let report = reports.join(format!("copy-{stamp}-{}.csv", &id[..8]));
        if std::fs::write(&report, report_csv(&spec.plan.items, &results)).is_ok() {
            let path = report.to_string_lossy().into_owned();
            self.update(app, id, |v| v.report = Some(path)).await;
        }
        Ok(failed)
    }

    #[allow(clippy::too_many_arguments)]
    async fn copy_one(
        &self,
        spec: &RunSpec,
        transfers: &Arc<crate::transfer::TransferManager>,
        app: &tauri::AppHandle,
        staging: &std::path::Path,
        item: &CopyItem,
        cancel: &crate::scan::CancelToken,
        dest_fs: &dyn crate::remotefs::RemoteFs,
    ) -> Result<()> {
        use crate::transfer::OverwritePolicy;
        if spec.same_connection && same_connection_copy(&spec.dest, item).await? {
            return verify(spec, item, dest_fs).await;
        }
        let Some(source) = spec.source.clone() else {
            return self.upload_local(spec, transfers, app, staging, item, cancel, dest_fs).await;
        };
        // Stage: download into a private folder, rename to the destination
        // name, upload into the destination folder, then drop the temp.
        let slot = staging.join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&slot).with_context(|| format!("create {}", slot.display()))?;
        let result = async {
            let dl = transfers
                .start_download(
                    source,
                    item.source.clone(),
                    slot.to_string_lossy().into_owned(),
                    OverwritePolicy::Overwrite,
                    app.clone(),
                )
                .await
                .with_context(|| format!("start download {}", item.source))?;
            let got = PathBuf::from(wait_transfer(transfers, app, &dl, cancel).await?);
            let named = slot.join(remote_name(&item.dest));
            if got != named {
                std::fs::rename(&got, &named).with_context(|| format!("stage {}", named.display()))?;
            }
            let policy = match item.action {
                ItemAction::Overwrite => OverwritePolicy::Overwrite,
                _ => OverwritePolicy::Skip,
            };
            let ul = transfers
                .start_upload(
                    spec.dest.clone(),
                    named.to_string_lossy().into_owned(),
                    remote_parent(&item.dest),
                    policy,
                    app.clone(),
                )
                .await
                .with_context(|| format!("start upload {}", item.dest))?;
            wait_transfer(transfers, app, &ul, cancel).await?;
            Ok::<(), anyhow::Error>(())
        }
        .await;
        let _ = std::fs::remove_dir_all(&slot);
        result?;
        verify(spec, item, dest_fs).await
    }
}

impl CopyJobs {
    /// Local disk → connection: upload the file itself, or a renamed hard link
    /// (copy if links aren't possible) when a rule changed its name.
    #[allow(clippy::too_many_arguments)]
    async fn upload_local(
        &self,
        spec: &RunSpec,
        transfers: &Arc<crate::transfer::TransferManager>,
        app: &tauri::AppHandle,
        staging: &std::path::Path,
        item: &CopyItem,
        cancel: &crate::scan::CancelToken,
        dest_fs: &dyn crate::remotefs::RemoteFs,
    ) -> Result<()> {
        use crate::transfer::OverwritePolicy;
        let want = remote_name(&item.dest);
        let (local, slot) = if remote_name(&item.source) == want {
            (PathBuf::from(&item.source), None)
        } else {
            let slot = staging.join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir_all(&slot)?;
            let named = slot.join(&want);
            if std::fs::hard_link(&item.source, &named).is_err() {
                std::fs::copy(&item.source, &named).with_context(|| format!("stage {}", item.source))?;
            }
            (named, Some(slot))
        };
        let policy = match item.action {
            ItemAction::Overwrite => OverwritePolicy::Overwrite,
            _ => OverwritePolicy::Skip,
        };
        let result = async {
            let ul = transfers
                .start_upload(spec.dest.clone(), local.to_string_lossy().into_owned(), remote_parent(&item.dest), policy, app.clone())
                .await
                .with_context(|| format!("start upload {}", item.dest))?;
            wait_transfer(transfers, app, &ul, cancel).await.map(|_| ())
        }
        .await;
        if let Some(slot) = slot {
            let _ = std::fs::remove_dir_all(slot);
        }
        result?;
        verify(spec, item, dest_fs).await
    }
}

async fn verify(spec: &RunSpec, item: &CopyItem, dest_fs: &dyn crate::remotefs::RemoteFs) -> Result<()> {
    if !spec.opts.verify {
        return Ok(());
    }
    let name = remote_name(&item.dest);
    let listing = dest_fs.list_dir(&remote_parent(&item.dest)).await?;
    match listing.iter().find(|e| e.name == name) {
        Some(e) if e.size == item.size => Ok(()),
        Some(e) => anyhow::bail!("verify: destination is {} bytes, source {}", e.size, item.size),
        None => anyhow::bail!("verify: destination file not found"),
    }
}

// ---------- Tauri commands ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceRef {
    pub path: String,
    pub is_dir: bool,
}

/// A session for the saved connection `profile_id`: an open one, else connect.
pub(crate) async fn session_for_profile(app: &tauri::AppHandle, profile_id: &str) -> Result<(String, Arc<crate::session::Session>)> {
    use tauri::Manager;
    let state = app.state::<crate::AppState>();
    if let Some(id) = state.sessions.ids_for_profile(profile_id).await.into_iter().next() {
        if let Some(s) = state.sessions.get(&id).await {
            return Ok((id, s));
        }
    }
    let profile = state
        .profiles
        .get(profile_id)
        .await?
        .ok_or_else(|| anyhow::anyhow!("that connection no longer exists"))?;
    let id = state.sessions.connect(profile, app.clone()).await?;
    let s = state.sessions.get(&id).await.ok_or_else(|| anyhow::anyhow!("session vanished"))?;
    Ok((id, s))
}

async fn build_plan(
    app: &tauri::AppHandle,
    source_session: Option<&Arc<crate::session::Session>>,
    sources: &[SourceRef],
    dest: &Arc<crate::session::Session>,
    dest_dir: &str,
    opts: &CopyOptions,
) -> Result<CopyPlan> {
    let src_fs: Box<dyn crate::remotefs::RemoteFs> = match source_session {
        Some(s) => crate::commands::fs_for_session(s),
        None => Box::new(crate::remotefs::local::LocalFs),
    };
    let dst_fs = crate::commands::fs_for_session(dest);
    let mut built = Vec::new();
    for s in sources {
        let name = remote_name(s.path.trim_end_matches(['/', '\\']));
        if s.is_dir {
            let tree = crate::scan::walk_tree(src_fs.as_ref(), &s.path)
                .await
                .with_context(|| format!("scan {}", s.path))?;
            built.push(Source { name, tree, is_dir: true });
        } else {
            let parent = remote_parent(&s.path);
            let entry = src_fs
                .list_dir(&parent)
                .await?
                .into_iter()
                .find(|e| e.name == name)
                .ok_or_else(|| anyhow::anyhow!("{} not found", s.path))?;
            built.push(Source {
                tree: single_file_tree(&name, &entry.path, entry.size, entry.modified.unwrap_or(0), entry.etag),
                name,
                is_dir: false,
            });
        }
    }
    let dest_tree = crate::scan::destination_tree(dst_fs.as_ref(), dest_dir).await?;
    let namer = crate::rules::namer_for(app, opts.rule_set.as_deref()).await?;
    Ok(plan(&built, dest_dir, &dest_tree, opts, namer.as_ref()))
}

async fn source_session(
    state: &crate::AppState,
    id: &str,
) -> Result<Option<Arc<crate::session::Session>>, String> {
    if id == crate::commands::LOCAL_SESSION {
        return Ok(None);
    }
    state.sessions.get(id).await.map(Some).ok_or_else(|| "source connection is closed".to_string())
}

#[tauri::command]
pub async fn copyto_plan(
    source_session_id: String,
    sources: Vec<SourceRef>,
    dest_profile_id: String,
    dest_dir: String,
    options: CopyOptions,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<CopyPlan, String> {
    let src = source_session(&state, &source_session_id).await?;
    let (_, dst) = session_for_profile(&app, &dest_profile_id).await.map_err(|e| format!("{e:#}"))?;
    build_plan(&app, src.as_ref(), &sources, &dst, &dest_dir, &options).await.map_err(|e| format!("{e:#}"))
}

/// Re-plan and start. Re-planning (rather than trusting a plan from the UI)
/// keeps the run honest if the destination changed while the dialog was open.
#[tauri::command]
pub async fn copyto_start(
    source_session_id: String,
    sources: Vec<SourceRef>,
    dest_profile_id: String,
    dest_dir: String,
    options: CopyOptions,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
) -> Result<String, String> {
    let src = source_session(&state, &source_session_id).await?;
    let (_, dst) = session_for_profile(&app, &dest_profile_id).await.map_err(|e| format!("{e:#}"))?;
    let plan = build_plan(&app, src.as_ref(), &sources, &dst, &dest_dir, &options)
        .await
        .map_err(|e| format!("{e:#}"))?;
    let same_connection = src.as_ref().is_some_and(|s| s.profile().id == dest_profile_id);
    let spec = RunSpec {
        source_label: src.as_ref().map(|s| s.profile().name.clone()).unwrap_or_else(|| "This PC".into()),
        dest_label: dst.profile().name.clone(),
        source: src,
        dest: dst,
        same_connection,
        plan,
        opts: options,
    };
    Ok(state.copyjobs.start(app, spec).await)
}

#[tauri::command]
pub async fn copyto_jobs(state: tauri::State<'_, crate::AppState>) -> Result<Vec<JobView>, String> {
    Ok(state.copyjobs.list().await)
}

#[tauri::command]
pub async fn copyto_cancel(id: String, state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    state.copyjobs.cancel(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn copyto_clear(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    state.copyjobs.clear_finished().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree(files: &[(&str, u64, i64)]) -> ScanTree {
        let mut t = ScanTree::default();
        for (rel, size, m) in files {
            t.files.insert(
                rel.to_string(),
                ScanEntry { absolute: format!("/src/{rel}"), size: *size, modified: *m, etag: None },
            );
            let mut p = parent_rel(rel);
            while !p.is_empty() {
                t.directories.insert(p.to_string());
                p = parent_rel(p);
            }
        }
        t.directories.insert(String::new());
        t
    }

    fn id(rel: &str, _: &ScanEntry) -> String {
        rel.to_string()
    }

    #[test]
    fn copies_new_skips_existing_and_creates_parents() {
        let src = Source { name: "lib".into(), tree: tree(&[("a.jpg", 10, 5), ("sub/b.jpg", 20, 5)]), is_dir: true };
        let mut dest = tree(&[("lib/a.jpg", 10, 5)]);
        dest.directories.insert("lib".into());
        let p = plan(&[src], "/dst", &dest, &CopyOptions::default(), &id);
        assert_eq!(p.files_to_copy, 1);
        assert_eq!(p.skipped, 1);
        assert_eq!(p.bytes_to_copy, 20);
        assert_eq!(p.directories, vec!["/dst/lib/sub".to_string()]);
        let b = p.items.iter().find(|i| i.rel_dest == "lib/sub/b.jpg").unwrap();
        assert_eq!(b.dest, "/dst/lib/sub/b.jpg");
        assert_eq!(b.source, "/src/sub/b.jpg");
    }

    #[test]
    fn newer_policy_compares_mixed_units() {
        // Source in seconds, destination in ms: 100 s vs 50_000 ms → newer.
        let src = Source { name: "x".into(), tree: tree(&[("f", 1, 100)]), is_dir: true };
        let dest = tree(&[("x/f", 1, 50_000)]);
        let opts = CopyOptions { overwrite: Overwrite::Newer, ..Default::default() };
        let p = plan(&[src.clone()], "/d", &dest, &opts, &id);
        assert_eq!(p.items[0].action, ItemAction::Overwrite);
        let dest_newer = tree(&[("x/f", 1, 200_000)]);
        assert_eq!(plan(&[src], "/d", &dest_newer, &opts, &id).items[0].action, ItemAction::Skip);
    }

    #[test]
    fn renames_and_collisions_get_suffixes() {
        let src = Source { name: "in".into(), tree: tree(&[("a.jpg", 1, 0), ("b.jpg", 1, 0), ("c.png", 1, 0)]), is_dir: true };
        // A rule that sends every jpg to the same name.
        let namer = |rel: &str, _: &ScanEntry| -> String {
            if rel.ends_with(".jpg") { "photos/same.jpg".into() } else { rel.into() }
        };
        let p = plan(&[src], "/d", &ScanTree::default(), &CopyOptions::default(), &namer);
        let mut names: Vec<_> = p.items.iter().map(|i| i.rel_dest.clone()).collect();
        names.sort();
        assert_eq!(names, vec!["in/c.png", "photos/same-1.jpg", "photos/same.jpg"]);
        assert_eq!(p.collisions, 1);
        assert_eq!(p.renamed, 2);
    }

    #[test]
    fn single_file_lands_under_its_name() {
        let src = Source { name: "r.pdf".into(), tree: single_file_tree("r.pdf", "/a/r.pdf", 3, 0, None), is_dir: false };
        let p = plan(&[src], "C:\\out", &ScanTree::default(), &CopyOptions::default(), &id);
        assert_eq!(p.items[0].dest, "C:\\out\\r.pdf");
        assert!(p.directories.is_empty());
    }

    #[test]
    fn csv_quotes_and_marks_results() {
        let items = vec![CopyItem {
            source: "/a/x \"1\".jpg".into(),
            dest: "/b/x.jpg".into(),
            rel_dest: "x.jpg".into(),
            size: 4,
            action: ItemAction::Copy,
            renamed: false,
        }];
        let mut r = HashMap::new();
        r.insert("/b/x.jpg".to_string(), "ok".to_string());
        let csv = report_csv(&items, &r);
        assert!(csv.contains("copy,\"/a/x \"\"1\"\".jpg\",\"/b/x.jpg\",4,\"ok\""));
    }

    #[test]
    fn suffix_goes_before_extension() {
        assert_eq!(with_suffix("a/b.tar.gz", 2), "a/b.tar-2.gz");
        assert_eq!(with_suffix(".env", 1), ".env-1");
        assert_eq!(with_suffix("noext", 3), "noext-3");
    }
}
