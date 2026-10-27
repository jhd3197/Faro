//! Cloudflare without a terminal (Plan 29, issue #53): which `cloudflared`
//! Faro runs, installing and updating a Faro-managed copy of the official
//! release, and the Access sign-in state per hostname.
//!
//! Shaped like `cli_updater.rs`: JSON config under the app data dir
//! (`cloudflared.json`), the managed copy in `<app data>/bin/`, status pushed
//! as `"cloudflared://status"`. The binary choice reaches `proxy_command`
//! through `configure`, which faro-cli calls too.

use crate::proc::NoConsoleWindow;
use crate::proxy_command;
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager as _, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::Mutex;

use crate::AppState;

/// GitHub API for the official releases.
pub const RELEASE_API: &str = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
/// How long a browser sign-in may take.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// `cloudflared access token`, `--version`: local, should be quick.
const QUICK_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// The user's own binary, instead of PATH or the managed copy.
    pub custom_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BinarySource {
    Custom,
    Managed,
    Path,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BinaryStatus {
    pub source: BinarySource,
    pub path: Option<String>,
    pub version: Option<String>,
    pub custom_path: Option<String>,
    /// Where Faro installs its own copy.
    pub managed_path: String,
    /// Latest official release, once checked.
    pub latest: Option<String>,
    /// The copy Faro runs is older than `latest`.
    pub update_available: bool,
    /// One line about the last action, for the UI.
    pub message: Option<String>,
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "cloudflared.exe"
    } else {
        "cloudflared"
    }
}

pub fn managed_path(data_dir: &Path) -> PathBuf {
    data_dir.join("bin").join(exe_name())
}

fn config_path(data_dir: &Path) -> PathBuf {
    data_dir.join("cloudflared.json")
}

pub fn read_config(data_dir: &Path) -> Config {
    std::fs::read(config_path(data_dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Which binary this data dir selects, and why: custom → managed → PATH.
pub fn locate(data_dir: &Path, cfg: &Config) -> (BinarySource, Option<PathBuf>) {
    if let Some(custom) = cfg.custom_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        return (BinarySource::Custom, Some(PathBuf::from(custom)));
    }
    let managed = managed_path(data_dir);
    if managed.is_file() {
        return (BinarySource::Managed, Some(managed));
    }
    match proxy_command::find_program("cloudflared", true) {
        Some(p) => (BinarySource::Path, Some(p)),
        None => (BinarySource::Missing, None),
    }
}

/// Point proxy commands at the binary this data dir selects. Without a
/// custom or managed copy, they search PATH as before.
pub fn configure(data_dir: &Path) {
    let (source, path) = locate(data_dir, &read_config(data_dir));
    proxy_command::set_cloudflared_path(match source {
        BinarySource::Custom | BinarySource::Managed => path,
        BinarySource::Path | BinarySource::Missing => None,
    });
}

/// `cloudflared version 2026.10.4 (built ...)` → `2026.10.4`.
pub fn parse_version(out: &str) -> Option<String> {
    let mut words = out.split_whitespace();
    words.by_ref().find(|w| *w == "version")?;
    let v = words.next()?.trim_start_matches('v');
    v.chars().next()?.is_ascii_digit().then(|| v.to_string())
}

pub async fn version(path: &Path) -> Option<String> {
    let out = tokio::time::timeout(
        QUICK_TIMEOUT,
        tokio::process::Command::new(path).arg("--version").no_console_window().output(),
    )
    .await
    .ok()?
    .ok()?;
    parse_version(&String::from_utf8_lossy(&out.stdout)).or_else(|| parse_version(&String::from_utf8_lossy(&out.stderr)))
}

/// `2026.10.4` < `2026.11.0`; non-numeric parts compare as 0.
pub fn is_newer(latest: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> { v.split(['.', '-']).map(|p| p.parse().unwrap_or(0)).collect() };
    parts(latest) > parts(current)
}

// ---- Install / update ------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct Release {
    pub tag_name: String,
    #[serde(default)]
    pub body: Option<String>,
    pub assets: Vec<Asset>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
    /// GitHub's `sha256:<hex>` of the uploaded file, when published.
    #[serde(default)]
    pub digest: Option<String>,
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

/// The sha256 the asset must have: GitHub's digest of the uploaded file,
/// else the release notes' `name: <hex>` checksum table.
pub fn expected_sha256(asset: &Asset, body: &str) -> Result<String> {
    if let Some(hex) = asset.digest.as_deref().and_then(|d| d.strip_prefix("sha256:")) {
        return Ok(hex.to_ascii_lowercase());
    }
    let prefix = format!("{}:", asset.name);
    body.lines()
        .find_map(|l| l.trim().strip_prefix(&prefix).map(|h| h.trim().to_ascii_lowercase()))
        .filter(|h| h.len() == 64 && h.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| anyhow!("the release publishes no checksum for {}, so it can't be verified", asset.name))
}

/// The `cloudflared` file inside a release `.tgz`.
fn extract_from_tgz(bytes: &[u8]) -> Result<Vec<u8>> {
    let mut tar = Vec::new();
    flate2::read::GzDecoder::new(bytes).read_to_end(&mut tar).context("unpack the .tgz")?;
    let mut at = 0;
    while at + 512 <= tar.len() {
        let header = &tar[at..at + 512];
        if header.iter().all(|b| *b == 0) {
            break;
        }
        let name = String::from_utf8_lossy(&header[..100]).trim_end_matches('\0').to_string();
        let size_field = String::from_utf8_lossy(&header[124..136]);
        let size = usize::from_str_radix(size_field.trim_matches(|c: char| c == '\0' || c.is_whitespace()), 8)
            .context("bad size in the .tgz")?;
        let data = at + 512;
        if name.rsplit('/').next() == Some("cloudflared") && header[156] != b'5' {
            return tar.get(data..data + size).map(<[u8]>::to_vec).ok_or_else(|| anyhow!("truncated .tgz"));
        }
        at = data + size.div_ceil(512) * 512;
    }
    bail!("the .tgz has no cloudflared in it")
}

/// Downloads official releases. The API URL is a field so tests can serve
/// their own.
pub struct Installer {
    pub api_url: String,
    client: reqwest::Client,
}

impl Default for Installer {
    fn default() -> Self {
        Self::new(RELEASE_API)
    }
}

impl Installer {
    pub fn new(api_url: &str) -> Self {
        Self {
            api_url: api_url.to_string(),
            client: reqwest::Client::builder()
                .user_agent(concat!("Faro/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
        }
    }

    pub async fn latest(&self) -> Result<Release> {
        self.client
            .get(&self.api_url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .context("couldn't reach GitHub for the latest cloudflared release")?
            .json()
            .await
            .context("unexpected answer from GitHub for the latest cloudflared release")
    }

    /// Download, verify and swap in the latest release at `dest`. Returns
    /// the installed version.
    pub async fn install(&self, dest: &Path) -> Result<String> {
        let release = self.latest().await?;
        let name = asset_name(std::env::consts::OS, std::env::consts::ARCH)?;
        let asset = release
            .assets
            .iter()
            .find(|a| a.name == name)
            .ok_or_else(|| anyhow!("cloudflared {} has no {name} download", release.tag_name))?;
        let want = expected_sha256(asset, release.body.as_deref().unwrap_or(""))?;
        let bytes = self
            .client
            .get(&asset.browser_download_url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .with_context(|| format!("download {name}"))?
            .bytes()
            .await
            .with_context(|| format!("download {name}"))?;
        let got = format!("{:x}", Sha256::digest(&bytes));
        if got != want {
            bail!("the downloaded {name} failed its checksum (expected {want}, got {got}); nothing was installed");
        }
        let binary = if name.ends_with(".tgz") { extract_from_tgz(&bytes)? } else { bytes.to_vec() };

        let dir = dest.parent().ok_or_else(|| anyhow!("bad install path"))?;
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        let staged = dest.with_extension("download");
        std::fs::write(&staged, &binary).with_context(|| format!("write {}", staged.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
        }
        let Some(installed) = version(&staged).await else {
            let _ = std::fs::remove_file(&staged);
            bail!("the downloaded cloudflared doesn't run on this machine; nothing was installed");
        };
        swap_in(&staged, dest)?;
        Ok(installed)
    }
}

/// Replace `dest` with `staged`. A running copy can't be overwritten on
/// Windows but can be renamed, so the old one moves aside first.
fn swap_in(staged: &Path, dest: &Path) -> Result<()> {
    let old = dest.with_extension("old");
    let _ = std::fs::remove_file(&old);
    if dest.exists() {
        std::fs::rename(dest, &old).with_context(|| format!("move the old {} aside", dest.display()))?;
    }
    if let Err(e) = std::fs::rename(staged, dest) {
        let _ = std::fs::rename(&old, dest);
        return Err(anyhow::Error::from(e).context(format!("install {}", dest.display())));
    }
    // Still in use until its sessions end; removed on the next update.
    let _ = std::fs::remove_file(&old);
    Ok(())
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

pub struct Manager {
    data_dir: PathBuf,
    config: Mutex<Config>,
    /// One install at a time.
    installing: Mutex<()>,
    latest: Mutex<Option<String>>,
}

impl Manager {
    pub fn load(app: &AppHandle) -> Result<Self> {
        let dir = app.path().app_data_dir().context("resolving app_data_dir")?;
        Ok(Self::from_dir(dir))
    }

    pub fn from_dir(data_dir: PathBuf) -> Self {
        configure(&data_dir);
        Self {
            config: Mutex::new(read_config(&data_dir)),
            data_dir,
            installing: Mutex::new(()),
            latest: Mutex::new(None),
        }
    }

    pub async fn status(&self) -> BinaryStatus {
        let cfg = self.config.lock().await.clone();
        let (source, path) = locate(&self.data_dir, &cfg);
        let version = match &path {
            Some(p) if p.is_file() => version(p).await,
            _ => None,
        };
        let latest = self.latest.lock().await.clone();
        BinaryStatus {
            update_available: matches!((&latest, &version), (Some(l), Some(v)) if is_newer(l, v)),
            source,
            path: path.map(|p| p.display().to_string()),
            version,
            custom_path: cfg.custom_path,
            managed_path: managed_path(&self.data_dir).display().to_string(),
            latest,
            message: None,
        }
    }

    /// Ask GitHub for the latest release, then report.
    pub async fn check(&self, installer: &Installer) -> BinaryStatus {
        match installer.latest().await {
            Ok(r) => {
                *self.latest.lock().await = Some(r.tag_name.trim_start_matches('v').to_string());
                self.status().await
            }
            Err(e) => {
                let mut s = self.status().await;
                s.message = Some(format!("{e:#}"));
                s
            }
        }
    }

    /// Install or update Faro's own copy and start using it.
    pub async fn install(&self, installer: &Installer) -> Result<BinaryStatus> {
        let _one = self.installing.lock().await;
        let dest = managed_path(&self.data_dir);
        let installed = installer.install(&dest).await?;
        *self.latest.lock().await = Some(installed.clone());
        // A custom path would keep winning; installing means "use this one".
        self.config.lock().await.custom_path = None;
        self.persist().await?;
        let mut s = self.status().await;
        s.message = Some(format!("Installed cloudflared {installed}"));
        Ok(s)
    }

    pub async fn set_custom_path(&self, path: Option<String>) -> Result<BinaryStatus> {
        let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        if let Some(p) = &path {
            if !Path::new(p).is_file() {
                bail!("{p} doesn't exist");
            }
            if version(Path::new(p)).await.is_none() {
                bail!("{p} doesn't look like cloudflared (it didn't report a version)");
            }
        }
        self.config.lock().await.custom_path = path;
        self.persist().await?;
        Ok(self.status().await)
    }

    async fn persist(&self) -> Result<()> {
        let cfg = self.config.lock().await.clone();
        std::fs::create_dir_all(&self.data_dir).ok();
        crate::fsutil::write_atomic(&config_path(&self.data_dir), &serde_json::to_vec_pretty(&cfg)?)?;
        configure(&self.data_dir);
        Ok(())
    }

    /// On launch: with a managed copy, look for an update in the background
    /// and tell the UI if there is one.
    pub async fn check_on_launch(&self, app: AppHandle) {
        if !managed_path(&self.data_dir).is_file() {
            return;
        }
        let status = self.check(&Installer::default()).await;
        if status.update_available {
            let _ = app.emit("cloudflared://status", &status);
        }
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
mod tests;
