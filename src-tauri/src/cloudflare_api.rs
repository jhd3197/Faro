//! A connected Cloudflare account (issue #57): the Cloudflare API v4 client,
//! and the account Faro is connected to.
//!
//! The user pastes a scoped API token once (Settings > Cloudflare). It lives
//! in the keychain; `cloudflare.json` in the app data dir keeps the account's
//! id and name and the account-wide Access service token's client id (its
//! secret is in the keychain too). With it Faro lists the account's SSH
//! hostnames and tunnel health, keeps one service token for unattended runs
//! (faro-cli), invites teammates and moves servers behind Cloudflare.
//! Without it everything still works by hand.
//!
//! `FARO_CF_API` points the client at another base URL (the tests' fake).

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const API_BASE: &str = "https://api.cloudflare.com/client/v4";
/// Keychain purposes (in `credentials::SERVICE`), per account so two data
/// dirs (or a test) can't overwrite each other's token.
pub fn token_purpose(account: &str) -> String {
    format!("cloudflare-api-token:{account}")
}
pub fn service_secret_purpose(account: &str) -> String {
    format!("cloudflare-service-token-secret:{account}")
}
const CONFIG_FILE: &str = "cloudflare.json";

/// The token permissions Faro needs, for the "create a token" help text.
pub const TOKEN_PERMISSIONS: &[&str] = &[
    "Account · Access: Apps and Policies · Edit",
    "Account · Access: Service Tokens · Edit",
    "Account · Access: Organizations, Identity Providers, and Groups · Edit",
    "Account · Cloudflare Tunnel · Edit",
    "Zone · DNS · Edit",
    "Zone · Zone · Read",
];

// ---- API client ----

pub struct Api {
    base: String,
    token: String,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Account {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Zone {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccessApp {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default, rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub aud: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tunnel {
    pub id: String,
    #[serde(default)]
    pub name: String,
    /// `inactive`, `healthy`, `degraded` or `down`.
    #[serde(default)]
    pub status: String,
    /// Live connectors. The list endpoint sometimes omits them; `ssh_hostnames`
    /// fetches the tunnel when they're missing.
    #[serde(default, deserialize_with = "null_default")]
    pub connections: Vec<TunnelConnection>,
    /// When a connector was last active, if Cloudflare sent it.
    #[serde(default)]
    pub conns_active_at: Option<String>,
    #[serde(default)]
    pub conns_inactive_at: Option<String>,
}

/// One cloudflared connector on a tunnel. `client_version` is the cloudflared
/// running on the server; `opened_at` is when this connector came up.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TunnelConnection {
    #[serde(default)]
    pub colo_name: String,
    #[serde(default)]
    pub opened_at: Option<String>,
    #[serde(default)]
    pub client_version: Option<String>,
    #[serde(default)]
    pub is_pending_reconnect: bool,
}

fn null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

/// `(last seen, cloudflared version)` for the newest connector. Last seen
/// falls back to the tunnel's active/inactive timestamps when no connector
/// row carries `opened_at`.
pub fn connector_info(tunnel: &Tunnel) -> (Option<String>, Option<String>) {
    let mut best: Option<&TunnelConnection> = None;
    for conn in &tunnel.connections {
        let newer = match (conn.opened_at.as_deref(), best.and_then(|c| c.opened_at.as_deref())) {
            (Some(opened), Some(prev)) => opened > prev,
            (Some(_), None) => true,
            (None, None) => best.is_none(),
            (None, Some(_)) => false,
        };
        if newer {
            best = Some(conn);
        }
    }
    let version = best.and_then(|c| c.client_version.clone()).filter(|s| !s.is_empty());
    let last_seen = best
        .and_then(|c| c.opened_at.clone())
        .filter(|s| !s.is_empty())
        .or_else(|| tunnel.conns_active_at.clone().filter(|s| !s.is_empty()))
        .or_else(|| tunnel.conns_inactive_at.clone().filter(|s| !s.is_empty()));
    (last_seen, version)
}

/// Tunnel status together with connector last-seen and the cloudflared
/// version on the server. The wizard polls this; the hostname list carries
/// the same fields.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TunnelHealth {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector_last_seen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector_version: Option<String>,
}

impl TunnelHealth {
    pub fn from_tunnel(tunnel: &Tunnel) -> Self {
        let (connector_last_seen, connector_version) = connector_info(tunnel);
        Self { status: tunnel.status.clone(), connector_last_seen, connector_version }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Ingress {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    pub service: String,
}

impl Api {
    pub fn new(token: impl Into<String>) -> Self {
        let base = std::env::var("FARO_CF_API").ok().filter(|b| !b.is_empty()).unwrap_or_else(|| API_BASE.into());
        Self::with_base(base, token)
    }

    pub fn with_base(base: impl Into<String>, token: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default();
        Self { base: base.into().trim_end_matches('/').to_string(), token: token.into(), http }
    }

    /// One API call, unwrapping Cloudflare's `{success, errors, result}`.
    pub async fn call<T: DeserializeOwned>(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<T> {
        let url = format!("{}/{}", self.base, path.trim_start_matches('/'));
        let mut req = self.http.request(method.clone(), &url).bearer_auth(&self.token);
        if let Some(body) = body {
            req = req.json(&body);
        }
        let resp = req.send().await.with_context(|| format!("reaching the Cloudflare API ({method} {path})"))?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let v: Value = serde_json::from_str(&text)
            .map_err(|_| anyhow!("the Cloudflare API answered {status} with something that isn't JSON"))?;
        if !v["success"].as_bool().unwrap_or(false) {
            let errors: Vec<String> = v["errors"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .map(|e| format!("{} (code {})", e["message"].as_str().unwrap_or("?"), e["code"]))
                        .collect()
                })
                .unwrap_or_default();
            if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::UNAUTHORIZED {
                bail!(
                    "Cloudflare refused the API token for {method} {path}: {}. Check that it has the permissions Faro lists.",
                    errors.join("; ")
                );
            }
            bail!("Cloudflare API {method} {path} failed: {}", if errors.is_empty() { status.to_string() } else { errors.join("; ") });
        }
        serde_json::from_value(v["result"].clone()).with_context(|| format!("reading Cloudflare's answer to {path}"))
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.call(reqwest::Method::GET, path, None).await
    }
    pub async fn post<T: DeserializeOwned>(&self, path: &str, body: Value) -> Result<T> {
        self.call(reqwest::Method::POST, path, Some(body)).await
    }
    pub async fn put<T: DeserializeOwned>(&self, path: &str, body: Value) -> Result<T> {
        self.call(reqwest::Method::PUT, path, Some(body)).await
    }
    pub async fn delete(&self, path: &str) -> Result<()> {
        self.call::<Value>(reqwest::Method::DELETE, path, None).await.map(|_| ())
    }

    pub async fn verify(&self) -> Result<()> {
        let v: Value = self.get("user/tokens/verify").await?;
        match v["status"].as_str() {
            Some("active") | None => Ok(()),
            Some(other) => bail!("this API token is {other}"),
        }
    }

    pub async fn accounts(&self) -> Result<Vec<Account>> {
        self.get("accounts?per_page=50").await
    }

    pub async fn zones(&self, account: &str) -> Result<Vec<Zone>> {
        self.get(&format!("zones?account.id={account}&per_page=50")).await
    }

    pub async fn access_apps(&self, account: &str) -> Result<Vec<AccessApp>> {
        self.get(&format!("accounts/{account}/access/apps")).await
    }

    pub async fn tunnels(&self, account: &str) -> Result<Vec<Tunnel>> {
        self.get(&format!("accounts/{account}/cfd_tunnel?is_deleted=false")).await
    }

    pub async fn tunnel(&self, account: &str, id: &str) -> Result<Tunnel> {
        self.get(&format!("accounts/{account}/cfd_tunnel/{id}")).await
    }

    /// A remotely managed tunnel's ingress rules (empty when it has none).
    pub async fn tunnel_ingress(&self, account: &str, id: &str) -> Result<Vec<Ingress>> {
        let v: Value = match self.get(&format!("accounts/{account}/cfd_tunnel/{id}/configurations")).await {
            Ok(v) => v,
            Err(_) => return Ok(Vec::new()),
        };
        Ok(serde_json::from_value(v["config"]["ingress"].clone()).unwrap_or_default())
    }
}

// ---- Access policies: who gets in ----

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Policy {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub decision: String,
    #[serde(default)]
    pub include: Vec<Value>,
    #[serde(default)]
    pub exclude: Vec<Value>,
    #[serde(default)]
    pub require: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub precedence: Option<i64>,
}

/// Name of the allow policy Faro creates for people.
pub const PEOPLE_POLICY: &str = "Faro: people";

impl Api {
    /// The Access application protecting `hostname`.
    pub async fn app_for_hostname(&self, account: &str, hostname: &str) -> Result<AccessApp> {
        let host = hostname.trim().to_ascii_lowercase();
        self.access_apps(account)
            .await?
            .into_iter()
            .find(|a| a.domain.split('/').next().unwrap_or("").eq_ignore_ascii_case(&host))
            .ok_or_else(|| anyhow!("{hostname} has no Access application in this Cloudflare account"))
    }

    pub async fn policies(&self, account: &str, app: &str) -> Result<Vec<Policy>> {
        self.get(&format!("accounts/{account}/access/apps/{app}/policies")).await
    }
}

fn include_email(rule: &Value) -> Option<String> {
    rule["email"]["email"].as_str().map(|e| e.to_ascii_lowercase())
}

/// Who an application lets in: emails, and `@domain` for an email domain.
pub async fn people(api: &Api, account: &str, app: &str) -> Result<Vec<String>> {
    let mut out = Vec::new();
    for p in api.policies(account, app).await?.into_iter().filter(|p| p.decision == "allow") {
        for rule in &p.include {
            if let Some(e) = include_email(rule) {
                out.push(e);
            } else if let Some(d) = rule["email_domain"]["domain"].as_str() {
                out.push(format!("@{d}"));
            }
        }
    }
    out.sort();
    out.dedup();
    Ok(out)
}

/// Add `email` to (or remove it from) the application's allow policies.
/// Adding goes into the first allow policy, or a new "Faro: people" one.
/// Returns whether anything changed.
pub async fn set_person(api: &Api, account: &str, app: &str, email: &str, allow: bool) -> Result<bool> {
    let email = email.trim().to_ascii_lowercase();
    let policies = api.policies(account, app).await?;
    let path = |id: &str| format!("accounts/{account}/access/apps/{app}/policies/{id}");
    let mut changed = false;
    if allow {
        let allows: Vec<&Policy> = policies.iter().filter(|p| p.decision == "allow").collect();
        if allows.iter().any(|p| p.include.iter().any(|r| include_email(r).as_deref() == Some(email.as_str()))) {
            return Ok(false);
        }
        let rule = json!({ "email": { "email": email } });
        match allows.first() {
            Some(p) => {
                let mut p = (*p).clone();
                p.include.push(rule);
                api.put::<Value>(&path(&p.id), serde_json::to_value(&p)?).await?;
            }
            None => {
                api.post::<Value>(
                    &format!("accounts/{account}/access/apps/{app}/policies"),
                    json!({ "name": PEOPLE_POLICY, "decision": "allow", "include": [rule] }),
                )
                .await?;
            }
        }
        changed = true;
    } else {
        for p in policies.into_iter().filter(|p| p.decision == "allow") {
            let before = p.include.len();
            let mut p = p;
            p.include.retain(|r| include_email(r).as_deref() != Some(email.as_str()));
            if p.include.len() == before {
                continue;
            }
            changed = true;
            if p.include.is_empty() {
                // An allow policy with nobody in it would be rejected.
                api.delete(&path(&p.id)).await?;
            } else {
                api.put::<Value>(&path(&p.id), serde_json::to_value(&p)?).await?;
            }
        }
    }
    Ok(changed)
}

// ---- The connected account ----

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account_name: Option<String>,
    /// The account-wide Access service token: its Cloudflare id and client id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_token_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_token_client_id: Option<String>,
}

pub fn config_path(dir: &Path) -> PathBuf {
    dir.join(CONFIG_FILE)
}

pub fn read_config(dir: &Path) -> Config {
    std::fs::read(config_path(dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn write_config(dir: &Path, cfg: &Config) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(cfg)?;
    crate::fsutil::write_atomic(&config_path(dir), &bytes).context("saving cloudflare.json")
}

/// The API for the connected account, or why there isn't one.
pub fn connected(dir: &Path) -> Result<(Api, String)> {
    let cfg = read_config(dir);
    let account = cfg.account_id.ok_or_else(|| anyhow!("no Cloudflare account is connected; connect one in Settings › Cloudflare"))?;
    let token = crate::credentials::get_secret(&token_purpose(&account))?
        .ok_or_else(|| anyhow!("the Cloudflare API token is missing from the keychain; connect the account again"))?;
    Ok((Api::new(token), account))
}

/// The account-wide service token (client id, secret), for unattended runs.
pub fn service_token(dir: &Path) -> Option<(String, String)> {
    let cfg = read_config(dir);
    let id = cfg.service_token_client_id?;
    let secret = crate::credentials::get_secret(&service_secret_purpose(cfg.account_id.as_deref()?)).ok().flatten()?;
    Some((id, secret))
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatus {
    pub connected: bool,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub service_token_client_id: Option<String>,
    /// Several accounts behind the token, and none chosen yet.
    pub choices: Vec<Account>,
    pub permissions: Vec<String>,
}

pub fn status(dir: &Path) -> AccountStatus {
    let cfg = read_config(dir);
    AccountStatus {
        connected: cfg.account_id.is_some(),
        account_id: cfg.account_id,
        account_name: cfg.account_name,
        service_token_client_id: cfg.service_token_client_id,
        choices: Vec::new(),
        permissions: TOKEN_PERMISSIONS.iter().map(|s| s.to_string()).collect(),
    }
}

/// Check `token`, pick the account (`account_id`, or the only one), and
/// store both. With several accounts and none named, nothing is stored and
/// the choices come back.
pub async fn connect(api: &Api, token: &str, account_id: Option<&str>, dir: &Path, db: &crate::db::Db) -> Result<AccountStatus> {
    api.verify().await?;
    let accounts = api.accounts().await?;
    let account = match account_id {
        Some(id) => accounts.iter().find(|a| a.id == id).cloned().ok_or_else(|| anyhow!("this token can't see account {id}"))?,
        None => match accounts.as_slice() {
            [] => bail!("this API token can't see any Cloudflare account; give it account permissions"),
            [one] => one.clone(),
            _ => return Ok(AccountStatus { choices: accounts, ..status(dir) }),
        },
    };
    crate::credentials::set_secret(&token_purpose(&account.id), token)?;
    db.record_keychain(crate::credentials::SERVICE, &token_purpose(&account.id))?;
    let mut cfg = read_config(dir);
    if let Some(old) = cfg.account_id.clone().filter(|old| *old != account.id) {
        // Another account: its token and service token go.
        forget_account(&old, db)?;
        cfg.service_token_id = None;
        cfg.service_token_client_id = None;
    }
    cfg.account_id = Some(account.id);
    cfg.account_name = Some(account.name);
    write_config(dir, &cfg)?;
    Ok(status(dir))
}

fn forget_account(account: &str, db: &crate::db::Db) -> Result<()> {
    for purpose in [token_purpose(account), service_secret_purpose(account)] {
        crate::credentials::delete_secret(&purpose);
        db.forget_keychain(crate::credentials::SERVICE, &purpose)?;
    }
    Ok(())
}

pub fn disconnect(dir: &Path, db: &crate::db::Db) -> Result<()> {
    if let Some(account) = read_config(dir).account_id {
        forget_account(&account, db)?;
    }
    let _ = std::fs::remove_file(config_path(dir));
    Ok(())
}

/// Create the account-wide service token (replacing Faro's previous one).
pub async fn create_service_token(api: &Api, account: &str, dir: &Path, db: &crate::db::Db) -> Result<AccountStatus> {
    let mut cfg = read_config(dir);
    if let Some(old) = cfg.service_token_id.take() {
        let _ = api.delete(&format!("accounts/{account}/access/service_tokens/{old}")).await;
    }
    let v: Value = api
        .post(&format!("accounts/{account}/access/service_tokens"), json!({ "name": "Faro (faro-cli and Agent Bridge)" }))
        .await?;
    let (Some(id), Some(client_id), Some(secret)) = (v["id"].as_str(), v["client_id"].as_str(), v["client_secret"].as_str()) else {
        bail!("Cloudflare didn't return the new service token");
    };
    crate::credentials::set_secret(&service_secret_purpose(account), secret)?;
    db.record_keychain(crate::credentials::SERVICE, &service_secret_purpose(account))?;
    cfg.service_token_id = Some(id.into());
    cfg.service_token_client_id = Some(client_id.into());
    write_config(dir, &cfg)?;
    Ok(status(dir))
}

pub async fn delete_service_token(api: &Api, account: &str, dir: &Path, db: &crate::db::Db) -> Result<AccountStatus> {
    let mut cfg = read_config(dir);
    if let Some(id) = cfg.service_token_id.take() {
        api.delete(&format!("accounts/{account}/access/service_tokens/{id}")).await?;
    }
    cfg.service_token_client_id = None;
    crate::credentials::delete_secret(&service_secret_purpose(account));
    db.forget_keychain(crate::credentials::SERVICE, &service_secret_purpose(account))?;
    write_config(dir, &cfg)?;
    Ok(status(dir))
}

/// An SSH hostname in the account: from a tunnel's `ssh://` ingress rule
/// and/or an Access application, with the tunnel's health.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SshHostname {
    pub hostname: String,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tunnel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tunnel_status: Option<String>,
    /// When the tunnel's connector was last seen (`opened_at`, else the
    /// tunnel's active/inactive timestamp).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector_last_seen: Option<String>,
    /// cloudflared version running on the server (the connector's `client_version`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
}

pub async fn ssh_hostnames(api: &Api, account: &str) -> Result<Vec<SshHostname>> {
    let mut out: Vec<SshHostname> = Vec::new();
    for listed in api.tunnels(account).await? {
        // The list call often includes connectors. When it doesn't, one
        // tunnel fetch supplies last-seen and the server's cloudflared version.
        let (seen, version) = connector_info(&listed);
        let t = if seen.is_none() && version.is_none() && listed.status != "inactive" {
            api.tunnel(account, &listed.id).await.unwrap_or(listed)
        } else {
            listed
        };
        let (last_seen, cloudflared_version) = connector_info(&t);
        for rule in api.tunnel_ingress(account, &t.id).await? {
            let Some(host) = rule.hostname.filter(|_| rule.service.starts_with("ssh://")) else { continue };
            out.push(SshHostname {
                label: format!("tunnel {}", t.name),
                hostname: host,
                tunnel_id: Some(t.id.clone()),
                tunnel_status: Some(t.status.clone()),
                connector_last_seen: last_seen.clone(),
                connector_version: cloudflared_version.clone(),
                app_id: None,
            });
        }
    }
    for app in api.access_apps(account).await? {
        let host = app.domain.split('/').next().unwrap_or("").to_string();
        if host.is_empty() || !matches!(app.kind.as_str(), "ssh" | "self_hosted") {
            continue;
        }
        match out.iter_mut().find(|h| h.hostname.eq_ignore_ascii_case(&host)) {
            Some(h) => h.app_id = Some(app.id.clone()),
            // An Access app with no tunnel rule here (a tunnel in another
            // account, or a public SSH port behind Access).
            None if app.kind == "ssh" => out.push(SshHostname {
                label: format!("Access app {}", app.name),
                hostname: host,
                tunnel_id: None,
                tunnel_status: None,
                connector_last_seen: None,
                connector_version: None,
                app_id: Some(app.id.clone()),
            }),
            None => {}
        }
    }
    out.sort_by(|a, b| a.hostname.cmp(&b.hostname));
    out.dedup_by(|a, b| a.hostname == b.hostname);
    Ok(out)
}

// ---- Commands ----

use crate::AppState;
use tauri::{AppHandle, Manager, State};

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

#[tauri::command]
pub fn cf_account_status(app: AppHandle) -> Result<AccountStatus, String> {
    Ok(status(&data_dir(&app)?))
}

#[tauri::command]
pub async fn cf_account_connect(
    token: String,
    account_id: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<AccountStatus, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("Paste a Cloudflare API token first.".into());
    }
    connect(&Api::new(token.clone()), &token, account_id.as_deref(), &data_dir(&app)?, &state.db).await.map_err(err)
}

#[tauri::command]
pub fn cf_account_disconnect(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    disconnect(&data_dir(&app)?, &state.db).map_err(err)
}

#[tauri::command]
pub async fn cf_account_hostnames(app: AppHandle) -> Result<Vec<SshHostname>, String> {
    let dir = data_dir(&app)?;
    if read_config(&dir).account_id.is_none() {
        return Ok(Vec::new());
    }
    let (api, account) = connected(&dir).map_err(err)?;
    ssh_hostnames(&api, &account).await.map_err(err)
}

#[tauri::command]
pub async fn cf_account_zones(app: AppHandle) -> Result<Vec<Zone>, String> {
    let (api, account) = connected(&data_dir(&app)?).map_err(err)?;
    api.zones(&account).await.map_err(err)
}

#[tauri::command]
pub async fn cf_account_create_service_token(app: AppHandle, state: State<'_, AppState>) -> Result<AccountStatus, String> {
    let dir = data_dir(&app)?;
    let (api, account) = connected(&dir).map_err(err)?;
    create_service_token(&api, &account, &dir, &state.db).await.map_err(err)
}

#[tauri::command]
pub async fn cf_account_delete_service_token(app: AppHandle, state: State<'_, AppState>) -> Result<AccountStatus, String> {
    let dir = data_dir(&app)?;
    let (api, account) = connected(&dir).map_err(err)?;
    delete_service_token(&api, &account, &dir, &state.db).await.map_err(err)
}

#[cfg(test)]
#[path = "cloudflare_api_tests.rs"]
pub(crate) mod tests;
