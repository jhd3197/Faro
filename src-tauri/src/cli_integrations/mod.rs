//! Cloud and platform CLIs as helpers for connections (Plan 35).
//!
//! Faro finds `aws`, `gcloud`, `az`, `gh`, `tailscale`, `doctl`, `hcloud`,
//! `render`, `hs` and `shopify` (it installs none of them: they are
//! [`Feed::DetectOnly`] tools in `managed_tools`), asks each one who is signed
//! in, imports servers, buckets and portals from it (discovery), and borrows
//! its login for short-lived credentials (sign-in). AWS SSM and Google IAP
//! tunnels live in `proxy_command.rs`.
//!
//! Rules every call here follows:
//! - A credential comes only from the command the CLI documents for it
//!   (`aws configure export-credentials`, `az account get-access-token`,
//!   `gcloud auth print-access-token`, `gh auth token`). Faro never reads a
//!   CLI's config or token files.
//! - The program runs from an absolute path with argv only: never a shell.
//!   An npm `.cmd` shim runs as `node <entry>.js`. Any other `.cmd`/`.bat`
//!   (gcloud and az ship as those on Windows) runs only with arguments made
//!   of plain characters, so `cmd.exe` has nothing to interpret.
//! - stdin is null, there is a time limit and an output cap, and no console
//!   window opens. Errors are Faro's own sentences; CLI output is never
//!   copied into one, and a credential is never logged or stored.

pub mod creds;
pub mod discover;
pub mod parse;
pub mod specs;
pub mod usage;

#[cfg(test)]
mod tests;

use crate::managed_tools::{self, Role};
use crate::proc::NoConsoleWindow;
use crate::AppState;
use anyhow::{anyhow, bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager as _, State};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::sync::Mutex;

pub use specs::specs;

/// Pushed whenever a CLI's account state changes.
pub const STATUS_EVENT: &str = "cli://status";
/// Account checks talk to a cloud API; `az` alone can take several seconds.
pub const CHECK_TIMEOUT: Duration = Duration::from_secs(45);
/// Listing servers or buckets across an account.
pub const DISCOVER_TIMEOUT: Duration = Duration::from_secs(60);
/// One credential.
pub const CRED_TIMEOUT: Duration = Duration::from_secs(30);
pub const SMALL_CAP: usize = 256 * 1024;
pub const LIST_CAP: usize = 8 * 1024 * 1024;
const STDERR_CAP: usize = 32 * 1024;
/// How often CLIs that some connection uses are re-checked.
pub const RECHECK_EVERY: Duration = Duration::from_secs(15 * 60);

// ---- Running a CLI ------------------------------------------------------------------

/// How a CLI's file is started: itself, or `node <script>` for an npm shim.
#[derive(Debug, Clone, PartialEq)]
pub struct Invocation {
    pub program: PathBuf,
    pub prefix: Vec<OsString>,
    /// A `.cmd`/`.bat` that `cmd.exe` runs: arguments must be plain.
    pub batch: bool,
}

fn is_batch(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"))
}

/// The JS entry an npm-generated `.cmd` shim runs: the quoted
/// `"%dp0%\node_modules\…\x.js"` (or `%~dp0`) path in it.
pub fn npm_shim_entry(shim: &str, dir: &Path) -> Option<PathBuf> {
    for marker in ["\"%dp0%\\", "\"%~dp0\\", "\"%~dp0"] {
        let mut rest = shim;
        while let Some(at) = rest.find(marker) {
            let after = &rest[at + marker.len()..];
            let Some(end) = after.find('"') else { break };
            let rel = &after[..end];
            if rel.to_ascii_lowercase().ends_with(".js") || rel.to_ascii_lowercase().ends_with(".cjs") || rel.to_ascii_lowercase().ends_with(".mjs") {
                let rel = rel.trim_start_matches(['\\', '/']);
                if rel.contains("..") || rel.contains('%') {
                    return None;
                }
                return Some(dir.join(rel.replace('\\', std::path::MAIN_SEPARATOR_STR)));
            }
            rest = &after[end..];
        }
    }
    None
}

/// Resolve how to start `path`.
pub fn invocation(path: &Path) -> Invocation {
    if cfg!(windows) && is_batch(path) {
        let dir = path.parent().unwrap_or(Path::new("."));
        let text = std::fs::read(path).ok().filter(|b| b.len() <= 64 * 1024).map(|b| String::from_utf8_lossy(&b).into_owned());
        if let Some(entry) = text.as_deref().and_then(|t| npm_shim_entry(t, dir)).filter(|e| e.is_file()) {
            let local_node = dir.join("node.exe");
            let node = if local_node.is_file() { Some(local_node) } else { specs::find_on_path(&["node"]) };
            if let Some(node) = node {
                return Invocation { program: node, prefix: vec![entry.into_os_string()], batch: false };
            }
        }
        return Invocation { program: path.to_path_buf(), prefix: Vec::new(), batch: true };
    }
    Invocation { program: path.to_path_buf(), prefix: Vec::new(), batch: false }
}

/// A plain argument `cmd.exe` passes through untouched.
pub fn plain_arg(a: &str) -> bool {
    !a.is_empty() && a.len() <= 512 && a.chars().all(|c| c.is_ascii_alphanumeric() || "-_.:/=@,+".contains(c))
}

/// A tokio command for `path` (an npm shim runs through node), with stdin
/// null, killed on drop and no console window. Used for `--version` too.
pub fn command(path: &Path) -> tokio::process::Command {
    let inv = invocation(path);
    let mut cmd = tokio::process::Command::new(&inv.program);
    cmd.args(&inv.prefix).stdin(Stdio::null()).kill_on_drop(true).no_console_window();
    cmd
}

/// The copy of tool `id` to run: `FARO_<ID>_PATH` (tests, the e2e harness),
/// then the user's own path from the CLIs page, then an installed one.
pub fn locate(id: &str) -> Option<PathBuf> {
    let var = format!("FARO_{}_PATH", id.to_ascii_uppercase().replace('-', "_"));
    if let Some(p) = std::env::var_os(&var).filter(|v| !v.is_empty()).map(PathBuf::from) {
        return Some(p);
    }
    if let Some(p) = managed_tools::selected(id) {
        return Some(p);
    }
    let spec = managed_tools::spec(id).ok()?;
    (spec.find_installed)()
}

/// What a CLI printed. `stderr` is for classifying failures only: it is
/// never shown or logged.
#[derive(Debug, Clone, Default)]
pub struct Ran {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

impl Ran {
    pub fn both(&self) -> String {
        format!("{}\n{}", self.stdout, self.stderr)
    }
}

pub fn display_name(id: &str) -> &'static str {
    managed_tools::spec(id).map(|s| s.name).unwrap_or("The CLI")
}

/// Run tool `id` with `args`.
pub async fn run(id: &str, args: &[String], limit: Duration, cap: usize) -> Result<Ran> {
    let name = display_name(id);
    let path = locate(id).ok_or_else(|| anyhow!("{name} isn't installed. Install it, then click Check on the CLIs page."))?;
    ensure!(path.is_absolute(), "{name} must be run from an absolute path");
    run_at(&path, name, args, limit, cap, &[]).await
}

/// Run the file at `path` (tests call this directly).
pub async fn run_at(path: &Path, name: &str, args: &[String], limit: Duration, cap: usize, env: &[(&str, &str)]) -> Result<Ran> {
    let inv = invocation(path);
    if inv.batch {
        ensure!(args.iter().all(|a| plain_arg(a)), "{name} can't be given that value safely; use only letters, digits and - _ . : / = @ , +");
    }
    let mut cmd = tokio::process::Command::new(&inv.program);
    cmd.args(&inv.prefix)
        .args(args)
        .envs(env.iter().copied())
        // Ask CLIs for plain, uncoloured, non-interactive output.
        .env("NO_COLOR", "1")
        .env("AWS_PAGER", "")
        .env("CLOUDSDK_CORE_DISABLE_PROMPTS", "1")
        .env("AZURE_CORE_NO_COLOR", "1")
        .env("AZURE_CORE_ONLY_SHOW_ERRORS", "1")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("RENDER_NO_UPDATE_CHECK", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_console_window();
    let mut child = cmd.spawn().map_err(|_| anyhow!("{name} couldn't start"))?;
    let stdout = child.stdout.take().context("no stdout")?;
    let stderr = child.stderr.take().context("no stderr")?;
    let done = tokio::time::timeout(limit, async {
        let (out, err) = tokio::join!(read_capped(stdout, cap), read_capped(stderr, STDERR_CAP));
        let status = child.wait().await;
        (out, err, status)
    })
    .await;
    match done {
        Ok((out, err, status)) => {
            let (out, over) = out?;
            ensure!(!over, "{name} printed more than Faro reads; narrow it down and try again");
            let (err, _) = err?;
            Ok(Ran {
                ok: status.map(|s| s.success()).unwrap_or(false),
                stdout: String::from_utf8_lossy(&out).into_owned(),
                stderr: String::from_utf8_lossy(&err).into_owned(),
            })
        }
        Err(_) => {
            let _ = child.kill().await;
            bail!("{name} didn't answer within {} seconds", limit.as_secs())
        }
    }
}

async fn read_capped(mut from: impl AsyncRead + Unpin, cap: usize) -> Result<(Vec<u8>, bool)> {
    let mut buf = Vec::new();
    (&mut from).take(cap as u64 + 1).read_to_end(&mut buf).await?;
    let over = buf.len() > cap;
    buf.truncate(cap);
    // Drain the rest so the child doesn't block on a full pipe.
    let mut sink = [0u8; 8192];
    while from.read(&mut sink).await.unwrap_or(0) > 0 {}
    Ok((buf, over))
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---- Account state --------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CliState {
    /// Not installed.
    Missing,
    /// Installed but nobody is signed in.
    SignedOut,
    Ready,
    /// The login expired: sign in again.
    Expired,
    /// The check failed for another reason (see `detail`).
    Error,
    /// Installed; this CLI has no account to check, or it wasn't checked yet.
    Unknown,
}

impl CliState {
    /// Something a person has to fix.
    pub fn is_problem(self) -> bool {
        matches!(self, CliState::Missing | CliState::SignedOut | CliState::Expired | CliState::Error)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliAccount {
    /// What Faro passes back to the CLI: an AWS profile, a gcloud account, an
    /// Azure subscription id, a HubSpot portal id, …
    pub id: String,
    /// For people: "client-a (123456789012)".
    pub label: String,
    pub state: CliState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// The CLI's default or active account.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub active: bool,
    /// Faro may use this account's login for connections.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub allowed: bool,
}

/// One account check's result.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Checked {
    pub state: Option<CliState>,
    pub accounts: Vec<CliAccount>,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    pub id: String,
    pub name: String,
    pub roles: Vec<Role>,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub state: CliState,
    pub accounts: Vec<CliAccount>,
    /// One of Faro's plain sentences about `state`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// When the account was last checked (unix seconds); 0 = never.
    pub checked_at: u64,
    /// The login command Sign in runs, for display: "aws sso login".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sign_in: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_url: Option<String>,
    /// The CLI has an account to check at all.
    pub has_account: bool,
    /// Where to read about it.
    pub docs_url: String,
}

/// Plain sentences Faro writes for each state.
pub fn state_detail(id: &str, state: CliState) -> Option<String> {
    let name = display_name(id);
    let login = specs::sign_in_display(id, None);
    Some(match state {
        CliState::Missing => format!("{name} isn't installed."),
        CliState::SignedOut => match login {
            Some(l) => format!("Nobody is signed in to {name}. Click Sign in (runs `{l}`)."),
            None => format!("Nobody is signed in to {name}."),
        },
        CliState::Expired => match login {
            Some(l) => format!("Your {name} login expired. Click Sign in (runs `{l}`)."),
            None => format!("Your {name} login expired."),
        },
        CliState::Error => format!("Faro couldn't check {name}. Click Check to try again."),
        CliState::Ready | CliState::Unknown => return None,
    })
}

/// Classify a failed run by what the CLI said: signed out, expired or other.
pub fn classify_failure(text: &str) -> CliState {
    let t = text.to_ascii_lowercase();
    const EXPIRED: [&str; 14] = [
        "expired",
        "token has expired",
        "sso session",
        "refresh token",
        "invalid_grant",
        "reauthenticat",
        "re-authenticat",
        "aadsts700082",
        "aadsts50173",
        "invalidclienttokenid",
        "the security token included in the request is invalid",
        "token is invalid",
        "unable to authenticate",
        "401",
    ];
    const SIGNED_OUT: [&str; 17] = [
        "not logged in",
        "not logged into",
        "please run 'az login'",
        "please run \"az login\"",
        "az login",
        "unable to locate credentials",
        "no credentialed accounts",
        "access token is required",
        "render login",
        "needslogin",
        "needs login",
        "gh auth login",
        "no active context",
        "could not be found",
        "no accounts",
        "you must be logged in",
        "not authenticated",
    ];
    if EXPIRED.iter().any(|m| t.contains(m)) {
        CliState::Expired
    } else if SIGNED_OUT.iter().any(|m| t.contains(m)) {
        CliState::SignedOut
    } else {
        CliState::Error
    }
}

/// Run tool `id`'s account check. `wanted` are accounts some connection uses:
/// they are checked first.
pub async fn check_account(id: &str, wanted: &BTreeSet<String>) -> Checked {
    let result = match id {
        "aws" => parse::aws_check(wanted).await,
        "gcloud" => run(id, &args(&["auth", "list", "--format=json"]), CHECK_TIMEOUT, SMALL_CAP).await.map(|r| parse::gcloud_accounts(&r)),
        "az" => run(id, &args(&["account", "list", "--all", "-o", "json"]), CHECK_TIMEOUT, LIST_CAP).await.map(|r| parse::az_accounts(&r)),
        "gh" => run(id, &args(&["auth", "status", "--hostname", "github.com"]), CHECK_TIMEOUT, SMALL_CAP).await.map(|r| parse::gh_status(&r)),
        "tailscale" => run(id, &args(&["status", "--json"]), CHECK_TIMEOUT, LIST_CAP).await.map(|r| parse::tailscale_status(&r)),
        "doctl" => run(id, &args(&["account", "get", "-o", "json"]), CHECK_TIMEOUT, SMALL_CAP).await.map(|r| parse::doctl_account(&r)),
        "hcloud" => run(id, &args(&["context", "active"]), CHECK_TIMEOUT, SMALL_CAP).await.map(|r| parse::hcloud_context(&r)),
        "render" => run(id, &args(&["whoami", "-o", "json"]), CHECK_TIMEOUT, SMALL_CAP).await.map(|r| parse::render_whoami(&r)),
        "hs" => run(id, &args(&["accounts", "list"]), CHECK_TIMEOUT, SMALL_CAP).await.map(|r| parse::hs_accounts(&r)),
        _ => return Checked { state: Some(CliState::Unknown), ..Default::default() },
    };
    match result {
        Ok(c) => c,
        Err(e) => Checked { state: Some(CliState::Error), detail: Some(format!("{e:#}")), ..Default::default() },
    }
}

pub fn args(a: &[&str]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

// ---- Settings (consent) -----------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// Accounts whose login Faro may use, per tool.
    pub allowed: BTreeMap<String, BTreeSet<String>>,
}

pub fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cli-integrations.json")
}

pub fn read_config(data_dir: &Path) -> Config {
    std::fs::read(config_path(data_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_config(data_dir: &Path, cfg: &Config) -> Result<()> {
    std::fs::create_dir_all(data_dir).ok();
    Ok(crate::fsutil::write_atomic(&config_path(data_dir), &serde_json::to_vec_pretty(cfg)?)?)
}

/// Whether `tool`'s `account` login may be used. faro-cli reads the same file.
pub fn is_allowed(data_dir: &Path, tool: &str, account: &str) -> bool {
    read_config(data_dir).allowed.get(tool).is_some_and(|s| s.contains(account))
}

pub fn set_allowed(data_dir: &Path, tool: &str, account: &str, allowed: bool) -> Result<()> {
    ensure!(managed_tools::spec(tool).is_ok(), "Unknown CLI: {tool}");
    ensure!(!account.trim().is_empty() && account.len() <= 256, "Pick an account");
    let mut cfg = read_config(data_dir);
    let set = cfg.allowed.entry(tool.to_string()).or_default();
    if allowed {
        set.insert(account.to_string());
    } else {
        set.remove(account);
        creds::forget(tool, account);
    }
    if set.is_empty() {
        cfg.allowed.remove(tool);
    }
    write_config(data_dir, &cfg)
}

/// The data dir faro-cli and the app share.
pub fn data_dir() -> Result<PathBuf> {
    crate::credential_refs::config_path().map(|p| p.parent().map(Path::to_path_buf).unwrap_or_default())
}

// ---- The app's state ------------------------------------------------------------------

pub struct Integrations {
    data_dir: PathBuf,
    last: Mutex<HashMap<String, CliStatus>>,
    /// One check per tool at a time.
    checking: Mutex<HashMap<String, Arc<Mutex<()>>>>,
}

impl Integrations {
    pub fn load(app: &AppHandle) -> Result<Self> {
        let dir = app.path().app_data_dir().context("resolving app_data_dir")?;
        Ok(Self::from_dir(dir))
    }

    pub fn from_dir(data_dir: PathBuf) -> Self {
        Self { data_dir, last: Mutex::new(HashMap::new()), checking: Mutex::new(HashMap::new()) }
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// Installed or not, version, and the last account check, without
    /// running an account check.
    pub async fn status(&self, id: &str, tools: &managed_tools::Tools) -> Result<CliStatus> {
        let spec = managed_tools::spec(id)?;
        let tool = tools.get(id)?.status().await;
        let env_path = locate_override(id);
        let installed = env_path.is_some() || tool.source != managed_tools::Source::Missing;
        let last = self.last.lock().await.get(id).cloned();
        let has_account = specs::has_account(id);
        let mut s = CliStatus {
            id: id.to_string(),
            name: spec.name.to_string(),
            roles: spec.roles.to_vec(),
            installed,
            path: env_path.map(|p| p.display().to_string()).or(tool.path),
            version: tool.version,
            state: if installed { CliState::Unknown } else { CliState::Missing },
            accounts: Vec::new(),
            detail: None,
            checked_at: 0,
            sign_in: specs::sign_in_display(id, None),
            install_url: tool.install_url,
            has_account,
            docs_url: specs::docs_url(id).to_string(),
        };
        if let (Some(last), true) = (last, installed) {
            s.state = last.state;
            s.accounts = last.accounts;
            s.detail = last.detail;
            s.checked_at = last.checked_at;
        }
        if !installed {
            s.detail = state_detail(id, CliState::Missing);
        }
        self.mark_allowed(&mut s);
        Ok(s)
    }

    fn mark_allowed(&self, s: &mut CliStatus) {
        let cfg = read_config(&self.data_dir);
        let allowed = cfg.allowed.get(&s.id);
        for a in &mut s.accounts {
            a.allowed = allowed.is_some_and(|set| set.contains(&a.id));
        }
    }

    /// Run the account check now.
    pub async fn check(&self, id: &str, tools: &managed_tools::Tools, wanted: &BTreeSet<String>) -> Result<CliStatus> {
        let lock = self.checking.lock().await.entry(id.to_string()).or_insert_with(|| Arc::new(Mutex::new(()))).clone();
        let _one = lock.lock().await;
        let mut s = self.status(id, tools).await?;
        if !s.installed {
            return Ok(s);
        }
        if s.has_account {
            let checked = check_account(id, wanted).await;
            s.state = checked.state.unwrap_or(CliState::Unknown);
            s.accounts = checked.accounts;
            s.detail = checked.detail.or_else(|| state_detail(id, s.state));
            s.sign_in = specs::sign_in_display(id, s.accounts.iter().find(|a| a.state != CliState::Ready).map(|a| a.id.as_str()));
        }
        s.checked_at = now_secs();
        self.mark_allowed(&mut s);
        self.last.lock().await.insert(id.to_string(), s.clone());
        Ok(s)
    }

    pub async fn statuses(&self, tools: &managed_tools::Tools) -> Vec<CliStatus> {
        let ids = specs::all_cli_ids();
        futures::future::join_all(ids.iter().map(|id| self.status(id, tools))).await.into_iter().filter_map(Result::ok).collect()
    }
}

fn locate_override(id: &str) -> Option<PathBuf> {
    let var = format!("FARO_{}_PATH", id.to_ascii_uppercase().replace('-', "_"));
    std::env::var_os(&var).filter(|v| !v.is_empty()).map(PathBuf::from)
}

/// After startup and every [`RECHECK_EVERY`]: check the CLIs that some
/// connection uses, and tell the UI.
pub async fn background_checks(app: AppHandle) {
    tokio::time::sleep(Duration::from_secs(8)).await;
    loop {
        let state = app.state::<AppState>();
        let profiles = state.profiles.list().await.unwrap_or_default();
        let used = usage::accounts_by_tool(&profiles);
        for (id, wanted) in used {
            if !specs::all_cli_ids().contains(&id.as_str()) {
                continue;
            }
            if let Ok(s) = state.clis.check(&id, &state.tools, &wanted).await {
                let _ = app.emit(STATUS_EVENT, &s);
            }
        }
        tokio::time::sleep(RECHECK_EVERY).await;
    }
}

/// One CLI for `faro-cli tools` and the Agent Bridge: its state and how many
/// connections use it. Never holds a credential.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolReport {
    #[serde(flatten)]
    pub status: CliStatus,
    pub used_by: usize,
}

/// Check every installed CLI (or just `only`) and report. Used outside the
/// app's state: faro-cli and the bridge build their own managers.
pub async fn report(data_dir: &Path, profiles: &[crate::profiles::ConnectionProfile], only: Option<&str>) -> Result<Vec<ToolReport>> {
    if let Some(id) = only {
        managed_tools::spec(id)?;
    }
    let tools = managed_tools::Tools::from_dir(data_dir);
    let ints = Integrations::from_dir(data_dir.to_path_buf());
    let wanted = usage::accounts_by_tool(profiles);
    let counts = usage::counts(profiles);
    let ids: Vec<&str> = specs::all_cli_ids().into_iter().filter(|id| only.is_none_or(|o| o == *id)).collect();
    let checks = futures::future::join_all(ids.iter().map(|id| {
        let w = wanted.get(*id).cloned().unwrap_or_default();
        let (tools, ints) = (&tools, &ints);
        async move { ints.check(id, tools, &w).await }
    }))
    .await;
    Ok(checks
        .into_iter()
        .filter_map(Result::ok)
        .map(|status| {
            let used_by = counts.get(&status.id).copied().unwrap_or(0);
            ToolReport { status, used_by }
        })
        .collect())
}

// ---- Sign in ----------------------------------------------------------------------------

/// Open the CLI's own login in a new console window. Faro never sees the
/// password; it re-checks when the window closes.
pub async fn sign_in(id: &str, account: Option<&str>) -> Result<tokio::process::Child> {
    let argv = specs::sign_in_args(id, account).ok_or_else(|| anyhow!("{} has no sign-in command", display_name(id)))?;
    let path = locate(id).ok_or_else(|| anyhow!("{} isn't installed", display_name(id)))?;
    let inv = invocation(&path);
    if inv.batch {
        ensure!(argv.iter().all(|a| plain_arg(a)), "That account name can't be passed to {} safely", display_name(id));
    }
    #[cfg(windows)]
    {
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        let mut cmd = tokio::process::Command::new(&inv.program);
        cmd.args(&inv.prefix).args(&argv).creation_flags(CREATE_NEW_CONSOLE);
        cmd.spawn().map_err(|_| anyhow!("Couldn't open a window for {}", display_name(id)))
    }
    #[cfg(target_os = "macos")]
    {
        // Terminal.app runs a `.command` file; every word is single-quoted
        // (and the words are checked to hold no quote).
        let words: Vec<String> = std::iter::once(inv.program.into_os_string())
            .chain(inv.prefix)
            .map(|w| w.to_string_lossy().into_owned())
            .chain(argv)
            .collect();
        ensure!(words.iter().all(|w| !w.contains('\'')), "That account name can't be passed safely");
        let line = words.iter().map(|w| format!("'{w}'")).collect::<Vec<_>>().join(" ");
        let script = std::env::temp_dir().join(format!("faro-sign-in-{}.command", uuid::Uuid::new_v4()));
        std::fs::write(&script, format!("#!/bin/sh\n{line}\nrm -f \"$0\"\n"))?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700))?;
        tokio::process::Command::new("open").args(["-W", "-a", "Terminal"]).arg(&script).spawn().map_err(|_| anyhow!("Couldn't open Terminal"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        for (term, flag) in [("x-terminal-emulator", "-e"), ("gnome-terminal", "--wait --"), ("konsole", "-e"), ("xterm", "-e")] {
            if let Some(t) = specs::find_on_path(&[term]) {
                let mut cmd = tokio::process::Command::new(t);
                cmd.args(flag.split(' ')).arg(&inv.program).args(&inv.prefix).args(&argv);
                if let Ok(child) = cmd.spawn() {
                    return Ok(child);
                }
            }
        }
        bail!("Faro couldn't find a terminal to open. Run `{}` yourself, then click Check.", specs::sign_in_display(id, account).unwrap_or_default())
    }
}

// ---- Tauri commands -------------------------------------------------------------------

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

async fn wanted_for(state: &AppState, id: &str) -> BTreeSet<String> {
    let profiles = state.profiles.list().await.unwrap_or_default();
    usage::accounts_by_tool(&profiles).remove(id).unwrap_or_default()
}

/// Every CLI, as last checked (no account checks run).
#[tauri::command]
pub async fn cli_statuses(state: State<'_, AppState>) -> Result<Vec<CliStatus>, String> {
    Ok(state.clis.statuses(&state.tools).await)
}

/// Check one CLI's account now.
#[tauri::command]
pub async fn cli_check(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<CliStatus, String> {
    let wanted = wanted_for(&state, &id).await;
    let s = state.clis.check(&id, &state.tools, &wanted).await.map_err(err)?;
    let _ = app.emit(STATUS_EVENT, &s);
    Ok(s)
}

/// Run the CLI's login in a window; re-check when it closes.
#[tauri::command]
pub async fn cli_sign_in(id: String, account: Option<String>, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let mut child = sign_in(&id, account.as_deref()).await.map_err(err)?;
    let _ = &state;
    tauri::async_runtime::spawn(async move {
        let _ = tokio::time::timeout(Duration::from_secs(15 * 60), child.wait()).await;
        let state = app.state::<AppState>();
        let wanted = wanted_for(&state, &id).await;
        if let Ok(s) = state.clis.check(&id, &state.tools, &wanted).await {
            let _ = app.emit(STATUS_EVENT, &s);
        }
    });
    Ok(())
}

/// Allow or stop Faro using `account`'s login.
#[tauri::command]
pub async fn cli_set_allowed(id: String, account: String, allowed: bool, app: AppHandle, state: State<'_, AppState>) -> Result<CliStatus, String> {
    set_allowed(state.clis.data_dir(), &id, &account, allowed).map_err(err)?;
    let s = state.clis.status(&id, &state.tools).await.map_err(err)?;
    let _ = app.emit(STATUS_EVENT, &s);
    Ok(s)
}

/// Servers, buckets or portals `account` can reach, as import previews.
#[tauri::command]
pub async fn cli_discover(id: String, account: Option<String>, state: State<'_, AppState>) -> Result<Vec<crate::importers::ProfilePreview>, String> {
    let mut previews = discover::discover(&id, account.as_deref()).await.map_err(err)?;
    let existing = state.profiles.list().await.map_err(err)?;
    discover::mark_conflicts(&mut previews, &existing);
    Ok(previews)
}

/// Test `cliAuth` for a profile draft: fetch a credential and drop it.
#[tauri::command]
pub async fn cli_auth_test(auth: crate::profiles::CliAuth, state: State<'_, AppState>) -> Result<String, String> {
    creds::test(state.clis.data_dir(), &auth).await.map_err(err)
}
