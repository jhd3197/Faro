//! Where each CLI lives, how to read its version and how it signs in.

use crate::managed_tools::{self, Feed, Role, ToolSpec};
use anyhow::{bail, Result};
use std::path::{Path, PathBuf};

/// The CLIs Faro finds but doesn't install, in the hub's default order.
pub fn specs() -> Vec<&'static ToolSpec> {
    vec![&AWS, &GCLOUD, &AZ, &GH, &TAILSCALE, &DOCTL, &HCLOUD, &RENDER, &HS, &SHOPIFY]
}

/// Every tool the CLIs page shows: Faro's three, then [`specs`].
pub fn all_cli_ids() -> Vec<&'static str> {
    managed_tools::tools().iter().map(|s| s.id).collect()
}

/// Whether the CLI has a login Faro checks.
pub fn has_account(id: &str) -> bool {
    matches!(id, "aws" | "gcloud" | "az" | "gh" | "tailscale" | "doctl" | "hcloud" | "render" | "hs")
}

pub fn docs_url(id: &str) -> &'static str {
    match id {
        "cloudflared" => "https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/",
        "op" => "https://developer.1password.com/docs/cli/",
        "bw" => "https://bitwarden.com/help/cli/",
        "aws" => "https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html",
        "gcloud" => "https://cloud.google.com/sdk/docs/install",
        "az" => "https://learn.microsoft.com/cli/azure/install-azure-cli",
        "gh" => "https://cli.github.com/",
        "tailscale" => "https://tailscale.com/download",
        "doctl" => "https://docs.digitalocean.com/reference/doctl/how-to/install/",
        "hcloud" => "https://github.com/hetznercloud/cli",
        "render" => "https://render.com/docs/cli",
        "hs" => "https://developers.hubspot.com/docs/cms/developer-reference/local-development-cli",
        "shopify" => "https://shopify.dev/docs/api/shopify-cli",
        _ => "",
    }
}

/// The login command, as argv after the program.
pub fn sign_in_args(id: &str, account: Option<&str>) -> Option<Vec<String>> {
    let a = |v: &[&str]| Some(v.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    match id {
        "aws" => match account.filter(|p| !p.is_empty()) {
            Some(profile) => Some(vec!["sso".into(), "login".into(), "--profile".into(), profile.to_string()]),
            None => a(&["configure", "sso"]),
        },
        "gcloud" => a(&["auth", "login"]),
        "az" => a(&["login"]),
        "gh" => a(&["auth", "login", "--hostname", "github.com", "--web"]),
        "tailscale" => a(&["login"]),
        "doctl" => a(&["auth", "init"]),
        "hcloud" => a(&["context", "create", "faro"]),
        "render" => a(&["login"]),
        "hs" => a(&["init"]),
        _ => None,
    }
}

pub fn sign_in_display(id: &str, account: Option<&str>) -> Option<String> {
    let args = sign_in_args(id, account)?;
    Some(format!("{id} {}", args.join(" ")))
}

// ---- Finding them -----------------------------------------------------------------------

fn env_dir(var: &str, rest: &str) -> Option<PathBuf> {
    std::env::var_os(var).filter(|v| !v.is_empty()).map(|v| PathBuf::from(v).join(rest))
}

/// Install folders package managers use, for every CLI.
fn common_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if cfg!(windows) {
        dirs.extend(env_dir("LOCALAPPDATA", r"Microsoft\WinGet\Links"));
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join(r"scoop\shims"));
        }
        dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
        dirs.extend(env_dir("APPDATA", "npm"));
    } else {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/snap/bin"].map(PathBuf::from));
        if let Some(home) = dirs::home_dir() {
            dirs.push(home.join(".local/bin"));
            dirs.push(home.join(".npm-global/bin"));
        }
    }
    dirs
}

/// Where each CLI's own installer puts it.
fn own_dirs(id: &str) -> Vec<PathBuf> {
    let mut d = Vec::new();
    if cfg!(windows) {
        match id {
            "aws" => d.extend(env_dir("ProgramFiles", r"Amazon\AWSCLIV2")),
            "gcloud" => {
                d.extend(env_dir("LOCALAPPDATA", r"Google\Cloud SDK\google-cloud-sdk\bin"));
                d.extend(env_dir("ProgramFiles(x86)", r"Google\Cloud SDK\google-cloud-sdk\bin"));
                d.extend(env_dir("ProgramFiles", r"Google\Cloud SDK\google-cloud-sdk\bin"));
            }
            "az" => {
                d.extend(env_dir("ProgramFiles", r"Microsoft SDKs\Azure\CLI2\wbin"));
                d.extend(env_dir("ProgramFiles(x86)", r"Microsoft SDKs\Azure\CLI2\wbin"));
            }
            "gh" => d.extend(env_dir("ProgramFiles", "GitHub CLI")),
            "tailscale" => d.extend(env_dir("ProgramFiles", "Tailscale")),
            _ => {}
        }
    } else if let Some(home) = dirs::home_dir() {
        match id {
            "gcloud" => d.push(home.join("google-cloud-sdk/bin")),
            "tailscale" => d.push(PathBuf::from("/Applications/Tailscale.app/Contents/MacOS")),
            _ => {}
        }
    }
    d
}

/// File names a program can have here: `x.exe`, then `x.cmd` on Windows.
fn file_names(program: &str) -> Vec<String> {
    if cfg!(windows) {
        vec![format!("{program}.exe"), format!("{program}.cmd")]
    } else {
        vec![program.to_string()]
    }
}

/// The first of `programs` on the live PATH or in the common folders.
pub fn find_on_path(programs: &[&str]) -> Option<PathBuf> {
    let dirs: Vec<PathBuf> = crate::env_path::search_dirs().into_iter().chain(common_dirs()).collect();
    for program in programs {
        for name in file_names(program) {
            if let Some(found) = dirs.iter().map(|d| d.join(&name)).find(|c| c.is_absolute() && c.is_file()) {
                return Some(found);
            }
        }
    }
    None
}

/// The AWS Session Manager plugin `aws ssm start-session` needs.
pub fn find_ssm_plugin() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = crate::env_path::search_dirs();
    if cfg!(windows) {
        dirs.extend(env_dir("ProgramFiles", r"Amazon\SessionManagerPlugin\bin"));
    } else {
        dirs.push(PathBuf::from("/usr/local/sessionmanagerplugin/bin"));
    }
    dirs.extend(common_dirs());
    file_names("session-manager-plugin").iter().find_map(|n| dirs.iter().map(|d| d.join(n)).find(|c| c.is_file()))
}

fn find(id: &str, program: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = crate::env_path::search_dirs();
    dirs.extend(own_dirs(id));
    dirs.extend(common_dirs());
    let mut names = file_names(program);
    if id == "tailscale" && cfg!(target_os = "macos") {
        names.push("Tailscale".into());
    }
    names.iter().find_map(|n| dirs.iter().map(|d| d.join(n)).find(|c| c.is_absolute() && c.is_file()))
}

/// A user-chosen copy: an `.exe`, or a `.cmd` on Windows (it then runs with
/// plain arguments only, or as `node <entry>` when it's an npm shim).
fn check_custom(p: &Path) -> Result<()> {
    if cfg!(windows) {
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
        if !matches!(ext.as_str(), "exe" | "cmd" | "bat") {
            bail!("Choose the program itself (.exe or .cmd)");
        }
    }
    Ok(())
}

/// `aws-cli/2.15.0 Python/3.11.6 …` → `2.15.0`.
pub fn slash_version(out: &str) -> Option<String> {
    out.split_whitespace()
        .find_map(|w| w.split_once('/').map(|(_, v)| v).filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit())))
        .map(|v| v.to_string())
        .or_else(|| managed_tools::plain_version(out))
}

macro_rules! cli_spec {
    ($static:ident, $id:literal, $name:literal, $url:literal, [$($role:ident),*], [$($va:literal),*], $parse:path) => {
        pub static $static: ToolSpec = ToolSpec {
            id: $id,
            name: $name,
            program: $id,
            config_file: concat!("cli-", $id, ".json"),
            feed: Feed::DetectOnly { install_url: $url },
            roles: &[$(Role::$role),*],
            version_args: &[$($va),*],
            parse_version: $parse,
            find_installed: || find($id, $id),
            check_custom,
            on_select: |_| {},
        };
    };
}

cli_spec!(AWS, "aws", "AWS CLI", "https://aws.amazon.com/cli/", [Tunnel, SignIn, Discover], ["--version"], slash_version);
cli_spec!(GCLOUD, "gcloud", "Google Cloud CLI", "https://cloud.google.com/sdk/docs/install", [Tunnel, SignIn, Discover], ["--version"], managed_tools::plain_version);
cli_spec!(AZ, "az", "Azure CLI", "https://learn.microsoft.com/cli/azure/install-azure-cli", [SignIn, Discover], ["version", "-o", "json"], az_version);
cli_spec!(GH, "gh", "GitHub CLI", "https://cli.github.com/", [SignIn], ["--version"], managed_tools::plain_version);
cli_spec!(TAILSCALE, "tailscale", "Tailscale", "https://tailscale.com/download", [Discover], ["version"], managed_tools::plain_version);
cli_spec!(DOCTL, "doctl", "DigitalOcean CLI", "https://docs.digitalocean.com/reference/doctl/how-to/install/", [Discover], ["version"], managed_tools::plain_version);
cli_spec!(HCLOUD, "hcloud", "Hetzner Cloud CLI", "https://github.com/hetznercloud/cli/releases", [Discover], ["version"], managed_tools::plain_version);
cli_spec!(RENDER, "render", "Render CLI", "https://render.com/docs/cli", [Discover], ["--version"], managed_tools::plain_version);
cli_spec!(HS, "hs", "HubSpot CLI", "https://www.npmjs.com/package/@hubspot/cli", [Discover], ["--version"], managed_tools::plain_version);
cli_spec!(SHOPIFY, "shopify", "Shopify CLI", "https://shopify.dev/docs/api/shopify-cli", [], ["version"], managed_tools::plain_version);

/// `az version -o json`: `{"azure-cli": "2.55.0", ...}`.
pub fn az_version(out: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(out.trim())
        .ok()
        .and_then(|v| v["azure-cli"].as_str().map(str::to_string))
        .or_else(|| managed_tools::plain_version(out))
}
