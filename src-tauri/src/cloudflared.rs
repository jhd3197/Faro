//! Cloudflare without a terminal (Plan 29, issue #53): which `cloudflared`
//! Faro runs, installing and updating a Faro-managed copy of the official
//! release, and the Access sign-in state per hostname.
//!
//! Shaped like `cli_updater.rs`: JSON config under the app data dir
//! (`cloudflared.json`), the managed copy in `<app data>/bin/`, status pushed
//! as `"cloudflared://status"`. The binary choice reaches `proxy_command`
//! through `configure`, which faro-cli calls too.
//!
//! The binary choice, install and update are the shared `managed_tools`
//! machinery; this module holds cloudflared's spec and the thin names
//! faro-cli and the tests use.

use crate::managed_tools::{self, Feed, ToolManager, ToolSpec};
use crate::proc::NoConsoleWindow;
use crate::proxy_command;
use anyhow::{bail, Context, Result};
use base64::Engine as _;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use crate::AppState;

pub use crate::managed_tools::{expected_sha256, is_newer, swap_in, Asset, Config, Source as BinarySource, ToolStatus as BinaryStatus};

/// GitHub API for the official releases.
pub const RELEASE_API: &str = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
/// How long a browser sign-in may take.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// `cloudflared access token`: local, should be quick.
const QUICK_TIMEOUT: Duration = Duration::from_secs(20);

pub static SPEC: ToolSpec = ToolSpec {
    id: "cloudflared",
    name: "cloudflared",
    program: "cloudflared",
    config_file: "cloudflared.json",
    feed: Feed::GitHub { api: RELEASE_API, tag_prefix: "", pick: pick_asset },
    parse_version,
    find_installed: || proxy_command::find_program("cloudflared", true),
    check_custom: |_| Ok(()),
    on_select: proxy_command::set_cloudflared_path,
};

#[cfg(test)]
fn exe_name() -> String {
    managed_tools::exe_name("cloudflared")
}

pub fn managed_path(data_dir: &Path) -> PathBuf {
    managed_tools::managed_path(&SPEC, data_dir)
}

pub fn read_config(data_dir: &Path) -> Config {
    managed_tools::read_config(&SPEC, data_dir)
}

/// Which binary this data dir selects, and why: custom → managed → PATH.
pub fn locate(data_dir: &Path, cfg: &Config) -> (BinarySource, Option<PathBuf>) {
    managed_tools::locate(&SPEC, data_dir, cfg)
}

/// Point proxy commands at the binary this data dir selects. Without a
/// custom or managed copy, they search PATH as before.
pub fn configure(data_dir: &Path) {
    managed_tools::configure(&SPEC, data_dir);
}

/// `cloudflared version 2026.10.4 (built ...)` → `2026.10.4`.
pub fn parse_version(out: &str) -> Option<String> {
    let mut words = out.split_whitespace();
    words.by_ref().find(|w| *w == "version")?;
    let v = words.next()?.trim_start_matches('v');
    v.chars().next()?.is_ascii_digit().then(|| v.to_string())
}

pub async fn version(path: &Path) -> Option<String> {
    managed_tools::version(&SPEC, path).await
}

/// The official release asset for an OS/arch (`std::env::consts` names).
pub fn asset_name(os: &str, arch: &str) -> Result<&'static str> {
    Ok(match (os, arch) {
        // No native Windows arm64 build; the amd64 one runs emulated.
        ("windows", "x86_64" | "aarch64") => "cloudflared-windows-amd64.exe",
        ("windows", "x86") => "cloudflared-windows-386.exe",
        ("linux", "x86_64") => "cloudflared-linux-amd64",
        ("linux", "aarch64") => "cloudflared-linux-arm64",
        ("linux", "arm") => "cloudflared-linux-arm",
        ("linux", "x86") => "cloudflared-linux-386",
        ("macos", "x86_64") => "cloudflared-darwin-amd64.tgz",
        ("macos", "aarch64") => "cloudflared-darwin-arm64.tgz",
        (os, arch) => bail!("Cloudflare publishes no cloudflared build for {os}/{arch}"),
    })
}

fn pick_asset(os: &str, arch: &str, _names: &[&str]) -> Result<String> {
    asset_name(os, arch).map(str::to_string)
}

/// The `cloudflared` file inside a release `.tgz`.
pub fn extract_from_tgz(bytes: &[u8]) -> Result<Vec<u8>> {
    managed_tools::extract_from_tgz(bytes, "cloudflared")
}

/// Downloads official releases. The API URL can point elsewhere for tests.
pub struct Installer(managed_tools::Installer);

impl Default for Installer {
    fn default() -> Self {
        Self::new(RELEASE_API)
    }
}

impl Installer {
    pub fn new(api_url: &str) -> Self {
        Self(managed_tools::Installer::with_urls(&SPEC, api_url, "", None))
    }

    /// Download, verify and swap in the latest release at `dest`. Returns
    /// the installed version.
    pub async fn install(&self, dest: &Path) -> Result<String> {
        self.0.install(dest).await
    }
}

// ---- Access sign-in --------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AccessState {
    LoggedIn,
    LoggedOut,
    Expired,
    /// No Access application in front of the host: no sign-in needed.
    NotProtected,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessStatus {
    pub hostname: String,
    pub state: AccessState,
    /// The signed-in email, or the service token's name.
    pub identity: Option<String>,
    /// Unix seconds.
    pub expires_at: Option<i64>,
    pub message: Option<String>,
}

fn app_url(hostname: &str) -> String {
    let h = hostname.trim().trim_end_matches('/');
    if h.starts_with("https://") || h.starts_with("http://") {
        h.to_string()
    } else {
        format!("https://{h}")
    }
}

/// Identity and expiry from an Access JWT's payload.
pub fn decode_jwt(token: &str) -> Option<(Option<String>, Option<i64>)> {
    let payload = token.trim().split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let v: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let identity = ["email", "common_name", "sub"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|x| x.as_str()).filter(|s| !s.is_empty()).map(String::from));
    Some((identity, v.get("exp").and_then(|e| e.as_i64())))
}

/// Read what `cloudflared access token` printed.
pub fn classify_token(hostname: &str, ok: bool, stdout: &str, stderr: &str, now: i64) -> AccessStatus {
    let mut status = AccessStatus {
        hostname: hostname.to_string(),
        state: AccessState::Unknown,
        identity: None,
        expires_at: None,
        message: None,
    };
    let text = format!("{stdout}\n{stderr}").to_ascii_lowercase();
    if text.contains("failed to find access application") {
        status.state = AccessState::NotProtected;
        return status;
    }
    if ["no such host", "failed to get app info", "could not resolve", "connection refused"].iter().any(|n| text.contains(n)) {
        status.message = Some(format!("can't reach {} (check the hostname and your network)", app_url(hostname)));
        return status;
    }
    let token = stdout.lines().map(str::trim).find(|l| l.matches('.').count() == 2 && !l.contains(' '));
    if let (true, Some((identity, exp))) = (ok, token.and_then(decode_jwt)) {
        status.identity = identity;
        status.expires_at = exp;
        status.state = match exp {
            Some(exp) if exp <= now => AccessState::Expired,
            _ => AccessState::LoggedIn,
        };
        return status;
    }
    if text.contains("unable to find token") || text.contains("no token") || text.contains("token is expired") || text.contains("login") {
        status.state = if text.contains("expired") { AccessState::Expired } else { AccessState::LoggedOut };
        return status;
    }
    status.message = stderr.lines().map(str::trim).rfind(|l| !l.is_empty()).map(String::from);
    status
}

fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Whether `hostname` has a usable Access token, and whose.
pub async fn access_status(bin: &Path, hostname: &str) -> AccessStatus {
    let run = tokio::process::Command::new(bin)
        .args(["access", "token", "--app", &app_url(hostname)])
        .stdin(std::process::Stdio::null())
        .no_console_window()
        .output();
    match tokio::time::timeout(QUICK_TIMEOUT, run).await {
        Ok(Ok(out)) => classify_token(
            hostname,
            out.status.success(),
            &String::from_utf8_lossy(&out.stdout),
            &String::from_utf8_lossy(&out.stderr),
            now(),
        ),
        Ok(Err(e)) => AccessStatus {
            hostname: hostname.into(),
            state: AccessState::Unknown,
            identity: None,
            expires_at: None,
            message: Some(format!("couldn't run cloudflared: {e}")),
        },
        Err(_) => AccessStatus {
            hostname: hostname.into(),
            state: AccessState::Unknown,
            identity: None,
            expires_at: None,
            message: Some("cloudflared didn't answer".into()),
        },
    }
}

/// Run `cloudflared <args>` for `hostname`, passing each Access sign-in URL
/// it prints to `on_url` once, and wait as long as a browser sign-in may take.
/// Returns whether it succeeded and every line it printed.
async fn run_with_sign_in(
    bin: &Path,
    args: &[&str],
    hostname: &str,
    on_url: impl Fn(String) + Send + Sync + 'static,
) -> Result<(bool, Vec<String>)> {
    let mut child = tokio::process::Command::new(bin)
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .no_console_window()
        .spawn()
        .with_context(|| format!("couldn't start {}", bin.display()))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        bail!("cloudflared's output could not be read");
    };
    // Each sign-in URL once, from whichever pipe prints it.
    let seen = std::sync::Mutex::new(Vec::<String>::new());
    let on_url: std::sync::Arc<dyn Fn(String) + Send + Sync> = std::sync::Arc::new(move |url: String| {
        let fresh = seen.lock().map(|mut s| !s.contains(&url) && { s.push(url.clone()); true }).unwrap_or(false);
        if fresh {
            on_url(url);
        }
    });
    let read = |pipe: Box<dyn tokio::io::AsyncRead + Unpin + Send>, on_url: std::sync::Arc<dyn Fn(String) + Send + Sync>| async move {
        let mut lines = Vec::new();
        let mut reader = BufReader::new(pipe);
        let mut buf = Vec::new();
        while reader.read_until(b'\n', &mut buf).await.unwrap_or(0) > 0 {
            let line = String::from_utf8_lossy(&buf).trim().to_string();
            if let Some(url) = proxy_command::access_login_url(&line) {
                on_url(url);
            }
            lines.push(line);
            buf.clear();
        }
        lines
    };
    let out_task = tokio::spawn(read(Box::new(stdout), on_url.clone()));
    let err_task = tokio::spawn(read(Box::new(stderr), on_url));
    let finished = tokio::time::timeout(LOGIN_TIMEOUT, child.wait()).await;
    let Ok(waited) = finished else {
        let _ = child.kill().await;
        bail!("the Cloudflare Access sign-in for {hostname} didn't finish within {} minutes", LOGIN_TIMEOUT.as_secs() / 60);
    };
    let ok = waited.map(|s| s.success()).unwrap_or(false);
    let mut said = out_task.await.unwrap_or_default();
    said.extend(err_task.await.unwrap_or_default());
    Ok((ok, said))
}

fn no_access_app(said: &[String]) -> bool {
    said.join("\n").to_ascii_lowercase().contains("failed to find access application")
}

fn last_line(said: &[String]) -> String {
    said.iter().rfind(|l| !l.is_empty()).cloned().unwrap_or_default()
}

/// Sign in to `hostname` in the browser (cloudflared opens it; `on_url` gets
/// the page too) and wait for it, then report the new state.
pub async fn access_login(bin: &Path, hostname: &str, on_url: impl Fn(String) + Send + Sync + 'static) -> Result<AccessStatus> {
    let app = app_url(hostname);
    let args = ["access", "login", "--quiet", "--auto-close", "--app", &app];
    let (ok, said) = run_with_sign_in(bin, &args, hostname, on_url).await?;
    if no_access_app(&said) {
        return Ok(classify_token(hostname, false, "", "failed to find Access application", now()));
    }
    let status = access_status(bin, hostname).await;
    if !ok && status.state != AccessState::LoggedIn {
        bail!("the Cloudflare Access sign-in for {hostname} failed: {}", last_line(&said));
    }
    Ok(status)
}

/// One `ssh-gen` per hostname at a time: its output files have fixed names.
fn ssh_gen_turn(hostname: &str) -> std::sync::Arc<Mutex<()>> {
    type Turns = std::sync::Mutex<std::collections::HashMap<String, std::sync::Arc<Mutex<()>>>>;
    static TURNS: std::sync::OnceLock<Turns> = std::sync::OnceLock::new();
    let mut turns = TURNS.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    turns.entry(hostname.to_ascii_lowercase()).or_default().clone()
}

/// A fresh short-lived SSH certificate for the signed-in user, from
/// `cloudflared access ssh-gen` (signing in first when needed; `on_url` gets
/// the page). The key and certificate it writes are read, then deleted.
pub async fn ssh_gen(
    bin: &Path,
    hostname: &str,
    on_url: impl Fn(String) + Send + Sync + Clone + 'static,
) -> Result<(russh_keys::key::KeyPair, ssh_key::Certificate)> {
    let dir = crate::ssh_cert::cloudflared_dir().context("couldn't find the home folder cloudflared writes to")?;
    ssh_gen_in(bin, hostname, &dir, on_url).await
}

/// `ssh_gen`, reading what cloudflared wrote to `dir`.
async fn ssh_gen_in(
    bin: &Path,
    hostname: &str,
    dir: &Path,
    on_url: impl Fn(String) + Send + Sync + Clone + 'static,
) -> Result<(russh_keys::key::KeyPair, ssh_key::Certificate)> {
    let turn = ssh_gen_turn(hostname);
    let _turn = turn.lock().await;
    let mut attempt = 0;
    loop {
        attempt += 1;
        let args = ["access", "ssh-gen", "--hostname", hostname];
        let (ok, said) = run_with_sign_in(bin, &args, hostname, on_url.clone()).await?;
        if no_access_app(&said) {
            bail!("{hostname} has no Cloudflare Access application, so Cloudflare can't issue an SSH certificate for it; log in with a key or password instead");
        }
        if !ok {
            bail!(
                "Cloudflare didn't issue an SSH certificate for {hostname}: {}. Check that you're signed in and that its Access application has a short-lived certificate CA",
                last_line(&said)
            );
        }
        match crate::ssh_cert::take_ssh_gen_output(dir, hostname) {
            // faro-cli may have run ssh-gen for the same host at the same moment.
            Err(e) if attempt == 1 && e.to_string().contains("doesn't match") => continue,
            done => return done,
        }
    }
}

// ---- App subsystem ----------------------------------------------------------

/// cloudflared's entry in `managed_tools::Tools`.
pub struct Manager(Arc<ToolManager>);

impl Manager {
    pub fn new(inner: Arc<ToolManager>) -> Self {
        Self(inner)
    }

    pub fn from_dir(data_dir: PathBuf) -> Self {
        Self(Arc::new(ToolManager::from_dir(&SPEC, data_dir)))
    }

    pub async fn status(&self) -> BinaryStatus {
        self.0.status().await
    }

    /// Ask GitHub for the latest release, then report.
    pub async fn check(&self, installer: &Installer) -> BinaryStatus {
        self.0.check(&installer.0).await
    }

    /// Install or update Faro's own copy and start using it.
    pub async fn install(&self, installer: &Installer) -> Result<BinaryStatus> {
        self.0.install(&installer.0).await
    }

    pub async fn set_custom_path(&self, path: Option<String>) -> Result<BinaryStatus> {
        self.0.set_custom_path(path).await
    }
}

// ---- Tauri commands ----------------------------------------------------------

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[tauri::command]
pub async fn cloudflared_status(state: State<'_, AppState>) -> Result<BinaryStatus, String> {
    Ok(state.cloudflared.status().await)
}

#[tauri::command]
pub async fn cloudflared_check(state: State<'_, AppState>) -> Result<BinaryStatus, String> {
    Ok(state.cloudflared.check(&Installer::default()).await)
}

#[tauri::command]
pub async fn cloudflared_install(app: AppHandle, state: State<'_, AppState>) -> Result<BinaryStatus, String> {
    let status = state.cloudflared.install(&Installer::default()).await.map_err(err)?;
    let _ = app.emit("cloudflared://status", &status);
    Ok(status)
}

#[tauri::command]
pub async fn cloudflared_set_custom_path(path: Option<String>, state: State<'_, AppState>) -> Result<BinaryStatus, String> {
    state.cloudflared.set_custom_path(path).await.map_err(err)
}

#[tauri::command]
pub async fn cf_access_status(hostname: String) -> Result<AccessStatus, String> {
    let bin = proxy_command::resolve_cloudflared().map_err(err)?;
    Ok(access_status(&bin, &hostname).await)
}

#[tauri::command]
pub async fn cf_access_login(hostname: String) -> Result<AccessStatus, String> {
    let bin = proxy_command::resolve_cloudflared().map_err(err)?;
    let message = format!("Finish the Cloudflare Access sign-in for {hostname} in your browser");
    access_login(&bin, &hostname, move |url| proxy_command::notice(&message, Some(&url)))
    .await
    .map_err(err)
}

#[cfg(test)]
#[path = "cloudflared_tests.rs"]
pub(crate) mod tests;
