//! Short-lived credentials from a CLI's own login (Plan 35 sign-in).
//!
//! Each comes from the command the CLI documents for it, only for an account
//! the person allowed on the CLIs page (or picked in the connection editor),
//! and lives in memory until shortly before it expires. It is never written
//! anywhere or logged, and errors never include it.
//!
//! The object stores get it through `object_store`'s credential providers,
//! so a transfer that outlives one token fetches the next by itself.

use super::{args, classify_failure, is_allowed, now_secs, run, CliState, CRED_TIMEOUT, SMALL_CAP};
use crate::profiles::CliAuth;
use anyhow::{anyhow, bail, ensure, Result};
use object_store::aws::AwsCredential;
use object_store::azure::AzureCredential;
use object_store::gcp::GcpCredential;
use object_store::CredentialProvider;
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};

/// Refetch this long before a credential expires.
const REFRESH_MARGIN: u64 = 120;
/// When the CLI doesn't say: gcloud tokens last an hour, `gh` tokens longer.
const DEFAULT_LIFETIME: u64 = 50 * 60;

#[derive(Clone)]
pub enum Secret {
    Aws { key_id: String, secret: String, token: Option<String> },
    Bearer(String),
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Secret::Aws { .. } => "Secret::Aws(..)",
            Secret::Bearer(_) => "Secret::Bearer(..)",
        })
    }
}

#[derive(Clone, Debug)]
pub struct ShortLived {
    pub secret: Secret,
    /// Unix seconds.
    pub expires_at: u64,
}

/// What the credential is for, which decides the command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Purpose {
    S3,
    AzureStorage,
    GcpStorage,
    GitHub,
}

type Key = (String, String, Purpose);

fn cache() -> &'static Mutex<HashMap<Key, ShortLived>> {
    static C: OnceLock<Mutex<HashMap<Key, ShortLived>>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// The account's name for consent and messages: the CLI's default is
/// `default`.
pub fn account_key(account: &str) -> &str {
    if account.trim().is_empty() {
        "default"
    } else {
        account.trim()
    }
}

/// Drop cached credentials for an account (consent revoked).
pub fn forget(tool: &str, account: &str) {
    if let Ok(mut c) = cache().lock() {
        c.retain(|(t, a, _), _| !(t == tool && a == account_key(account)));
    }
}

pub fn purpose_for(tool: &str, protocol: &str) -> Result<Purpose> {
    Ok(match (tool, protocol) {
        ("aws", "s3") => Purpose::S3,
        ("az", "azure") => Purpose::AzureStorage,
        ("gcloud", "gcs") => Purpose::GcpStorage,
        ("gh", _) => Purpose::GitHub,
        (t, p) => bail!("{} can't sign in to a {p} connection", super::display_name(t)),
    })
}

fn signin_hint(tool: &str, account: &str) -> String {
    super::specs::sign_in_display(tool, Some(account).filter(|a| *a != "default")).map(|c| format!(" (runs `{c}`)")).unwrap_or_default()
}

/// A credential for `auth`, from the cache or the CLI.
pub async fn get(data_dir: &Path, auth: &CliAuth, purpose: Purpose) -> Result<ShortLived> {
    let tool = auth.tool.as_str();
    let account = account_key(&auth.account).to_string();
    let name = super::display_name(tool);
    ensure!(account == "default" || super::plain_arg(&account), "That {name} account name can't be passed safely");
    ensure!(
        is_allowed(data_dir, tool, &account),
        "Faro isn't allowed to use your {name} login for {account} yet. Allow it on the CLIs page (or pick it again in the connection editor), then connect again."
    );
    let key: Key = (tool.to_string(), account.clone(), purpose);
    if let Some(hit) = cache().lock().ok().and_then(|c| c.get(&key).cloned()) {
        if hit.expires_at > now_secs() + REFRESH_MARGIN {
            return Ok(hit);
        }
    }
    let fresh = fetch(tool, &account, purpose).await?;
    if let Ok(mut c) = cache().lock() {
        c.insert(key, fresh.clone());
    }
    Ok(fresh)
}

fn with_account(mut v: Vec<String>, flag: &str, account: &str) -> Vec<String> {
    if account != "default" {
        if flag.ends_with('=') {
            v.push(format!("{flag}{account}"));
        } else {
            v.push(flag.to_string());
            v.push(account.to_string());
        }
    }
    v
}

async fn fetch(tool: &str, account: &str, purpose: Purpose) -> Result<ShortLived> {
    let argv = match purpose {
        Purpose::S3 => with_account(args(&["configure", "export-credentials", "--format", "process"]), "--profile", account),
        Purpose::AzureStorage => with_account(args(&["account", "get-access-token", "--resource", "https://storage.azure.com/", "-o", "json"]), "--subscription", account),
        Purpose::GcpStorage => with_account(args(&["auth", "print-access-token"]), "--account=", account),
        Purpose::GitHub => args(&["auth", "token", "--hostname", "github.com"]),
    };
    let ran = run(tool, &argv, CRED_TIMEOUT, SMALL_CAP).await?;
    let name = super::display_name(tool);
    if !ran.ok {
        let hint = signin_hint(tool, account);
        bail!(match classify_failure(&ran.both()) {
            CliState::Expired => format!("Your {name} login for {account} expired. Sign in on the CLIs page{hint}, then connect again."),
            CliState::SignedOut => format!("Nobody is signed in to {name} for {account}. Sign in on the CLIs page{hint}, then connect again."),
            _ => format!("{name} couldn't give Faro a credential for {account}. Check that it works in a terminal, then connect again."),
        });
    }
    parse(purpose, &ran.stdout, now_secs()).ok_or_else(|| anyhow!("{name} answered in a way Faro doesn't understand; update it and try again"))
}

/// Read a credential command's output.
pub fn parse(purpose: Purpose, out: &str, now: u64) -> Option<ShortLived> {
    let out = out.trim();
    match purpose {
        Purpose::S3 => {
            let v: Value = serde_json::from_str(out).ok()?;
            let key_id = v["AccessKeyId"].as_str().filter(|s| !s.is_empty())?.to_string();
            let secret = v["SecretAccessKey"].as_str().filter(|s| !s.is_empty())?.to_string();
            let token = v["SessionToken"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
            let expires_at = v["Expiration"].as_str().and_then(rfc3339).unwrap_or(now + DEFAULT_LIFETIME);
            Some(ShortLived { secret: Secret::Aws { key_id, secret, token }, expires_at })
        }
        Purpose::AzureStorage => {
            let v: Value = serde_json::from_str(out).ok()?;
            let token = v["accessToken"].as_str().filter(|s| !s.is_empty())?.to_string();
            let expires_at = v["expires_on"]
                .as_u64()
                .or_else(|| v["expires_on"].as_str().and_then(|s| s.parse().ok()))
                .unwrap_or(now + DEFAULT_LIFETIME);
            Some(ShortLived { secret: Secret::Bearer(token), expires_at })
        }
        Purpose::GcpStorage | Purpose::GitHub => {
            let token = out.lines().next()?.trim();
            (!token.is_empty() && !token.contains(char::is_whitespace))
                .then(|| ShortLived { secret: Secret::Bearer(token.to_string()), expires_at: now + DEFAULT_LIFETIME })
        }
    }
}

fn rfc3339(s: &str) -> Option<u64> {
    chrono::DateTime::parse_from_rfc3339(s).ok().and_then(|d| u64::try_from(d.timestamp()).ok())
}

/// Fetch and drop a credential for the editor's Test button.
pub async fn test(data_dir: &Path, auth: &CliAuth) -> Result<String> {
    let purpose = match auth.tool.as_str() {
        "aws" => Purpose::S3,
        "az" => Purpose::AzureStorage,
        "gcloud" => Purpose::GcpStorage,
        other => bail!("{} can't sign in to connections", super::display_name(other)),
    };
    let got = get(data_dir, auth, purpose).await?;
    let mins = got.expires_at.saturating_sub(now_secs()) / 60;
    Ok(format!("Signed in. This credential lasts about {mins} more minutes; Faro fetches a new one by itself."))
}

// ---- object_store providers -------------------------------------------------------------

fn store_err(store: &'static str, e: anyhow::Error) -> object_store::Error {
    object_store::Error::Generic { store, source: format!("{e:#}").into() }
}

#[derive(Debug)]
pub struct AwsCli {
    pub auth: CliAuth,
    pub data_dir: std::path::PathBuf,
}

#[async_trait::async_trait]
impl CredentialProvider for AwsCli {
    type Credential = AwsCredential;
    async fn get_credential(&self) -> object_store::Result<Arc<AwsCredential>> {
        match get(&self.data_dir, &self.auth, Purpose::S3).await.map_err(|e| store_err("S3", e))?.secret {
            Secret::Aws { key_id, secret, token } => Ok(Arc::new(AwsCredential { key_id, secret_key: secret, token })),
            Secret::Bearer(_) => Err(store_err("S3", anyhow!("unexpected credential"))),
        }
    }
}

#[derive(Debug)]
pub struct AzureCli {
    pub auth: CliAuth,
    pub data_dir: std::path::PathBuf,
}

#[async_trait::async_trait]
impl CredentialProvider for AzureCli {
    type Credential = AzureCredential;
    async fn get_credential(&self) -> object_store::Result<Arc<AzureCredential>> {
        match get(&self.data_dir, &self.auth, Purpose::AzureStorage).await.map_err(|e| store_err("MicrosoftAzure", e))?.secret {
            Secret::Bearer(t) => Ok(Arc::new(AzureCredential::BearerToken(t))),
            Secret::Aws { .. } => Err(store_err("MicrosoftAzure", anyhow!("unexpected credential"))),
        }
    }
}

#[derive(Debug)]
pub struct GcpCli {
    pub auth: CliAuth,
    pub data_dir: std::path::PathBuf,
}

#[async_trait::async_trait]
impl CredentialProvider for GcpCli {
    type Credential = GcpCredential;
    async fn get_credential(&self) -> object_store::Result<Arc<GcpCredential>> {
        match get(&self.data_dir, &self.auth, Purpose::GcpStorage).await.map_err(|e| store_err("GCS", e))?.secret {
            Secret::Bearer(bearer) => Ok(Arc::new(GcpCredential { bearer })),
            Secret::Aws { .. } => Err(store_err("GCS", anyhow!("unexpected credential"))),
        }
    }
}

/// A GitHub token from `gh` for Faro's own GitHub API calls (release checks),
/// only when the person allowed it. `None` otherwise or on any failure.
pub async fn github_token() -> Option<String> {
    let dir = super::data_dir().ok()?;
    let account = super::read_config(&dir).allowed.get("gh")?.iter().next()?.clone();
    match get(&dir, &CliAuth { tool: "gh".into(), account }, Purpose::GitHub).await.ok()?.secret {
        Secret::Bearer(t) => Some(t),
        Secret::Aws { .. } => None,
    }
}
