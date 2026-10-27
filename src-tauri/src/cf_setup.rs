//! Cloudflare team actions on a server (issue #57): inviting a teammate, and
//! the root commands both invites and the "move this server behind
//! Cloudflare" setup need on the server.
//!
//! Short-lived certificates name their principal after the user part of the
//! signed-in email (`jane.doe@example.com` -> `jane.doe`). A server set up by
//! Faro trusts the Access application's CA and reads the principals allowed
//! for each local user from `/etc/ssh/faro_principals/<user>`, so several
//! people can share an account (`deploy`) without sharing a key. An invite
//! adds the email to the application's Access policy and the principal to
//! that file; removing reverses both.
//!
//! Root on the server: when the connection is live, Faro runs the command
//! with `sudo` (shown first); otherwise it hands over one command to paste
//! into any root console.

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};

use crate::cloudflare_api::{self, Api};
use crate::profiles::{ConnectionProfile, ProxyCommandKind};

pub const PRINCIPALS_DIR: &str = "/etc/ssh/faro_principals";

/// A name safe to put in a shell command and a file name unquoted.
fn is_safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// The principal Cloudflare puts in `email`'s certificates.
pub fn principal_for(email: &str) -> Result<String> {
    let email = email.trim();
    let (local, domain) = email.split_once('@').ok_or_else(|| anyhow!("{email} isn't an email address"))?;
    if domain.is_empty() || !domain.contains('.') {
        bail!("{email} isn't an email address");
    }
    if !is_safe_name(local) {
        bail!("the user part of {email} can't be an SSH principal; use letters, digits, dot, dash or underscore");
    }
    Ok(local.to_string())
}

/// The root command that lets `principal` log in as `user` (or stops it).
pub fn principal_command(user: &str, principal: &str, add: bool) -> Result<String> {
    if !is_safe_name(user) {
        bail!("the server username '{user}' has characters Faro won't put in a root command");
    }
    if !is_safe_name(principal) {
        bail!("'{principal}' can't be an SSH principal");
    }
    let file = format!("{PRINCIPALS_DIR}/{user}");
    Ok(if add {
        format!(
            "mkdir -p {PRINCIPALS_DIR} && touch {file} && chmod 644 {file} && (grep -qxF {principal} {file} || echo {principal} >> {file})"
        )
    } else {
        format!("[ -f {file} ] && sed -i '/^{}$/d' {file} || true", principal.replace('.', "\\."))
    })
}

/// `s` as one single-quoted shell word.
pub fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The Access hostname a connection goes through.
pub fn access_hostname(p: &ConnectionProfile) -> Result<String> {
    match &p.proxy_command {
        Some(c) if c.kind == ProxyCommandKind::Cloudflare => Ok(c
            .hostname
            .clone()
            .filter(|h| !h.trim().is_empty())
            .unwrap_or_else(|| p.host.clone())),
        _ => bail!("{} isn't reached through Cloudflare", p.name),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvitePlan {
    pub email: String,
    pub principal: String,
    pub username: String,
    pub hostname: String,
    /// Whether the Access policy changed (false: it already said so).
    pub policy_changed: bool,
    /// What to run as root on the server for step 2.
    pub root_command: String,
}

/// Steps 1 and 2 of an invite (or of removing someone): the Access policy
/// through the API, and the root command for the principals file.
pub async fn invite(api: &Api, account: &str, profile: &ConnectionProfile, email: &str, add: bool) -> Result<InvitePlan> {
    let principal = principal_for(email)?;
    let hostname = access_hostname(profile)?;
    let root_command = principal_command(&profile.username, &principal, add)?;
    let app = api.app_for_hostname(account, &hostname).await?;
    let policy_changed = cloudflare_api::set_person(api, account, &app.id, email, add).await?;
    Ok(InvitePlan {
        email: email.trim().to_ascii_lowercase(),
        principal,
        username: profile.username.clone(),
        hostname,
        policy_changed,
        root_command,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootRun {
    pub ok: bool,
    pub output: String,
    pub exit_code: Option<i32>,
    /// sudo wants a password and none was given: ask, or offer the paste.
    pub needs_password: bool,
}

/// Run `script` as root over a live SSH session: as root already, with
/// `sudo -n`, or with sudo answering its prompt with `password`.
pub async fn run_root(ssh: &crate::session::SshSession, script: &str, password: Option<&str>) -> Result<RootRun> {
    use std::time::Duration;
    let limit = 1 << 20;
    let timeout = Duration::from_secs(300);
    let quoted = sh_quote(script);
    let id = ssh.exec_bounded("id -u", 64, Duration::from_secs(20), None).await?;
    let out = if id.stdout.trim() == "0" {
        ssh.exec_bounded(&format!("sh -c {quoted}"), limit, timeout, None).await?
    } else {
        let probe = ssh.exec_bounded("sudo -n true", 4096, Duration::from_secs(20), None).await?;
        if probe.exit_code == Some(0) {
            ssh.exec_bounded(&format!("sudo -n sh -c {quoted}"), limit, timeout, None).await?
        } else {
            match password.filter(|p| !p.is_empty()) {
                Some(pw) => ssh.exec_sudo(&format!("sudo sh -c {quoted}"), pw, limit, timeout, None).await?,
                None => {
                    return Ok(RootRun {
                        ok: false,
                        output: probe.stderr.trim().to_string(),
                        exit_code: probe.exit_code,
                        needs_password: true,
                    })
                }
            }
        }
    };
    let output = [out.stdout.trim_end(), out.stderr.trim_end()].iter().filter(|s| !s.is_empty()).cloned().collect::<Vec<_>>().join("\n");
    Ok(RootRun { ok: out.exit_code == Some(0), output, exit_code: out.exit_code, needs_password: false })
}

// ---- Commands ----

use crate::AppState;
use tauri::{AppHandle, Manager, State};

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

async fn account_and_profile(
    app: &AppHandle,
    state: &State<'_, AppState>,
    profile_id: &str,
) -> Result<(Api, String, ConnectionProfile), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (api, account) = cloudflare_api::connected(&dir).map_err(err)?;
    let profile = state
        .profiles
        .get(profile_id)
        .await
        .map_err(err)?
        .ok_or_else(|| "that connection no longer exists".to_string())?;
    Ok((api, account, profile))
}

/// Who the connection's Access application lets in.
#[tauri::command]
pub async fn cf_access_people(profile_id: String, app: AppHandle, state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let (api, account, profile) = account_and_profile(&app, &state, &profile_id).await?;
    let hostname = access_hostname(&profile).map_err(err)?;
    let app_id = api.app_for_hostname(&account, &hostname).await.map_err(err)?.id;
    cloudflare_api::people(&api, &account, &app_id).await.map_err(err)
}

/// Invite `email` to the connection (`add`), or remove them.
#[tauri::command]
pub async fn cf_invite(
    profile_id: String,
    email: String,
    add: bool,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<InvitePlan, String> {
    let (api, account, profile) = account_and_profile(&app, &state, &profile_id).await?;
    invite(&api, &account, &profile, &email, add).await.map_err(err)
}

/// Run a root command on a live SSH session (after the user saw it).
#[tauri::command]
pub async fn ssh_run_as_root(
    session_id: String,
    script: String,
    password: Option<String>,
    state: State<'_, AppState>,
) -> Result<RootRun, String> {
    let ssh = state
        .sessions
        .get_ssh(&session_id)
        .await
        .ok_or_else(|| "that server isn't connected".to_string())?;
    run_root(&ssh, &script, password.as_deref()).await.map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn principals_and_commands() {
        assert_eq!(principal_for("Jane.Doe@example.com").unwrap(), "Jane.Doe");
        assert!(principal_for("not-an-email").is_err());
        assert!(principal_for("a b@example.com").is_err());
        assert!(principal_for("x@localhost").is_err());
        assert_eq!(
            principal_command("deploy", "jane.doe", true).unwrap(),
            "mkdir -p /etc/ssh/faro_principals && touch /etc/ssh/faro_principals/deploy && chmod 644 /etc/ssh/faro_principals/deploy && (grep -qxF jane.doe /etc/ssh/faro_principals/deploy || echo jane.doe >> /etc/ssh/faro_principals/deploy)"
        );
        assert_eq!(
            principal_command("deploy", "jane.doe", false).unwrap(),
            "[ -f /etc/ssh/faro_principals/deploy ] && sed -i '/^jane\\.doe$/d' /etc/ssh/faro_principals/deploy || true"
        );
        assert!(principal_command("root; rm -rf /", "x", true).is_err());
        assert!(principal_command("deploy", "-x", true).is_err());
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
    }

    #[tokio::test]
    async fn invites_edit_the_access_policy() {
        use crate::cloudflare_api::tests::{start, ACCOUNT};
        use serde_json::json;
        let apps = format!("accounts/{ACCOUNT}/access/apps");
        let cf = start(
            "invite",
            json!({
                apps.clone(): [{ "id": "app1", "name": "web-1", "domain": "web-1-ssh.example.com", "type": "self_hosted" }],
                format!("{apps}/app1/policies"): [
                    { "id": "p1", "name": "team", "decision": "allow", "include": [{ "email": { "email": "owner@example.com" } }] },
                    { "id": "p2", "name": "ci", "decision": "non_identity", "include": [{ "service_token": { "token_id": "st" } }] },
                ],
            }),
        );
        let mut p = crate::importers::ProfilePreview::new("web-1").into_profile();
        p.host = "web-1-ssh.example.com".into();
        p.username = "deploy".into();
        p.proxy_command = Some(crate::profiles::ProxyCommandConfig {
            kind: ProxyCommandKind::Cloudflare,
            command: String::new(),
            hostname: None,
            service_token_id: None,
            service_token_secret: None,
        });
        let api = cf.api();
        let plan = invite(&api, ACCOUNT, &p, "Jane.Doe@Example.com", true).await.unwrap();
        assert!(plan.policy_changed);
        assert_eq!((plan.principal.as_str(), plan.email.as_str()), ("Jane.Doe", "jane.doe@example.com"));
        assert!(plan.root_command.contains("echo Jane.Doe >> /etc/ssh/faro_principals/deploy"));
        let people = cloudflare_api::people(&api, ACCOUNT, "app1").await.unwrap();
        assert_eq!(people, ["jane.doe@example.com", "owner@example.com"]);
        // Inviting again changes nothing; the service-token policy is untouched.
        assert!(!invite(&api, ACCOUNT, &p, "jane.doe@example.com", true).await.unwrap().policy_changed);
        let store = cf.store();
        let policies = &store[format!("{apps}/app1/policies")];
        assert_eq!(policies[1]["decision"], "non_identity");

        let removed = invite(&api, ACCOUNT, &p, "jane.doe@example.com", false).await.unwrap();
        assert!(removed.policy_changed && removed.root_command.contains("sed -i"));
        assert_eq!(cloudflare_api::people(&api, ACCOUNT, "app1").await.unwrap(), ["owner@example.com"]);

        // A direct connection can't be invited to.
        p.proxy_command = None;
        assert!(invite(&api, ACCOUNT, &p, "x@example.com", true).await.unwrap_err().to_string().contains("isn't reached through Cloudflare"));
    }
}
