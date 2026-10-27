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

// ---- Move a server behind Cloudflare ----

/// Where the setup script puts the Access CA, and the sshd_config markers.
pub const CA_FILE: &str = "/etc/ssh/faro_cloudflare_ca.pub";
const BLOCK_BEGIN: &str = "# BEGIN faro-cloudflare";
const BLOCK_END: &str = "# END faro-cloudflare";
/// The last line a successful setup script prints.
pub const SETUP_OK: &str = "FARO_SETUP_OK";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupRequest {
    /// e.g. `web-1`: `web-1-ssh.<zone>` and `web-1-panel.<zone>`.
    pub name: String,
    pub zone_id: String,
    pub zone_name: String,
    /// A web control panel on this local port, published too.
    #[serde(default)]
    pub panel_port: Option<u16>,
    /// Emails, or `@domain` for everyone with an email there.
    pub people: Vec<String>,
}

/// Something setup created in the account, and how to delete it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub label: String,
    /// API path to DELETE.
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupState {
    pub ssh_hostname: String,
    pub panel_hostname: Option<String>,
    pub tunnel_id: String,
    pub ca_public_key: String,
    /// Run once as root on the server.
    pub script: String,
    /// Undoes the script's server changes, as root.
    pub undo_script: String,
    pub created: Vec<Created>,
}

/// A one-level label: deeper names need Advanced Certificate Manager.
fn check_label(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 50
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
        && !name.starts_with('-')
        && !name.ends_with('-');
    if !ok {
        bail!("use letters, digits and dashes for the name (it becomes {name}-ssh.<domain>), with no dots");
    }
    Ok(())
}

fn people_rules(people: &[String]) -> Result<Vec<serde_json::Value>> {
    use serde_json::json;
    let mut rules = Vec::new();
    for who in people.iter().map(|p| p.trim()).filter(|p| !p.is_empty()) {
        if let Some(domain) = who.strip_prefix('@') {
            if !domain.contains('.') {
                bail!("{who} isn't an email domain");
            }
            rules.push(json!({ "email_domain": { "domain": domain.to_ascii_lowercase() } }));
        } else {
            principal_for(who)?;
            rules.push(json!({ "email": { "email": who.to_ascii_lowercase() } }));
        }
    }
    if rules.is_empty() {
        bail!("say who gets in: at least one email or @domain");
    }
    Ok(rules)
}

/// The root script for the server: install cloudflared as a service with
/// the tunnel's token, trust the Access CA, list the principals that may log
/// in as `user`, and switch sshd over, restoring the old config if `sshd -t`
/// rejects the new one.
pub fn setup_script(tunnel_token: &str, ca_key: &str, user: &str, people: &[String]) -> Result<String> {
    if !is_safe_name(user) {
        bail!("the server username '{user}' has characters Faro won't put in a root command");
    }
    if !tunnel_token.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '=' | '+' | '/' | '.')) {
        bail!("Cloudflare returned an unexpected tunnel token");
    }
    if ca_key.contains('\'') || ca_key.contains('\n') {
        bail!("Cloudflare returned an unexpected CA key");
    }
    let principals: Vec<String> = people
        .iter()
        .filter(|p| !p.trim().starts_with('@'))
        .map(|p| principal_for(p))
        .collect::<Result<_>>()?;
    let mut s = String::new();
    s.push_str("set -e\n");
    s.push_str("# Faro: put this server behind Cloudflare.\n");
    s.push_str("# 1. cloudflared, as a service connected to this server's tunnel.\n");
    s.push_str(r#"if ! command -v cloudflared >/dev/null 2>&1; then
  case "$(uname -m)" in
    x86_64|amd64) a=amd64 ;; aarch64|arm64) a=arm64 ;; armv7l|armhf) a=arm ;; i386|i686) a=386 ;;
    *) echo "No cloudflared build for $(uname -m)"; exit 1 ;;
  esac
  u="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$a"
  if command -v curl >/dev/null 2>&1; then curl -fsSL -o /usr/local/bin/cloudflared "$u"; else wget -qO /usr/local/bin/cloudflared "$u"; fi
  chmod 755 /usr/local/bin/cloudflared
fi
"#);
    s.push_str(&format!("cloudflared service install {tunnel_token}\n"));
    s.push_str("# 2. Trust Cloudflare Access certificates, and who may log in as this user.\n");
    s.push_str(&format!("printf '%s\\n' '{ca_key}' > {CA_FILE}\nchmod 644 {CA_FILE}\n"));
    s.push_str(&format!("mkdir -p {PRINCIPALS_DIR}\n"));
    for p in &principals {
        s.push_str(&principal_command(user, p, true)?);
        s.push('\n');
    }
    s.push_str("# 3. sshd: the new settings go first; a config sshd rejects is put back.\n");
    s.push_str(&format!(
        r#"conf=/etc/ssh/sshd_config
backup=/etc/ssh/sshd_config.faro-backup
cp -p "$conf" "$backup"
sed -i '/^{BLOCK_BEGIN}$/,/^{BLOCK_END}$/d' "$conf"
{{
  echo '{BLOCK_BEGIN}'
  echo 'TrustedUserCAKeys {CA_FILE}'
  echo 'AuthorizedPrincipalsFile {PRINCIPALS_DIR}/%u'
  echo '{BLOCK_END}'
  cat "$conf"
}} > "$conf.faro-new"
cat "$conf.faro-new" > "$conf" && rm -f "$conf.faro-new"
sshd_bin=$(command -v sshd || echo /usr/sbin/sshd)
if ! "$sshd_bin" -t; then
  cp -p "$backup" "$conf"
  echo "sshd rejected the new settings, so the old sshd_config is back. Nothing else changed in sshd."
  exit 1
fi
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || service sshd reload 2>/dev/null || kill -HUP "$(cat /var/run/sshd.pid)"
echo {SETUP_OK}
"#
    ));
    Ok(s)
}

/// Undo the script: the service, the CA, the sshd block, the principals.
pub fn undo_script() -> String {
    format!(
        r#"set -e
cloudflared service uninstall 2>/dev/null || true
conf=/etc/ssh/sshd_config
sed -i '/^{BLOCK_BEGIN}$/,/^{BLOCK_END}$/d' "$conf"
rm -f {CA_FILE} /etc/ssh/sshd_config.faro-backup
rm -rf {PRINCIPALS_DIR}
sshd_bin=$(command -v sshd || echo /usr/sbin/sshd)
"$sshd_bin" -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || service sshd reload 2>/dev/null || kill -HUP "$(cat /var/run/sshd.pid)"
echo {SETUP_OK}
"#
    )
}

/// Delete what setup created, newest first. Best effort: every item is tried,
/// and the failures come back.
pub async fn undo(api: &Api, created: &[Created]) -> Vec<String> {
    let mut failed = Vec::new();
    for c in created.iter().rev() {
        if let Err(e) = api.delete(&c.path).await {
            failed.push(format!("{}: {e:#}", c.label));
        }
    }
    failed
}

/// The Cloudflare side of moving `profile` behind Cloudflare, through the
/// API: a login method if the account has none, a tunnel with its routes,
/// DNS records, an Access application per hostname with its policies, and
/// the application's short-lived certificate CA. On failure, everything
/// created so far is deleted again.
pub async fn setup_cloudflare(api: &Api, account: &str, profile: &ConnectionProfile, req: &SetupRequest, service_token_id: Option<&str>) -> Result<SetupState> {
    check_label(&req.name)?;
    let rules = people_rules(&req.people)?;
    if !is_safe_name(&profile.username) {
        bail!("the connection's username '{}' can't be used in the server setup", profile.username);
    }
    let mut created = Vec::new();
    match setup_steps(api, account, profile, req, service_token_id, rules, &mut created).await {
        Ok(state) => Ok(state),
        Err(e) => {
            let failed = undo(api, &created).await;
            if failed.is_empty() {
                Err(e.context("setup stopped, and what it had created in Cloudflare was deleted again"))
            } else {
                Err(e.context(format!("setup stopped, and these couldn't be deleted again: {}", failed.join("; "))))
            }
        }
    }
}

async fn setup_steps(
    api: &Api,
    account: &str,
    profile: &ConnectionProfile,
    req: &SetupRequest,
    service_token_id: Option<&str>,
    rules: Vec<serde_json::Value>,
    created: &mut Vec<Created>,
) -> Result<SetupState> {
    use serde_json::{json, Value};
    let zone = req.zone_name.trim().trim_end_matches('.').to_ascii_lowercase();
    let ssh_host = format!("{}-ssh.{zone}", req.name.to_ascii_lowercase());
    let panel_host = req.panel_port.map(|_| format!("{}-panel.{zone}", req.name.to_ascii_lowercase()));
    let hosts: Vec<&String> = std::iter::once(&ssh_host).chain(panel_host.iter()).collect();

    // Names already taken stop us before anything is created.
    for h in &hosts {
        let existing: Vec<Value> = api.get(&format!("zones/{}/dns_records?name={h}", req.zone_id)).await?;
        if !existing.is_empty() {
            bail!("{h} already has a DNS record; pick another name");
        }
    }

    // A login method, so people can sign in at all.
    let idps: Vec<Value> = api.get(&format!("accounts/{account}/access/identity_providers")).await?;
    if idps.is_empty() {
        let idp: Value = api
            .post(
                &format!("accounts/{account}/access/identity_providers"),
                json!({ "name": "One-time PIN", "type": "onetimepin", "config": {} }),
            )
            .await?;
        created.push(Created {
            label: "login method: one-time PIN by email".into(),
            path: format!("accounts/{account}/access/identity_providers/{}", idp["id"].as_str().unwrap_or("")),
        });
    }

    let tunnel: Value = api
        .post(
            &format!("accounts/{account}/cfd_tunnel"),
            json!({ "name": format!("faro-{}", req.name.to_ascii_lowercase()), "config_src": "cloudflare" }),
        )
        .await?;
    let tunnel_id = tunnel["id"].as_str().ok_or_else(|| anyhow!("Cloudflare didn't return the tunnel's id"))?.to_string();
    created.push(Created { label: format!("tunnel faro-{}", req.name.to_ascii_lowercase()), path: format!("accounts/{account}/cfd_tunnel/{tunnel_id}") });

    let mut ingress = vec![json!({ "hostname": ssh_host, "service": format!("ssh://localhost:{}", if profile.port == 0 { 22 } else { profile.port }) })];
    if let (Some(h), Some(port)) = (&panel_host, req.panel_port) {
        ingress.push(json!({ "hostname": h, "service": format!("http://localhost:{port}") }));
    }
    ingress.push(json!({ "service": "http_status:404" }));
    api.put::<Value>(&format!("accounts/{account}/cfd_tunnel/{tunnel_id}/configurations"), json!({ "config": { "ingress": ingress } }))
        .await?;

    for h in &hosts {
        let rec: Value = api
            .post(
                &format!("zones/{}/dns_records", req.zone_id),
                json!({ "type": "CNAME", "name": h, "content": format!("{tunnel_id}.cfargotunnel.com"), "proxied": true, "comment": "Faro" }),
            )
            .await?;
        created.push(Created { label: format!("DNS record {h}"), path: format!("zones/{}/dns_records/{}", req.zone_id, rec["id"].as_str().unwrap_or("")) });
    }

    let mut ca_key = String::new();
    for (i, h) in hosts.iter().enumerate() {
        let app: Value = api
            .post(
                &format!("accounts/{account}/access/apps"),
                json!({
                    "name": if i == 0 { format!("{} SSH", req.name) } else { format!("{} panel", req.name) },
                    "domain": h,
                    "type": "self_hosted",
                    "session_duration": "24h",
                    "app_launcher_visible": false,
                }),
            )
            .await?;
        let app_id = app["id"].as_str().ok_or_else(|| anyhow!("Cloudflare didn't return the Access application's id"))?.to_string();
        created.push(Created { label: format!("Access application {h}"), path: format!("accounts/{account}/access/apps/{app_id}") });
        let policies = format!("accounts/{account}/access/apps/{app_id}/policies");
        api.post::<Value>(&policies, json!({ "name": cloudflare_api::PEOPLE_POLICY, "decision": "allow", "include": rules, "precedence": 1 }))
            .await?;
        if let Some(token) = service_token_id.filter(|_| i == 0) {
            api.post::<Value>(
                &policies,
                json!({ "name": "Faro: service token", "decision": "non_identity", "include": [{ "service_token": { "token_id": token } }], "precedence": 2 }),
            )
            .await?;
        }
        if i == 0 {
            let ca: Value = api.post(&format!("accounts/{account}/access/apps/{app_id}/ca"), json!({})).await?;
            ca_key = ca["public_key"].as_str().ok_or_else(|| anyhow!("Cloudflare didn't return the SSH CA key"))?.trim().to_string();
        }
    }

    let token: String = api.get(&format!("accounts/{account}/cfd_tunnel/{tunnel_id}/token")).await?;
    let script = setup_script(&token, &ca_key, &profile.username, &req.people)?;
    Ok(SetupState {
        ssh_hostname: ssh_host,
        panel_hostname: panel_host,
        tunnel_id,
        ca_public_key: ca_key,
        script,
        undo_script: undo_script(),
        created: created.clone(),
    })
}

/// Which of `ports` on `host` answer from here, a stand-in for "from the
/// outside": a port this machine reaches directly is likely open to all.
pub async fn open_ports(host: &str, ports: &[u16]) -> Vec<u16> {
    let mut open = Vec::new();
    for &port in ports {
        let addr = format!("{host}:{port}");
        let ok = tokio::time::timeout(std::time::Duration::from_secs(3), tokio::net::TcpStream::connect(&addr))
            .await
            .is_ok_and(|r| r.is_ok());
        if ok {
            open.push(port);
        }
    }
    open
}

#[tauri::command]
pub async fn cf_setup_cloudflare(
    profile_id: String,
    request: SetupRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<SetupState, String> {
    let (api, account, profile) = account_and_profile(&app, &state, &profile_id).await?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let token = cloudflare_api::read_config(&dir).service_token_id;
    setup_cloudflare(&api, &account, &profile, &request, token.as_deref()).await.map_err(err)
}

/// A tunnel's status, polled while the root step runs.
#[tauri::command]
pub async fn cf_tunnel_status(tunnel_id: String, app: AppHandle) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (api, account) = cloudflare_api::connected(&dir).map_err(err)?;
    Ok(api.tunnel(&account, &tunnel_id).await.map_err(err)?.status)
}

/// Delete what setup created in the account; returns what couldn't be.
#[tauri::command]
pub async fn cf_setup_undo(created: Vec<Created>, app: AppHandle) -> Result<Vec<String>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let (api, _) = cloudflare_api::connected(&dir).map_err(err)?;
    Ok(undo(&api, &created).await)
}

#[tauri::command]
pub async fn check_open_ports(host: String, ports: Vec<u16>) -> Result<Vec<u16>, String> {
    Ok(open_ports(&host, &ports).await)
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

    fn direct_profile() -> ConnectionProfile {
        let mut p = crate::importers::ProfilePreview::new("web-1").into_profile();
        p.host = "203.0.113.7".into();
        p.username = "deploy".into();
        p
    }

    fn request(panel: Option<u16>) -> SetupRequest {
        SetupRequest {
            name: "web-1".into(),
            zone_id: "zone1".into(),
            zone_name: "example.com".into(),
            panel_port: panel,
            people: vec!["jane.doe@example.com".into(), "@example.org".into()],
        }
    }

    #[tokio::test]
    async fn setup_creates_the_cloudflare_side_and_undo_removes_it() {
        use crate::cloudflare_api::tests::{start, ACCOUNT};
        let cf = start("setup", serde_json::json!({}));
        let api = cf.api();
        let state = setup_cloudflare(&api, ACCOUNT, &direct_profile(), &request(Some(8080)), Some("st1")).await.unwrap();
        assert_eq!(state.ssh_hostname, "web-1-ssh.example.com");
        assert_eq!(state.panel_hostname.as_deref(), Some("web-1-panel.example.com"));

        let store = cf.store();
        let get = |k: String| store.get(&k).cloned().unwrap_or_default();
        assert_eq!(get(format!("accounts/{ACCOUNT}/access/identity_providers"))[0]["type"], "onetimepin");
        let tunnel = &get(format!("accounts/{ACCOUNT}/cfd_tunnel"))[0];
        let ingress = &get(format!("accounts/{ACCOUNT}/cfd_tunnel/{}/configurations", state.tunnel_id))[0]["config"]["ingress"];
        assert_eq!(ingress[0]["service"], "ssh://localhost:22");
        assert_eq!(ingress[1]["service"], "http://localhost:8080");
        assert_eq!(ingress[2]["service"], "http_status:404");
        let dns = get("zones/zone1/dns_records".into());
        assert_eq!(dns.as_array().unwrap().len(), 2);
        assert_eq!(dns[0]["content"], format!("{}.cfargotunnel.com", tunnel["id"].as_str().unwrap()));
        assert_eq!(dns[0]["proxied"], true);
        let apps = get(format!("accounts/{ACCOUNT}/access/apps"));
        assert_eq!(apps.as_array().unwrap().len(), 2);
        let ssh_app = apps[0]["id"].as_str().unwrap();
        let policies = get(format!("accounts/{ACCOUNT}/access/apps/{ssh_app}/policies"));
        assert_eq!(policies[0]["include"][0]["email"]["email"], "jane.doe@example.com");
        assert_eq!(policies[0]["include"][1]["email_domain"]["domain"], "example.org");
        assert_eq!(policies[1]["include"][0]["service_token"]["token_id"], "st1");
        assert!(!state.ca_public_key.is_empty());

        // The script carries the tunnel token, the CA and jane's principal.
        assert!(state.script.contains(&format!("cloudflared service install tunnel-token-{}", state.tunnel_id)));
        assert!(state.script.contains(&state.ca_public_key));
        assert!(state.script.contains("echo jane.doe >> /etc/ssh/faro_principals/deploy"));
        assert!(state.script.contains("-t; then"), "guarded by sshd -t");

        // Taken names stop a second setup before it creates anything.
        let again = setup_cloudflare(&api, ACCOUNT, &direct_profile(), &request(None), None).await.unwrap_err();
        assert!(format!("{again:#}").contains("already has a DNS record"), "{again:#}");
        assert_eq!(cf.store()[format!("accounts/{ACCOUNT}/cfd_tunnel")].as_array().unwrap().len(), 1);

        assert!(undo(&api, &state.created).await.is_empty());
        let store = cf.store();
        for k in ["zones/zone1/dns_records".to_string(), format!("accounts/{ACCOUNT}/access/apps"), format!("accounts/{ACCOUNT}/cfd_tunnel"), format!("accounts/{ACCOUNT}/access/identity_providers")] {
            assert_eq!(store[&k], serde_json::json!([]), "{k} left behind");
        }
    }

    #[test]
    fn setup_input_is_checked() {
        assert!(check_label("web-1").is_ok());
        assert!(check_label("web.1").is_err(), "one level only");
        assert!(check_label("-web").is_err());
        assert!(people_rules(&[]).is_err());
        assert!(people_rules(&["@localhost".into()]).is_err());
        assert!(setup_script("tok", "ssh-ed25519 AAA ca", "root;x", &[]).is_err());
        assert!(setup_script("tok'; rm", "k", "deploy", &[]).is_err());
        assert!(undo_script().contains("cloudflared service uninstall"));
    }
}
