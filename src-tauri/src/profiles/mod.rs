use crate::credentials;
use crate::db::Db;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};
use tokio::sync::Mutex;

/// faro.db setting (JSON `"true"`/`"false"`) that keeps saved profile passwords
/// in the OS keychain instead of `profiles.json`.
pub const KEYCHAIN_SETTING: &str = "storePasswordsInKeychain";

/// Whether saved secrets live in the keychain. An explicit setting wins. With
/// no setting yet, a fresh install (no `profiles.json` in `dir`) starts in the
/// keychain if one actually works here; an existing install keeps its
/// plain-text file. The resolved value is written back so the UI and the
/// backend always read the same answer.
pub fn resolve_keychain_setting(db: &Db, dir: &std::path::Path) -> bool {
    resolve_keychain_setting_with(db, dir, credentials::keychain_works)
}

fn resolve_keychain_setting_with(
    db: &Db,
    dir: &std::path::Path,
    keychain_works: impl FnOnce() -> bool,
) -> bool {
    if let Some(v) = db.settings_get(KEYCHAIN_SETTING).ok().flatten() {
        return v == "true";
    }
    // A machine with no usable keychain (headless Linux without Secret
    // Service) would fail every profile save, so it keeps the file.
    let on = !dir.join("profiles.json").exists() && keychain_works();
    let _ = db.settings_set(KEYCHAIN_SETTING, if on { "true" } else { "false" });
    on
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum AuthMethod {
    Password {
        #[serde(default, skip_serializing_if = "String::is_empty")]
        password: String,
    },
    Key {
        path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        passphrase: Option<String>,
    },
    Agent,
    /// A reference to private-key material stored in the OS keychain (under
    /// `key_ref`, e.g. `grant-key:<profile-id>`), never on disk. The connect
    /// path resolves it via `credentials::get_secret` at connect time.
    #[serde(rename_all = "camelCase")]
    KeyRef { key_ref: String },
}

/// Client-side proxy a connection's first TCP hop goes through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyKind {
    Socks5,
    Http,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    pub kind: ProxyKind,
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    // Kept in the keychain (and blanked from profiles.json) in keychain mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub password: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProxyCommandKind {
    /// An OpenSSH-style `ProxyCommand` line.
    Command,
    /// `cloudflared access ssh`, built from the Access hostname.
    Cloudflare,
}

/// SSH over a local process's stdin/stdout (OpenSSH `ProxyCommand`), for
/// Cloudflare Access, AWS SSM, Google IAP and the like. See `proxy_command.rs`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyCommandConfig {
    pub kind: ProxyCommandKind,
    /// The command line, with `%h %p %r` expanded (`kind = command`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub command: String,
    /// Access hostname (`kind = cloudflare`). Absent = the profile's host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    /// Access service token, for logins with no browser (CLI, Agent Bridge).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_token_id: Option<String>,
    // Kept in the keychain (and blanked from profiles.json) in keychain mode.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub service_token_secret: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub protocol: String, // "sftp" | "ftp" | "ftps" | "s3"
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: AuthMethod,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_remote_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    // Connect automatically on app launch. Optional so existing profile JSON
    // files (written before this field existed) keep loading as `None`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_connect: Option<bool>,
    // Object-store-specific fields. Unused for sftp/ftp protocols. We keep
    // them optional so existing profile JSON files keep loading.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bucket: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    // Azure Blob specific. `account` is the Azure storage account name,
    // and `bucket` doubles as the container. For S3, both stay absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    // Faro Agent (protocol "faro-agent") specific: the daemon's pinned static
    // public key (base64), learned at pairing time. Its presence means this
    // profile is paired; absence means the user still needs to pair with a code.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_key: Option<String>,
    // Rail organisation. `group` is a free-form folder name (absent = ungrouped);
    // `sort_order` is the manual drag-and-drop position. Profiles without one
    // sort after ordered ones, by protocol/name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_order: Option<u32>,
    // Custom bubble glyph for the rail: an emoji (any short string without a
    // colon) or a bundled Iconify key ("prefix:name"). Absent = the name
    // monogram. Optional so existing profile JSON files keep loading.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    // Single-hop bastion (ProxyJump). When `jump_host` is set, the SSH connect
    // path first connects there with the SAME auth material, then tunnels to
    // `host:port` over a direct-tcpip channel. `jump_port` defaults to 22,
    // `jump_username` defaults to `username`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_host: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_port: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_username: Option<String>,
    // FTP/FTPS character set for path names: absent or "auto" negotiates
    // UTF-8 and falls back to Windows-1252; otherwise a WHATWG label
    // ("utf-8", "windows-1252", "shift_jis", "gbk", ...).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ftp_encoding: Option<String>,
    // FTP/FTPS data connections in active (PORT) mode instead of passive.
    // Absent = passive, which works through client-side NAT.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ftp_active_mode: Option<bool>,
    // FTP/FTPS: logged-in connections kept for transfers, separate from the
    // browsing connection (Plan 24). Absent = 2. Lowered automatically when
    // the server refuses more logins.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ftp_max_connections: Option<u8>,
    // FTP/FTPS: parallel connections one download may split across. Absent
    // = 1, since many servers cap logins per user.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ftp_segments: Option<u8>,
    // SOCKS5 / HTTP CONNECT proxy for backends that dial TCP. Absent = direct.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxyConfig>,
    // SSH only: run this command and speak SSH over its stdin/stdout instead
    // of dialing TCP. Exclusive with `proxy`. Absent = dial directly.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_command: Option<ProxyCommandConfig>,
    // Id of another SSH profile to connect through (ProxyJump), with that
    // profile's own auth, proxy and jump host. Distinct from the inline
    // `jump_host` above, which access grants use.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_profile: Option<String>,
    // `jump_profile` resolved against the store when the profile is read.
    #[serde(skip)]
    pub jump_via: Option<JumpVia>,
    // Cloud drives (Dropbox/OneDrive/Google Drive/Box): the client id of the
    // user's own registered OAuth app. Absent = the app built into Faro, if
    // the release has one. Its optional client secret lives in the keychain.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub oauth_client_id: Option<String>,
}

/// Longest bastion chain a profile may connect through.
pub const MAX_JUMP_HOPS: usize = 8;

/// A profile's resolved jump host: the bastion profile (itself resolved), or
/// why the chain can't be built. Connecting fails on `Broken` rather than
/// silently going direct.
#[derive(Debug, Clone)]
pub enum JumpVia {
    Profile(Box<ConnectionProfile>),
    Broken(String),
}

/// Resolve `profile.jump_profile` (recursively) against `all`.
fn resolve_jump(all: &[ConnectionProfile], mut profile: ConnectionProfile) -> ConnectionProfile {
    profile.jump_via = jump_chain(all, &profile, &mut vec![profile.id.clone()]);
    profile
}

fn jump_chain(
    all: &[ConnectionProfile],
    profile: &ConnectionProfile,
    seen: &mut Vec<String>,
) -> Option<JumpVia> {
    let id = profile.jump_profile.as_deref().filter(|id| !id.is_empty())?;
    let broken = |msg: String| Some(JumpVia::Broken(msg));
    if seen.iter().any(|s| s == id) {
        return broken(format!("the jump host chain of '{}' loops back on itself", profile.name));
    }
    if seen.len() > MAX_JUMP_HOPS {
        return broken(format!("the jump host chain is longer than {MAX_JUMP_HOPS} hops"));
    }
    let Some(bastion) = all.iter().find(|p| p.id == id) else {
        return broken(format!(
            "the jump host of '{}' was deleted; pick another in the connection editor",
            profile.name
        ));
    };
    if !matches!(bastion.protocol.as_str(), "sftp" | "ssh" | "") {
        return broken(format!("jump host '{}' is not an SSH connection", bastion.name));
    }
    seen.push(id.to_string());
    let mut bastion = bastion.clone();
    bastion.jump_via = jump_chain(all, &bastion, seen);
    Some(JumpVia::Profile(Box::new(bastion)))
}

// Plain JSON file in the app data dir. With the keychain setting on, saved
// passwords and key passphrases live in the OS keychain and are left out of
// this file.
pub struct ProfileStore {
    path: PathBuf,
    keychain: AtomicBool,
    /// Profiles whose keychain secret could not be read at launch, as
    /// `(id, name)`. They run with an empty secret, and nothing is ever written
    /// to or deleted from their keychain entry until the app restarts, so a
    /// transient keychain error can't destroy a stored secret.
    unresolved: Vec<(String, String)>,
    inner: Arc<Mutex<Vec<ConnectionProfile>>>,
}

impl ProfileStore {
    pub fn load_or_create(app: &AppHandle, keychain: bool) -> Result<Self> {
        let dir = app
            .path()
            .app_data_dir()
            .context("resolving app_data_dir")?;
        Self::from_dir(&dir, keychain)
    }

    /// Load (or initialise) the profile store from a known directory. Used by
    /// the CLI binary, which doesn't have a Tauri AppHandle. Resolves to the
    /// same on-disk path the GUI uses — see `default_data_dir`.
    pub fn from_dir(dir: &std::path::Path, keychain: bool) -> Result<Self> {
        std::fs::create_dir_all(dir).ok();
        let path = dir.join("profiles.json");
        // An unparseable file is moved aside rather than read as "no
        // profiles" — otherwise the next save would replace it for good.
        let mut profiles: Vec<ConnectionProfile> = crate::fsutil::read_json_or_quarantine(&path);
        let mut unresolved = Vec::new();
        if keychain {
            for p in profiles.iter_mut() {
                if let Some(proxy) = p.proxy.as_mut().filter(|x| x.password.is_none()) {
                    let purpose = credentials::profile_proxy_password_purpose(&p.id);
                    match credentials::get_secret(&purpose) {
                        Ok(v) => proxy.password = v,
                        Err(e) => {
                            eprintln!("keychain read failed for profile {} proxy: {e:#}", p.name);
                            unresolved.push((p.id.clone(), p.name.clone()));
                        }
                    }
                }
                if let Some(cmd) = p.proxy_command.as_mut().filter(|c| {
                    c.service_token_id.is_some() && c.service_token_secret.is_none()
                }) {
                    let purpose = credentials::profile_cf_token_secret_purpose(&p.id);
                    match credentials::get_secret(&purpose) {
                        Ok(v) => cmd.service_token_secret = v,
                        Err(e) => {
                            eprintln!("keychain read failed for profile {} Access token: {e:#}", p.name);
                            unresolved.push((p.id.clone(), p.name.clone()));
                        }
                    }
                }
                let purpose = match secret_purpose(p) {
                    Some(purpose) if secret_is_empty(&p.auth) => purpose,
                    _ => continue,
                };
                match credentials::get_secret(&purpose) {
                    Ok(Some(v)) => set_secret_value(&mut p.auth, v),
                    Ok(None) => {}
                    Err(e) => {
                        eprintln!("keychain read failed for profile {}: {e:#}", p.name);
                        unresolved.push((p.id.clone(), p.name.clone()));
                    }
                }
            }
            // A profile whose proxy and auth secrets both failed is listed once.
            unresolved.dedup();
        }
        Ok(Self {
            path: path.clone(),
            keychain: AtomicBool::new(keychain),
            unresolved,
            inner: Arc::new(Mutex::new(profiles)),
        })
    }

    pub fn keychain_enabled(&self) -> bool {
        self.keychain.load(Ordering::SeqCst)
    }

    /// Names of profiles whose saved secret couldn't be read from the keychain.
    pub fn keychain_warnings(&self) -> Vec<String> {
        self.unresolved.iter().map(|(_, name)| name.clone()).collect()
    }

    /// Whether a profile's keychain entry must be left alone on an empty save.
    pub fn is_unresolved(&self, id: &str) -> bool {
        self.unresolved.iter().any(|(uid, _)| uid == id)
    }

    /// Switch where saved secrets live. Turning it on moves each secret into the
    /// keychain before the file drops it; turning it off writes them back to the
    /// file before the keychain entries are removed.
    pub async fn set_keychain(&self, on: bool, db: &Db) -> Result<()> {
        let g = self.inner.lock().await;
        if on {
            for p in g.iter() {
                sync_profile_secret(p, db, false)?;
            }
            self.keychain.store(true, Ordering::SeqCst);
            if let Err(e) = self.write(&g) {
                self.keychain.store(false, Ordering::SeqCst);
                return Err(e);
            }
        } else {
            // Turning off writes secrets back to the file; a secret that never
            // loaded would be written back empty and then lost with its entry.
            if !self.unresolved.is_empty() {
                anyhow::bail!(
                    "couldn't read the saved passwords for {} from the keychain at launch; restart Faro with keychain access before turning this off",
                    self.keychain_warnings().join(", ")
                );
            }
            self.keychain.store(false, Ordering::SeqCst);
            if let Err(e) = self.write(&g) {
                self.keychain.store(true, Ordering::SeqCst);
                return Err(e);
            }
            for p in g.iter() {
                for purpose in all_secret_purposes(&p.id)
                    .into_iter()
                    .chain([
                        credentials::profile_proxy_password_purpose(&p.id),
                        credentials::profile_cf_token_secret_purpose(&p.id),
                    ])
                {
                    credentials::delete_secret(&purpose);
                    let _ = db.forget_keychain(credentials::SERVICE, &purpose);
                }
            }
        }
        Ok(())
    }

    pub async fn list(&self) -> Result<Vec<ConnectionProfile>> {
        let g = self.inner.lock().await;
        Ok(g.iter().cloned().map(|p| resolve_jump(&g, p)).collect())
    }

    pub async fn get(&self, id: &str) -> Result<Option<ConnectionProfile>> {
        let g = self.inner.lock().await;
        Ok(g.iter().find(|p| p.id == id).cloned().map(|p| resolve_jump(&g, p)))
    }

    /// `profile` (e.g. an unsaved one from the editor) with its jump host
    /// resolved against the saved profiles.
    pub async fn with_jump_resolved(&self, profile: ConnectionProfile) -> ConnectionProfile {
        resolve_jump(&self.inner.lock().await, profile)
    }

    pub async fn upsert(&self, profile: ConnectionProfile) -> Result<()> {
        let mut g = self.inner.lock().await;
        if let Some(existing) = g.iter_mut().find(|p| p.id == profile.id) {
            *existing = profile;
        } else {
            g.push(profile);
        }
        self.write(&g)?;
        Ok(())
    }

    /// Persist a manual rail order: each listed profile gets `sort_order` =
    /// its index. Ids not in the store are skipped; one write for the batch.
    pub async fn reorder(&self, ids: &[String]) -> Result<()> {
        let mut g = self.inner.lock().await;
        for (i, id) in ids.iter().enumerate() {
            if let Some(p) = g.iter_mut().find(|p| &p.id == id) {
                p.sort_order = Some(i as u32);
            }
        }
        self.write(&g)?;
        Ok(())
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        let mut g = self.inner.lock().await;
        g.retain(|p| p.id != id);
        self.write(&g)?;
        Ok(())
    }

    fn write(&self, profiles: &[ConnectionProfile]) -> Result<()> {
        let bytes = serde_json::to_vec_pretty(&for_disk(profiles, self.keychain_enabled()))?;
        crate::fsutil::write_atomic(&self.path, &bytes)
            .with_context(|| format!("writing {}", self.path.display()))?;
        Ok(())
    }
}

/// Keychain purpose holding a profile's secret (saved password or key
/// passphrase), or `None` when its auth method keeps no secret of its own.
pub fn secret_purpose(profile: &ConnectionProfile) -> Option<String> {
    match &profile.auth {
        AuthMethod::Password { .. } => Some(credentials::profile_password_purpose(&profile.id)),
        AuthMethod::Key { .. } => Some(credentials::profile_passphrase_purpose(&profile.id)),
        _ => None,
    }
}

/// Every keychain purpose a profile's own secret can live under, whatever its
/// current auth method. Used to clean up on delete and on an auth-kind switch.
pub fn all_secret_purposes(profile_id: &str) -> [String; 2] {
    [
        credentials::profile_password_purpose(profile_id),
        credentials::profile_passphrase_purpose(profile_id),
    ]
}

/// Whether the secret slot of `auth` holds nothing.
fn secret_is_empty(auth: &AuthMethod) -> bool {
    match auth {
        AuthMethod::Password { password } => password.is_empty(),
        AuthMethod::Key { passphrase, .. } => passphrase.as_deref().map_or(true, str::is_empty),
        _ => true,
    }
}

fn set_secret_value(auth: &mut AuthMethod, value: String) {
    match auth {
        AuthMethod::Password { password } => *password = value,
        AuthMethod::Key { passphrase, .. } => *passphrase = Some(value),
        _ => {}
    }
}

/// Keychain side of one profile's secret (keychain mode only): write it under
/// the profile's purpose and record it in the manifest so backups pick it up,
/// or clear both when it is empty. An empty value on an unresolved profile
/// (`keep_unresolved`) is skipped so a failed read can't delete its entry.
pub fn sync_profile_secret(profile: &ConnectionProfile, db: &Db, keep_unresolved: bool) -> Result<()> {
    sync_proxy_secret(profile, db, keep_unresolved)?;
    // An entry left under the other auth kind (e.g. password -> key) is stale.
    let current = secret_purpose(profile);
    for stale in all_secret_purposes(&profile.id) {
        if current.as_ref() != Some(&stale) {
            credentials::delete_secret(&stale);
            db.forget_keychain(credentials::SERVICE, &stale)?;
        }
    }
    let Some(purpose) = current else {
        return Ok(());
    };
    if secret_is_empty(&profile.auth) {
        if keep_unresolved {
            return Ok(());
        }
        credentials::delete_secret(&purpose);
        return db.forget_keychain(credentials::SERVICE, &purpose);
    }
    let value = match &profile.auth {
        AuthMethod::Password { password } => password.as_str(),
        AuthMethod::Key { passphrase, .. } => passphrase.as_deref().unwrap_or_default(),
        _ => return Ok(()),
    };
    credentials::set_secret(&purpose, value)?;
    db.record_keychain(credentials::SERVICE, &purpose)
}

/// Keychain side of a profile's proxy password and Access service-token
/// secret, like `sync_profile_secret`.
fn sync_proxy_secret(profile: &ConnectionProfile, db: &Db, keep_unresolved: bool) -> Result<()> {
    let password = profile.proxy.as_ref().and_then(|p| p.password.as_deref());
    sync_optional_secret(
        &credentials::profile_proxy_password_purpose(&profile.id),
        password,
        db,
        keep_unresolved,
    )?;
    let token = profile.proxy_command.as_ref().and_then(|c| c.service_token_secret.as_deref());
    sync_optional_secret(
        &credentials::profile_cf_token_secret_purpose(&profile.id),
        token,
        db,
        keep_unresolved,
    )
}

fn sync_optional_secret(purpose: &str, value: Option<&str>, db: &Db, keep_unresolved: bool) -> Result<()> {
    match value.filter(|v| !v.is_empty()) {
        Some(value) => {
            credentials::set_secret(purpose, value)?;
            db.record_keychain(credentials::SERVICE, purpose)
        }
        None if keep_unresolved => Ok(()),
        None => {
            credentials::delete_secret(purpose);
            db.forget_keychain(credentials::SERVICE, purpose)
        }
    }
}

/// What lands in `profiles.json`: with the keychain on, secrets are blanked so
/// they never reach the file.
fn for_disk(profiles: &[ConnectionProfile], keychain: bool) -> Vec<ConnectionProfile> {
    profiles
        .iter()
        .cloned()
        .map(|mut p| {
            if keychain {
                match &mut p.auth {
                    AuthMethod::Password { password } => password.clear(),
                    AuthMethod::Key { passphrase, .. } => *passphrase = None,
                    _ => {}
                }
                if let Some(proxy) = p.proxy.as_mut() {
                    proxy.password = None;
                }
                if let Some(cmd) = p.proxy_command.as_mut() {
                    cmd.service_token_secret = None;
                }
            }
            p
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(auth: serde_json::Value) -> ConnectionProfile {
        serde_json::from_value(serde_json::json!({
            "id": "p1",
            "name": "box",
            "protocol": "sftp",
            "host": "example.test",
            "port": 22,
            "username": "ivo",
            "auth": auth
        }))
        .unwrap()
    }

    #[test]
    fn keychain_mode_keeps_password_out_of_file() {
        let profiles = [profile(serde_json::json!({ "kind": "password", "password": "hunter2" }))];
        let on = serde_json::to_string(&for_disk(&profiles, true)).unwrap();
        assert!(!on.contains("hunter2"));
        let off = serde_json::to_string(&for_disk(&profiles, false)).unwrap();
        assert!(off.contains("hunter2"));
        // The in-memory profile is untouched either way.
        assert!(matches!(&profiles[0].auth, AuthMethod::Password { password } if password == "hunter2"));
    }

    #[test]
    fn keychain_mode_keeps_key_passphrase_out_of_file() {
        let profiles = [profile(serde_json::json!({
            "kind": "key", "path": "~/.ssh/id_ed25519", "passphrase": "s3cret"
        }))];
        let on = serde_json::to_string(&for_disk(&profiles, true)).unwrap();
        assert!(!on.contains("s3cret"));
        assert!(on.contains("id_ed25519"));
        let off = serde_json::to_string(&for_disk(&profiles, false)).unwrap();
        assert!(off.contains("s3cret"));
    }

    #[test]
    fn keychain_mode_keeps_proxy_password_out_of_file() {
        let mut p = profile(serde_json::json!({ "kind": "agent" }));
        p.proxy = Some(ProxyConfig {
            kind: ProxyKind::Socks5,
            host: "proxy.test".into(),
            port: 1080,
            username: Some("u".into()),
            password: Some("proxy-pw".into()),
        });
        let on = serde_json::to_string(&for_disk(&[p.clone()], true)).unwrap();
        assert!(!on.contains("proxy-pw") && on.contains("proxy.test"));
        let off = serde_json::to_string(&for_disk(&[p], false)).unwrap();
        assert!(off.contains("proxy-pw") && off.contains(r#""kind":"socks5""#));
    }

    #[test]
    fn keychain_mode_keeps_access_token_secret_out_of_file() {
        let mut p = profile(serde_json::json!({ "kind": "agent" }));
        p.proxy_command = Some(ProxyCommandConfig {
            kind: ProxyCommandKind::Cloudflare,
            command: String::new(),
            hostname: Some("ssh.example.com".into()),
            service_token_id: Some("tok.access".into()),
            service_token_secret: Some("cf-secret".into()),
        });
        let on = serde_json::to_string(&for_disk(&[p.clone()], true)).unwrap();
        assert!(!on.contains("cf-secret"), "{on}");
        // The id stays: it's what tells the loader to fetch the secret.
        assert!(on.contains("tok.access") && on.contains("ssh.example.com"));
        let off = serde_json::to_string(&for_disk(&[p], false)).unwrap();
        assert!(off.contains("cf-secret"));
    }

    fn ssh(id: &str, jump: Option<&str>) -> ConnectionProfile {
        let mut p = profile(serde_json::json!({ "kind": "agent" }));
        p.id = id.into();
        p.name = id.into();
        p.jump_profile = jump.map(Into::into);
        p
    }

    fn hops(p: &ConnectionProfile) -> Result<Vec<String>, String> {
        let mut out = Vec::new();
        let mut cur = p;
        loop {
            match &cur.jump_via {
                None => return Ok(out),
                Some(JumpVia::Broken(msg)) => return Err(msg.clone()),
                Some(JumpVia::Profile(b)) => {
                    out.push(b.id.clone());
                    cur = b;
                }
            }
        }
    }

    #[test]
    fn jump_chain_resolves_recursively() {
        let all = vec![ssh("a", Some("b")), ssh("b", Some("c")), ssh("c", None)];
        assert_eq!(hops(&resolve_jump(&all, all[0].clone())), Ok(vec!["b".into(), "c".into()]));
        assert_eq!(hops(&resolve_jump(&all, all[2].clone())), Ok(vec![]));
    }

    #[test]
    fn jump_chain_rejects_cycles_missing_and_non_ssh() {
        let all = vec![ssh("a", Some("b")), ssh("b", Some("a"))];
        assert!(hops(&resolve_jump(&all, all[0].clone())).unwrap_err().contains("loops back"));
        let self_loop = vec![ssh("a", Some("a"))];
        assert!(hops(&resolve_jump(&self_loop, self_loop[0].clone())).is_err());

        let missing = vec![ssh("a", Some("gone"))];
        assert!(hops(&resolve_jump(&missing, missing[0].clone())).unwrap_err().contains("deleted"));

        let mut s3 = ssh("b", None);
        s3.protocol = "s3".into();
        let all = vec![ssh("a", Some("b")), s3];
        assert!(hops(&resolve_jump(&all, all[0].clone())).unwrap_err().contains("not an SSH"));
    }

    #[test]
    fn jump_chain_depth_is_capped() {
        let mut all: Vec<_> = (0..12).map(|i| ssh(&format!("p{i}"), Some(&format!("p{}", i + 1)))).collect();
        all.push(ssh("p12", None));
        assert!(hops(&resolve_jump(&all, all[0].clone())).unwrap_err().contains("longer than"));
        assert_eq!(hops(&resolve_jump(&all, all[5].clone())).unwrap().len(), 7);
    }

    #[test]
    fn keychain_default_depends_on_install_age() {
        let base = std::env::temp_dir().join(format!("faro-kc-default-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let db = Db::open_in_memory().unwrap();

        // Fresh install: no profiles.json yet, so keychain by default, and recorded.
        assert!(resolve_keychain_setting_with(&db, &base, || true));
        assert_eq!(db.settings_get(KEYCHAIN_SETTING).unwrap().as_deref(), Some("true"));

        // Fresh install on a machine with no usable keychain keeps the file.
        let no_kc_db = Db::open_in_memory().unwrap();
        assert!(!resolve_keychain_setting_with(&no_kc_db, &base, || false));
        assert_eq!(no_kc_db.settings_get(KEYCHAIN_SETTING).unwrap().as_deref(), Some("false"));

        // Existing install without a setting row keeps plain text, and the
        // keychain isn't even probed.
        let old_db = Db::open_in_memory().unwrap();
        std::fs::write(base.join("profiles.json"), "[]").unwrap();
        assert!(!resolve_keychain_setting_with(&old_db, &base, || panic!("probed")));
        assert_eq!(old_db.settings_get(KEYCHAIN_SETTING).unwrap().as_deref(), Some("false"));

        // An explicit setting always wins over the install-age default.
        let off_db = Db::open_in_memory().unwrap();
        off_db.settings_set(KEYCHAIN_SETTING, "false").unwrap();
        let _ = std::fs::remove_file(base.join("profiles.json"));
        assert!(!resolve_keychain_setting_with(&off_db, &base, || panic!("probed")));

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn secret_purpose_covers_password_and_passphrase() {
        let pw = profile(serde_json::json!({ "kind": "password", "password": "" }));
        assert_eq!(secret_purpose(&pw).as_deref(), Some("profile-password:p1"));
        let key = profile(serde_json::json!({ "kind": "key", "path": "k" }));
        assert_eq!(secret_purpose(&key).as_deref(), Some("profile-passphrase:p1"));
        let agent = profile(serde_json::json!({ "kind": "agent" }));
        assert_eq!(secret_purpose(&agent), None);
    }

    fn keychain_test_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("faro-kc-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Toggling moves secrets file -> keychain -> file, and a relaunch in
    /// keychain mode loads them back. Run with
    /// `cargo test -p faro --lib profiles -- --ignored`.
    #[tokio::test]
    #[ignore = "touches the OS keychain"]
    async fn keychain_toggle_moves_secrets_both_ways() {
        let dir = keychain_test_dir("toggle");
        let db = Db::open_in_memory().unwrap();
        let mut pw = profile(serde_json::json!({ "kind": "password", "password": "pw-test-1" }));
        pw.id = format!("kc-test-pw-{}", std::process::id());
        let mut key = profile(serde_json::json!({
            "kind": "key", "path": "k", "passphrase": "pp-test-1"
        }));
        key.id = format!("kc-test-key-{}", std::process::id());
        let file = dir.join("profiles.json");
        std::fs::write(&file, serde_json::to_vec(&[&pw, &key]).unwrap()).unwrap();
        let on_disk = || std::fs::read_to_string(&file).unwrap();
        let stored = |p: &ConnectionProfile| credentials::get_secret(&secret_purpose(p).unwrap()).unwrap();

        let store = ProfileStore::from_dir(&dir, false).unwrap();
        store.set_keychain(true, &db).await.unwrap();
        assert!(!on_disk().contains("pw-test-1") && !on_disk().contains("pp-test-1"));
        assert_eq!(stored(&pw).as_deref(), Some("pw-test-1"));
        assert_eq!(stored(&key).as_deref(), Some("pp-test-1"));

        let relaunched = ProfileStore::from_dir(&dir, true).unwrap();
        let loaded = relaunched.list().await.unwrap();
        assert!(matches!(&loaded[0].auth, AuthMethod::Password { password } if password == "pw-test-1"));
        assert!(matches!(&loaded[1].auth, AuthMethod::Key { passphrase: Some(p), .. } if p == "pp-test-1"));
        assert!(relaunched.keychain_warnings().is_empty());

        relaunched.set_keychain(false, &db).await.unwrap();
        assert!(on_disk().contains("pw-test-1") && on_disk().contains("pp-test-1"));
        assert_eq!(stored(&pw), None);
        assert_eq!(stored(&key), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Switching a profile from password to key auth drops the old password
    /// entry instead of leaving it orphaned in the keychain.
    #[test]
    #[ignore = "touches the OS keychain"]
    fn keychain_auth_switch_drops_stale_entry() {
        let db = Db::open_in_memory().unwrap();
        let mut p = profile(serde_json::json!({ "kind": "password", "password": "pw-test-2" }));
        p.id = format!("kc-test-switch-{}", std::process::id());
        let [pw_purpose, pp_purpose] = all_secret_purposes(&p.id);

        sync_profile_secret(&p, &db, false).unwrap();
        assert_eq!(credentials::get_secret(&pw_purpose).unwrap().as_deref(), Some("pw-test-2"));

        p.auth = AuthMethod::Key { path: "k".into(), passphrase: Some("pp-test-2".into()) };
        sync_profile_secret(&p, &db, false).unwrap();
        assert_eq!(credentials::get_secret(&pw_purpose).unwrap(), None);
        assert_eq!(credentials::get_secret(&pp_purpose).unwrap().as_deref(), Some("pp-test-2"));
        assert_eq!(db.list_keychain().unwrap().len(), 1);

        credentials::delete_secret(&pp_purpose);
    }
}
