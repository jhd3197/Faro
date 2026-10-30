//! Named Cloudflare Access TCP forwards (issue #61).
//!
//! A connection stores the definitions (`profiles::CfForward`). This module
//! runs them: `cloudflared access tcp --hostname H --url 127.0.0.1:PORT`,
//! with the same binary and Access credentials as an SSH session. The app
//! starts them when the session connects and stops them when it disconnects
//! or the process exits. `faro-cli cf forward` uses the same functions, the
//! same `profiles.json`, and the pid file in the app data dir, so a forward
//! started in one can be stopped from the other.
//!
//! A forward the app started is marked `owner = "app"` and is killed on exit.
//! One the CLI started stays up after the CLI returns, until `stop`.

use std::collections::HashMap;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::profiles::{CfForward, ConnectionProfile, ProxyCommandKind};

const FILE_NAME: &str = "cf-forwards.json";
/// How long a new cloudflared is watched before we trust it stayed up.
const EARLY_EXIT: Duration = Duration::from_millis(400);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Record {
    profile_id: String,
    profile_name: String,
    name: String,
    pid: u32,
    local_port: u16,
    hostname: String,
    web: bool,
    /// `"app"` (dies with Faro) or `"cli"` (stays until `stop`).
    owner: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct File {
    #[serde(default)]
    forwards: Vec<Record>,
}

/// What `start` handed back. Dropping it does not kill the process — the pid
/// file is what `stop` and exit cleanup use, so the CLI can return while the
/// forward keeps listening.
pub struct RunningForward {
    pub name: String,
    pub hostname: String,
    pub local_port: u16,
    pub pid: u32,
    /// Already listening from an earlier start; nothing new was spawned.
    pub already: bool,
    child: Option<Child>,
}

impl std::fmt::Debug for RunningForward {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RunningForward")
            .field("name", &self.name)
            .field("hostname", &self.hostname)
            .field("local_port", &self.local_port)
            .field("pid", &self.pid)
            .field("already", &self.already)
            .field("child", &self.child.as_ref().map(|c| c.id()))
            .finish()
    }
}

/// One row for the server rail.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardStatus {
    pub profile_id: String,
    pub profile_name: String,
    pub name: String,
    pub hostname: String,
    pub local_port: u16,
    pub web: bool,
    pub running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// In-process bookkeeping for the app: child handles (so a crash is reaped)
/// and the last start error, which the rail shows next to the forward.
pub struct Manager {
    dir: PathBuf,
    children: Mutex<HashMap<(String, String), Child>>,
    errors: Mutex<HashMap<(String, String), String>>,
}

impl Manager {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        Self {
            dir: dir.into(),
            children: Mutex::new(HashMap::new()),
            errors: Mutex::new(HashMap::new()),
        }
    }

    /// Start every forward on `profile`. One failure does not stop the others;
    /// each error is remembered for the rail.
    pub fn start_profile(&self, profile: &ConnectionProfile) -> Vec<ForwardStatus> {
        for forward in &profile.cf_forwards {
            let key = (profile.id.clone(), forward.name.trim().to_string());
            match start(&self.dir, profile, forward, "app", None) {
                Ok(running) => {
                    if let Some(child) = running.child {
                        if let Ok(mut children) = self.children.lock() {
                            if let Some(old) = children.insert(key.clone(), child) {
                                reap(old);
                            }
                        }
                    }
                    if let Ok(mut errors) = self.errors.lock() {
                        errors.remove(&key);
                    }
                }
                Err(e) => {
                    if let Ok(mut errors) = self.errors.lock() {
                        errors.insert(key, format!("{e:#}"));
                    }
                }
            }
        }
        self.list(std::slice::from_ref(profile))
    }

    /// Stop the forwards this app started for a connection (session disconnect).
    /// A forward the CLI started is left running.
    pub fn stop_profile(&self, profile_id: &str) {
        let names: Vec<String> = load(&self.dir)
            .into_iter()
            .filter(|r| r.profile_id == profile_id && r.owner == "app")
            .map(|r| r.name)
            .collect();
        for name in names {
            let _ = self.stop(profile_id, &name);
        }
    }

    pub fn stop(&self, profile_id: &str, name: &str) -> Result<()> {
        let key = (profile_id.to_string(), name.to_string());
        if let Ok(mut children) = self.children.lock() {
            if let Some(child) = children.remove(&key) {
                reap(child);
            }
        }
        stop(&self.dir, profile_id, name)?;
        if let Ok(mut errors) = self.errors.lock() {
            errors.remove(&key);
        }
        Ok(())
    }

    /// Kill every forward the app started. Called on process exit.
    pub fn shutdown(&self) {
        let owned: Vec<(String, String)> = load(&self.dir)
            .into_iter()
            .filter(|r| r.owner == "app")
            .map(|r| (r.profile_id, r.name))
            .collect();
        for (profile_id, name) in owned {
            let _ = self.stop(&profile_id, &name);
        }
        if let Ok(mut children) = self.children.lock() {
            for (_, child) in children.drain() {
                reap(child);
            }
        }
    }

    pub fn list(&self, profiles: &[ConnectionProfile]) -> Vec<ForwardStatus> {
        let errors = self
            .errors
            .lock()
            .ok()
            .map(|g| g.clone())
            .unwrap_or_default();
        status_rows(&self.dir, profiles, &errors)
    }

    /// Start one forward if it isn't up, then open the local web panel.
    pub fn open_in_browser(&self, profile: &ConnectionProfile, name: &str) -> Result<()> {
        let forward = profile
            .cf_forwards
            .iter()
            .find(|f| f.name == name)
            .with_context(|| {
                format!("connection '{}' has no forward named {name}", profile.name)
            })?;
        if !forward.web {
            bail!("forward '{name}' is not a web panel");
        }
        let running = start(&self.dir, profile, forward, "app", None)?;
        let key = (profile.id.clone(), forward.name.trim().to_string());
        if let Some(child) = running.child {
            if let Ok(mut children) = self.children.lock() {
                children.insert(key.clone(), child);
            }
        }
        if let Ok(mut errors) = self.errors.lock() {
            errors.remove(&key);
        }
        let url = local_url(running.local_port);
        crate::proc::open_in_browser(&url).with_context(|| format!("open {url}"))
    }
}

pub fn local_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}/")
}

/// Find a saved forward by `name`, or by `connection/name` when more than one
/// connection uses that name.
pub fn resolve<'a>(
    profiles: &'a [ConnectionProfile],
    name: &str,
) -> Result<(&'a ConnectionProfile, &'a CfForward)> {
    let name = name.trim();
    if let Some((connection, forward_name)) = name.split_once('/') {
        let profile = profiles
            .iter()
            .find(|p| p.name == connection || p.id == connection)
            .with_context(|| format!("no connection named {connection}"))?;
        let matches: Vec<_> = profile
            .cf_forwards
            .iter()
            .filter(|f| f.name == forward_name)
            .collect();
        return match matches.len() {
            1 => Ok((profile, matches[0])),
            0 => bail!(
                "connection '{}' has no forward named {forward_name}",
                profile.name
            ),
            _ => bail!(
                "connection '{}' has more than one forward named {forward_name}",
                profile.name
            ),
        };
    }
    let mut hits: Vec<_> = profiles
        .iter()
        .flat_map(|p| {
            p.cf_forwards
                .iter()
                .filter(|f| f.name == name)
                .map(move |f| (p, f))
        })
        .collect();
    match hits.len() {
        1 => Ok(hits.remove(0)),
        0 => bail!(
            "no saved forward named {name}. Add it on the connection in Faro, then try again."
        ),
        _ => {
            let list = hits
                .iter()
                .map(|(p, f)| format!("{}/{}", p.name, f.name))
                .collect::<Vec<_>>()
                .join(", ");
            bail!("more than one forward is named {name}: {list}. Use connection/name.")
        }
    }
}

/// Listen for `forward`. `cloudflared` overrides the binary the app resolved
/// (tests pass a stand-in); `None` uses the same path Settings and faro-cli use.
pub fn start(
    dir: &Path,
    profile: &ConnectionProfile,
    forward: &CfForward,
    owner: &str,
    cloudflared: Option<&Path>,
) -> Result<RunningForward> {
    let name = forward.name.trim();
    if name.is_empty() {
        bail!("a forward needs a name");
    }
    if name.contains('/') {
        bail!("forward name '{name}' can't contain /");
    }
    if forward.local_port == 0 {
        bail!("forward '{name}' needs a local port");
    }
    let hostname = access_hostname(profile, forward)?;
    let mut records = load(dir);
    records.retain(|r| alive(r.pid));
    if let Some(existing) = records
        .iter()
        .find(|r| r.profile_id == profile.id && r.name == name)
    {
        if existing.local_port == forward.local_port && existing.hostname == hostname {
            save(dir, &records)?;
            return Ok(RunningForward {
                name: name.to_string(),
                hostname,
                local_port: existing.local_port,
                pid: existing.pid,
                already: true,
                child: None,
            });
        }
        // The saved port or hostname changed under a live process.
        kill_tree(existing.pid);
    }
    records.retain(|r| !(r.profile_id == profile.id && r.name == name));
    if let Some(other) = records.iter().find(|r| r.local_port == forward.local_port) {
        bail!(
            "local port {} is already used by forward '{}' on {}",
            forward.local_port,
            other.name,
            other.profile_name
        );
    }
    // Bind before spawning so a conflict never leaves a process behind.
    // cloudflared would fail the same way a moment later; this reports it
    // without starting anything.
    ensure_port_free(forward.local_port)?;
    let bin = cloudflared_bin(cloudflared)?;
    let cfg = profile
        .proxy_command
        .as_ref()
        .filter(|c| c.kind == ProxyCommandKind::Cloudflare);
    let env = crate::proxy_command::cloudflare_token_env(cfg)?;
    let mut child = spawn(&bin, &hostname, forward.local_port, &env)?;
    if let Some(message) = early_exit(&mut child) {
        let _ = child.wait();
        bail!("cloudflared didn't start the forward '{name}': {message}");
    }
    let pid = child.id();
    records.push(Record {
        profile_id: profile.id.clone(),
        profile_name: profile.name.clone(),
        name: name.to_string(),
        pid,
        local_port: forward.local_port,
        hostname: hostname.clone(),
        web: forward.web,
        owner: owner.to_string(),
    });
    if let Err(e) = save(dir, &records) {
        reap(child);
        return Err(e);
    }
    Ok(RunningForward {
        name: name.to_string(),
        hostname,
        local_port: forward.local_port,
        pid,
        already: false,
        child: Some(child),
    })
}

/// Stop one forward, whoever started it. Missing is an error so `stop` on the
/// CLI can tell the user it wasn't running.
pub fn stop(dir: &Path, profile_id: &str, name: &str) -> Result<()> {
    let mut records = load(dir);
    let Some(pos) = records
        .iter()
        .position(|r| r.profile_id == profile_id && r.name == name)
    else {
        bail!("forward '{name}' is not running");
    };
    let record = records.remove(pos);
    save(dir, &records)?;
    kill_tree(record.pid);
    Ok(())
}

pub fn access_hostname(profile: &ConnectionProfile, forward: &CfForward) -> Result<String> {
    if let Some(host) = forward
        .hostname
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Ok(host.to_string());
    }
    if let Some(cfg) = profile
        .proxy_command
        .as_ref()
        .filter(|c| c.kind == ProxyCommandKind::Cloudflare)
    {
        if let Some(host) = cfg
            .hostname
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            return Ok(host.to_string());
        }
    }
    let host = profile.host.trim();
    if host.is_empty() {
        bail!("forward '{}' has no Access hostname", forward.name.trim());
    }
    Ok(host.to_string())
}

fn status_rows(
    dir: &Path,
    profiles: &[ConnectionProfile],
    errors: &HashMap<(String, String), String>,
) -> Vec<ForwardStatus> {
    let mut records = load(dir);
    let before = records.len();
    records.retain(|r| alive(r.pid));
    if records.len() != before {
        let _ = save(dir, &records);
    }
    let mut rows = Vec::new();
    for profile in profiles {
        for forward in &profile.cf_forwards {
            let name = forward.name.trim();
            if name.is_empty() {
                continue;
            }
            let key = (profile.id.clone(), name.to_string());
            let running = records
                .iter()
                .find(|r| r.profile_id == profile.id && r.name == name);
            let hostname = access_hostname(profile, forward).unwrap_or_default();
            rows.push(ForwardStatus {
                profile_id: profile.id.clone(),
                profile_name: profile.name.clone(),
                name: name.to_string(),
                hostname: running.map(|r| r.hostname.clone()).unwrap_or(hostname),
                local_port: forward.local_port,
                web: forward.web,
                running: running.is_some(),
                pid: running.map(|r| r.pid),
                error: errors.get(&key).cloned(),
            });
        }
    }
    rows
}

fn cloudflared_bin(explicit: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        if !path.is_file() {
            bail!("cloudflared at {} doesn't exist", path.display());
        }
        return Ok(path.to_path_buf());
    }
    crate::proxy_command::resolve_cloudflared()
}

fn ensure_port_free(port: u16) -> Result<()> {
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(e) => bail!("local port {port} is already in use ({e})"),
    }
}

fn spawn(bin: &Path, hostname: &str, port: u16, env: &[(String, String)]) -> Result<Child> {
    let mut cmd = Command::new(bin);
    cmd.arg("access")
        .arg("tcp")
        .arg("--hostname")
        .arg(hostname)
        .arg("--url")
        .arg(format!("127.0.0.1:{port}"));
    for (key, value) in env {
        cmd.env(key, value);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    // Own process group, and no console window: the forward outlives the CLI
    // process that started it, and Faro can kill the group on stop.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("run cloudflared ({})", bin.display()))?;
    // Drain stderr so a chatty cloudflared can't fill the pipe and stall.
    // The early-exit check reads whatever arrived.
    let log = std::sync::Arc::new(Mutex::new(String::new()));
    if let Some(mut err) = child.stderr.take() {
        let log = log.clone();
        std::thread::spawn(move || {
            let mut buf = [0u8; 1024];
            loop {
                match err.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if let Ok(mut text) = log.lock() {
                            text.push_str(&String::from_utf8_lossy(&buf[..n]));
                            if text.len() > 4000 {
                                let drain = text.len() - 4000;
                                text.drain(..drain);
                            }
                        }
                    }
                }
            }
        });
    }
    // Stash the log on the child via a side channel the early check reads.
    // The thread owns the pipe; we keep the Arc in a process-local map keyed
    // by pid so early_exit can see the message.
    if let Ok(mut logs) = stderr_logs().lock() {
        logs.insert(child.id(), log);
    }
    Ok(child)
}

fn stderr_logs() -> &'static Mutex<HashMap<u32, std::sync::Arc<Mutex<String>>>> {
    static LOGS: std::sync::OnceLock<Mutex<HashMap<u32, std::sync::Arc<Mutex<String>>>>> =
        std::sync::OnceLock::new();
    LOGS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn early_exit(child: &mut Child) -> Option<String> {
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                std::thread::sleep(Duration::from_millis(30));
                let text = stderr_logs()
                    .lock()
                    .ok()
                    .and_then(|mut logs| logs.remove(&child.id()))
                    .and_then(|log| log.lock().ok().map(|t| t.trim().to_string()))
                    .filter(|t| !t.is_empty());
                return Some(text.unwrap_or_else(|| format!("cloudflared exited ({status})")));
            }
            Ok(None) => {
                if start.elapsed() >= EARLY_EXIT {
                    return None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => return None,
        }
    }
}

fn reap(mut child: Child) {
    let pid = child.id();
    kill_tree(pid);
    let _ = child.wait();
    if let Ok(mut logs) = stderr_logs().lock() {
        logs.remove(&pid);
    }
}

fn kill_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        std::thread::sleep(Duration::from_millis(150));
        if alive(pid) {
            let _ = Command::new("kill")
                .args(["-KILL", &format!("-{pid}")])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let _ = Command::new("kill")
                .args(["-KILL", &pid.to_string()])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub(crate) fn alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    {
        // A zombie still answers `kill -0`. On Linux the state in
        // /proc/<pid>/stat is `Z` once the process has actually exited;
        // that is what "no orphan" means here. Other Unixes fall back to
        // `kill -0` (the parent is expected to wait on the Child).
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            let state = stat
                .rsplit(')')
                .next()
                .and_then(|rest| rest.split_whitespace().next());
            return !matches!(state, None | Some("Z"));
        }
        Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .creation_flags(0x0800_0000)
            .output();
        out.map(|o| String::from_utf8_lossy(&o.stdout).contains(&pid.to_string()))
            .unwrap_or(false)
    }
}

fn path_of(dir: &Path) -> PathBuf {
    dir.join(FILE_NAME)
}

fn load(dir: &Path) -> Vec<Record> {
    let path = path_of(dir);
    let Ok(bytes) = std::fs::read(&path) else {
        return Vec::new();
    };
    serde_json::from_slice::<File>(&bytes)
        .map(|f| f.forwards)
        .unwrap_or_default()
}

fn save(dir: &Path, records: &[Record]) -> Result<()> {
    std::fs::create_dir_all(dir).ok();
    let path = path_of(dir);
    let data = serde_json::to_vec_pretty(&File {
        forwards: records.to_vec(),
    })?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, data).with_context(|| format!("write {}", tmp.display()))?;
    std::fs::rename(&tmp, &path).with_context(|| format!("replace {}", path.display()))?;
    Ok(())
}

// ---- Commands ----

use crate::AppState;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn cf_forwards_status(state: State<'_, AppState>) -> Result<Vec<ForwardStatus>, String> {
    let profiles = state.profiles.list().await.map_err(|e| format!("{e:#}"))?;
    Ok(state.cf_forwards.list(&profiles))
}

#[tauri::command]
pub async fn cf_forward_start(
    profile_id: String,
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ForwardStatus, String> {
    let profile = state
        .profiles
        .get(&profile_id)
        .await
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| format!("profile {profile_id} not found"))?;
    let forward = profile
        .cf_forwards
        .iter()
        .find(|f| f.name == name)
        .cloned()
        .ok_or_else(|| format!("connection '{}' has no forward named {name}", profile.name))?;
    let mgr = state.cf_forwards.clone();
    let profile_for = profile.clone();
    let started = tokio::task::spawn_blocking(move || {
        let key = (profile_for.id.clone(), forward.name.trim().to_string());
        match start(&mgr.dir, &profile_for, &forward, "app", None) {
            Ok(running) => {
                if let Some(child) = running.child {
                    if let Ok(mut children) = mgr.children.lock() {
                        children.insert(key.clone(), child);
                    }
                }
                if let Ok(mut errors) = mgr.errors.lock() {
                    errors.remove(&key);
                }
                Ok(())
            }
            Err(e) => {
                if let Ok(mut errors) = mgr.errors.lock() {
                    errors.insert(key, format!("{e:#}"));
                }
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    let _ = app.emit("cf-forward://status", ());
    started.map_err(|e| format!("{e:#}"))?;
    state
        .cf_forwards
        .list(std::slice::from_ref(&profile))
        .into_iter()
        .find(|row| row.name == name)
        .ok_or_else(|| format!("forward {name} disappeared"))
}

#[tauri::command]
pub async fn cf_forward_stop(
    profile_id: String,
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mgr = state.cf_forwards.clone();
    tokio::task::spawn_blocking(move || mgr.stop(&profile_id, &name))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))?;
    let _ = app.emit("cf-forward://status", ());
    Ok(())
}

#[tauri::command]
pub async fn cf_forward_open(
    profile_id: String,
    name: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let profile = state
        .profiles
        .get(&profile_id)
        .await
        .map_err(|e| format!("{e:#}"))?
        .ok_or_else(|| format!("profile {profile_id} not found"))?;
    let mgr = state.cf_forwards.clone();
    let open_name = name.clone();
    tokio::task::spawn_blocking(move || mgr.open_in_browser(&profile, &open_name))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))?;
    let _ = app.emit("cf-forward://status", ());
    Ok(())
}

#[cfg(test)]
#[path = "cf_forward_tests.rs"]
mod tests;
