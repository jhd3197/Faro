//! "Cloudflare login" on a server (issue #86 follow-up): let people log in
//! with their Cloudflare Access sign-in, set up by an admin who is already
//! connected another way (a key or password login).
//!
//! Two modes, both behind the Access CA in `TrustedUserCAKeys`:
//! - **Listed people** (default). `/etc/ssh/faro_principals/<user>` lists the
//!   certificate names that may log in as `<user>`; Faro adds and removes them.
//! - **Anyone the Access policy allows** (opt-in, per user). A `Match User`
//!   block at the end of sshd_config whose `AuthorizedPrincipalsCommand`
//!   prints the certificate's own principals. sshd runs it only for a
//!   certificate the trusted CA signed, so Access decides who gets in.
//!
//! A change backs up what it touches, checks the new sshd_config with
//! `sshd -t` before it goes live, reloads (never restarts, so open sessions
//! stay), then tries a certificate login. If any step fails the backup goes
//! back. The admin's own session is only used to run the commands.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};

use crate::cf_setup::{principal_for, principal_command, run_root, RootRun, CA_FILE, PRINCIPALS_DIR, SETUP_OK};

const BLOCK_BEGIN: &str = "# BEGIN faro-cloudflare";
const BLOCK_END: &str = "# END faro-cloudflare";
const POLICY_BEGIN: &str = "# BEGIN faro-cloudflare-policy";
const POLICY_END: &str = "# END faro-cloudflare-policy";
/// Prints the principals of the certificate sshd is checking.
pub const POLICY_CMD: &str = "/usr/local/sbin/faro-access-principals";
const POLICY_DIR: &str = "/usr/local/sbin";
/// What the last change replaced, for the restore.
pub const BACKUP_DIR: &str = "/etc/ssh/faro-login-backup";
const SSHD_CONFIG: &str = "/etc/ssh/sshd_config";
/// The last line a successful restore prints.
pub const RESTORED: &str = "FARO_RESTORED";

const POLICY_SCRIPT: &str = r#"#!/bin/sh
# Faro: the principals of the certificate sshd is checking (%t %k).
printf '%s %s\n' "$1" "$2" | ssh-keygen -L -f /dev/stdin 2>/dev/null |
  awk '/^[[:space:]]*Principals:/ {p=1; next} /^[[:space:]]*Critical Options:/ {p=0} p {print $1}'
"#;

/// A name safe to put in a shell command and a file name unquoted.
fn is_safe_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && !s.starts_with('-')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// An email or a certificate name, as the certificate name.
pub fn person_principal(person: &str) -> Result<String> {
    let p = person.trim();
    if p.contains('@') {
        return principal_for(p);
    }
    if !is_safe_name(p) {
        bail!("'{p}' can't be a certificate name; use an email, or letters, digits, dot, dash or underscore");
    }
    Ok(p.to_string())
}

/// One line, an OpenSSH public key, nothing a shell would read.
pub fn check_ca_key(key: &str) -> Result<String> {
    let key = key.trim();
    let mut parts = key.split_whitespace();
    let kind = parts.next().unwrap_or("");
    let body = parts.next().unwrap_or("");
    let kind_ok = kind.starts_with("ecdsa-sha2-") || kind.starts_with("ssh-") || kind.starts_with("sk-");
    let body_ok = body.len() >= 8 && body.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='));
    let safe = key.chars().all(|c| c.is_ascii_graphic() || c == ' ') && !key.contains('\'');
    if !kind_ok || !body_ok || !safe || key.lines().count() != 1 {
        bail!("that isn't an SSH public key; paste the one line that starts with ecdsa-sha2-nistp256");
    }
    Ok(key.to_string())
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Mode {
    /// The server doesn't trust the Access CA through Faro.
    NotSetUp,
    /// Only the people on `user`'s list.
    Listed,
    /// Anyone the Access policy allows, as `user`.
    Policy,
}

/// What the server says about Cloudflare login for one user.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServerLoginState {
    pub user: String,
    pub mode: Mode,
    /// Faro's `TrustedUserCAKeys` block is in sshd_config.
    pub ca_installed: bool,
    /// The CA key Faro installed, when readable.
    pub ca_key: Option<String>,
    /// A `TrustedUserCAKeys` set by hand, outside Faro's block.
    pub other_ca: Option<String>,
    /// Certificate names allowed to log in as `user`.
    pub people: Vec<String>,
    /// Users anyone in the Access policy may log in as.
    pub policy_users: Vec<String>,
    /// sshd_config couldn't be read without a sudo password.
    pub unreadable: bool,
}

/// Reads the state without root where the files allow it (sshd_config is
/// usually world-readable), else with `sudo -n`.
pub fn probe_script(user: &str) -> Result<String> {
    if !is_safe_name(user) {
        bail!("the server username '{user}' has characters Faro won't put in a command");
    }
    let rd = |f: &str| format!("cat {f} 2>/dev/null || sudo -n cat {f} 2>/dev/null || echo '@@unreadable'");
    Ok(format!(
        "echo '@@conf'; {}; echo '@@people'; cat {PRINCIPALS_DIR}/{user} 2>/dev/null; echo '@@ca'; cat {CA_FILE} 2>/dev/null; true",
        rd(SSHD_CONFIG)
    ))
}

pub fn parse_state(out: &str, user: &str) -> ServerLoginState {
    let mut section = "";
    let (mut conf, mut people, mut ca) = (Vec::new(), Vec::new(), Vec::new());
    for line in out.lines() {
        match line.trim() {
            "@@conf" => section = "conf",
            "@@people" => section = "people",
            "@@ca" => section = "ca",
            _ => match section {
                "conf" => conf.push(line),
                "people" => people.push(line),
                "ca" => ca.push(line),
                _ => {}
            },
        }
    }
    let unreadable = conf.iter().any(|l| l.trim() == "@@unreadable");
    let (mut ca_installed, mut other_ca, mut policy_users) = (false, None, Vec::new());
    let mut block = "";
    for line in &conf {
        let t = line.trim();
        if t == BLOCK_BEGIN {
            block = "faro";
            ca_installed = true;
            continue;
        }
        if t == POLICY_BEGIN {
            block = "policy";
            continue;
        }
        if t == BLOCK_END || t == POLICY_END {
            block = "";
            continue;
        }
        let mut words = t.split_whitespace();
        let key = words.next().unwrap_or("").to_ascii_lowercase();
        let rest: Vec<&str> = words.collect();
        match block {
            "policy" if key == "match" && rest.first().is_some_and(|w| w.eq_ignore_ascii_case("user")) => {
                policy_users = rest[1..].join(" ").split(',').map(|u| u.trim().to_string()).filter(|u| !u.is_empty()).collect();
            }
            "" if key == "trustedusercakeys" && other_ca.is_none() => {
                let v = rest.join(" ");
                if v != CA_FILE && !v.eq_ignore_ascii_case("none") {
                    other_ca = Some(v);
                }
            }
            _ => {}
        }
    }
    let people: Vec<String> = people
        .iter()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(String::from)
        .collect();
    let ca_key = ca.iter().map(|l| l.trim()).find(|l| !l.is_empty()).map(String::from);
    let mode = if !ca_installed {
        Mode::NotSetUp
    } else if policy_users.iter().any(|u| u == user) {
        Mode::Policy
    } else {
        Mode::Listed
    };
    ServerLoginState { user: user.into(), mode, ca_installed, ca_key, other_ca, people, policy_users, unreadable }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    /// The server account people log in as.
    pub user: String,
    /// The Access CA public key. Needed when the server doesn't trust it yet;
    /// replaces the installed one when given.
    #[serde(default)]
    pub ca_key: Option<String>,
    /// Emails or certificate names to add to `user`'s list.
    #[serde(default)]
    pub add_people: Vec<String>,
    /// Anyone the Access policy allows may log in as `user`.
    #[serde(default)]
    pub policy: bool,
    /// Take Cloudflare login off the server (people lists are kept).
    #[serde(default)]
    pub remove: bool,
}

/// What a change does, shown before it runs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoginPlan {
    pub user: String,
    /// In words, one line each.
    pub changes: Vec<String>,
    /// Every file it may write or delete.
    pub files: Vec<String>,
    /// Run as root: back up, change, `sshd -t`, reload.
    pub script: String,
    /// Run as root: put the backup back and reload.
    pub restore_script: String,
    /// The certificate names the change adds.
    pub principals: Vec<String>,
    pub policy_users: Vec<String>,
}

fn backed_up(user: &str) -> [(String, &'static str); 4] {
    [
        (SSHD_CONFIG.to_string(), "sshd_config"),
        (CA_FILE.to_string(), "ca"),
        (format!("{PRINCIPALS_DIR}/{user}"), "principals"),
        (POLICY_CMD.to_string(), "policy-cmd"),
    ]
}

const RELOAD: &str = "systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || service sshd reload 2>/dev/null || kill -HUP \"$(cat /run/sshd.pid 2>/dev/null || cat /var/run/sshd.pid)\"";

/// The shell function that puts the backup back.
fn restore_fn(user: &str) -> String {
    let mut s = String::from("restore() {\n");
    for (path, key) in backed_up(user) {
        s.push_str(&format!(
            "  if [ -e \"$b/{key}\" ]; then cp -p \"$b/{key}\" {path}; elif [ -e \"$b/{key}.absent\" ]; then rm -f {path}; fi\n"
        ));
    }
    s.push_str("}\n");
    s
}

pub fn build_plan(req: &LoginRequest, state: &ServerLoginState) -> Result<LoginPlan> {
    let user = req.user.trim();
    if !is_safe_name(user) {
        bail!("the server username '{user}' has characters Faro won't put in a root command");
    }
    let ca_key = req.ca_key.as_deref().map(check_ca_key).transpose()?;
    let mut principals: Vec<String> = req.add_people.iter().filter(|p| !p.trim().is_empty()).map(|p| person_principal(p)).collect::<Result<_>>()?;
    principals.sort();
    principals.dedup();
    if !req.remove && !state.ca_installed && ca_key.is_none() {
        bail!("the server doesn't trust the Cloudflare Access CA yet; Faro needs its public key");
    }
    let mut policy_users: Vec<String> = state.policy_users.iter().filter(|u| u.as_str() != user && is_safe_name(u)).cloned().collect();
    if req.policy && !req.remove {
        policy_users.push(user.to_string());
    }
    policy_users.sort();
    policy_users.dedup();

    let mut changes = Vec::new();
    let mut files = vec![SSHD_CONFIG.to_string()];
    let mut s = String::new();
    s.push_str("set -e\n# Faro: Cloudflare login on this server.\n");
    s.push_str(&format!("b={BACKUP_DIR}\nconf={SSHD_CONFIG}\n"));
    s.push_str(&restore_fn(user));
    s.push_str("# 1. Back up everything this changes.\nrm -rf \"$b\"\nmkdir -m 700 \"$b\"\n");
    for (path, key) in backed_up(user) {
        s.push_str(&format!("if [ -e {path} ]; then cp -p {path} \"$b/{key}\"; else : > \"$b/{key}.absent\"; fi\n"));
    }
    s.push_str("echo \"Backed up to $b\"\n");
    // Any failure from here on puts the backup back (and reloads, once the
    // new config was live).
    s.push_str(&format!(
        "ok=0; live=0\ntrap 'if [ \"$ok\" != 1 ]; then set +e; restore; [ \"$live\" = 1 ] && {{ {RELOAD}; }}; echo \"The old settings are back.\"; echo {RESTORED}; fi' EXIT\n"
    ));

    if req.remove {
        changes.push("Stop trusting Cloudflare Access certificates (people lists are kept)".into());
        files.push(CA_FILE.into());
        files.push(POLICY_CMD.into());
        s.push_str(&format!("# 2. Remove the CA and the policy command.\nrm -f {CA_FILE} {POLICY_CMD}\n"));
    } else {
        s.push_str("# 2. The Access CA, the people list, the policy command.\n");
        if let Some(key) = &ca_key {
            changes.push(if state.ca_installed && state.ca_key.as_deref() != Some(key.as_str()) {
                "Replace the trusted Cloudflare Access CA key".to_string()
            } else {
                "Trust certificates signed by the Cloudflare Access CA".to_string()
            });
            files.push(CA_FILE.into());
            s.push_str(&format!("printf '%s\\n' '{key}' > {CA_FILE}\nchmod 644 {CA_FILE}\n"));
        }
        s.push_str(&format!("[ -s {CA_FILE} ] || {{ echo 'No Access CA key at {CA_FILE}'; exit 1; }}\n"));
        if !principals.is_empty() {
            files.push(format!("{PRINCIPALS_DIR}/{user}"));
            for p in &principals {
                changes.push(format!("Allow {p} to log in as {user}"));
                s.push_str(&principal_command(user, p, true)?);
                s.push('\n');
            }
        }
        let was_policy = state.policy_users.iter().any(|u| u == user);
        if req.policy && !was_policy {
            changes.push(format!("Let anyone the Access policy allows log in as {user}"));
        } else if !req.policy && was_policy {
            changes.push(format!("Only listed people may log in as {user} (no longer anyone in the Access policy)"));
        }
        files.push(POLICY_CMD.into());
        if policy_users.is_empty() {
            s.push_str(&format!("rm -f {POLICY_CMD}\n"));
        } else {
            s.push_str(&format!(
                "mkdir -p {POLICY_DIR}\ncat > {POLICY_CMD} <<'FARO_EOF'\n{POLICY_SCRIPT}FARO_EOF\nchown root:root {POLICY_CMD}\nchmod 755 {POLICY_CMD}\n"
            ));
        }
        if !state.ca_installed {
            changes.push(format!("Only listed people may log in with a certificate (lists in {PRINCIPALS_DIR}/)"));
        }
    }

    // sshd_config: Faro's blocks out, then the CA block first (before any
    // Match) and the policy block last. Checked before it goes live.
    s.push_str("# 3. sshd_config, checked with sshd -t before it goes live.\n");
    s.push_str(&format!(
        "new=\"$conf.faro-new\"\nsed -e '/^{BLOCK_BEGIN}$/,/^{BLOCK_END}$/d' -e '/^{POLICY_BEGIN}$/,/^{POLICY_END}$/d' \"$conf\" > \"$new.body\"\n{{\n"
    ));
    if !req.remove {
        s.push_str(&format!(
            "  echo '{BLOCK_BEGIN}'\n  echo 'TrustedUserCAKeys {CA_FILE}'\n  echo 'AuthorizedPrincipalsFile {PRINCIPALS_DIR}/%u'\n  echo '{BLOCK_END}'\n"
        ));
    }
    s.push_str("  cat \"$new.body\"\n");
    if !req.remove && !policy_users.is_empty() {
        s.push_str(&format!(
            "  echo '{POLICY_BEGIN}'\n  echo 'Match User {}'\n  echo '    AuthorizedPrincipalsCommand {POLICY_CMD} %t %k'\n  echo '    AuthorizedPrincipalsCommandUser nobody'\n  echo '{POLICY_END}'\n",
            policy_users.join(",")
        ));
    }
    s.push_str("} > \"$new\"\nrm -f \"$new.body\"\n");
    s.push_str(&format!(
        r#"sshd_bin=$(command -v sshd || echo /usr/sbin/sshd)
if ! "$sshd_bin" -t -f "$new"; then
  rm -f "$new"
  echo "sshd rejected the new settings, so nothing changed."
  exit 1
fi
cat "$new" > "$conf"; rm -f "$new"; live=1
# 4. Reload: open sessions stay connected.
"$sshd_bin" -t
{{ {RELOAD}; }}
sleep 1
ok=1
echo {SETUP_OK}
"#
    ));

    let restore_script = format!(
        "set -e\nb={BACKUP_DIR}\nconf={SSHD_CONFIG}\n{}[ -d \"$b\" ] || {{ echo 'No backup to restore'; exit 1; }}\nrestore\nsshd_bin=$(command -v sshd || echo /usr/sbin/sshd)\n\"$sshd_bin\" -t\n{RELOAD}\necho {RESTORED}\n",
        restore_fn(user)
    );
    files.dedup();
    Ok(LoginPlan { user: user.into(), changes, files, script: s, restore_script, principals, policy_users })
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApplyResult {
    pub ok: bool,
    /// sudo wants a password and none was given; nothing ran.
    pub needs_password: bool,
    /// The change's own output.
    pub output: String,
    /// A certificate login was tried after the reload.
    pub tested: bool,
    pub test_error: Option<String>,
    /// The backup went back (sshd rejected the change, or the test failed).
    pub restored: bool,
    pub restore_output: Option<String>,
}

/// Run `plan` as root over `ssh`, then `test` a certificate login when given;
/// a failed test puts the backup back.
pub async fn apply<F, Fut>(ssh: &crate::session::SshSession, plan: &LoginPlan, password: Option<&str>, test: Option<F>) -> Result<ApplyResult>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    let run: RootRun = run_root(ssh, &plan.script, password).await?;
    let mut out = ApplyResult { needs_password: run.needs_password, output: run.output.clone(), ..Default::default() };
    if run.needs_password {
        return Ok(out);
    }
    if !run.ok || !run.output.contains(SETUP_OK) {
        // The script restores on its own when sshd refuses the change.
        out.restored = run.output.contains(RESTORED);
        return Ok(out);
    }
    if let Some(test) = test {
        out.tested = true;
        if let Err(e) = test().await {
            out.test_error = Some(format!("{e:#}"));
            let r = run_root(ssh, &plan.restore_script, password).await?;
            out.restored = r.ok && r.output.contains(RESTORED);
            out.restore_output = Some(r.output);
            return Ok(out);
        }
    }
    out.ok = true;
    Ok(out)
}

// ---- Commands ----

use crate::AppState;
use tauri::{AppHandle, Manager, State};

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

async fn ssh_for(state: &State<'_, AppState>, session_id: &str) -> Result<std::sync::Arc<crate::session::SshSession>, String> {
    state.sessions.get_ssh(session_id).await.ok_or_else(|| "that server isn't connected".to_string())
}

pub async fn read_state(ssh: &crate::session::SshSession, user: &str) -> Result<ServerLoginState> {
    let out = ssh.exec_bounded(&probe_script(user)?, 1 << 20, std::time::Duration::from_secs(30), None).await?;
    Ok(parse_state(&out.stdout, user))
}

/// Cloudflare login on the server behind `session_id`, for `user`.
#[tauri::command]
pub async fn cf_login_state(session_id: String, user: String, state: State<'_, AppState>) -> Result<ServerLoginState, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    read_state(&ssh, user.trim()).await.map_err(err)
}

/// The change, built against the server as it is now.
#[tauri::command]
pub async fn cf_login_plan(session_id: String, request: LoginRequest, state: State<'_, AppState>) -> Result<LoginPlan, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let now = read_state(&ssh, request.user.trim()).await.map_err(err)?;
    build_plan(&request, &now).map_err(err)
}

/// Run a plan the person has seen. `test_profile`: the Cloudflare connection
/// to try a certificate login with afterwards (a failed try restores).
#[tauri::command]
pub async fn cf_login_apply(
    session_id: String,
    plan: LoginPlan,
    test_profile: Option<crate::profiles::ConnectionProfile>,
    password: Option<String>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ApplyResult, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let test = match test_profile {
        Some(mut p) => {
            p.auth = crate::profiles::AuthMethod::CloudflareCert;
            Some(state.profiles.with_jump_resolved(p).await)
        }
        None => None,
    };
    let sessions = state.sessions.clone();
    let test = test.map(|p| {
        move || async move {
            let id = tokio::time::timeout(std::time::Duration::from_secs(180), sessions.connect(p, app))
                .await
                .map_err(|_| anyhow::anyhow!("the test login took too long"))??;
            let _ = sessions.disconnect(&id).await;
            Ok(())
        }
    });
    apply(&ssh, &plan, password.as_deref(), test).await.map_err(err)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonCommand {
    pub principal: String,
    pub command: String,
}

/// The root command that adds (or removes) one person on `user`'s list.
#[tauri::command]
pub fn cf_login_person_command(user: String, person: String, add: bool) -> Result<PersonCommand, String> {
    let principal = person_principal(&person).map_err(err)?;
    let command = principal_command(user.trim(), &principal, add).map_err(err)?;
    Ok(PersonCommand { principal, command })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaLookup {
    pub key: Option<String>,
    /// Why there's no key: no account connected, no Access application, …
    pub error: Option<String>,
    /// A Cloudflare account is connected in Settings.
    pub account: bool,
}

/// The Access application's SSH CA for `hostname`, created if it has none.
pub async fn access_ca(api: &crate::cloudflare_api::Api, account: &str, hostname: &str) -> Result<String> {
    let app = api.app_for_hostname(account, hostname).await?;
    let path = format!("accounts/{account}/access/apps/{}/ca", app.id);
    let ca: serde_json::Value = match api.get(&path).await {
        Ok(v) => v,
        Err(_) => api.post(&path, serde_json::json!({})).await?,
    };
    let key = ca["public_key"].as_str().unwrap_or("").trim().to_string();
    check_ca_key(&key).map_err(|_| anyhow::anyhow!("Cloudflare didn't return an SSH CA key for {hostname}"))
}

/// The CA key through the Cloudflare API when an account is connected.
#[tauri::command]
pub async fn cf_login_ca(hostname: String, app: AppHandle) -> Result<CaLookup, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let Ok((api, account)) = crate::cloudflare_api::connected(&dir) else {
        return Ok(CaLookup { key: None, error: None, account: false });
    };
    Ok(match access_ca(&api, &account, hostname.trim()).await {
        Ok(key) => CaLookup { key: Some(key), error: None, account: true },
        Err(e) => CaLookup { key: None, error: Some(err(e)), account: true },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY= open-ssh-ca@cloudflareaccess.org";

    fn probe(conf: &str, people: &str, ca: &str) -> String {
        format!("@@conf\n{conf}\n@@people\n{people}\n@@ca\n{ca}\n")
    }

    #[test]
    fn reads_the_three_states() {
        let plain = parse_state(&probe("PasswordAuthentication yes\nTrustedUserCAKeys /etc/ssh/ca.pub", "", ""), "deploy");
        assert_eq!(plain.mode, Mode::NotSetUp);
        assert_eq!(plain.other_ca.as_deref(), Some("/etc/ssh/ca.pub"));

        let listed_conf = format!("{BLOCK_BEGIN}\nTrustedUserCAKeys {CA_FILE}\nAuthorizedPrincipalsFile {PRINCIPALS_DIR}/%u\n{BLOCK_END}\nPasswordAuthentication yes");
        let listed = parse_state(&probe(&listed_conf, "jane.doe\n# note\nana", KEY), "deploy");
        assert_eq!(listed.mode, Mode::Listed);
        assert_eq!(listed.people, ["jane.doe", "ana"]);
        assert_eq!(listed.ca_key.as_deref(), Some(KEY));
        assert_eq!(listed.other_ca, None);

        let policy_conf = format!("{listed_conf}\n{POLICY_BEGIN}\nMatch User deploy,www-data\n    AuthorizedPrincipalsCommand {POLICY_CMD} %t %k\n{POLICY_END}");
        let policy = parse_state(&probe(&policy_conf, "", KEY), "deploy");
        assert_eq!(policy.mode, Mode::Policy);
        assert_eq!(policy.policy_users, ["deploy", "www-data"]);
        assert_eq!(parse_state(&probe(&policy_conf, "", KEY), "ops").mode, Mode::Listed);

        assert!(parse_state(&probe("@@unreadable", "", ""), "deploy").unreadable);
    }

    #[test]
    fn plans_back_up_check_and_restore() {
        let fresh = parse_state(&probe("PasswordAuthentication yes", "", ""), "deploy");
        let req = LoginRequest { user: "deploy".into(), ca_key: None, add_people: vec!["Jane.Doe@example.com".into()], policy: false, remove: false };
        assert!(build_plan(&req, &fresh).unwrap_err().to_string().contains("public key"));

        let plan = build_plan(&LoginRequest { ca_key: Some(KEY.into()), ..req.clone() }, &fresh).unwrap();
        assert_eq!(plan.principals, ["Jane.Doe"]);
        assert!(plan.changes.iter().any(|c| c == "Allow Jane.Doe to log in as deploy"));
        let s = &plan.script;
        let pos = |needle: &str| s.find(needle).unwrap_or_else(|| panic!("{needle} missing:\n{s}"));
        assert!(pos("cp -p /etc/ssh/sshd_config \"$b/sshd_config\"") < pos("printf '%s\\n' 'ecdsa-sha2-nistp256"));
        assert!(pos("-t -f \"$new\"") < pos("cat \"$new\" > \"$conf\""));
        // (The rollback trap mentions the reload earlier; the real one is last.)
        assert!(pos("cat \"$new\" > \"$conf\"") < s.rfind("systemctl reload ssh").unwrap());
        assert!(pos("trap '") < pos("printf '%s\\n' 'ecdsa-sha2-nistp256"), "rollback armed before any change");
        assert!(!s.contains("restart"), "a reload keeps open sessions");
        assert!(s.contains("echo 'AuthorizedPrincipalsFile /etc/ssh/faro_principals/%u'"));
        assert!(!s.contains("Match User"), "listed people only");
        assert!(plan.restore_script.contains("cp -p \"$b/sshd_config\" /etc/ssh/sshd_config"));
        assert!(plan.restore_script.contains("rm -f /etc/ssh/faro_cloudflare_ca.pub"));

        // The opt-in adds the Match block; others in it are kept.
        let listed_conf = format!("{BLOCK_BEGIN}\n{BLOCK_END}\n{POLICY_BEGIN}\nMatch User www-data\n{POLICY_END}");
        let listed = parse_state(&probe(&listed_conf, "", KEY), "deploy");
        let on = build_plan(&LoginRequest { user: "deploy".into(), ca_key: None, add_people: vec![], policy: true, remove: false }, &listed).unwrap();
        assert!(on.script.contains("echo 'Match User deploy,www-data'"));
        assert!(on.script.contains("AuthorizedPrincipalsCommand /usr/local/sbin/faro-access-principals %t %k"));
        assert!(on.changes.iter().any(|c| c.starts_with("Let anyone the Access policy allows")));
        let policy = parse_state(&probe(&format!("{BLOCK_BEGIN}\n{BLOCK_END}\n{POLICY_BEGIN}\nMatch User deploy\n{POLICY_END}"), "", KEY), "deploy");
        let off = build_plan(&LoginRequest { user: "deploy".into(), ca_key: None, add_people: vec![], policy: false, remove: false }, &policy).unwrap();
        assert!(!off.script.contains("Match User"));
        assert!(off.script.contains("rm -f /usr/local/sbin/faro-access-principals"));

        let rm = build_plan(&LoginRequest { user: "deploy".into(), ca_key: None, add_people: vec![], policy: false, remove: true }, &listed).unwrap();
        assert!(!rm.script.contains("TrustedUserCAKeys"));

        assert!(build_plan(&LoginRequest { user: "root;x".into(), ..req.clone() }, &listed).is_err());
        assert!(check_ca_key("ssh-ed25519 AAAA'; rm -rf /").is_err());
        assert!(check_ca_key(KEY).is_ok());
        assert!(person_principal("a b").is_err());
        assert_eq!(person_principal("jane.doe").unwrap(), "jane.doe");
    }

    #[tokio::test]
    async fn the_ca_comes_from_the_access_app() {
        use crate::cloudflare_api::tests::{start, ACCOUNT};
        let apps = format!("accounts/{ACCOUNT}/access/apps");
        let cf = start("login-ca", serde_json::json!({ apps.clone(): [{ "id": "app1", "name": "web-1", "domain": "web-1-ssh.example.com", "type": "self_hosted" }] }));
        let api = cf.api();
        let first = access_ca(&api, ACCOUNT, "web-1-ssh.example.com").await.unwrap();
        assert!(first.starts_with("ecdsa-sha2-nistp256"));
        // Asking again reads the same CA instead of failing to create one.
        assert_eq!(access_ca(&api, ACCOUNT, "web-1-ssh.example.com").await.unwrap(), first);
        assert!(access_ca(&api, ACCOUNT, "nope.example.com").await.is_err());
    }
}
