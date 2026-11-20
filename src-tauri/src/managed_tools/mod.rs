//! The command-line tools Faro drives: cloudflared and the 1Password and
//! Bitwarden CLIs, which Faro can install itself, plus the cloud and platform
//! CLIs (`aws`, `gcloud`, `az`, `gh`, ...) it only finds and uses (Plan 35,
//! `cli_integrations`).
//!
//! Each tool is a [`ToolSpec`]: where its official releases are, which
//! download fits this machine and how that download is verified. Adding a
//! tool means writing one spec next to the code that uses the tool and listing
//! it in [`TOOLS`]; locating, version checks, installs and updates, the
//! Settings card and the `faro-cli` wiring come from here.
//!
//! Which copy runs: the user's own path, else Faro's copy in `<app data>/bin/`,
//! else one already installed (PATH and the usual folders). A download is
//! verified before it replaces anything, by the sha256 the publisher lists or
//! by an OpenPGP signature checked against a key pinned in the spec. One that
//! can't be verified, or doesn't run here, is never installed.

pub mod openpgp;

use crate::proc::NoConsoleWindow;
use crate::AppState;
use anyhow::{anyhow, bail, ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager as _, State};
use tokio::sync::Mutex;

pub use openpgp::PgpKey;

/// `--version`: local, should be quick.
const QUICK_TIMEOUT: Duration = Duration::from_secs(20);
/// Far above any tool's size (the Bitwarden CLI is ~140 MB unpacked).
const MAX_DOWNLOAD: u64 = 512 * 1024 * 1024;
/// Pushed whenever a tool's status changes in the background.
pub const STATUS_EVENT: &str = "tools://status";

/// Every tool Faro knows. The order is the Settings order: the three Faro can
/// install, then the CLIs it only finds (`cli_integrations`).
pub fn tools() -> &'static [&'static ToolSpec] {
    static ALL: std::sync::OnceLock<Vec<&'static ToolSpec>> = std::sync::OnceLock::new();
    ALL.get_or_init(|| {
        let mut all: Vec<&'static ToolSpec> =
            vec![&crate::cloudflared::SPEC, &crate::password_managers::OP_TOOL, &crate::password_managers::BW_TOOL];
        all.extend(crate::cli_integrations::specs());
        all
    })
}

pub fn spec(id: &str) -> Result<&'static ToolSpec> {
    tools().iter().copied().find(|t| t.id == id).ok_or_else(|| anyhow!("Unknown tool: {id}"))
}

/// What a CLI does for Faro.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Role {
    /// Makes a connection reachable (a ProxyCommand).
    Tunnel,
    /// Supplies a saved password or key.
    Secrets,
    /// Short-lived credentials from the CLI's own login.
    SignIn,
    /// Lists servers, buckets or portals to import.
    Discover,
}

// ---- Specs ------------------------------------------------------------------

pub struct ToolSpec {
    /// Stable id for IPC and config: `cloudflared`, `op`, `bw`.
    pub id: &'static str,
    /// For people: "cloudflared", "1Password CLI".
    pub name: &'static str,
    /// The executable's name without `.exe`.
    pub program: &'static str,
    /// The tool's settings file in the app data dir.
    pub config_file: &'static str,
    /// Where releases come from.
    pub feed: Feed,
    /// What the tool does for Faro.
    pub roles: &'static [Role],
    /// The arguments that print the version: `--version`, or `version`.
    pub version_args: &'static [&'static str],
    /// The version out of `<program> <version_args>`.
    pub parse_version: fn(&str) -> Option<String>,
    /// A copy installed outside Faro (PATH, the usual folders).
    pub find_installed: fn() -> Option<PathBuf>,
    /// Refuse a custom path the tool's users can't run (say, a `.cmd`).
    pub check_custom: fn(&Path) -> Result<()>,
    /// Told the user's or Faro's copy whenever the choice changes; `None`
    /// means "search for an installed one". Most tools read [`selected`].
    pub on_select: fn(Option<PathBuf>),
}

pub enum Feed {
    /// GitHub releases. With a tag prefix the API URL lists releases and the
    /// newest stable one with that prefix wins (a repository that publishes
    /// several products); without one it's `/releases/latest`. Assets are
    /// verified by GitHub's digest or a `name: <sha256>` line in the notes.
    GitHub {
        api: &'static str,
        tag_prefix: &'static str,
        /// The asset for an OS/arch (`std::env::consts` names) among the
        /// release's asset names.
        pick: fn(os: &str, arch: &str, names: &[&str]) -> Result<String>,
    },
    /// The publisher's own update check (JSON with a `version`) and a
    /// download URL built from the version. Each archive carries a detached
    /// `<program>.sig` checked against `key`.
    Signed {
        /// Shown in errors: "couldn't reach 1Password".
        publisher: &'static str,
        check_url: &'static str,
        /// `(os, arch, version)` → download URL relative to `download_base`.
        asset: fn(os: &str, arch: &str, version: &str) -> Result<String>,
        download_base: &'static str,
        key: fn() -> PgpKey,
    },
    /// Faro doesn't install this one (an MSI, an SDK bundle, a daemon, an
    /// npm package): it finds it, and the UI links the publisher's page.
    DetectOnly { install_url: &'static str },
}

impl Feed {
    pub fn installable(&self) -> bool {
        !matches!(self, Feed::DetectOnly { .. })
    }
}

pub fn exe_name(program: &str) -> String {
    if cfg!(windows) {
        format!("{program}.exe")
    } else {
        program.to_string()
    }
}

/// The first word that looks like a version: `2.42.0`, `v2026.11.0`.
pub fn plain_version(out: &str) -> Option<String> {
    out.split_whitespace().find_map(|w| {
        let v = w.trim_start_matches('v').trim_end_matches([',', ')']);
        (v.chars().next()?.is_ascii_digit() && v.contains('.') && v.chars().all(|c| c.is_ascii_alphanumeric() || ".-+".contains(c)))
            .then(|| v.to_string())
    })
}

/// `2026.10.4` < `2026.11.0`; non-numeric parts compare as 0.
pub fn is_newer(latest: &str, current: &str) -> bool {
    version_key(latest) > version_key(current)
}

fn version_key(v: &str) -> Vec<u64> {
    v.split(['.', '-']).map(|p| p.parse().unwrap_or(0)).collect()
}

// ---- Which copy runs ----------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    /// The user's own binary, instead of Faro's copy or an installed one.
    pub custom_path: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Custom,
    Managed,
    Path,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub id: String,
    pub name: String,
    pub roles: Vec<Role>,
    /// Faro can install and update its own copy.
    pub installable: bool,
    /// Where to get a tool Faro doesn't install.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_url: Option<String>,
    pub source: Source,
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

pub fn managed_path(spec: &ToolSpec, data_dir: &Path) -> PathBuf {
    data_dir.join("bin").join(exe_name(spec.program))
}

fn config_path(spec: &ToolSpec, data_dir: &Path) -> PathBuf {
    data_dir.join(spec.config_file)
}

pub fn read_config(spec: &ToolSpec, data_dir: &Path) -> Config {
    std::fs::read(config_path(spec, data_dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Which binary this data dir selects, and why: custom → managed → installed.
pub fn locate(spec: &ToolSpec, data_dir: &Path, cfg: &Config) -> (Source, Option<PathBuf>) {
    if let Some(custom) = cfg.custom_path.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        return (Source::Custom, Some(PathBuf::from(custom)));
    }
    let managed = managed_path(spec, data_dir);
    if managed.is_file() {
        return (Source::Managed, Some(managed));
    }
    match (spec.find_installed)() {
        Some(p) => (Source::Path, Some(p)),
        None => (Source::Missing, None),
    }
}

static SELECTED: RwLock<Option<HashMap<&'static str, PathBuf>>> = RwLock::new(None);

/// The user's or Faro's copy of a tool, when one is chosen; `None` means
/// "use an installed one".
pub fn selected(id: &str) -> Option<PathBuf> {
    SELECTED.read().ok()?.as_ref()?.get(id).cloned()
}

fn select(spec: &'static ToolSpec, path: Option<PathBuf>) {
    if let Ok(mut map) = SELECTED.write() {
        let map = map.get_or_insert_with(HashMap::new);
        match &path {
            Some(p) => map.insert(spec.id, p.clone()),
            None => map.remove(spec.id),
        };
    }
    (spec.on_select)(path);
}

/// Point the tool's users at the copy this data dir selects.
pub fn configure(spec: &'static ToolSpec, data_dir: &Path) {
    let (source, path) = locate(spec, data_dir, &read_config(spec, data_dir));
    select(
        spec,
        match source {
            Source::Custom | Source::Managed => path,
            Source::Path | Source::Missing => None,
        },
    );
}

/// Every tool's choice, for the app and faro-cli at startup.
pub fn configure_all(data_dir: &Path) {
    for spec in tools().iter().copied() {
        configure(spec, data_dir);
    }
}

pub async fn version(spec: &ToolSpec, path: &Path) -> Option<String> {
    // A binary written moments ago (an install) can still be open for writing
    // in a child some other thread forked meanwhile, and Unix then refuses to
    // run it ("text file busy"). That clears as soon as the child execs, so
    // try again shortly instead of calling the download broken.
    for attempt in 1..=5 {
        let run = tokio::time::timeout(
            QUICK_TIMEOUT,
            crate::cli_integrations::command(path)
                .args(spec.version_args)
                .stdin(std::process::Stdio::null())
                .kill_on_drop(true)
                .no_console_window()
                .output(),
        )
        .await
        .ok()?;
        match run {
            Ok(out) => {
                return (spec.parse_version)(&String::from_utf8_lossy(&out.stdout))
                    .or_else(|| (spec.parse_version)(&String::from_utf8_lossy(&out.stderr)))
            }
            Err(e) if text_file_busy(&e) && attempt < 5 => tokio::time::sleep(Duration::from_millis(100)).await,
            Err(_) => return None,
        }
    }
    None
}

/// ETXTBSY: the executable is still open for writing somewhere.
fn text_file_busy(e: &std::io::Error) -> bool {
    cfg!(unix) && e.raw_os_error() == Some(26)
}

// ---- Releases -----------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct GhRelease {
    pub tag_name: String,
    #[serde(default)]
    pub body: Option<String>,
    pub assets: Vec<Asset>,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
    /// GitHub's `sha256:<hex>` of the uploaded file, when published.
    #[serde(default)]
    pub digest: Option<String>,
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

/// The newest stable release whose tag starts with `prefix`, from either a
/// `/releases/latest` object or a `/releases` list.
pub fn newest_release(answer: Value, prefix: &str) -> Result<GhRelease> {
    let releases: Vec<GhRelease> = if answer.is_array() {
        serde_json::from_value(answer)?
    } else {
        vec![serde_json::from_value(answer)?]
    };
    releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease && r.tag_name.starts_with(prefix))
        .max_by(|a, b| version_key(tag_version(&a.tag_name, prefix)).cmp(&version_key(tag_version(&b.tag_name, prefix))))
        .ok_or_else(|| anyhow!("no release found"))
}

fn tag_version<'a>(tag: &'a str, prefix: &str) -> &'a str {
    tag.strip_prefix(prefix).unwrap_or(tag).trim_start_matches('v')
}

/// One release, resolved for this machine.
#[derive(Debug, Clone)]
pub struct Release {
    pub version: String,
    /// The download's file name: decides how it's unpacked.
    pub asset: String,
    pub url: String,
    pub check: Check,
}

#[derive(Debug, Clone)]
pub enum Check {
    Sha256(String),
    /// The archive's `<program>.sig`, against the spec's key.
    Signature,
}

/// The `name` file inside a `.tgz`.
pub fn extract_from_tgz(bytes: &[u8], name: &str) -> Result<Vec<u8>> {
    let mut tar = Vec::new();
    flate2::read::GzDecoder::new(bytes)
        .take(MAX_DOWNLOAD)
        .read_to_end(&mut tar)
        .context("unpack the .tgz")?;
    let mut at = 0;
    while at + 512 <= tar.len() {
        let header = &tar[at..at + 512];
        if header.iter().all(|b| *b == 0) {
            break;
        }
        let entry = String::from_utf8_lossy(&header[..100]).trim_end_matches('\0').to_string();
        let size_field = String::from_utf8_lossy(&header[124..136]);
        let size = usize::from_str_radix(size_field.trim_matches(|c: char| c == '\0' || c.is_whitespace()), 8)
            .context("bad size in the .tgz")?;
        let data = at + 512;
        if entry.rsplit('/').next() == Some(name) && header[156] != b'5' {
            return tar.get(data..data + size).map(<[u8]>::to_vec).ok_or_else(|| anyhow!("truncated .tgz"));
        }
        at = data + size.div_ceil(512) * 512;
    }
    bail!("the .tgz has no {name} in it")
}

/// Write the binary out of the download at `archive` to `staged`. Returns
/// the archive's detached signature for it, if it has one.
fn unpack(archive: &Path, asset: &str, program: &str, staged: &Path) -> Result<Option<Vec<u8>>> {
    let exe = exe_name(program);
    if asset.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?).context("open the .zip")?;
        let (mut found, mut sig) = (false, None);
        for i in 0..zip.len() {
            let mut entry = zip.by_index(i).context("read the .zip")?;
            if entry.is_dir() {
                continue;
            }
            let base = entry.name().rsplit(['/', '\\']).next().unwrap_or("").to_string();
            if base == exe && !found {
                let mut out = std::fs::File::create(staged).with_context(|| format!("write {}", staged.display()))?;
                std::io::copy(&mut (&mut entry).take(MAX_DOWNLOAD), &mut out).context("unpack the .zip")?;
                out.flush()?;
                found = true;
            } else if base == format!("{exe}.sig") {
                let mut raw = Vec::new();
                (&mut entry).take(64 * 1024).read_to_end(&mut raw)?;
                sig = Some(raw);
            }
        }
        ensure!(found, "the .zip has no {exe} in it");
        Ok(sig)
    } else if asset.ends_with(".tgz") || asset.ends_with(".tar.gz") {
        let binary = extract_from_tgz(&std::fs::read(archive)?, program)?;
        std::fs::write(staged, binary).with_context(|| format!("write {}", staged.display()))?;
        Ok(None)
    } else {
        std::fs::copy(archive, staged).with_context(|| format!("write {}", staged.display()))?;
        Ok(None)
    }
}

/// Replace `dest` with `staged`. A running copy can't be overwritten on
/// Windows but can be renamed, so the old one moves aside first.
pub fn swap_in(staged: &Path, dest: &Path) -> Result<()> {
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

// ---- Install / update -------------------------------------------------------------

/// Downloads a tool's official releases. The URLs and the signing key are
/// fields so tests can serve and sign their own.
pub struct Installer {
    pub spec: &'static ToolSpec,
    /// The GitHub API URL, or the publisher's update check.
    pub api_url: String,
    pub download_base: String,
    pub key: Option<PgpKey>,
    client: reqwest::Client,
}

impl Installer {
    pub fn new(spec: &'static ToolSpec) -> Self {
        let (api, base, key) = match &spec.feed {
            Feed::GitHub { api, .. } => (*api, "", None),
            Feed::Signed { check_url, download_base, key, .. } => (*check_url, *download_base, Some(key())),
            Feed::DetectOnly { .. } => ("", "", None),
        };
        Self::with_urls(spec, api, base, key)
    }

    pub fn with_urls(spec: &'static ToolSpec, api_url: &str, download_base: &str, key: Option<PgpKey>) -> Self {
        Self {
            spec,
            api_url: api_url.to_string(),
            download_base: download_base.trim_end_matches('/').to_string(),
            key,
            client: reqwest::Client::builder()
                .user_agent(concat!("Faro/", env!("CARGO_PKG_VERSION")))
                .connect_timeout(Duration::from_secs(20))
                .build()
                .expect("reqwest client"),
        }
    }

    async fn get_json(&self, url: &str, from: &str) -> Result<Value> {
        let name = self.spec.name;
        let mut req = self.client.get(url);
        // With the person's OK on the CLIs page, release checks use their
        // `gh` login, which lifts GitHub's 60-an-hour anonymous limit.
        if url.starts_with("https://api.github.com/") {
            if let Some(token) = crate::cli_integrations::creds::github_token().await {
                req = req.bearer_auth(token);
            }
        }
        req
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .with_context(|| format!("couldn't reach {from} for the latest {name} release"))?
            .json()
            .await
            .with_context(|| format!("unexpected answer from {from} for the latest {name} release"))
    }

    /// The latest release, resolved for this OS and architecture.
    pub async fn latest(&self) -> Result<Release> {
        let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
        match &self.spec.feed {
            Feed::GitHub { tag_prefix, pick, .. } => {
                let release = newest_release(self.get_json(&self.api_url, "GitHub").await?, tag_prefix)
                    .with_context(|| format!("GitHub lists no {} release", self.spec.name))?;
                let names: Vec<&str> = release.assets.iter().map(|a| a.name.as_str()).collect();
                let version = tag_version(&release.tag_name, tag_prefix).to_string();
                let name = pick(os, arch, &names)?;
                let asset = release
                    .assets
                    .iter()
                    .find(|a| a.name == name)
                    .ok_or_else(|| anyhow!("{} {version} has no {name} download", self.spec.name))?;
                let want = expected_sha256(asset, release.body.as_deref().unwrap_or(""))?;
                Ok(Release { version, asset: name, url: asset.browser_download_url.clone(), check: Check::Sha256(want) })
            }
            Feed::Signed { publisher, asset, .. } => {
                let answer = self.get_json(&self.api_url, publisher).await?;
                let version = answer["version"]
                    .as_str()
                    .map(|v| v.trim().trim_start_matches('v').to_string())
                    // It becomes part of a URL: digits and dots only.
                    .filter(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit() || c == '.'))
                    .ok_or_else(|| anyhow!("unexpected answer from {publisher} for the latest {} release", self.spec.name))?;
                let path = asset(os, arch, &version)?;
                let file = path.rsplit('/').next().unwrap_or(&path).to_string();
                Ok(Release { url: format!("{}/{path}", self.download_base), version, asset: file, check: Check::Signature })
            }
            Feed::DetectOnly { install_url } => {
                bail!("Faro doesn't install {}; get it from {install_url}", self.spec.name)
            }
        }
    }

    /// Stream `url` to `to`; returns the sha256 of what arrived.
    async fn download(&self, url: &str, to: &Path, asset: &str) -> Result<String> {
        let mut resp = self
            .client
            .get(url)
            .send()
            .await
            .and_then(|r| r.error_for_status())
            .with_context(|| format!("download {asset}"))?;
        let mut file = std::fs::File::create(to).with_context(|| format!("write {}", to.display()))?;
        let (mut hash, mut total) = (Sha256::new(), 0u64);
        while let Some(chunk) = resp.chunk().await.with_context(|| format!("download {asset}"))? {
            total += chunk.len() as u64;
            ensure!(total <= MAX_DOWNLOAD, "{asset} is larger than any {} release; nothing was installed", self.spec.name);
            hash.update(&chunk);
            file.write_all(&chunk).with_context(|| format!("write {}", to.display()))?;
        }
        file.flush()?;
        Ok(format!("{:x}", hash.finalize()))
    }

    async fn fetch_and_stage(&self, release: &Release, part: &Path, staged: &Path) -> Result<()> {
        let asset = &release.asset;
        let got = self.download(&release.url, part, asset).await?;
        if let Check::Sha256(want) = &release.check {
            if got != *want {
                bail!("the downloaded {asset} failed its checksum (expected {want}, got {got}); nothing was installed");
            }
        }
        let (part_owned, staged_owned, asset_owned, program) =
            (part.to_path_buf(), staged.to_path_buf(), asset.clone(), self.spec.program);
        let sig = tokio::task::spawn_blocking(move || unpack(&part_owned, &asset_owned, program, &staged_owned))
            .await
            .context("unpack the download")??;
        if let Check::Signature = release.check {
            let key = self.key.as_ref().ok_or_else(|| anyhow!("no signing key for {}", self.spec.name))?;
            let sig = sig.ok_or_else(|| anyhow!("{asset} carries no signature, so it can't be verified; nothing was installed"))?;
            openpgp::verify_file(key, &sig, staged)
                .map_err(|e| anyhow!("the downloaded {asset} failed its signature check ({e}); nothing was installed"))?;
        }
        Ok(())
    }

    /// Download, verify and swap in the latest release at `dest`. Returns
    /// the installed version.
    pub async fn install(&self, dest: &Path) -> Result<String> {
        let release = self.latest().await?;
        let dir = dest.parent().ok_or_else(|| anyhow!("bad install path"))?;
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        let part = dest.with_extension("part");
        let staged = dest.with_extension("download");
        let fetched = self.fetch_and_stage(&release, &part, &staged).await;
        let _ = std::fs::remove_file(&part);
        if let Err(e) = fetched {
            let _ = std::fs::remove_file(&staged);
            return Err(e);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))?;
        }
        let Some(installed) = version(self.spec, &staged).await else {
            let _ = std::fs::remove_file(&staged);
            bail!("the downloaded {} doesn't run on this machine; nothing was installed", self.spec.name);
        };
        swap_in(&staged, dest)?;
        Ok(installed)
    }
}

// ---- One tool in the app ------------------------------------------------------------

pub struct ToolManager {
    pub spec: &'static ToolSpec,
    data_dir: PathBuf,
    config: Mutex<Config>,
    /// One install at a time.
    installing: Mutex<()>,
    latest: Mutex<Option<String>>,
    /// The last `--version` answer, by path and file time: some CLIs (az,
    /// gcloud) take seconds to say it, and the CLIs page lists them all.
    version_cache: std::sync::Mutex<Option<(PathBuf, Option<std::time::SystemTime>, Option<String>)>>,
}

impl ToolManager {
    pub fn from_dir(spec: &'static ToolSpec, data_dir: PathBuf) -> Self {
        configure(spec, &data_dir);
        Self {
            spec,
            config: Mutex::new(read_config(spec, &data_dir)),
            data_dir,
            installing: Mutex::new(()),
            latest: Mutex::new(None),
            version_cache: std::sync::Mutex::new(None),
        }
    }

    pub fn managed_path(&self) -> PathBuf {
        managed_path(self.spec, &self.data_dir)
    }

    async fn cached_version(&self, path: &Path) -> Option<String> {
        let mtime = std::fs::metadata(path).and_then(|m| m.modified()).ok();
        if let Ok(c) = self.version_cache.lock() {
            if let Some((p, t, v)) = c.as_ref() {
                if p == path && *t == mtime && mtime.is_some() {
                    return v.clone();
                }
            }
        }
        let v = version(self.spec, path).await;
        if let Ok(mut c) = self.version_cache.lock() {
            *c = Some((path.to_path_buf(), mtime, v.clone()));
        }
        v
    }

    pub async fn status(&self) -> ToolStatus {
        let cfg = self.config.lock().await.clone();
        let (source, path) = locate(self.spec, &self.data_dir, &cfg);
        let version = match &path {
            Some(p) if p.is_file() => self.cached_version(p).await,
            _ => None,
        };
        let latest = self.latest.lock().await.clone();
        ToolStatus {
            id: self.spec.id.to_string(),
            name: self.spec.name.to_string(),
            roles: self.spec.roles.to_vec(),
            installable: self.spec.feed.installable(),
            install_url: match &self.spec.feed {
                Feed::DetectOnly { install_url } => Some(install_url.to_string()),
                _ => None,
            },
            update_available: matches!((&latest, &version), (Some(l), Some(v)) if is_newer(l, v)),
            source,
            path: path.map(|p| p.display().to_string()),
            version,
            custom_path: cfg.custom_path,
            managed_path: self.managed_path().display().to_string(),
            latest,
            message: None,
        }
    }

    /// Ask the publisher for the latest release, then report. A tool Faro
    /// doesn't install just reports what is there.
    pub async fn check(&self, installer: &Installer) -> ToolStatus {
        if !self.spec.feed.installable() {
            return self.status().await;
        }
        match installer.latest().await {
            Ok(r) => {
                *self.latest.lock().await = Some(r.version);
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
    pub async fn install(&self, installer: &Installer) -> Result<ToolStatus> {
        ensure!(self.spec.feed.installable(), "Faro doesn't install {}; install it yourself, then click Check", self.spec.name);
        let _one = self.installing.lock().await;
        let installed = installer.install(&self.managed_path()).await?;
        *self.latest.lock().await = Some(installed.clone());
        // A custom path would keep winning; installing means "use this one".
        self.config.lock().await.custom_path = None;
        self.persist().await?;
        let mut s = self.status().await;
        s.message = Some(format!("Installed {} {installed}", self.spec.name));
        Ok(s)
    }

    pub async fn set_custom_path(&self, path: Option<String>) -> Result<ToolStatus> {
        let path = path.map(|p| p.trim().to_string()).filter(|p| !p.is_empty());
        if let Some(p) = &path {
            let at = Path::new(p);
            if !at.is_file() {
                bail!("{p} doesn't exist");
            }
            (self.spec.check_custom)(at)?;
            if version(self.spec, at).await.is_none() {
                bail!("{p} doesn't look like {} (it didn't report a version)", self.spec.name);
            }
        }
        self.config.lock().await.custom_path = path;
        self.persist().await?;
        Ok(self.status().await)
    }

    async fn persist(&self) -> Result<()> {
        let cfg = self.config.lock().await.clone();
        std::fs::create_dir_all(&self.data_dir).ok();
        crate::fsutil::write_atomic(&config_path(self.spec, &self.data_dir), &serde_json::to_vec_pretty(&cfg)?)?;
        configure(self.spec, &self.data_dir);
        Ok(())
    }

    /// With a Faro-managed copy, look for an update and tell the UI if there
    /// is one.
    pub async fn check_on_launch(&self, app: &AppHandle, event: &str) {
        if !self.managed_path().is_file() {
            return;
        }
        let status = self.check(&Installer::new(self.spec)).await;
        if status.update_available {
            let _ = app.emit(event, &status);
            if event != STATUS_EVENT {
                let _ = app.emit(STATUS_EVENT, &status);
            }
        }
    }
}

/// Every tool's manager, keyed by id.
pub struct Tools {
    by_id: HashMap<&'static str, Arc<ToolManager>>,
}

impl Tools {
    pub fn load(app: &AppHandle) -> Result<Self> {
        let dir = app.path().app_data_dir().context("resolving app_data_dir")?;
        Ok(Self::from_dir(&dir))
    }

    pub fn from_dir(data_dir: &Path) -> Self {
        let by_id = tools().iter().copied().map(|s| (s.id, Arc::new(ToolManager::from_dir(s, data_dir.to_path_buf())))).collect();
        Self { by_id }
    }

    pub fn get(&self, id: &str) -> Result<Arc<ToolManager>> {
        self.by_id.get(id).cloned().ok_or_else(|| anyhow!("Unknown tool: {id}"))
    }

    /// After startup: look for updates to every Faro-managed copy.
    pub async fn check_on_launch(&self, app: AppHandle) {
        for spec in tools().iter().copied() {
            if let Some(m) = self.by_id.get(spec.id) {
                let event = if spec.id == crate::cloudflared::SPEC.id { "cloudflared://status" } else { STATUS_EVENT };
                m.check_on_launch(&app, event).await;
            }
        }
    }
}

// ---- Tauri commands ------------------------------------------------------------------

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[tauri::command]
pub async fn tool_status(id: String, state: State<'_, AppState>) -> Result<ToolStatus, String> {
    Ok(state.tools.get(&id).map_err(err)?.status().await)
}

/// Also asks the publisher for the latest release.
#[tauri::command]
pub async fn tool_check(id: String, state: State<'_, AppState>) -> Result<ToolStatus, String> {
    let m = state.tools.get(&id).map_err(err)?;
    Ok(m.check(&Installer::new(m.spec)).await)
}

#[tauri::command]
pub async fn tool_install(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<ToolStatus, String> {
    let m = state.tools.get(&id).map_err(err)?;
    let status = m.install(&Installer::new(m.spec)).await.map_err(err)?;
    let _ = app.emit(STATUS_EVENT, &status);
    Ok(status)
}

#[tauri::command]
pub async fn tool_set_custom_path(id: String, path: Option<String>, state: State<'_, AppState>) -> Result<ToolStatus, String> {
    state.tools.get(&id).map_err(err)?.set_custom_path(path).await.map_err(err)
}

#[cfg(test)]
mod tests;
