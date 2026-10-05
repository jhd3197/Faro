use crate::proc::NoConsoleWindow;
use crate::error::{ErrorKind, FaroError};
use crate::profiles::{AuthMethod, ConnectionProfile};
use crate::remotefs::{Capabilities, DirEntry, RemoteFs};
use crate::session::{HostDecision, JobHandle, Session, SshSession};
use crate::transfer::{OverwritePolicy, Transfer, TransferStatus};
use crate::AppState;
use base64::Engine as _;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use uuid::Uuid;

pub const LOCAL_SESSION: &str = "local";

/// Convert any error to a string for crossing the IPC boundary. The frontend
/// surfaces these directly to the user, so the Display message must be useful.
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------- Profiles ----------

#[tauri::command]
pub async fn list_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<ConnectionProfile>, String> {
    state.profiles.list().await.map_err(err)
}

#[tauri::command]
pub async fn save_profile(
    profile: ConnectionProfile,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.profiles.upsert(profile).await.map_err(err)
}

/// Persist the rail's drag-and-drop order: `ids` is every profile id in the
/// desired display order; each gets `sort_order` = its index in one write.
#[tauri::command]
pub async fn reorder_profiles(
    ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.profiles.reorder(&ids).await.map_err(err)
}

#[tauri::command]
pub async fn delete_profile(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Clean up any keychain-stored OAuth tokens for this profile.
    if let Ok(Some(p)) = state.profiles.get(&id).await {
        match p.protocol.as_str() {
            "dropbox" => {
                crate::oauth::delete_tokens(crate::session::dropbox::DROPBOX_SERVICE, &id)
            }
            "onedrive" => {
                crate::oauth::delete_tokens(crate::session::onedrive::ONEDRIVE_SERVICE, &id)
            }
            "gdrive" => {
                crate::oauth::delete_tokens(crate::session::gdrive::GDRIVE_SERVICE, &id)
            }
            "box" => crate::oauth::delete_tokens(crate::session::boxdrive::BOX_SERVICE, &id),
            "shopify" => {
                // Keychain-stored Admin credential (never in profiles.json).
                let key = crate::session::shopify::credential_key(&id);
                crate::credentials::delete_secret(&key);
                let _ = state
                    .db
                    .forget_keychain(crate::credentials::SERVICE, &key);
            }
            _ => {}
        }
        // Grant-imported profiles hold their private key in the OS keychain
        // under `grant-key:<profile-id>` — remove it with the profile.
        if let AuthMethod::KeyRef { key_ref } = &p.auth {
            crate::credentials::delete_secret(key_ref);
            let _ = state
                .db
                .forget_keychain(crate::credentials::SERVICE, key_ref);
        }
    }
    state.profiles.delete(&id).await.map_err(err)
}

// ---------- SSH key generation ----------

/// Suggested defaults for the in-app key generator: the `~/.ssh` dir and a
/// non-colliding filename under it.
#[tauri::command]
pub fn ssh_key_defaults() -> crate::keys::SshKeyDefaults {
    crate::keys::defaults()
}

/// Generate a new SSH keypair, write the private key (PKCS#8 PEM, encrypted when
/// a passphrase is given) plus a `.pub` beside it, and return the public-key line
/// to install on the server. Key generation is CPU-bound (RSA-4096 especially),
/// so it runs on the blocking pool rather than the async runtime.
#[tauri::command]
pub async fn generate_ssh_key(
    req: crate::keys::GenerateKeyRequest,
) -> Result<crate::keys::GeneratedKey, String> {
    tokio::task::spawn_blocking(move || crate::keys::generate(&req))
        .await
        .map_err(err)?
        .map_err(err)
}

/// Derive the public-key line + fingerprint for an existing private key path, so
/// the user can copy it without regenerating. Needs the passphrase if the key is
/// encrypted.
#[tauri::command]
pub async fn ssh_public_key_for(
    path: String,
    passphrase: Option<String>,
) -> Result<crate::keys::GeneratedKey, String> {
    tokio::task::spawn_blocking(move || {
        crate::keys::public_key_for(&path, passphrase.as_deref())
    })
    .await
    .map_err(err)?
    .map_err(err)
}

// ---------- Sessions ----------

#[tauri::command]
pub async fn connect(
    profile_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, FaroError> {
    let profile = state
        .profiles
        .get(&profile_id)
        .await
        .map_err(FaroError::from)?
        .ok_or_else(|| {
            FaroError::new(ErrorKind::NotFound, format!("profile {profile_id} not found"))
        })?;
    let session_id = state
        .sessions
        .connect(profile, app)
        .await
        .map_err(FaroError::from)?;
    // Re-apply a previously-granted Agent Bridge access for this profile (session
    // ids are per-connect, so the bridge tracks the persistent grant by profile).
    state
        .bridge
        .on_session_connected(&session_id, &profile_id)
        .await;
    Ok(session_id)
}

/// "Test connection" in the editor: connect with the profile as it stands in
/// the form (not necessarily saved), then disconnect right away. Uses the
/// normal connect path, so host-key and login prompts behave exactly as they
/// will for real. Keychain-held secrets must already be set by the caller.
#[tauri::command]
pub async fn test_connection(
    profile: ConnectionProfile,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), FaroError> {
    let session_id = state
        .sessions
        .connect(profile, app)
        .await
        .map_err(FaroError::from)?;
    let _ = state.sessions.disconnect(&session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn disconnect(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.sessions.disconnect(&session_id).await.map_err(err)
}

// ---------- Faro Agent (Faro-to-Faro remote control) ----------

/// A discovered daemon plus what this Faro already knows about it, so the UI
/// can label machines that are already paired instead of offering to re-pair.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredAgent {
    #[serde(flatten)]
    pub agent: crate::session::agent::discovery::Discovered,
    /// Id of a saved profile whose pinned key matches this machine, if any.
    pub paired_profile_id: Option<String>,
}

/// Discover `faro-agentd` daemons on the local network over mDNS. Best-effort;
/// returns an empty list on a network without multicast rather than erroring.
#[tauri::command]
pub async fn discover_agents(
    state: State<'_, AppState>,
) -> Result<Vec<DiscoveredAgent>, String> {
    let found = crate::session::agent::discovery::browse(Duration::from_millis(1500)).await;
    // Map the pinned keys of saved profiles to the fingerprints daemons advertise.
    let mut fp_to_profile = std::collections::HashMap::new();
    for p in state.profiles.list().await.map_err(err)? {
        if let Some(key) = &p.agent_key {
            if let Ok(raw) = faro_agent_proto::decode_public(key) {
                fp_to_profile.insert(faro_agent_proto::fingerprint_of(&raw), p.id.clone());
            }
        }
    }
    Ok(found
        .into_iter()
        .map(|agent| DiscoveredAgent {
            paired_profile_id: fp_to_profile.get(&agent.fingerprint).cloned(),
            agent,
        })
        .collect())
}

/// This controller's own agent public key (base64). Shown in the pairing UI so a
/// user can eyeball which controller a daemon just pinned.
#[tauri::command]
pub async fn agent_public_key() -> Result<String, String> {
    crate::session::agent::controller_public_key().map_err(err)
}

/// Result of pairing, surfaced to the UI to confirm the machine. Carries the
/// daemon's pinned key; the frontend stores it into the profile it saves.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentPairResult {
    pub server_key: String,
    pub fingerprint: String,
    pub hostname: String,
    pub os: String,
}

/// Pair with a `faro-agentd` at `host:port` using a one-time `code`. Persists
/// nothing — the connection editor keeps the returned key and only saves a
/// profile once pairing has succeeded, so a failed attempt leaves no
/// half-configured connection behind.
#[tauri::command]
pub async fn pair_agent(host: String, port: u16, code: String) -> Result<AgentPairResult, String> {
    let outcome = crate::session::agent_pair(host.trim(), port, &code)
        .await
        .map_err(err)?;
    Ok(AgentPairResult {
        server_key: outcome.server_key,
        fingerprint: outcome.fingerprint,
        hostname: outcome.system_info.hostname,
        os: outcome.system_info.os,
    })
}

// ---------- Dropbox (OAuth cloud) ----------

/// Result of a Dropbox authorization, shown to the user to confirm the account.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DropboxAuthResult {
    pub account_label: String,
}

/// Run the interactive Dropbox OAuth flow (opens the browser, catches the
/// loopback redirect), store the tokens in the OS keychain keyed by `profile_id`,
/// and return the account label. Mirrors agent pairing: the editor persists the
/// profile once this succeeds, so a cancelled flow leaves no saved connection.
#[tauri::command]
pub async fn dropbox_authorize(profile_id: String) -> Result<DropboxAuthResult, String> {
    let config = crate::session::dropbox::dropbox_config();
    let (tokens, _raw) = crate::oauth::authorize_loopback(&config).await.map_err(err)?;
    crate::oauth::store_tokens(
        crate::session::dropbox::DROPBOX_SERVICE,
        &profile_id,
        &tokens,
    )
    .map_err(err)?;

    // Fetch the account label with a throwaway session over the fresh tokens.
    let probe = ConnectionProfile {
        id: profile_id.clone(),
        name: String::new(),
        protocol: "dropbox".into(),
        host: "dropbox.com".into(),
        port: 443,
        username: String::new(),
        auth: AuthMethod::Password { password: String::new() },
        default_remote_path: None,
        color: None,
        auto_connect: None,
        bucket: None,
        region: None,
        endpoint: None,
        account: None,
        agent_key: None,
        group: None,
        sort_order: None,
        icon: None,
        jump_host: None,
        jump_port: None,
        jump_username: None,
        ftp_encoding: None,
        ftp_active_mode: None,
        ftp_max_connections: None,
        ftp_segments: None,
    };
    let account_label = match crate::session::dropbox_connect(&probe).await {
        Ok(session) => session.account_label().await.unwrap_or_default(),
        Err(_) => String::new(),
    };
    Ok(DropboxAuthResult { account_label })
}

/// Run the interactive OneDrive OAuth flow, store tokens in the keychain keyed by
/// `profile_id`, and return the account label. Same shape as `dropbox_authorize`.
#[tauri::command]
pub async fn onedrive_authorize(profile_id: String) -> Result<DropboxAuthResult, String> {
    let config = crate::session::onedrive::onedrive_config();
    let (tokens, _raw) = crate::oauth::authorize_loopback(&config).await.map_err(err)?;
    crate::oauth::store_tokens(
        crate::session::onedrive::ONEDRIVE_SERVICE,
        &profile_id,
        &tokens,
    )
    .map_err(err)?;

    let probe = ConnectionProfile {
        id: profile_id.clone(),
        name: String::new(),
        protocol: "onedrive".into(),
        host: "onedrive.com".into(),
        port: 443,
        username: String::new(),
        auth: AuthMethod::Password { password: String::new() },
        default_remote_path: None,
        color: None,
        auto_connect: None,
        bucket: None,
        region: None,
        endpoint: None,
        account: None,
        agent_key: None,
        group: None,
        sort_order: None,
        icon: None,
        jump_host: None,
        jump_port: None,
        jump_username: None,
        ftp_encoding: None,
        ftp_active_mode: None,
        ftp_max_connections: None,
        ftp_segments: None,
    };
    let account_label = match crate::session::onedrive_connect(&probe).await {
        Ok(session) => session.account_label().await.unwrap_or_default(),
        Err(_) => String::new(),
    };
    Ok(DropboxAuthResult { account_label })
}

/// Run the interactive Dynamics 365 (delegated) OAuth flow — the OneDrive
/// pattern with the org's `user_impersonation` scope — store tokens in the
/// keychain keyed by `profile_id`, and return the account label. `host` is
/// the environment URL the editor collected (`{org}.crm.dynamics.com`).
#[tauri::command]
pub async fn dynamics_authorize(
    profile_id: String,
    host: String,
) -> Result<DropboxAuthResult, String> {
    let host = host
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    let config = crate::session::dynamics::dynamics_config(&host);
    let (tokens, _raw) = crate::oauth::authorize_loopback(&config).await.map_err(err)?;
    crate::oauth::store_tokens(
        crate::session::dynamics::DYNAMICS_TOKEN_SERVICE,
        &profile_id,
        &tokens,
    )
    .map_err(err)?;

    let probe = ConnectionProfile {
        id: profile_id.clone(),
        name: String::new(),
        protocol: "dynamics".into(),
        host: host.clone(),
        port: 443,
        username: String::new(),
        auth: AuthMethod::Password { password: String::new() },
        default_remote_path: None,
        color: None,
        auto_connect: None,
        bucket: None,
        region: None,
        endpoint: None,
        account: None,
        agent_key: None,
        group: None,
        sort_order: None,
        icon: None,
        jump_host: None,
        jump_port: None,
        jump_username: None,
        ftp_encoding: None,
        ftp_active_mode: None,
        ftp_max_connections: None,
        ftp_segments: None,
    };
    let account_label = match crate::session::dynamics_connect(&probe).await {
        Ok(session) => session.account_label().await.unwrap_or_default(),
        Err(_) => String::new(),
    };
    Ok(DropboxAuthResult { account_label })
}

/// Run the interactive Google Drive OAuth flow, store tokens, return the label.
#[tauri::command]
pub async fn gdrive_authorize(profile_id: String) -> Result<DropboxAuthResult, String> {
    let config = crate::session::gdrive::gdrive_config();
    let (tokens, _raw) = crate::oauth::authorize_loopback(&config).await.map_err(err)?;
    crate::oauth::store_tokens(crate::session::gdrive::GDRIVE_SERVICE, &profile_id, &tokens)
        .map_err(err)?;

    let probe = ConnectionProfile {
        id: profile_id.clone(),
        name: String::new(),
        protocol: "gdrive".into(),
        host: "drive.google.com".into(),
        port: 443,
        username: String::new(),
        auth: AuthMethod::Password { password: String::new() },
        default_remote_path: None,
        color: None,
        auto_connect: None,
        bucket: None,
        region: None,
        endpoint: None,
        account: None,
        agent_key: None,
        group: None,
        sort_order: None,
        icon: None,
        jump_host: None,
        jump_port: None,
        jump_username: None,
        ftp_encoding: None,
        ftp_active_mode: None,
        ftp_max_connections: None,
        ftp_segments: None,
    };
    let account_label = match crate::session::gdrive_connect(&probe).await {
        Ok(session) => session.account_label().await.unwrap_or_default(),
        Err(_) => String::new(),
    };
    Ok(DropboxAuthResult { account_label })
}

/// Run the interactive Box OAuth flow, store tokens, return the label.
#[tauri::command]
pub async fn box_authorize(profile_id: String) -> Result<DropboxAuthResult, String> {
    let config = crate::session::boxdrive::box_config();
    let (tokens, _raw) = crate::oauth::authorize_loopback(&config).await.map_err(err)?;
    crate::oauth::store_tokens(crate::session::boxdrive::BOX_SERVICE, &profile_id, &tokens)
        .map_err(err)?;

    let probe = ConnectionProfile {
        id: profile_id.clone(),
        name: String::new(),
        protocol: "box".into(),
        host: "box.com".into(),
        port: 443,
        username: String::new(),
        auth: AuthMethod::Password { password: String::new() },
        default_remote_path: None,
        color: None,
        auto_connect: None,
        bucket: None,
        region: None,
        endpoint: None,
        account: None,
        agent_key: None,
        group: None,
        sort_order: None,
        icon: None,
        jump_host: None,
        jump_port: None,
        jump_username: None,
        ftp_encoding: None,
        ftp_active_mode: None,
        ftp_max_connections: None,
        ftp_segments: None,
    };
    let account_label = match crate::session::box_connect(&probe).await {
        Ok(session) => session.account_label().await.unwrap_or_default(),
        Err(_) => String::new(),
    };
    Ok(DropboxAuthResult { account_label })
}

/// List the in-flight tracked commands (agent/bridge `exec`s, tails) running on a
/// session, so the UI can show a Jobs panel with a Kill button. Returns an empty
/// list for a non-SSH or unknown session rather than erroring.
#[tauri::command]
pub async fn list_agent_jobs(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<JobHandle>, String> {
    match state.sessions.get_ssh(&session_id).await {
        Some(ssh) => Ok(ssh.list_jobs().await),
        None => Ok(Vec::new()),
    }
}

/// Terminate a running tracked job (by op_id) on a session — the user-facing
/// "stop this" for a long background command. Returns `true` if a matching live
/// job was found and signalled.
#[tauri::command]
pub async fn kill_agent_job(
    session_id: String,
    op_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let Some(ssh) = state.sessions.get_ssh(&session_id).await else {
        return Err(format!("session {session_id} is not a live SSH connection"));
    };
    ssh.kill_job(&op_id).await.map_err(err)
}

#[tauri::command]
pub async fn respond_to_host_prompt(
    request_id: String,
    decision: HostDecision,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .sessions
        .prompts
        .resolve(&request_id, decision)
        .await
        .map_err(err)
}

/// Answer a keyboard-interactive auth prompt (e.g. a forced password change for
/// an expired/temp password). `responses` is one string per prompt, or `null`
/// when the user cancelled the dialog (which aborts the connection).
#[tauri::command]
pub async fn respond_to_auth_prompt(
    request_id: String,
    responses: Option<Vec<String>>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .sessions
        .auth_prompts
        .resolve(&request_id, responses)
        .await
        .map_err(err)
}

// ---------- File system ----------

#[tauri::command]
pub async fn list_directory(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<DirEntry>, String> {
    let fs = fs_for(&session_id, &state).await?;
    fs.list_dir(&path).await.map_err(err)
}

#[tauri::command]
pub async fn capabilities(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Capabilities, String> {
    let fs = fs_for(&session_id, &state).await?;
    Ok(fs.capabilities())
}

/// Largest local file we'll slurp for an image thumbnail. Beyond this the grid
/// falls back to a type icon rather than reading a huge file into memory.
const MAX_PREVIEW_BYTES: u64 = 4 * 1024 * 1024; // 4 MiB

/// Read a small **local** file and return it base64-encoded, so the grid view
/// can render a real image preview instead of a generic icon. Local-only and
/// size-capped: remote previews would need a per-protocol read primitive, which
/// the `RemoteFs` trait doesn't expose yet — the frontend treats an error here
/// as "no preview" and shows the icon.
#[tauri::command]
pub async fn read_file_preview(
    session_id: String,
    path: String,
) -> Result<String, String> {
    if session_id != LOCAL_SESSION {
        return Err("preview is only supported for local files".into());
    }
    let data = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<u8>> {
        let meta = std::fs::metadata(&path)?;
        if meta.len() > MAX_PREVIEW_BYTES {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "file too large for preview",
            ));
        }
        std::fs::read(&path)
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    Ok(base64::engine::general_purpose::STANDARD.encode(data))
}

// ---------- Terminal ----------

#[tauri::command]
pub async fn open_terminal(
    session_id: String,
    cols: u32,
    rows: u32,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if session_id == LOCAL_SESSION {
        return Err("Local terminal is not supported".into());
    }
    let ssh = state
        .sessions
        .get_ssh(&session_id)
        .await
        .ok_or_else(|| format!("FTP sessions have no shell"))?;
    state
        .ptys
        .open(&ssh, cols, rows, app)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn terminal_write(
    terminal_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ptys.write(&terminal_id, data).await.map_err(err)
}

#[tauri::command]
pub async fn terminal_resize(
    terminal_id: String,
    cols: u32,
    rows: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .ptys
        .resize(&terminal_id, cols, rows)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn close_terminal(
    terminal_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.ptys.close(&terminal_id).await.map_err(err)
}

// ---------- Command snippets (Plan 11 Phase 4) ----------
//
// The low-friction, single-session counterpart to Fleet Skills: saved command
// lines with optional `{{variable}}` placeholders, inserted into a live shell
// with one keystroke. Backed by the `snippets` table in `faro.db`; every
// mutation returns the fresh, re-ordered list (most-used first) so the store
// stays in lockstep — the same shape the saved-commands / skills IPC uses.

#[tauri::command]
pub async fn snippet_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::Snippet>, String> {
    state.db.list_snippets().map_err(err)
}

#[tauri::command]
pub async fn snippet_save(
    snippet: crate::db::Snippet,
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::Snippet>, String> {
    state
        .db
        .upsert_snippet(
            &snippet.id,
            &snippet.name,
            &snippet.body,
            snippet.folder.as_deref().filter(|s| !s.is_empty()),
        )
        .map_err(err)
}

#[tauri::command]
pub async fn snippet_delete(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::Snippet>, String> {
    state.db.delete_snippet(&id).map_err(err)
}

/// Record that a snippet's text was inserted into a shell (bumps its use count
/// so it floats up the palette ordering). Returns the re-ordered list.
#[tauri::command]
pub async fn snippet_run(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::db::Snippet>, String> {
    state.db.touch_snippet(&id).map_err(err)
}

// ---------- Transfers ----------

#[tauri::command]
pub async fn start_download(
    session_id: String,
    remote_path: String,
    local_dir: String,
    overwrite_policy: Option<OverwritePolicy>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session = state
        .sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session {session_id} not found"))?;
    state
        .transfers
        .start_download(
            session,
            remote_path,
            local_dir,
            overwrite_policy.unwrap_or_default(),
            app,
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn start_upload(
    session_id: String,
    local_path: String,
    remote_dir: String,
    overwrite_policy: Option<OverwritePolicy>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let session = state
        .sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session {session_id} not found"))?;
    state
        .transfers
        .start_upload(
            session,
            local_path,
            remote_dir,
            overwrite_policy.unwrap_or_default(),
            app,
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn cancel_transfer(
    transfer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .transfers
        .cancel(&transfer_id, &app)
        .await
        .map_err(err)
}

/// Pause a queued or running transfer (Plan 17 Phase 2). A running one parks
/// at the next chunk boundary; resume re-runs its file from byte 0.
#[tauri::command]
pub async fn transfer_pause(
    transfer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.transfers.pause(&transfer_id, &app).await.map_err(err)
}

#[tauri::command]
pub async fn transfer_resume(
    transfer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // A row restored from an earlier run (Plan 24) resumes on its connection,
    // which the user has to have open.
    if let Some(profile_id) = state.transfers.restored_connection(&transfer_id).await {
        let Some(session) = state.sessions.find_by_profile(&profile_id).await else {
            let name = state
                .profiles
                .get(&profile_id)
                .await
                .ok()
                .flatten()
                .map(|p| p.name)
                .unwrap_or_else(|| "its connection".into());
            return Err(format!("Connect to {name} first, then resume this transfer."));
        };
        return state
            .transfers
            .resume_restored(&transfer_id, session, &app)
            .await
            .map_err(err);
    }
    state
        .transfers
        .resume(&transfer_id, &app)
        .await
        .map_err(err)
}

/// Re-enqueue a failed or canceled transfer with its original source/
/// destination (Plan 17 Phase 3). Same id — the panel row resets in place.
#[tauri::command]
pub async fn transfer_retry(
    transfer_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.transfers.retry(&transfer_id, &app).await.map_err(err)
}

/// Reorder a waiting transfer in the queue FIFO (Plan 17). `direction` is
/// "up" (sooner) or "down" (later); active transfers are untouched.
#[tauri::command]
pub async fn transfer_move(
    transfer_id: String,
    direction: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .transfers
        .move_in_queue(&transfer_id, direction == "up", &app)
        .await
        .map_err(err)
}

/// Pause admission of new transfers; running ones keep going.
#[tauri::command]
pub async fn transfer_pause_all(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.transfers.pause_all(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn transfer_resume_all(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.transfers.resume_all(&app).await;
    Ok(())
}

/// Live-adjust how many transfers may run at once (1..=32).
#[tauri::command]
pub async fn transfer_set_concurrency(
    count: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.transfers.set_concurrency(count as usize);
    Ok(())
}

/// Live-adjust the global bandwidth cap in KiB/s (0 = unlimited). Takes
/// effect on the next chunk of every active transfer (Plan 17 Phase 4).
#[tauri::command]
pub async fn transfer_set_throttle(
    kbps: u64,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.transfers.set_throttle_kbps(kbps);
    Ok(())
}

/// Live-adjust the delta-sync switch (Plan 23). Applies to the next transfer
/// decision; `FARO_DELTA=0` still force-disables regardless of the setting.
#[tauri::command]
pub async fn transfer_set_delta_sync(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.transfers.set_delta_enabled(enabled);
    Ok(())
}

/// Live-adjust how many parallel ranges/parts one file may use (Plan 24);
/// 0 = auto.
#[tauri::command]
pub async fn transfer_set_segments(
    count: u32,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .transfers
        .set_segments((count > 0).then_some(count as usize));
    Ok(())
}

/// Live-adjust checksum verification of finished transfers (Plan 24).
#[tauri::command]
pub async fn transfer_set_verify(
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.transfers.set_verify(enabled);
    Ok(())
}

/// Queue snapshot for the panel's initial load (waiting FIFO + pause-all +
/// concurrency + throttle).
#[tauri::command]
pub async fn transfer_queue_state(
    state: State<'_, AppState>,
) -> Result<crate::transfer::QueueState, String> {
    Ok(state.transfers.queue_state().await)
}

#[tauri::command]
pub async fn list_transfers(
    state: State<'_, AppState>,
) -> Result<Vec<Transfer>, String> {
    Ok(state.transfers.list().await)
}

#[tauri::command]
pub async fn start_directory_download(
    session_id: String,
    remote_dir: String,
    local_dir: String,
    overwrite_policy: Option<OverwritePolicy>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let session = state
        .sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session {session_id} not found"))?;
    state
        .transfers
        .start_directory_download(
            session,
            remote_dir,
            local_dir,
            overwrite_policy.unwrap_or_default(),
            app,
        )
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn start_directory_upload(
    session_id: String,
    local_dir: String,
    remote_dir: String,
    overwrite_policy: Option<OverwritePolicy>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let session = state
        .sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session {session_id} not found"))?;
    state
        .transfers
        .start_directory_upload(
            session,
            local_dir,
            remote_dir,
            overwrite_policy.unwrap_or_default(),
            app,
        )
        .await
        .map_err(err)
}

// ---------- File ops (rename, delete, mkdir, chmod) ----------
//
// Polymorphic dispatch on session type. The UI doesn't need to know whether
// it's talking to SFTP or FTP — RemoteFs hides that.

async fn fs_for(
    session_id: &str,
    state: &AppState,
) -> Result<Box<dyn RemoteFs>, String> {
    if session_id == LOCAL_SESSION {
        return Ok(Box::new(crate::remotefs::local::LocalFs));
    }
    let session = state
        .sessions
        .get(session_id)
        .await
        .ok_or_else(|| format!("session {session_id} not found"))?;
    Ok(fs_for_session(&session))
}

/// `fs_for` for other subsystems (e.g. the disk-usage scanner) that resolve a
/// `RemoteFs` from a session id — same `local`-aware dispatch, exported.
pub async fn fs_for_public(
    session_id: &str,
    state: &AppState,
) -> Result<Box<dyn RemoteFs>, String> {
    fs_for(session_id, state).await
}

pub fn fs_for_session(session: &Arc<Session>) -> Box<dyn RemoteFs> {
    match &**session {
        Session::Ssh(ssh) => Box::new(crate::remotefs::sftp::SftpFs::new(ssh.clone())),
        Session::Ftp(ftp) => Box::new(crate::remotefs::ftp::FtpFs::new(ftp.clone())),
        Session::Object(obj) => {
            Box::new(crate::remotefs::object::ObjectFs::new(obj.clone()))
        }
        Session::Webdav(dav) => Box::new(crate::remotefs::webdav::WebdavFs::new(dav.clone())),
        Session::Http(http) => Box::new(crate::remotefs::http::HttpFs::new(http.clone())),
        Session::Dropbox(dbx) => Box::new(crate::remotefs::dropbox::DropboxFs::new(dbx.clone())),
        Session::OneDrive(od) => Box::new(crate::remotefs::onedrive::OneDriveFs::new(od.clone())),
        Session::GDrive(gd) => Box::new(crate::remotefs::gdrive::GDriveFs::new(gd.clone())),
        Session::Box(bx) => Box::new(crate::remotefs::boxdrive::BoxFs::new(bx.clone())),
        Session::Shopify(sh) => Box::new(crate::remotefs::shopify::ShopifyFs::new(sh.clone())),
        Session::HubSpot(hs) => Box::new(crate::remotefs::hubspot::HubSpotFs::new(hs.clone())),
        Session::Dynamics(dynm) => Box::new(crate::remotefs::dynamics::DynamicsFs::new(dynm.clone())),
        Session::WordPress(wp) => Box::new(crate::remotefs::wordpress::WordPressFs::new(wp.clone())),
        Session::Agent(agent) => Box::new(crate::remotefs::agent::AgentFs::new(agent.clone())),
    }
}

#[tauri::command]
pub async fn rename_path(
    session_id: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), FaroError> {
    let fs = fs_for(&session_id, &state).await?;
    fs.rename(&from, &to).await.map_err(FaroError::from)
}

#[tauri::command]
pub async fn delete_path(
    session_id: String,
    path: String,
    recursive: bool,
    state: State<'_, AppState>,
) -> Result<(), FaroError> {
    let fs = fs_for(&session_id, &state).await?;
    fs.delete(&path, recursive).await.map_err(FaroError::from)
}

#[tauri::command]
pub async fn create_directory(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), FaroError> {
    let fs = fs_for(&session_id, &state).await?;
    fs.create_dir(&path).await.map_err(FaroError::from)
}

#[tauri::command]
pub async fn chmod_path(
    session_id: String,
    path: String,
    mode: u32,
    state: State<'_, AppState>,
) -> Result<(), FaroError> {
    let fs = fs_for(&session_id, &state).await?;
    fs.chmod(&path, mode).await.map_err(FaroError::from)
}

// ---------- Duplicate ----------

/// POSIX single-quote a string so it survives spaces / shell metacharacters when
/// interpolated into a remote command. `'` is closed, escaped, and reopened.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Split a POSIX path into (parent, last-component). "/foo" → ("", "foo"),
/// "/a/b" → ("/a", "b"), "rel" → (".", "rel").
fn split_remote(path: &str) -> (&str, &str) {
    match path.rfind('/') {
        Some(0) => ("", &path[1..]),
        Some(i) => (&path[..i], &path[i + 1..]),
        None => (".", path),
    }
}

/// "foo.txt" + 1 → "foo copy.txt"; + 2 → "foo copy 2.txt". The extension (a dot
/// that isn't the leading char) is preserved; dotfiles / extension-less names
/// just get the suffix appended.
fn copy_name(name: &str, n: usize) -> String {
    let suffix = if n <= 1 {
        " copy".to_string()
    } else {
        format!(" copy {n}")
    };
    match name.rfind('.') {
        Some(i) if i > 0 => format!("{}{}{}", &name[..i], suffix, &name[i..]),
        _ => format!("{name}{suffix}"),
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

fn duplicate_local(path: &str) -> Result<(), String> {
    let src = Path::new(path);
    if !src.exists() {
        return Err(format!("{path} does not exist"));
    }
    let parent = src
        .parent()
        .ok_or_else(|| "can't duplicate this path".to_string())?;
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "invalid file name".to_string())?;

    let mut n = 1;
    let mut dst = parent.join(copy_name(name, n));
    while dst.exists() {
        n += 1;
        if n > 1000 {
            return Err("too many copies already exist".into());
        }
        dst = parent.join(copy_name(name, n));
    }

    if src.is_dir() {
        copy_dir_recursive(src, &dst).map_err(err)?;
    } else {
        std::fs::copy(src, &dst).map_err(err)?;
    }
    Ok(())
}

async fn duplicate_ssh(ssh: &Arc<SshSession>, path: &str) -> Result<(), String> {
    let path = path.trim_end_matches('/');
    let (parent, name) = split_remote(path);
    let mut n = 1;
    let dst = loop {
        let cand = format!("{parent}/{}", copy_name(name, n));
        let probe = ssh
            .exec(&format!("test -e {}", sh_quote(&cand)))
            .await
            .map_err(err)?;
        if probe.exit_code != Some(0) {
            break cand; // doesn't exist yet
        }
        n += 1;
        if n > 1000 {
            return Err("too many copies already exist".into());
        }
    };
    let out = ssh
        .exec(&format!(
            "cp -a -- {} {}",
            sh_quote(path),
            sh_quote(&dst)
        ))
        .await
        .map_err(err)?;
    if out.exit_code != Some(0) {
        let msg = out.stderr.trim();
        return Err(if msg.is_empty() {
            "copy failed".into()
        } else {
            format!("copy failed: {msg}")
        });
    }
    Ok(())
}

/// Copy a file/folder next to the original under a free "… copy" name. Local
/// uses a filesystem copy; SSH uses `cp -a` server-side. FTP/object stores have
/// no copy primitive, so they're refused.
#[tauri::command]
pub async fn duplicate_path(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if session_id == LOCAL_SESSION {
        return duplicate_local(&path);
    }
    let session = state
        .sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session {session_id} not found"))?;
    match &*session {
        Session::Ssh(ssh) => duplicate_ssh(ssh, &path).await,
        _ => Err("Duplicate isn't supported on this connection yet".into()),
    }
}

// ---------- Server-side archive + download ----------

/// Archive a remote directory on the server (a single `tar`/`zip` command) and
/// download the resulting file — far cheaper than walking the tree and pulling
/// each file. The temp archive lives in a unique `/tmp` dir so the downloaded
/// file keeps a friendly name (`<folder>.tar.gz`); it's removed once the
/// transfer settles. SSH/SFTP only.
#[tauri::command]
pub async fn start_archive_download(
    session_id: String,
    remote_path: String,
    format: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let ssh = state
        .sessions
        .get_ssh(&session_id)
        .await
        .ok_or_else(|| "Archiving requires an SSH/SFTP connection".to_string())?;
    let session = state
        .sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session {session_id} not found"))?;

    let folder = remote_path.trim_end_matches('/');
    if folder.is_empty() {
        return Err("Can't archive the filesystem root".into());
    }
    let (parent, base) = split_remote(folder);
    let parent = if parent.is_empty() { "/" } else { parent };

    let is_zip = format == "zip";
    let ext = if is_zip { "zip" } else { "tar.gz" };
    let tmp_dir = format!("/tmp/faro-archive-{}", Uuid::new_v4());
    let tmp = format!("{tmp_dir}/{base}.{ext}");

    // `cd parent` (zip) / `-C parent` (tar) so paths inside the archive are
    // relative to the folder, not absolute.
    let build = if is_zip {
        format!(
            "mkdir -p {dir} && cd {p} && zip -r -q {out} {b}",
            dir = sh_quote(&tmp_dir),
            p = sh_quote(parent),
            out = sh_quote(&tmp),
            b = sh_quote(&format!("./{base}")),
        )
    } else {
        format!(
            "mkdir -p {dir} && tar -czf {out} -C {p} -- {b}",
            dir = sh_quote(&tmp_dir),
            out = sh_quote(&tmp),
            p = sh_quote(parent),
            b = sh_quote(base),
        )
    };

    let out = ssh.exec(&build).await.map_err(err)?;
    if out.exit_code != Some(0) {
        let _ = ssh.exec(&format!("rm -rf {}", sh_quote(&tmp_dir))).await;
        let stderr = out.stderr.trim();
        let hint = if is_zip
            && (stderr.contains("not found") || stderr.contains("command not found"))
        {
            "  (the `zip` command may not be installed on the server — try .tar.gz)"
        } else {
            ""
        };
        return Err(format!(
            "Archive failed: {}{}",
            if stderr.is_empty() {
                "non-zero exit"
            } else {
                stderr
            },
            hint
        ));
    }

    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;
    let local_dir = dir.to_string_lossy().into_owned();

    let id = state
        .transfers
        .start_download(session, tmp.clone(), local_dir, OverwritePolicy::Rename, app)
        .await
        .map_err(err)?;

    // Poll the transfer; once it settles, delete the server-side temp dir.
    let transfers = Arc::clone(&state.transfers);
    let ssh_cleanup = Arc::clone(&ssh);
    let tmp_dir_cleanup = tmp_dir.clone();
    let id_cleanup = id.clone();
    tokio::spawn(async move {
        for _ in 0..14_400u32 {
            tokio::time::sleep(Duration::from_millis(500)).await;
            match transfers.snapshot(&id_cleanup).await {
                Some(t) => {
                    if matches!(
                        t.status,
                        TransferStatus::Done
                            | TransferStatus::Error
                            | TransferStatus::Skipped
                            | TransferStatus::Canceled
                    ) {
                        break;
                    }
                }
                None => break,
            }
        }
        let _ = ssh_cleanup
            .exec(&format!("rm -rf {}", sh_quote(&tmp_dir_cleanup)))
            .await;
    });

    Ok(id)
}

// ---------- Importers (OpenSSH config, FileZilla, PuTTY) ----------

use crate::importers::{self, ProfilePreview};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImporterPaths {
    pub openssh: Option<String>,
    pub filezilla: Option<String>,
    pub putty: Option<String>,
}

#[tauri::command]
pub fn importer_default_paths() -> ImporterPaths {
    ImporterPaths {
        openssh: importers::openssh::default_path().map(|p| p.display().to_string()),
        filezilla: importers::filezilla::default_path().map(|p| p.display().to_string()),
        putty: importers::putty::default_path().map(|p| p.display().to_string()),
    }
}

#[tauri::command]
pub fn import_openssh(path: Option<String>) -> Result<Vec<ProfilePreview>, String> {
    let path = path
        .map(std::path::PathBuf::from)
        .or_else(importers::openssh::default_path)
        .ok_or_else(|| "could not determine ~/.ssh/config location".to_string())?;
    importers::openssh::parse_file(&path).map_err(err)
}

#[tauri::command]
pub fn import_filezilla(path: Option<String>) -> Result<Vec<ProfilePreview>, String> {
    let path = path
        .map(std::path::PathBuf::from)
        .or_else(importers::filezilla::default_path)
        .ok_or_else(|| "could not determine FileZilla sitemanager.xml location".to_string())?;
    importers::filezilla::parse_file(&path).map_err(err)
}

#[tauri::command]
pub fn import_putty() -> Result<Vec<ProfilePreview>, String> {
    importers::putty::parse_default().map_err(err)
}

#[tauri::command]
pub async fn save_imported_profiles(
    previews: Vec<ProfilePreview>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let n = previews.len();
    for preview in previews {
        state
            .profiles
            .upsert(preview.into_profile())
            .await
            .map_err(err)?;
    }
    Ok(n)
}

// ---------- Sync ----------

use crate::sync::{self, SyncDirection, SyncPlan, SyncStrategy};

#[tauri::command]
pub async fn sync_plan(
    session_id: String,
    local_path: String,
    remote_path: String,
    direction: SyncDirection,
    strategy: SyncStrategy,
    state: State<'_, AppState>,
) -> Result<SyncPlan, String> {
    let local_fs: Box<dyn RemoteFs> = Box::new(crate::remotefs::local::LocalFs);
    let remote_fs = fs_for(&session_id, &state).await?;
    sync::plan(
        local_fs.as_ref(),
        remote_fs.as_ref(),
        &local_path,
        &remote_path,
        direction,
        strategy,
    )
    .await
    .map_err(err)
}

#[tauri::command]
pub async fn sync_execute(
    session_id: String,
    plan: SyncPlan,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let session = state
        .sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session {session_id} not found"))?;
    execute_sync_plan(session, plan, &state.transfers, &app)
        .await
        .map_err(err)
}

/// Queue a sync plan's copies through the transfer engine (overwriting the
/// destination — the user confirmed the plan), then apply its Mirror deletes.
/// Shared by the `sync_execute` Tauri command and the Agent Bridge's
/// `faro_sync`, so both paths behave identically.
pub(crate) async fn execute_sync_plan(
    session: Arc<Session>,
    plan: SyncPlan,
    transfers: &Arc<crate::transfer::TransferManager>,
    app: &AppHandle,
) -> anyhow::Result<Vec<String>> {
    let local_fs: Box<dyn RemoteFs> = Box::new(crate::remotefs::local::LocalFs);
    let remote_fs = fs_for_session(&session);

    let mut ids = Vec::new();
    let policy = crate::transfer::OverwritePolicy::Overwrite;

    for copy in plan.copies {
        let dest_parent = parent_of(&copy.destination_path);
        let id = match plan.direction {
            SyncDirection::LocalToRemote => {
                transfers
                    .start_upload(
                        session.clone(),
                        copy.source_path,
                        dest_parent,
                        policy,
                        app.clone(),
                    )
                    .await?
            }
            SyncDirection::RemoteToLocal => {
                transfers
                    .start_download(
                        session.clone(),
                        copy.source_path,
                        dest_parent,
                        policy,
                        app.clone(),
                    )
                    .await?
            }
        };
        ids.push(id);
    }

    // Apply Mirror deletes after queueing transfers. We don't gate on
    // transfer completion — the user already confirmed the plan — but we
    // do execute deletes serially in this call so the function only
    // returns once the destination is in its final shape.
    for d in plan.deletes {
        let fs: &dyn RemoteFs = match plan.direction {
            SyncDirection::LocalToRemote => remote_fs.as_ref(),
            SyncDirection::RemoteToLocal => local_fs.as_ref(),
        };
        let _ = fs.delete(&d.path, false).await; // best-effort
    }

    Ok(ids)
}

fn parent_of(p: &str) -> String {
    let last_slash = p.rfind(|c: char| c == '/' || c == '\\');
    match last_slash {
        Some(0) => "/".to_string(),
        Some(i) => p[..i].to_string(),
        None => ".".to_string(),
    }
}

// ---------- Edit-in-place ----------

#[tauri::command]
pub async fn start_edit(
    session_id: String,
    remote_path: String,
    editor: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::editor::EditStartedEvent, String> {
    let session = state
        .sessions
        .get(&session_id)
        .await
        .ok_or_else(|| format!("session {session_id} not found"))?;
    state
        .editors
        .start(session, session_id, remote_path, editor, app)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn stop_edit(
    edit_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.editors.stop(&edit_id).await.map_err(err)
}

// ---------- Agent Bridge ----------

use crate::bridge::{ActivityEntry, ApprovalDecision, ApprovalPolicy, BridgeStatus, SavedCommand, Skill};

#[tauri::command]
pub async fn bridge_start(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BridgeStatus, String> {
    state.bridge.start(app).await.map_err(err)
}

#[tauri::command]
pub async fn bridge_stop(state: State<'_, AppState>) -> Result<BridgeStatus, String> {
    state.bridge.stop().await;
    Ok(state.bridge.status().await)
}

/// The master on/off switch (persisted, default off). On => start + publish the
/// discovery file + auto-start next launch; off => stop + remove the token/file.
#[tauri::command]
pub async fn bridge_set_enabled(
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BridgeStatus, String> {
    state.bridge.set_enabled(app, enabled).await.map_err(err)
}

#[tauri::command]
pub async fn bridge_status(state: State<'_, AppState>) -> Result<BridgeStatus, String> {
    Ok(state.bridge.status().await)
}

#[tauri::command]
pub async fn bridge_set_session_access(
    session_id: String,
    enabled: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<BridgeStatus, String> {
    state.bridge.set_access(&app, &session_id, enabled).await;
    Ok(state.bridge.status().await)
}

#[tauri::command]
pub async fn bridge_set_policy(
    policy: ApprovalPolicy,
    state: State<'_, AppState>,
) -> Result<BridgeStatus, String> {
    state.bridge.set_policy(policy).await;
    Ok(state.bridge.status().await)
}

#[tauri::command]
pub async fn respond_to_bridge_approval(
    request_id: String,
    decision: ApprovalDecision,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .bridge
        .resolve_approval(&request_id, decision)
        .await
        .map_err(err)
}

#[tauri::command]
pub async fn bridge_activity(
    state: State<'_, AppState>,
) -> Result<Vec<ActivityEntry>, String> {
    Ok(state.bridge.recent_activity().await)
}

#[tauri::command]
pub async fn bridge_clear_activity(state: State<'_, AppState>) -> Result<(), String> {
    state.bridge.clear_activity().await;
    Ok(())
}

// ---------- Saved commands (pre-approved; local-UI managed only) ----------

#[tauri::command]
pub async fn bridge_list_commands(
    state: State<'_, AppState>,
) -> Result<Vec<SavedCommand>, String> {
    Ok(state.bridge.list_commands().await)
}

#[tauri::command]
pub async fn bridge_save_command(
    command: SavedCommand,
    state: State<'_, AppState>,
) -> Result<Vec<SavedCommand>, String> {
    Ok(state.bridge.upsert_command(command).await)
}

#[tauri::command]
pub async fn bridge_delete_command(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<SavedCommand>, String> {
    Ok(state.bridge.delete_command(&id).await)
}

// ---------- Skills (Plan 8; local-UI authoring + fleet runner) ----------

#[tauri::command]
pub async fn bridge_list_skills(state: State<'_, AppState>) -> Result<Vec<Skill>, String> {
    Ok(state.bridge.list_skills().await)
}

/// Create/update a hand-authored Skill (born approved). Keyed by id; a blank id
/// mints a new one. Local-UI only — the agent's write path is `faro_save_skill`,
/// which forces a proposal.
#[tauri::command]
pub async fn bridge_save_skill(
    skill: Skill,
    state: State<'_, AppState>,
) -> Result<Vec<Skill>, String> {
    Ok(state.bridge.upsert_skill(skill).await)
}

#[tauri::command]
pub async fn bridge_delete_skill(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Skill>, String> {
    Ok(state.bridge.delete_skill(&id).await)
}

/// Approve a proposed (AI-authored) Skill so it becomes runnable — the one human
/// gate on the agent's authoring path.
#[tauri::command]
pub async fn bridge_approve_skill(
    id: String,
    state: State<'_, AppState>,
) -> Result<Vec<Skill>, String> {
    Ok(state.bridge.approve_skill(&id).await)
}

/// Run a Skill across its targets from the GUI. Returns the aggregated per-target
/// result on success; a hard failure (proposal not approved, no targets, unknown
/// skill) surfaces as an error.
#[tauri::command]
pub async fn bridge_run_skill(
    name: String,
    params: std::collections::HashMap<String, String>,
    targets: Option<Vec<String>>,
    dry_run: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let (status, body) =
        crate::bridge::op_run_skill(&app, &state.bridge, &name, params, targets, dry_run).await;
    if status == 200 {
        Ok(body)
    } else {
        Err(body
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or("skill run failed")
            .to_string())
    }
}

// ---------- Agent console export ----------

/// Write the Agent console's text to the user's Downloads folder (falling back
/// to the app data dir) and return the saved path. Kept plugin-free to match the
/// rest of the app — a direct write, not the dialog/fs plugins. `name` is the
/// caller-suggested filename; path separators are stripped and a name collision
/// gets a " (n)" suffix so an export never clobbers an existing file.
#[tauri::command]
pub async fn export_agent_log(
    content: String,
    name: String,
    app: AppHandle,
) -> Result<String, String> {
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(err)?;
    std::fs::create_dir_all(&dir).map_err(err)?;

    let safe: String = name.chars().filter(|c| !matches!(c, '/' | '\\')).collect();
    let safe = if safe.trim().is_empty() {
        "faro-agent-console.txt".to_string()
    } else {
        safe
    };
    let (stem, ext) = match safe.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (safe.clone(), String::new()),
    };
    let mut path = dir.join(&safe);
    let mut n = 1;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::write(&path, content).map_err(err)?;
    Ok(path.to_string_lossy().into_owned())
}

// ---------- Agent Bridge ----------

/// Notify the bridge which session is currently focused in the UI. The bridge
/// exposes this in `faro_context` so agents know what the user is looking at.
#[tauri::command]
pub async fn bridge_set_active_session(
    session_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.bridge.set_active_session(session_id).await;
    Ok(())
}

// ---------- Service credentials (Plan 12 Phase 1) ----------

/// Store (or clear, if `value` is empty) a service credential in the OS
/// keychain, keyed by `purpose`. **One-way** — there is deliberately no command
/// that reads the value back; Rust fetches it at the point of use. Also updates
/// the `faro.db` keychain manifest so the encrypted backup can enumerate it.
#[tauri::command]
pub async fn set_api_key(
    purpose: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    crate::credentials::set_secret(&purpose, &value).map_err(err)?;
    if value.is_empty() {
        state
            .db
            .forget_keychain(crate::credentials::SERVICE, &purpose)
            .map_err(err)?;
    } else {
        state
            .db
            .record_keychain(crate::credentials::SERVICE, &purpose)
            .map_err(err)?;
    }
    Ok(())
}

/// Whether a credential exists for `purpose`. The only credential state the
/// frontend gets — enough to render a Set/••••/Clear affordance.
#[tauri::command]
pub async fn api_key_status(purpose: String) -> Result<bool, String> {
    Ok(crate::credentials::has_secret(&purpose))
}

// ---------- Settings (Plan 12 Phase 2) ----------

/// Every persisted setting as `key -> raw JSON value`. The frontend store seeds
/// itself from the pre-paint injection when it can; this is the async fallback
/// (popout windows, or reconciling after a background write).
#[tauri::command]
pub async fn settings_get_all(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    state.db.settings_get_all().map_err(err)
}

/// Open a web link (About → GitHub, Help → Report an issue, release notes) in
/// the system browser. The webview's `window.open` doesn't reach the OS
/// browser under Tauri 2, so the frontend routes every external link here.
/// Only http(s) — anything else could launch an arbitrary local handler.
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("invalid URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!("refusing to open a {} link", parsed.scheme()));
    }
    crate::proc::open_in_browser(parsed.as_str()).map_err(|e| e.to_string())
}

/// Faro's fixed app id for WordPress's "Authorize Application" page (it
/// must be a UUID; WordPress uses it to group the passwords it issues).
const WORDPRESS_APP_ID: &str = "8c4e4c26-3b8f-4f0e-9a6e-2f6d7f3c5a91";

/// Open the site's "Authorize Application" page in the browser with Faro's
/// name filled in. The admin approves there and WordPress shows the new
/// Application Password on the page; they paste it into the editor.
/// (WordPress can't hand it back by itself: its page drops redirect URLs
/// that aren't http(s), and plain-http loopback is refused off local sites.)
/// Returns the normalized site address and the link, shown as a fallback
/// when no browser opens.
#[tauri::command]
pub async fn wordpress_authorize(site: String) -> Result<WordPressAuthorize, String> {
    let (base, authorize) = crate::session::wordpress::authorize_endpoint(&site)
        .await
        .map_err(err)?;
    let mut url = url::Url::parse(&authorize).map_err(|e| format!("bad authorize URL: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("the site's authorize page isn't http(s)".into());
    }
    url.query_pairs_mut()
        .append_pair("app_name", "Faro")
        .append_pair("app_id", WORDPRESS_APP_ID);
    // A browser that fails to start isn't fatal — the editor shows the link.
    if let Err(e) = crate::proc::open_in_browser(url.as_str()) {
        tracing::warn!("wordpress authorize: couldn't open the browser: {e}");
    }
    Ok(WordPressAuthorize { site: base, authorize_url: url.to_string() })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WordPressAuthorize {
    site: String,
    authorize_url: String,
}

/// Upsert one setting. `value` is a raw JSON string (the frontend stringifies).
#[tauri::command]
pub async fn settings_set(
    key: String,
    value: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.settings_set(&key, &value).map_err(err)
}

/// Delete one setting row (reset-to-default for shortcut overrides & friends).
#[tauri::command]
pub async fn settings_delete(
    key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.db.settings_delete(&key).map_err(err)
}

/// Bulk-upsert settings in one transaction — the one-time localStorage import.
#[tauri::command]
pub async fn settings_set_all(
    values: std::collections::HashMap<String, String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let entries: Vec<(String, String)> = values.into_iter().collect();
    state.db.settings_set_many(&entries).map_err(err)
}

// ---------- Encrypted backup / restore (Plan 12 Phase 4) ----------

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, FaroError> {
    app.path()
        .app_data_dir()
        .map_err(|e| FaroError::other(format!("resolving app data dir: {e}")))
}

/// Export an encrypted backup (profiles + faro.db + configs + all keychain
/// credentials) to `path`, protected by `password`.
#[tauri::command]
pub async fn backup_export(
    path: String,
    password: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<crate::backup::BackupSummary, FaroError> {
    let dir = app_data_dir(&app)?;
    crate::backup::export(&dir, &state.db, &password, Path::new(&path)).map_err(FaroError::from)
}

/// Decrypt a backup and report what's inside — without applying it (the UI's
/// "what's inside" confirmation before restoring).
#[tauri::command]
pub async fn backup_inspect(
    path: String,
    password: String,
) -> Result<crate::backup::BackupSummary, FaroError> {
    crate::backup::inspect(&password, Path::new(&path)).map_err(FaroError::from)
}

/// Restore a backup: stage its files (applied on next launch) and inject its
/// keychain credentials now. The frontend prompts the user to restart.
#[tauri::command]
pub async fn backup_import(
    path: String,
    password: String,
    app: AppHandle,
) -> Result<crate::backup::BackupSummary, FaroError> {
    let dir = app_data_dir(&app)?;
    // defer = true: the GUI has files open, so stage + swap on next startup.
    crate::backup::import(&dir, &password, Path::new(&path), true).map_err(FaroError::from)
}

/// Register Faro's MCP server with Claude Code so the user doesn't have to
/// copy/paste the `claude mcp add` command. Best-effort: reports success or
/// the error text so the UI can guide the user.
#[tauri::command]
pub async fn bridge_register_mcp(url: String, token: String) -> Result<String, String> {
    // Try the most likely binary names across platforms.
    let candidates: Vec<&str> = if cfg!(windows) {
        vec!["claude.exe", "claude"]
    } else {
        vec!["claude"]
    };

    let args = [
        "mcp",
        "add",
        "--transport",
        "http",
        "faro",
        &url,
        "--header",
        &format!("Authorization: Bearer {token}"),
    ];

    let mut last_err = String::new();
    for bin in candidates {
        let output = std::process::Command::new(bin)
            .args(&args)
            .no_console_window()
            .output()
            .map_err(|e| format!("couldn't run {bin}: {e}"))?;
        if output.status.success() {
            return Ok(format!(
                "Faro MCP server registered as 'faro'. Claude Code can now use it."
            ));
        }
        last_err = format!(
            "{} exited with {}: {}",
            bin,
            output.status,
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Err(format!(
        "Couldn't register the MCP server automatically. Make sure Claude Code is installed and on your PATH. {last_err}"
    ))
}
