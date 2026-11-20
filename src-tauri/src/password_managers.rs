//! Built-in 1Password and Bitwarden credential providers.
//!
//! They ride the existing `credentialRef` (`credential_refs.rs`) under the ids
//! `1password` and `bitwarden`, which `credential-providers.json` can't
//! override. Each talks to the manager's own CLI (`op`, `bw`) with the same
//! process rules as a configured adapter: an absolute path, argv only (never a
//! shell), stdin null, a time limit, an output cap and no console window.
//!
//! Errors are plain sentences written here. They never copy the CLI's output,
//! a resolved value or the Bitwarden master password.
//!
//! Bitwarden needs a session key. Faro keeps it in memory only and hands it to
//! `bw` through the `BW_SESSION` environment variable, never argv. The master
//! password reaches `bw unlock` through `--passwordenv` and that child's
//! environment only.
use crate::credential_refs::CredentialRef;
use crate::managed_tools::{self, Feed, PgpKey, ToolSpec};
use anyhow::{anyhow, bail, ensure, Result};
use serde::Serialize;
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tokio::io::{AsyncRead, AsyncReadExt};

pub const ONEPASSWORD: &str = "1password";
pub const BITWARDEN: &str = "bitwarden";

/// Ids that always exist and that a configured adapter can't replace.
pub fn is_builtin(provider: &str) -> bool {
    provider == ONEPASSWORD || provider == BITWARDEN
}

const TIMEOUT: Duration = Duration::from_secs(20);
/// Single values, status and unlock.
const VALUE_CAP: usize = 64 * 1024;
/// Item lists and whole items: a vault's listing is larger than one value.
const LIST_CAP: usize = 8 * 1024 * 1024;
const STDERR_CAP: usize = 16 * 1024;
const MAX_ITEMS: usize = 200;
/// The environment variable `bw unlock --passwordenv` reads.
const PASSWORD_ENV: &str = "FARO_BW_PASSWORD";

const OP_MISSING: &str = "The 1Password CLI isn't installed. Install it in Settings › Password managers.";
const BW_MISSING: &str = "The Bitwarden CLI isn't installed. Install it in Settings › Password managers.";
const BW_CMD: &str = "Faro needs the standalone Bitwarden CLI (bw.exe); the npm bw.cmd can't be used. Install it in Settings › Password managers.";
const OP_LOCKED: &str = "Click Sign in, then approve Faro in the 1Password app.";
const OP_SIGNED_OUT: &str = "Open the 1Password app and turn on Settings › Developer › Integrate with 1Password CLI. The app has to stay running.";
const OP_APP_CLOSED: &str = "Faro can't reach the 1Password app. Open 1Password and unlock it, then click Check again.";
const OP_NO_APP: &str = "The 1Password CLI only works with the 1Password app. Install the app, sign in, then turn on Settings › Developer › Integrate with 1Password CLI.";
const OP_UNKNOWN: &str = "1Password couldn't check your account. Open the 1Password app, then click Check again.";
const BW_LOCKED: &str = "Bitwarden is locked. Unlock it in Settings › Password managers.";
const BW_SIGNED_OUT: &str = "Bitwarden isn't signed in. Run `bw login` once in a terminal.";

/// The Bitwarden session key, for as long as Faro runs or until locked.
static BW_SESSION: Mutex<Option<String>> = Mutex::new(None);

fn bw_session() -> Option<String> {
    BW_SESSION.lock().unwrap_or_else(|e| e.into_inner()).clone()
}

fn set_bw_session(value: Option<String>) {
    *BW_SESSION.lock().unwrap_or_else(|e| e.into_inner()) = value;
}

// ---------- Shapes (camelCase JSON) ----------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PmState {
    Missing,
    SignedOut,
    Locked,
    Ready,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PmStatus {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cli_path: Option<String>,
    pub state: PmState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PmItem {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub subtitle: Option<String>,
    pub category: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vault: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FieldKind {
    Password,
    Username,
    Otp,
    Text,
    Note,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PmField {
    pub label: String,
    /// The `credentialRef.item` that reads this field.
    pub reference: String,
    pub kind: FieldKind,
    pub concealed: bool,
}

fn display_name(provider: &str) -> &'static str {
    if provider == ONEPASSWORD { "1Password" } else { "Bitwarden" }
}

fn unknown(provider: &str) -> anyhow::Error {
    anyhow!("Unknown password manager: {provider}")
}

// ---------- Finding the CLI ----------

#[derive(Clone)]
struct Cli {
    program: PathBuf,
    /// Arguments before the command's own (tests run a script through an
    /// interpreter).
    prefix_args: Vec<String>,
    timeout: Duration,
    /// For messages: "1Password" or "Bitwarden".
    name: &'static str,
}

fn cli(provider: &str) -> Result<Cli> {
    Ok(Cli { program: discover(provider)?, prefix_args: Vec::new(), timeout: TIMEOUT, name: display_name(provider) })
}

fn missing(provider: &str) -> &'static str {
    if provider == ONEPASSWORD { OP_MISSING } else { BW_MISSING }
}

fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join(r"Microsoft\WinGet\Links"));
        }
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join(r"scoop\shims"));
        }
        dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
    } else {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"].map(PathBuf::from));
    }
    dirs
}

/// The CLI to run: `FARO_OP_PATH` / `FARO_BW_PATH`, then the user's or
/// Faro's own copy (Settings › Password managers), then `PATH`, then the
/// usual install folders.
fn discover(provider: &str) -> Result<PathBuf> {
    let (name, var, tool) = match provider {
        ONEPASSWORD => ("op", "FARO_OP_PATH", OP_TOOL.id),
        BITWARDEN => ("bw", "FARO_BW_PATH", BW_TOOL.id),
        other => return Err(unknown(other)),
    };
    if let Some(path) = std::env::var_os(var).filter(|v| !v.is_empty()).map(PathBuf::from) {
        check_program(&path, provider)?;
        return Ok(path);
    }
    if let Some(path) = managed_tools::selected(tool) {
        check_program(&path, provider)?;
        return Ok(path);
    }
    if let Some(found) = find_installed(name) {
        return Ok(found);
    }
    if cfg!(windows) && provider == BITWARDEN && search_dirs().iter().any(|d| d.join("bw.cmd").is_file()) {
        bail!(BW_CMD);
    }
    bail!(missing(provider))
}

fn search_dirs() -> Vec<PathBuf> {
    // The live PATH, so a CLI installed while Faro runs is found without a restart.
    let mut dirs = crate::env_path::search_dirs();
    dirs.extend(extra_dirs());
    dirs
}

/// A copy installed outside Faro: `PATH`, then the usual install folders.
fn find_installed(name: &str) -> Option<PathBuf> {
    let exe = managed_tools::exe_name(name);
    search_dirs().into_iter().map(|d| d.join(&exe)).find(|c| c.is_absolute() && c.is_file())
}

// ---------- Faro-managed copies (managed_tools) ----------

/// 1Password's code-signing key ("Code signing for 1Password
/// <codesign@1password.com>"), which signs every CLI download's `op.sig`.
pub fn op_signing_key() -> PgpKey {
    PgpKey::from_hex("3FEF9748469ADBE15DA7CA80AC2D62742012EA22", &OP_SIGNING_KEY_N.concat(), "010001")
}

const OP_SIGNING_KEY_N: [&str; 11] = [
    "b2e9f5078858bf62f5d9d84e46b3ba852fc4d229018bb7483cc3f36d068b4c36f796d8dce069772627613469763b9c14",
    "6da4881146b6fb5eeb240d9c06995c783d0b21699b88a334b44f591d322b686e2e24de0d8ce79d727f56cf5a5d677952",
    "793266e99279da206e958cc1f1711284d315c3621a41b6ded0410c351d3f2f3a350e5c151f5488f6a3b23ff9c4463600",
    "dd91bb8645c702f21486ca2597cb8158f313efc4c4825e82f9c39df57b068697f33e980382ddce93ed2d3909c34de746",
    "7ac2e942883646bee276e78ec4e6253d28294011c8491fdc90d8f90b1f2dce422d2506dfb83e619e04e231bc555719bb",
    "461adc7aa0567155a603cc5f811c71d145d52cef9a56cd19b9cbfde3d23f8ee1428b5af331dd237b81146eea03f99ef3",
    "b0eb077261eadc8b6347c752492a533a77acf1123f9c2781a805e2508498b7515a43cb41e14d7de289df59cf56a7b10a",
    "d2ba35d4dadf36ebde564c66aee6c6ab85e0f26b89e229f54e8782033016c0d7b7e7a896d2b6d6222f98b8f9ea976e40",
    "08b5dabeb2486aa94125ad1382d112a25e15f4d271eef8048762ea6bff501cf7f8dd934c064cd6f5b9eefa6811891d90",
    "3453aee89e9fcc91510e0afd389c74596c702b334c39dafe345486946b1e5961f2d238892a2243c7a32c26851ed6e905",
    "6505b8cfeb3595ad30161273f1d950d0564d425f6f67fe433f275904eb4a6865",
];

pub static OP_TOOL: ToolSpec = ToolSpec {
    id: "op",
    name: "1Password CLI",
    program: "op",
    config_file: "op-cli.json",
    feed: Feed::Signed {
        publisher: "1Password",
        check_url: "https://app-updates.agilebits.com/check/1/0/CLI2/en/2.0.0/N",
        asset: op_asset,
        download_base: "https://cache.agilebits.com/dist/1P/op2/pkg",
        key: op_signing_key,
    },
    roles: &[managed_tools::Role::Secrets],
    version_args: &["--version"],
    parse_version: managed_tools::plain_version,
    find_installed: || find_installed("op"),
    check_custom: |p| check_program(p, ONEPASSWORD),
    on_select: |_| {},
};

pub static BW_TOOL: ToolSpec = ToolSpec {
    id: "bw",
    name: "Bitwarden CLI",
    program: "bw",
    config_file: "bw-cli.json",
    // The repository also publishes the desktop, web and browser apps.
    feed: Feed::GitHub {
        api: "https://api.github.com/repos/bitwarden/clients/releases?per_page=100",
        tag_prefix: "cli-",
        pick: bw_asset,
    },
    roles: &[managed_tools::Role::Secrets],
    version_args: &["--version"],
    parse_version: managed_tools::plain_version,
    find_installed: || find_installed("bw"),
    check_custom: |p| check_program(p, BITWARDEN),
    on_select: |_| {},
};

/// `v2.42.0/op_windows_amd64_v2.42.0.zip`, relative to the download base.
pub fn op_asset(os: &str, arch: &str, version: &str) -> Result<String> {
    let platform = match os {
        "windows" => "windows",
        "linux" => "linux",
        "macos" => "darwin",
        _ => bail!("1Password publishes no CLI build for {os}/{arch}"),
    };
    let cpu = match (os, arch) {
        // No native Windows arm64 build; the amd64 one runs emulated.
        ("windows", "x86_64" | "aarch64") => "amd64",
        (_, "x86_64") => "amd64",
        (_, "aarch64") => "arm64",
        ("windows" | "linux", "x86") => "386",
        ("linux", "arm") => "arm",
        _ => bail!("1Password publishes no CLI build for {os}/{arch}"),
    };
    Ok(format!("v{version}/op_{platform}_{cpu}_v{version}.zip"))
}

/// The standalone CLI zip: `bw-bit-windows-2026.11.0.zip` (older releases:
/// `bw-windows-…`). The full build wins over the `bw-oss-` one.
pub fn bw_asset(os: &str, arch: &str, names: &[&str]) -> Result<String> {
    let platform = match (os, arch) {
        // No native Windows arm64 build; the x64 one runs emulated.
        ("windows", "x86_64" | "aarch64") => "windows",
        ("linux", "x86_64") => "linux",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "x86_64") => "macos",
        ("macos", "aarch64") => "macos-arm64",
        _ => bail!("Bitwarden publishes no CLI build for {os}/{arch}"),
    };
    for prefix in ["bw-bit-", "bw-"] {
        let want = format!("{prefix}{platform}-");
        let hit = names.iter().find(|n| {
            n.ends_with(".zip") && n.strip_prefix(want.as_str()).is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
        });
        if let Some(name) = hit {
            return Ok(name.to_string());
        }
    }
    bail!("this Bitwarden CLI release has no {platform} download")
}

/// The adapter rules: an absolute path to a real file, and on Windows an
/// `.exe` (a `.cmd` would run through the shell).
fn check_program(path: &Path, provider: &str) -> Result<()> {
    ensure!(path.is_absolute(), "The {} CLI path must be absolute.", display_name(provider));
    if cfg!(windows) {
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if ext != "exe" {
            if provider == BITWARDEN && ext == "cmd" {
                bail!(BW_CMD);
            }
            bail!("The {} CLI must be an .exe, not a script.", display_name(provider));
        }
    }
    ensure!(path.is_file(), missing(provider));
    Ok(())
}

// ---------- Running it ----------

struct Out {
    ok: bool,
    stdout: Vec<u8>,
    /// Only matched against known phrases; never shown.
    stderr: String,
}

async fn read_capped<R: AsyncRead + Unpin>(mut reader: R, cap: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let (mut out, mut over, mut buf) = (Vec::new(), false, [0u8; 8192]);
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            return Ok((out, over));
        }
        let room = cap.saturating_sub(out.len());
        over |= n > room;
        out.extend_from_slice(&buf[..n.min(room)]);
    }
}

async fn exec(cli: &Cli, args: &[&str], env: &[(&str, &str)], session: Option<&str>, cap: usize) -> Result<Out> {
    let name = cli.name;
    let mut command = tokio::process::Command::new(&cli.program);
    command
        .args(&cli.prefix_args)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_remove("BW_SESSION")
        .env_remove(PASSWORD_ENV)
        .env("BW_NOINTERACTION", "true");
    if let Some(session) = session {
        command.env("BW_SESSION", session);
    }
    for (key, value) in env {
        command.env(key, value);
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let spawned = command.spawn();
    // The command holds the child's environment (maybe the master password).
    drop(command);
    let mut child = spawned.map_err(|_| anyhow!("The {name} CLI couldn't start."))?;
    let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) else {
        bail!("The {name} CLI couldn't start.");
    };
    let result = tokio::time::timeout(cli.timeout, async {
        let (out, err) = tokio::join!(read_capped(stdout, cap), read_capped(stderr, STDERR_CAP));
        let ((stdout, over), (stderr, _)) = (out?, err?);
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, stdout, stderr, over))
    })
    .await;
    match result {
        Ok(Ok((status, stdout, stderr, over))) => {
            ensure!(!over, "{name} returned more data than Faro accepts.");
            Ok(Out { ok: status.success(), stdout, stderr: String::from_utf8_lossy(&stderr).to_lowercase() })
        }
        Ok(Err(_)) => {
            let _ = child.kill().await;
            bail!("Faro couldn't read the {name} CLI's answer.")
        }
        Err(_) => {
            let _ = child.kill().await;
            bail!("{name} didn't answer within {} seconds.", cli.timeout.as_secs())
        }
    }
}

fn text(bytes: Vec<u8>, name: &str) -> Result<String> {
    let value = String::from_utf8(bytes).map_err(|_| anyhow!("{name} returned text Faro can't read."))?;
    Ok(value.strip_suffix("\r\n").or_else(|| value.strip_suffix('\n')).unwrap_or(&value).to_string())
}

/// JSON from a CLI, tolerating a warning line before it.
fn json(bytes: &[u8], name: &str) -> Result<Value> {
    let start = bytes.iter().position(|&b| b == b'{' || b == b'[').unwrap_or(0);
    serde_json::from_slice(&bytes[start..]).map_err(|_| anyhow!("{name} returned something Faro doesn't understand."))
}

fn str_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter().try_fold(value, |v, key| v.get(key))?.as_str().filter(|s| !s.is_empty())
}

fn has_control(s: &str) -> bool {
    s.chars().any(char::is_control)
}

// ---------- References ----------

/// `op://<vault>/<item>/[section/]<field>`, optionally `?attribute=…`.
fn validate_op_reference(reference: &str) -> Result<()> {
    let ok = reference.len() <= 4096
        && !has_control(reference)
        && reference.strip_prefix("op://").is_some_and(|rest| {
            let path = rest.split('?').next().unwrap_or("");
            let parts: Vec<&str> = path.split('/').collect();
            parts.len() >= 3 && parts.iter().all(|p| !p.is_empty())
        });
    ensure!(ok, "A 1Password reference looks like op://vault/item/field.");
    Ok(())
}

#[derive(Debug, PartialEq)]
enum BwField {
    Password,
    Username,
    Totp,
    Notes,
    Custom(String),
}

fn bw_item_id(id: &str) -> Result<()> {
    let ok = id.len() == 36 && uuid::Uuid::parse_str(id).is_ok();
    ensure!(ok, "A Bitwarden item id is a UUID.");
    Ok(())
}

/// `<itemId>/<field>`: `password`, `username`, `totp`, `notes` or
/// `field:<custom name>`.
fn parse_bw_reference(reference: &str) -> Result<(String, BwField)> {
    let invalid = || anyhow!("A Bitwarden reference looks like <item id>/password.");
    let (id, field) = reference.split_once('/').ok_or_else(invalid)?;
    bw_item_id(id)?;
    let field = match field {
        "password" => BwField::Password,
        "username" => BwField::Username,
        "totp" => BwField::Totp,
        "notes" => BwField::Notes,
        other => {
            let name = other.strip_prefix("field:").ok_or_else(invalid)?;
            ensure!(!name.is_empty() && name.len() <= 512 && !has_control(name), "That Bitwarden field name isn't valid.");
            BwField::Custom(name.to_string())
        }
    };
    Ok((id.to_string(), field))
}

/// Check a reference without running anything.
pub fn validate(reference: &CredentialRef) -> Result<()> {
    match reference.provider.as_str() {
        ONEPASSWORD => validate_op_reference(&reference.item),
        BITWARDEN => parse_bw_reference(&reference.item).map(|_| ()),
        other => Err(unknown(other)),
    }
}

// ---------- 1Password ----------

/// What a failed `op` call means, from its stderr.
#[derive(Debug, PartialEq)]
enum OpProblem {
    /// The app integration works but this session isn't approved yet.
    NeedsApproval,
    /// The 1Password app isn't running (or is locked and unreachable).
    AppClosed,
    /// "Integrate with 1Password CLI" is off, or the app has no account.
    IntegrationOff,
    /// Anything else. op's own words are never shown (they can echo input).
    Other,
}

fn op_problem(stderr: &str) -> OpProblem {
    let s = stderr.to_ascii_lowercase();
    let any = |pats: &[&str]| pats.iter().any(|p| s.contains(p));
    // Order matters: op's "can't connect" message also tells you to turn the
    // integration on, so reachability is checked first.
    if any(&["connecting to desktop app", "cannot connect", "can't connect", "couldn't connect", "make sure 1password is running", "app is not running", "is not running"]) {
        OpProblem::AppClosed
    } else if any(&["no accounts configured", "no account found", "integration is disabled", "integrate with 1password cli"]) {
        OpProblem::IntegrationOff
    } else if any(&["not currently signed in", "account is not signed in", "not signed in", "authorization prompt dismissed", "authorization timeout", "authorization denied", "biometric", "locked"]) {
        OpProblem::NeedsApproval
    } else {
        OpProblem::Other
    }
}

fn op_failure(stderr: &str, otherwise: &str) -> anyhow::Error {
    match op_problem(stderr) {
        OpProblem::NeedsApproval => anyhow!(OP_LOCKED),
        OpProblem::AppClosed => anyhow!(OP_APP_CLOSED),
        OpProblem::IntegrationOff => anyhow!(op_not_connected()),
        OpProblem::Other => anyhow!("{otherwise}"),
    }
}

/// What Faro can tell about the 1Password desktop app without running it.
#[derive(Debug, PartialEq)]
enum OpApp {
    NotInstalled,
    /// Installed; `Some(true)` when its "Integrate with 1Password CLI" is on.
    Installed { integration: Option<bool> },
}

fn op_app() -> OpApp {
    op_app_in(&op_app_paths(), &op_settings_paths())
}

fn op_app_in(apps: &[PathBuf], settings: &[PathBuf]) -> OpApp {
    let settings_file = settings.iter().find(|p| p.is_file());
    if !apps.iter().any(|p| p.exists()) && settings_file.is_none() {
        return OpApp::NotInstalled;
    }
    let integration = settings_file
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("developers.cliSharedLockState.enabled").and_then(Value::as_bool));
    OpApp::Installed { integration }
}

fn op_app_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        for var in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(base) = std::env::var_os(var) {
                out.push(PathBuf::from(base).join("1Password").join("app").join("8").join("1Password.exe"));
            }
        }
        // The Microsoft Store build.
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            if let Ok(entries) = std::fs::read_dir(PathBuf::from(local).join("Packages")) {
                out.extend(
                    entries
                        .flatten()
                        .filter(|e| e.file_name().to_string_lossy().to_ascii_lowercase().contains("1password"))
                        .map(|e| e.path()),
                );
            }
        }
    } else if cfg!(target_os = "macos") {
        out.push(PathBuf::from("/Applications/1Password.app"));
        if let Some(home) = dirs::home_dir() {
            out.push(home.join("Applications/1Password.app"));
        }
    } else {
        out.push(PathBuf::from("/opt/1Password/1password"));
        out.push(PathBuf::from("/usr/bin/1password"));
    }
    out
}

fn op_settings_paths() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            out.push(PathBuf::from(local).join("1Password/settings/settings.json"));
        }
    } else if let Some(home) = dirs::home_dir() {
        out.push(home.join("Library/Group Containers/2BUA8C4S2C.com.1password/Library/Application Support/1Password/Data/settings/settings.json"));
        out.push(home.join(".config/1Password/settings/settings.json"));
    }
    out
}

/// Why `op` sees no account: no app, app closed, or the setting is off.
fn op_not_connected() -> &'static str {
    match op_app() {
        OpApp::NotInstalled => OP_NO_APP,
        OpApp::Installed { integration: Some(true) } => OP_APP_CLOSED,
        OpApp::Installed { .. } => OP_SIGNED_OUT,
    }
}

/// `op whoami` only succeeds once this session is approved, so a "not signed
/// in" answer alone can't tell "approve in the app" from "integration off".
/// `op account list` can: with the integration on it lists the app's
/// accounts without asking for approval.
async fn op_status(cli: &Cli) -> (PmState, Option<String>, Option<String>) {
    let whoami = match exec(cli, &["whoami", "--format", "json"], &[], None, VALUE_CAP).await {
        Ok(out) => out,
        Err(e) => return (PmState::SignedOut, None, Some(e.to_string())),
    };
    if whoami.ok {
        let info = json(&whoami.stdout, cli.name).unwrap_or(Value::Null);
        let account = str_at(&info, &["email"]).or_else(|| str_at(&info, &["url"])).map(str::to_string);
        return (PmState::Ready, account, None);
    }
    match op_problem(&whoami.stderr) {
        OpProblem::AppClosed => return (PmState::SignedOut, None, Some(OP_APP_CLOSED.into())),
        OpProblem::Other => return (PmState::SignedOut, None, Some(OP_UNKNOWN.into())),
        // "No account found" is also what op says when the app isn't there:
        // the account list below sorts it out.
        OpProblem::IntegrationOff | OpProblem::NeedsApproval => {}
    }
    match exec(cli, &["account", "list", "--format", "json"], &[], None, VALUE_CAP).await {
        Ok(list) if list.ok => {
            let accounts = json(&list.stdout, cli.name).unwrap_or(Value::Null);
            let first = accounts.as_array().and_then(|a| a.first()).cloned();
            match first {
                Some(acct) => {
                    let who = str_at(&acct, &["email"]).or_else(|| str_at(&acct, &["url"])).map(str::to_string);
                    (PmState::Locked, who, Some(OP_LOCKED.into()))
                }
                None => (PmState::SignedOut, None, Some(op_not_connected().into())),
            }
        }
        Ok(list) => match op_problem(&list.stderr) {
            OpProblem::AppClosed => (PmState::SignedOut, None, Some(OP_APP_CLOSED.into())),
            OpProblem::Other => (PmState::SignedOut, None, Some(OP_UNKNOWN.into())),
            _ => (PmState::SignedOut, None, Some(op_not_connected().into())),
        },
        Err(e) => (PmState::SignedOut, None, Some(e.to_string())),
    }
}

/// `op signin`: with the desktop-app integration this raises 1Password's own
/// unlock prompt, so Faro never sees the account password.
async fn op_unlock(cli: &Cli) -> Result<()> {
    let out = exec(cli, &["signin"], &[], None, VALUE_CAP).await?;
    if out.ok { Ok(()) } else { Err(op_failure(&out.stderr, OP_LOCKED)) }
}

async fn op_resolve(cli: &Cli, reference: &str) -> Result<String> {
    validate_op_reference(reference)?;
    let out = exec(cli, &["read", "--no-newline", reference], &[], None, VALUE_CAP).await?;
    if !out.ok {
        return Err(op_failure(&out.stderr, "1Password couldn't read that reference. Check that the item and field still exist."));
    }
    let value = text(out.stdout, cli.name)?;
    ensure!(!value.is_empty(), "That 1Password field is empty.");
    Ok(value)
}

const OP_CATEGORIES: &str = "Login,Password,Server,SSH Key,API Credential,Database";

fn op_category(category: &str) -> String {
    match category {
        "LOGIN" => "login",
        "PASSWORD" => "password",
        "SERVER" => "server",
        "SSH_KEY" => "sshKey",
        "API_CREDENTIAL" => "apiCredential",
        "DATABASE" => "database",
        other => return other.to_ascii_lowercase(),
    }
    .into()
}

fn matches(query: &str, haystack: &[Option<&str>]) -> bool {
    query.is_empty() || haystack.iter().flatten().any(|h| h.to_lowercase().contains(query))
}

fn op_items_from(list: &Value, query: &str) -> Vec<PmItem> {
    let query = query.trim().to_lowercase();
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = str_at(item, &["id"])?;
            let title = str_at(item, &["title"]).unwrap_or("(untitled)");
            let urls = item.get("urls").and_then(Value::as_array);
            let url = urls
                .and_then(|u| u.iter().find(|u| u.get("primary").and_then(Value::as_bool) == Some(true)).or(u.first()))
                .and_then(|u| str_at(u, &["href"]));
            let category = str_at(item, &["category"]).unwrap_or("");
            let info = str_at(item, &["additional_information"]);
            let vault = str_at(item, &["vault", "name"]);
            matches(&query, &[Some(title), info, vault, url]).then(|| PmItem {
                id: id.into(),
                title: title.into(),
                subtitle: info.map(Into::into),
                category: op_category(category),
                vault: vault.map(Into::into),
                url: url.map(Into::into),
                username: info.filter(|_| category == "LOGIN").map(Into::into),
            })
        })
        .take(MAX_ITEMS)
        .collect()
}

async fn op_items(cli: &Cli, query: &str) -> Result<Vec<PmItem>> {
    let out = exec(cli, &["item", "list", "--format", "json", "--categories", OP_CATEGORIES], &[], None, LIST_CAP).await?;
    if !out.ok {
        return Err(op_failure(&out.stderr, "1Password couldn't list your items."));
    }
    Ok(op_items_from(&json(&out.stdout, cli.name)?, query))
}

fn op_fields_from(item: &Value) -> Vec<PmField> {
    item.get("fields")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|f| {
            let reference = str_at(f, &["reference"])?;
            let ty = str_at(f, &["type"]).unwrap_or("STRING");
            let kind = match (str_at(f, &["purpose"]), ty) {
                (Some("USERNAME"), _) => FieldKind::Username,
                (Some("PASSWORD"), _) => FieldKind::Password,
                (Some("NOTES"), _) => FieldKind::Note,
                (_, "OTP") => FieldKind::Otp,
                (_, "CONCEALED") => FieldKind::Password,
                _ => FieldKind::Text,
            };
            // An empty notes field isn't worth offering. Only presence is read.
            if kind == FieldKind::Note && str_at(f, &["value"]).is_none() {
                return None;
            }
            let label = str_at(f, &["label"]).or_else(|| str_at(f, &["id"])).unwrap_or("Field");
            let label = match str_at(f, &["section", "label"]) {
                Some(section) => format!("{section} › {label}"),
                None => label.to_string(),
            };
            // `op read` of an OTP field gives the secret; the attribute gives the code.
            let reference = if kind == FieldKind::Otp && !reference.contains('?') {
                format!("{reference}?attribute=otp")
            } else {
                reference.to_string()
            };
            let concealed = matches!(ty, "CONCEALED" | "OTP" | "SSHKEY") || kind == FieldKind::Password;
            Some(PmField { label, reference, kind, concealed })
        })
        .collect()
}

async fn op_fields(cli: &Cli, item_id: &str) -> Result<Vec<PmField>> {
    let ok = !item_id.is_empty() && item_id.len() <= 64 && item_id.chars().all(|c| c.is_ascii_alphanumeric());
    ensure!(ok, "That 1Password item id isn't valid.");
    let out = exec(cli, &["item", "get", item_id, "--format", "json"], &[], None, LIST_CAP).await?;
    if !out.ok {
        return Err(op_failure(&out.stderr, "1Password couldn't open that item."));
    }
    Ok(op_fields_from(&json(&out.stdout, cli.name)?))
}

// ---------- Bitwarden ----------

fn bw_failure(stderr: &str, otherwise: &str) -> anyhow::Error {
    if stderr.contains("not logged in") || stderr.contains("unauthenticated") {
        anyhow!(BW_SIGNED_OUT)
    } else if stderr.contains("locked") || stderr.contains("session") {
        anyhow!(BW_LOCKED)
    } else if stderr.contains("not found") {
        anyhow!("Bitwarden couldn't find that item.")
    } else {
        anyhow!("{otherwise}")
    }
}

async fn bw_status(cli: &Cli, session: Option<&str>) -> (PmState, Option<String>, Option<String>) {
    let out = match exec(cli, &["status"], &[], session, VALUE_CAP).await {
        Ok(out) if out.ok => out,
        Ok(_) => return (PmState::SignedOut, None, Some("The Bitwarden CLI didn't report its status.".into())),
        Err(e) => return (PmState::SignedOut, None, Some(e.to_string())),
    };
    let info = json(&out.stdout, cli.name).unwrap_or(Value::Null);
    let account = str_at(&info, &["userEmail"]).map(str::to_string);
    match str_at(&info, &["status"]) {
        Some("unlocked") => (PmState::Ready, account, None),
        Some("locked") => (PmState::Locked, account, Some("Enter your master password to unlock.".into())),
        _ => (PmState::SignedOut, account, Some("Run `bw login` once in a terminal.".into())),
    }
}

/// `bw unlock --raw --passwordenv`, with the password only in that child's
/// environment. Returns the session key.
async fn bw_unlock(cli: &Cli, password: &str) -> Result<String> {
    ensure!(!password.is_empty(), "Enter your Bitwarden master password.");
    let out = exec(cli, &["unlock", "--raw", "--passwordenv", PASSWORD_ENV], &[(PASSWORD_ENV, password)], None, VALUE_CAP).await?;
    if !out.ok {
        if out.stderr.contains("not logged in") {
            bail!("Bitwarden isn't signed in. Run `bw login` once in a terminal, then unlock here.");
        }
        bail!("Bitwarden didn't unlock. Check the master password.");
    }
    let session = text(out.stdout, cli.name)?.trim().to_string();
    ensure!(
        !session.is_empty() && session.len() <= 1024 && !session.chars().any(|c| c.is_whitespace() || c.is_control()),
        "Bitwarden didn't return a session."
    );
    Ok(session)
}

fn bw_category(item: &Value) -> &'static str {
    match item.get("type").and_then(Value::as_u64) {
        Some(1) => "login",
        Some(2) => "note",
        Some(3) => "card",
        Some(4) => "identity",
        Some(5) => "sshKey",
        _ => "other",
    }
}

fn bw_items_from(list: &Value) -> Vec<PmItem> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = str_at(item, &["id"])?;
            let username = str_at(item, &["login", "username"]);
            let url = item
                .pointer("/login/uris")
                .and_then(Value::as_array)
                .and_then(|uris| uris.iter().find_map(|u| str_at(u, &["uri"])));
            Some(PmItem {
                id: id.into(),
                title: str_at(item, &["name"]).unwrap_or("(untitled)").into(),
                subtitle: username.map(Into::into),
                category: bw_category(item).into(),
                vault: None,
                url: url.map(Into::into),
                username: username.map(Into::into),
            })
        })
        .take(MAX_ITEMS)
        .collect()
}

async fn bw_items(cli: &Cli, session: Option<&str>, query: &str) -> Result<Vec<PmItem>> {
    let session = session.ok_or_else(|| anyhow!(BW_LOCKED))?;
    let query = query.trim();
    ensure!(query.len() <= 256 && !has_control(query), "That search isn't valid.");
    // `--search=<q>` so a query starting with `-` stays a value.
    let search = format!("--search={query}");
    let args: Vec<&str> = if query.is_empty() { vec!["list", "items"] } else { vec!["list", "items", &search] };
    let out = exec(cli, &args, &[], Some(session), LIST_CAP).await?;
    if !out.ok {
        return Err(bw_failure(&out.stderr, "Bitwarden couldn't list your items."));
    }
    Ok(bw_items_from(&json(&out.stdout, cli.name)?))
}

fn bw_fields_from(id: &str, item: &Value) -> Vec<PmField> {
    let field = |label: &str, suffix: &str, kind, concealed| PmField { label: label.into(), reference: format!("{id}/{suffix}"), kind, concealed };
    let mut out = Vec::new();
    // Only presence is read; values stay in the parsed JSON.
    if str_at(item, &["login", "username"]).is_some() {
        out.push(field("Username", "username", FieldKind::Username, false));
    }
    if str_at(item, &["login", "password"]).is_some() {
        out.push(field("Password", "password", FieldKind::Password, true));
    }
    if str_at(item, &["login", "totp"]).is_some() {
        out.push(field("One-time code", "totp", FieldKind::Otp, true));
    }
    for custom in item.get("fields").and_then(Value::as_array).into_iter().flatten() {
        let Some(name) = str_at(custom, &["name"]).filter(|n| !has_control(n)) else { continue };
        // 0 text, 1 hidden, 2 boolean; 3 (linked) points at another field.
        let ty = custom.get("type").and_then(Value::as_u64).unwrap_or(0);
        if ty > 2 {
            continue;
        }
        out.push(field(name, &format!("field:{name}"), FieldKind::Text, ty == 1));
    }
    if str_at(item, &["notes"]).is_some() {
        out.push(field("Notes", "notes", FieldKind::Note, false));
    }
    out
}

async fn bw_get_item(cli: &Cli, session: Option<&str>, id: &str) -> Result<Value> {
    bw_item_id(id)?;
    let session = session.ok_or_else(|| anyhow!(BW_LOCKED))?;
    let out = exec(cli, &["get", "item", id], &[], Some(session), LIST_CAP).await?;
    if !out.ok {
        return Err(bw_failure(&out.stderr, "Bitwarden couldn't open that item."));
    }
    json(&out.stdout, cli.name)
}

async fn bw_fields(cli: &Cli, session: Option<&str>, id: &str) -> Result<Vec<PmField>> {
    Ok(bw_fields_from(id, &bw_get_item(cli, session, id).await?))
}

async fn bw_resolve(cli: &Cli, session: Option<&str>, reference: &str) -> Result<String> {
    let (id, field) = parse_bw_reference(reference)?;
    let value = if field == BwField::Totp {
        let session = session.ok_or_else(|| anyhow!(BW_LOCKED))?;
        let out = exec(cli, &["get", "totp", &id], &[], Some(session), VALUE_CAP).await?;
        if !out.ok {
            return Err(bw_failure(&out.stderr, "Bitwarden couldn't make a one-time code for that item."));
        }
        Some(text(out.stdout, cli.name)?.trim().to_string())
    } else {
        let item = bw_get_item(cli, session, &id).await?;
        let pick = |path: &[&str]| str_at(&item, path).map(str::to_string);
        match &field {
            BwField::Password => pick(&["login", "password"]),
            BwField::Username => pick(&["login", "username"]),
            BwField::Notes => pick(&["notes"]),
            BwField::Custom(name) => item
                .get("fields")
                .and_then(Value::as_array)
                .and_then(|fields| fields.iter().find(|f| str_at(f, &["name"]) == Some(name.as_str())))
                .and_then(|f| str_at(f, &["value"]).map(str::to_string)),
            BwField::Totp => None,
        }
    };
    let what = match &field {
        BwField::Password => "a password".to_string(),
        BwField::Username => "a username".into(),
        BwField::Totp => "a one-time code".into(),
        BwField::Notes => "notes".into(),
        BwField::Custom(name) => format!("a field named \"{name}\""),
    };
    value.filter(|v| !v.is_empty()).ok_or_else(|| anyhow!("That Bitwarden item has no {what}."))
}

/// Run a Bitwarden call with the held session; a session `bw` no longer
/// accepts is forgotten.
fn forget_stale_session<T>(result: Result<T>) -> Result<T> {
    if result.as_ref().err().is_some_and(|e| e.to_string() == BW_LOCKED) {
        set_bw_session(None);
    }
    result
}

// ---------- Public API ----------

/// Resolve a built-in provider's reference to its value.
pub async fn resolve(reference: &CredentialRef) -> Result<String> {
    match reference.provider.as_str() {
        ONEPASSWORD => op_resolve(&cli(ONEPASSWORD)?, &reference.item).await,
        BITWARDEN => {
            parse_bw_reference(&reference.item)?;
            let cli = cli(BITWARDEN)?;
            forget_stale_session(bw_resolve(&cli, bw_session().as_deref(), &reference.item).await)
        }
        other => Err(unknown(other)),
    }
}

async fn status_of(provider: &str) -> PmStatus {
    let name = display_name(provider).to_string();
    let cli = match cli(provider) {
        Ok(cli) => cli,
        Err(e) => {
            return PmStatus { id: provider.into(), name, cli_path: None, state: PmState::Missing, account: None, detail: Some(e.to_string()) }
        }
    };
    let (state, account, detail) = if provider == ONEPASSWORD {
        op_status(&cli).await
    } else {
        let session = bw_session();
        let status = bw_status(&cli, session.as_deref()).await;
        if session.is_some() && status.0 != PmState::Ready {
            set_bw_session(None);
        }
        status
    };
    PmStatus { id: provider.into(), name, cli_path: Some(cli.program.display().to_string()), state, account, detail }
}

pub async fn status() -> Vec<PmStatus> {
    let (op, bw) = tokio::join!(status_of(ONEPASSWORD), status_of(BITWARDEN));
    vec![op, bw]
}

/// Bitwarden: unlock with the master password, keeping the session in
/// memory. 1Password: raise the app's unlock prompt.
pub async fn unlock(provider: &str, password: String) -> Result<()> {
    match provider {
        ONEPASSWORD => op_unlock(&cli(ONEPASSWORD)?).await,
        BITWARDEN => {
            let session = bw_unlock(&cli(BITWARDEN)?, &password).await;
            drop(password);
            set_bw_session(Some(session?));
            Ok(())
        }
        other => Err(unknown(other)),
    }
}

/// Bitwarden: forget the session and lock the CLI. 1Password locks from its
/// own app, so there's nothing to do.
pub async fn lock(provider: &str) -> Result<()> {
    match provider {
        ONEPASSWORD => Ok(()),
        BITWARDEN => {
            if let (Some(session), Ok(cli)) = (bw_session(), cli(BITWARDEN)) {
                let _ = exec(&cli, &["lock"], &[], Some(&session), VALUE_CAP).await;
            }
            set_bw_session(None);
            Ok(())
        }
        other => Err(unknown(other)),
    }
}

pub async fn items(provider: &str, query: &str) -> Result<Vec<PmItem>> {
    match provider {
        ONEPASSWORD => op_items(&cli(ONEPASSWORD)?, query).await,
        BITWARDEN => forget_stale_session(bw_items(&cli(BITWARDEN)?, bw_session().as_deref(), query).await),
        other => Err(unknown(other)),
    }
}

pub async fn fields(provider: &str, item_id: &str) -> Result<Vec<PmField>> {
    match provider {
        ONEPASSWORD => op_fields(&cli(ONEPASSWORD)?, item_id).await,
        BITWARDEN => forget_stale_session(bw_fields(&cli(BITWARDEN)?, bw_session().as_deref(), item_id).await),
        other => Err(unknown(other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ITEM: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";

    /// A fake `op`/`bw`: each rule is (argv prefix, stdout, stderr, exit
    /// code); stdout `SLEEP` hangs. Every call appends its argv and the
    /// session / password environment to a log.
    struct Fake {
        cli: Cli,
        log: PathBuf,
        dir: PathBuf,
    }

    impl Drop for Fake {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    impl Fake {
        fn new(rules: &[(&str, &str, &str, i32)]) -> Self {
            let dir = std::env::temp_dir().join(format!("faro-pm-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let log = dir.join("calls.log");
            let cli = Self::script(&dir, &log, rules);
            Fake { cli, log, dir }
        }

        #[cfg(windows)]
        fn script(dir: &Path, log: &Path, rules: &[(&str, &str, &str, i32)]) -> Cli {
            let q = |s: &str| format!("'{}'", s.replace('\'', "''"));
            let log = q(&log.to_string_lossy());
            let mut s = String::from(
                "$all = [Environment]::GetCommandLineArgs()\n\
                 $i = [Array]::IndexOf($all, '-File') + 2\n\
                 $rest = if ($i -lt $all.Length) { $all[$i..($all.Length - 1)] } else { @() }\n\
                 $joined = $rest -join ' '\n",
            );
            s += &format!("Add-Content -LiteralPath {log} -Value ('ARGV ' + $joined)\n");
            s += &format!("Add-Content -LiteralPath {log} -Value ('ENV BW_SESSION=' + $env:BW_SESSION + ' PW=' + $env:FARO_BW_PASSWORD)\n");
            for (prefix, stdout, stderr, code) in rules {
                let body = if *stdout == "SLEEP" {
                    "Start-Sleep -Seconds 30".to_string()
                } else {
                    format!("[Console]::Out.Write({}); [Console]::Error.Write({})", q(stdout), q(stderr))
                };
                s += &format!("if ($joined.StartsWith({})) {{ {body}; exit {code} }}\n", q(prefix));
            }
            s += "[Console]::Error.Write('unexpected call'); exit 64\n";
            let script = dir.join("fake.ps1");
            std::fs::write(&script, s).unwrap();
            Cli {
                program: PathBuf::from(std::env::var("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
                prefix_args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]
                    .iter()
                    .map(|a| a.to_string())
                    .chain([script.to_string_lossy().into_owned()])
                    .collect(),
                timeout: TIMEOUT,
                name: "Fake",
            }
        }

        #[cfg(unix)]
        fn script(dir: &Path, log: &Path, rules: &[(&str, &str, &str, i32)]) -> Cli {
            let q = |s: &str| format!("'{}'", s.replace('\'', r"'\''"));
            let log = q(&log.to_string_lossy());
            let mut s = String::from("#!/bin/sh\njoined=\"$*\"\n");
            s += &format!("printf 'ARGV %s\\n' \"$joined\" >> {log}\n");
            s += &format!("printf 'ENV BW_SESSION=%s PW=%s\\n' \"$BW_SESSION\" \"$FARO_BW_PASSWORD\" >> {log}\n");
            s += "case \"$joined\" in\n";
            for (prefix, stdout, stderr, code) in rules {
                let body = if *stdout == "SLEEP" {
                    "sleep 30".to_string()
                } else {
                    format!("printf '%s' {}; printf '%s' {} >&2", q(stdout), q(stderr))
                };
                s += &format!("  {}*) {body}; exit {code};;\n", q(prefix));
            }
            s += "esac\nprintf 'unexpected call' >&2\nexit 64\n";
            let script = dir.join("fake.sh");
            std::fs::write(&script, s).unwrap();
            Cli { program: "/bin/sh".into(), prefix_args: vec![script.to_string_lossy().into_owned()], timeout: TIMEOUT, name: "Fake" }
        }

        fn calls(&self) -> String {
            std::fs::read_to_string(&self.log).unwrap_or_default()
        }

        fn argv_lines(&self) -> Vec<String> {
            self.calls().lines().filter(|l| l.starts_with("ARGV")).map(str::to_string).collect()
        }
    }

    #[tokio::test]
    async fn op_reads_a_reference() {
        let fake = Fake::new(&[("read --no-newline op://Dev/db/password", "s3cret value", "", 0)]);
        assert_eq!(op_resolve(&fake.cli, "op://Dev/db/password").await.unwrap(), "s3cret value");
        assert_eq!(fake.argv_lines(), ["ARGV read --no-newline op://Dev/db/password"]);
    }

    #[tokio::test]
    async fn op_status_states() {
        let ready = Fake::new(&[("whoami --format json", r#"{"url":"my.1password.com","email":"me@example.com"}"#, "", 0)]);
        assert_eq!(op_status(&ready.cli).await, (PmState::Ready, Some("me@example.com".into()), None));
        // Integration on, session not approved yet: the app's account shows, so "Sign in".
        let approve = Fake::new(&[
            ("whoami", "", "[ERROR] 2026/11/19 10:00:00 account is not signed in", 1),
            ("account list", r#"[{"url":"my.1password.com","email":"me@example.com","user_uuid":"U","account_uuid":"A"}]"#, "", 0),
        ]);
        assert_eq!(op_status(&approve.cli).await, (PmState::Locked, Some("me@example.com".into()), Some(OP_LOCKED.into())));
        // Integration off: no accounts configured.
        let off = Fake::new(&[
            ("whoami", "", "[ERROR] 2026/11/19 10:00:00 account is not signed in", 1),
            ("account list", "", "[ERROR] 2026/11/19 10:00:00 No accounts configured for use with 1Password CLI.", 1),
        ]);
        let off_state = op_status(&off.cli).await;
        assert_eq!(off_state.0, PmState::SignedOut);
        assert!([OP_NO_APP, OP_SIGNED_OUT, OP_APP_CLOSED].contains(&off_state.2.as_deref().unwrap()));
        // The app isn't running.
        let closed = Fake::new(&[("whoami", "", "[ERROR] 2026/11/19 10:00:00 error initializing client: connecting to desktop app: cannot connect to 1Password app, make sure it is running", 1)]);
        assert_eq!(op_status(&closed.cli).await.2.as_deref(), Some(OP_APP_CLOSED));
        // Anything unknown gets a fixed message, never op's own text.
        let odd = Fake::new(&[("whoami", "", "[ERROR] 2026/11/19 10:00:00 STDERR-SHOULD-NOT-LEAK", 1)]);
        assert_eq!(op_status(&odd.cli).await.2.as_deref(), Some(OP_UNKNOWN));
        let locked = Fake::new(&[
            ("whoami", "", "[ERROR] authorization prompt dismissed, please try again", 1),
            ("account list", r#"[{"url":"my.1password.com"}]"#, "", 0),
        ]);
        assert_eq!(op_status(&locked.cli).await.0, PmState::Locked);
    }

    #[test]
    fn op_app_detection() {
        let dir = std::env::temp_dir().join(format!("faro-op-app-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let app = dir.join("1Password.exe");
        let settings = dir.join("settings.json");
        assert_eq!(op_app_in(std::slice::from_ref(&app), std::slice::from_ref(&settings)), OpApp::NotInstalled);
        std::fs::write(&app, b"").unwrap();
        assert_eq!(op_app_in(std::slice::from_ref(&app), std::slice::from_ref(&settings)), OpApp::Installed { integration: None });
        std::fs::write(&settings, br#"{"developers.cliSharedLockState.enabled": true}"#).unwrap();
        assert_eq!(op_app_in(std::slice::from_ref(&app), std::slice::from_ref(&settings)), OpApp::Installed { integration: Some(true) });
        std::fs::write(&settings, br#"{"developers.cliSharedLockState.enabled": false}"#).unwrap();
        assert_eq!(op_app_in(&[app], &[settings]), OpApp::Installed { integration: Some(false) });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn op_problem_kinds() {
        assert_eq!(op_problem("[error] 2026/11/20 01:13:24 no account found for filter"), OpProblem::IntegrationOff);
        assert_eq!(op_problem("[error] account is not signed in"), OpProblem::NeedsApproval);
        assert_eq!(op_problem("[error] connecting to desktop app: make sure 1password is running"), OpProblem::AppClosed);
        assert_eq!(op_problem("[error] something else"), OpProblem::Other);
    }

    #[tokio::test]
    async fn op_items_and_fields() {
        let list = r#"[
          {"id":"abc123","title":"Prod DB","category":"DATABASE","vault":{"id":"v1","name":"Work"},"additional_information":"postgres"},
          {"id":"def456","title":"Web box","category":"LOGIN","vault":{"name":"Work"},"additional_information":"deploy",
           "urls":[{"href":"https://other.example"},{"href":"ssh://web.example","primary":true}]}
        ]"#;
        let item = r#"{"id":"def456","fields":[
          {"id":"username","type":"STRING","purpose":"USERNAME","label":"username","value":"deploy","reference":"op://Work/Web box/username"},
          {"id":"password","type":"CONCEALED","purpose":"PASSWORD","label":"password","value":"hunter2-secret","reference":"op://Work/Web box/password"},
          {"id":"notesPlain","type":"STRING","purpose":"NOTES","label":"notesPlain","reference":"op://Work/Web box/notesPlain"},
          {"id":"totp","type":"OTP","label":"one-time password","section":{"id":"s","label":"Security"},"value":"otpauth://x","reference":"op://Work/Web box/Security/one-time password"}
        ]}"#;
        let fake = Fake::new(&[("item list --format json --categories", list, "", 0), ("item get def456 --format json", item, "", 0)]);
        let items = op_items(&fake.cli, "web").await.unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].url.as_deref(), Some("ssh://web.example"));
        assert_eq!(items[0].username.as_deref(), Some("deploy"));
        assert_eq!(items[0].vault.as_deref(), Some("Work"));
        assert_eq!(items[0].category, "login");
        assert_eq!(op_items(&fake.cli, "").await.unwrap().len(), 2);
        assert!(fake.calls().contains("--categories Login,Password,Server,SSH Key,API Credential,Database"));

        let fields = op_fields(&fake.cli, "def456").await.unwrap();
        let kinds: Vec<FieldKind> = fields.iter().map(|f| f.kind).collect();
        assert_eq!(kinds, [FieldKind::Username, FieldKind::Password, FieldKind::Otp]);
        assert_eq!(fields[2].label, "Security › one-time password");
        assert!(fields[2].reference.ends_with("?attribute=otp"));
        assert!(fields[1].concealed && !fields[0].concealed);
        let json = serde_json::to_string(&fields).unwrap();
        assert!(!json.contains("hunter2-secret") && !json.contains("otpauth"), "{json}");
        assert!(op_fields(&fake.cli, "--help").await.is_err());
    }

    #[tokio::test]
    async fn bw_master_password_only_travels_in_the_environment() {
        let password = "Correct horse battery staple";
        let item = format!(r#"{{"id":"{ITEM}","type":1,"name":"Server","login":{{"username":"root","password":"pw-from-vault"}}}}"#);
        let fake = Fake::new(&[("unlock --raw --passwordenv FARO_BW_PASSWORD", "SESSIONKEY123\n", "", 0), (&format!("get item {ITEM}"), &item, "", 0)]);
        let session = bw_unlock(&fake.cli, password).await.unwrap();
        assert_eq!(session, "SESSIONKEY123");
        let value = bw_resolve(&fake.cli, Some(&session), &format!("{ITEM}/password")).await.unwrap();
        assert_eq!(value, "pw-from-vault");

        let calls = fake.calls();
        for line in fake.argv_lines() {
            assert!(!line.contains("Correct horse") && !line.contains("SESSIONKEY123"), "{line}");
        }
        let envs: Vec<&str> = calls.lines().filter(|l| l.starts_with("ENV")).collect();
        // The unlock child alone sees the password; the read child alone gets the session.
        assert_eq!(envs[0], format!("ENV BW_SESSION= PW={password}"));
        assert_eq!(envs[1], "ENV BW_SESSION=SESSIONKEY123 PW=");
    }

    #[tokio::test]
    async fn bw_status_states() {
        let signed_out = Fake::new(&[("status", r#"{"serverUrl":null,"status":"unauthenticated"}"#, "", 0)]);
        assert_eq!(bw_status(&signed_out.cli, None).await.0, PmState::SignedOut);
        let locked = Fake::new(&[("status", r#"{"status":"locked","userEmail":"me@example.com"}"#, "", 0)]);
        assert_eq!(bw_status(&locked.cli, None).await.0, PmState::Locked);
        let ready = Fake::new(&[("status", r#"{"status":"unlocked","userEmail":"me@example.com"}"#, "", 0)]);
        let (state, account, _) = bw_status(&ready.cli, Some("KEY")).await;
        assert_eq!((state, account.as_deref()), (PmState::Ready, Some("me@example.com")));
        assert!(ready.calls().contains("ENV BW_SESSION=KEY"));
    }

    #[tokio::test]
    async fn bw_items_fields_and_totp() {
        let list = format!(
            r#"[{{"id":"{ITEM}","type":1,"name":"Web box","login":{{"username":"deploy","password":"x","uris":[{{"uri":"sftp://web.example"}}]}}}},
               {{"id":"11111111-2222-3333-4444-555555555555","type":2,"name":"Note","notes":"n"}}]"#
        );
        let item = format!(
            r#"{{"id":"{ITEM}","type":1,"name":"Web box","notes":"see wiki",
                "login":{{"username":"deploy","password":"vault-pass","totp":"otpauth://totp/x"}},
                "fields":[{{"name":"api key","value":"k-123","type":1}},{{"name":"region","value":"eu","type":0}},{{"name":"link","value":null,"type":3}}]}}"#
        );
        let fake = Fake::new(&[
            ("list items --search=web", &list, "", 0),
            (&format!("get item {ITEM}"), &item, "", 0),
            (&format!("get totp {ITEM}"), "123456\n", "", 0),
        ]);
        let items = bw_items(&fake.cli, Some("S"), "web").await.unwrap();
        assert_eq!(items[0].url.as_deref(), Some("sftp://web.example"));
        assert_eq!(items[0].username.as_deref(), Some("deploy"));
        assert_eq!(items[1].category, "note");

        let fields = bw_fields(&fake.cli, Some("S"), ITEM).await.unwrap();
        let refs: Vec<&str> = fields.iter().map(|f| f.reference.strip_prefix(ITEM).unwrap()).collect();
        assert_eq!(refs, ["/username", "/password", "/totp", "/field:api key", "/field:region", "/notes"]);
        assert!(fields[3].concealed && !fields[4].concealed);
        let json = serde_json::to_string(&fields).unwrap();
        assert!(!json.contains("vault-pass") && !json.contains("k-123"));

        assert_eq!(bw_resolve(&fake.cli, Some("S"), &format!("{ITEM}/totp")).await.unwrap(), "123456");
        assert_eq!(bw_resolve(&fake.cli, Some("S"), &format!("{ITEM}/field:api key")).await.unwrap(), "k-123");
        assert_eq!(bw_resolve(&fake.cli, Some("S"), &format!("{ITEM}/notes")).await.unwrap(), "see wiki");
        // No session: a plain "locked" error without running bw.
        let before = fake.argv_lines().len();
        assert_eq!(bw_resolve(&fake.cli, None, &format!("{ITEM}/password")).await.unwrap_err().to_string(), BW_LOCKED);
        assert_eq!(fake.argv_lines().len(), before);
    }

    #[tokio::test]
    async fn errors_never_carry_cli_output_or_values() {
        let item = format!(r#"{{"id":"{ITEM}","type":1,"login":{{"password":"VALUE-SHOULD-NOT-LEAK"}}}}"#);
        let fake = Fake::new(&[
            ("read", "STDOUT-SHOULD-NOT-LEAK", "STDERR-SHOULD-NOT-LEAK", 1),
            (&format!("get item {ITEM}"), &item, "", 0),
            ("list items", "STDOUT-SHOULD-NOT-LEAK", "Vault is locked. STDERR-SHOULD-NOT-LEAK", 1),
            ("unlock", "STDOUT-SHOULD-NOT-LEAK", "Invalid master password. STDERR-SHOULD-NOT-LEAK", 1),
        ]);
        let errors = [
            op_resolve(&fake.cli, "op://Dev/db/password").await.unwrap_err(),
            bw_resolve(&fake.cli, Some("S"), &format!("{ITEM}/field:missing")).await.unwrap_err(),
            bw_items(&fake.cli, Some("S"), "").await.unwrap_err(),
            bw_unlock(&fake.cli, "MASTER-SHOULD-NOT-LEAK").await.unwrap_err(),
        ];
        for e in &errors {
            let text = format!("{e:#}");
            assert!(!text.contains("SHOULD-NOT-LEAK"), "{text}");
        }
        assert_eq!(errors[2].to_string(), BW_LOCKED);
        assert_eq!(errors[3].to_string(), "Bitwarden didn't unlock. Check the master password.");
    }

    #[tokio::test]
    async fn a_hung_cli_times_out() {
        let mut fake = Fake::new(&[("read", "SLEEP", "", 0)]);
        fake.cli.timeout = Duration::from_secs(2);
        let started = std::time::Instant::now();
        let err = op_resolve(&fake.cli, "op://Dev/db/password").await.unwrap_err();
        assert!(err.to_string().contains("didn't answer within 2 seconds"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(15));
    }

    #[test]
    fn reference_validation() {
        assert!(validate_op_reference("op://Dev/db/password").is_ok());
        assert!(validate_op_reference("op://Dev/db/Section/one-time password?attribute=otp").is_ok());
        for bad in ["https://Dev/db/password", "op://Dev/db", "op://Dev//password", "op://Dev/db/pass\nword", "-op://a/b/c"] {
            assert!(validate_op_reference(bad).is_err(), "{bad}");
        }
        assert_eq!(parse_bw_reference(&format!("{ITEM}/password")).unwrap().1, BwField::Password);
        assert_eq!(parse_bw_reference(&format!("{ITEM}/field:api key")).unwrap().1, BwField::Custom("api key".into()));
        for bad in [
            "not-a-uuid/password".to_string(),
            format!("{ITEM}/secret"),
            format!("{ITEM}/field:"),
            format!("{ITEM}/field:bad\u{7}name"),
            ITEM.to_string(),
            "0f8fad5bd9cb469fa16570867728950e/password".into(),
        ] {
            assert!(parse_bw_reference(&bad).is_err(), "{bad}");
        }
        assert!(validate(&CredentialRef { provider: "other".into(), item: "x".into() }).is_err());
    }

    #[tokio::test]
    async fn builtin_references_still_refuse_option_injection() {
        let err = crate::credential_refs::resolve(&CredentialRef { provider: BITWARDEN.into(), item: "-x".into() }).await.unwrap_err();
        assert!(err.to_string().contains("Invalid credential reference"));
    }

    #[test]
    fn program_rules() {
        assert!(check_program(Path::new("op.exe"), ONEPASSWORD).is_err());
        #[cfg(windows)]
        {
            let err = check_program(Path::new(r"C:\npm\bw.cmd"), BITWARDEN).unwrap_err();
            assert_eq!(err.to_string(), BW_CMD);
            assert!(check_program(Path::new(r"C:\tools\op.ps1"), ONEPASSWORD).is_err());
            assert_eq!(check_program(Path::new(r"C:\does-not-exist\op.exe"), ONEPASSWORD).unwrap_err().to_string(), OP_MISSING);
        }
    }

    /// The only test that sets the override variables.
    #[tokio::test]
    async fn missing_clis_report_missing_and_resolve_plainly() {
        let gone = std::env::temp_dir().join(format!("faro-gone-{}", uuid::Uuid::new_v4()));
        let exe = |name: &str| gone.join(if cfg!(windows) { format!("{name}.exe") } else { name.to_string() });
        std::env::set_var("FARO_OP_PATH", exe("op"));
        std::env::set_var("FARO_BW_PATH", exe("bw"));
        let states: Vec<(PmState, Option<String>)> = status().await.into_iter().map(|s| (s.state, s.detail)).collect();
        assert_eq!(states, [(PmState::Missing, Some(OP_MISSING.into())), (PmState::Missing, Some(BW_MISSING.into()))]);
        let err = crate::credential_refs::resolve(&CredentialRef { provider: ONEPASSWORD.into(), item: "op://a/b/c".into() }).await.unwrap_err();
        assert_eq!(err.to_string(), OP_MISSING);
        std::env::remove_var("FARO_OP_PATH");
        std::env::remove_var("FARO_BW_PATH");
    }

    #[test]
    fn status_json_shape() {
        let status = PmStatus { id: BITWARDEN.into(), name: "Bitwarden".into(), cli_path: Some("/usr/bin/bw".into()), state: PmState::SignedOut, account: None, detail: None };
        let json = serde_json::to_value(&status).unwrap();
        assert_eq!(json, serde_json::json!({"id":"bitwarden","name":"Bitwarden","cliPath":"/usr/bin/bw","state":"signedOut"}));
        let field = PmField { label: "Password".into(), reference: "r".into(), kind: FieldKind::Otp, concealed: true };
        assert_eq!(serde_json::to_value(&field).unwrap(), serde_json::json!({"label":"Password","reference":"r","kind":"otp","concealed":true}));
    }
}
