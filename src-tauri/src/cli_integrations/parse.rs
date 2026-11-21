//! Reading each CLI's account answer. Pure functions over [`Ran`] so they
//! can be tested against recorded output; the CLI's text never reaches an
//! error message.

use super::{args, classify_failure, run, state_detail, Checked, CliAccount, CliState, Ran, CHECK_TIMEOUT, SMALL_CAP};
use serde_json::Value;
use std::collections::BTreeSet;

fn failed(id: &str, ran: &Ran) -> Checked {
    let state = classify_failure(&ran.both());
    Checked { state: Some(state), accounts: Vec::new(), detail: state_detail(id, state) }
}

fn json(ran: &Ran) -> Option<Value> {
    serde_json::from_str(ran.stdout.trim()).ok()
}

fn account(id: &str, label: &str, state: CliState, active: bool) -> CliAccount {
    CliAccount { id: id.to_string(), label: label.to_string(), state, detail: None, active, allowed: false }
}

/// Overall state from per-account states: a problem with an account some
/// connection uses wins; else ready if any account is.
pub fn overall(accounts: &[CliAccount], wanted: &BTreeSet<String>) -> CliState {
    if let Some(bad) = accounts.iter().find(|a| wanted.contains(&a.id) && a.state.is_problem()) {
        return bad.state;
    }
    if accounts.iter().any(|a| a.state == CliState::Ready) {
        return CliState::Ready;
    }
    accounts.first().map(|a| a.state).unwrap_or(CliState::SignedOut)
}

// ---- aws ------------------------------------------------------------------------------

/// `aws configure list-profiles`: one profile per line.
pub fn aws_profiles(ran: &Ran) -> Vec<String> {
    ran.stdout.lines().map(str::trim).filter(|l| !l.is_empty() && super::plain_arg(l)).map(str::to_string).take(200).collect()
}

/// `aws sts get-caller-identity --output json`.
pub fn aws_identity(profile: &str, ran: &Ran) -> CliAccount {
    if !ran.ok {
        let state = classify_failure(&ran.both());
        let mut a = account(profile, profile, state, profile == "default");
        a.detail = Some(match state {
            CliState::Expired => format!("The login for profile {profile} expired. Click Sign in (runs `aws sso login --profile {profile}`)."),
            CliState::SignedOut => format!("Profile {profile} has no credentials. Run `aws configure --profile {profile}` or `aws configure sso`."),
            _ => format!("Faro couldn't check profile {profile}."),
        });
        return a;
    }
    let v = json(ran).unwrap_or(Value::Null);
    let acct = v["Account"].as_str().unwrap_or("");
    let label = if acct.is_empty() { profile.to_string() } else { format!("{profile} ({acct})") };
    account(profile, &label, CliState::Ready, profile == "default")
}

/// List the profiles, then check the ones connections use (and `default`, or
/// the first), at most five at once.
pub async fn aws_check(wanted: &BTreeSet<String>) -> anyhow::Result<Checked> {
    let listed = run("aws", &args(&["configure", "list-profiles"]), CHECK_TIMEOUT, SMALL_CAP).await?;
    if !listed.ok {
        return Ok(failed("aws", &listed));
    }
    let profiles = aws_profiles(&listed);
    if profiles.is_empty() {
        return Ok(Checked {
            state: Some(CliState::SignedOut),
            accounts: Vec::new(),
            detail: Some("The AWS CLI has no profiles yet. Click Sign in (runs `aws configure sso`).".into()),
        });
    }
    let mut to_check: Vec<String> = profiles.iter().filter(|p| wanted.contains(*p)).cloned().collect();
    let first = if profiles.iter().any(|p| p == "default") { "default".to_string() } else { profiles[0].clone() };
    if !to_check.contains(&first) {
        to_check.push(first);
    }
    to_check.truncate(5);
    let checks = futures::future::join_all(to_check.iter().map(|p| async move {
        let ran = run("aws", &args(&["sts", "get-caller-identity", "--profile", p, "--output", "json"]), CHECK_TIMEOUT, SMALL_CAP).await;
        match ran {
            Ok(r) => aws_identity(p, &r),
            Err(_) => {
                let mut a = account(p, p, CliState::Error, p == "default");
                a.detail = Some(format!("Faro couldn't check profile {p}."));
                a
            }
        }
    }))
    .await;
    let mut accounts: Vec<CliAccount> = profiles
        .iter()
        .map(|p| checks.iter().find(|c| &c.id == p).cloned().unwrap_or_else(|| account(p, p, CliState::Unknown, p == "default")))
        .collect();
    accounts.sort_by_key(|a| (!a.active, a.state != CliState::Ready, a.id.clone()));
    let state = overall(&accounts, wanted);
    Ok(Checked { state: Some(state), detail: accounts.iter().find(|a| a.state == state && state.is_problem()).and_then(|a| a.detail.clone()), accounts })
}

// ---- gcloud ---------------------------------------------------------------------------

/// `gcloud auth list --format=json`: `[{account, status: "ACTIVE"}]`.
pub fn gcloud_accounts(ran: &Ran) -> Checked {
    if !ran.ok {
        return failed("gcloud", ran);
    }
    let list = json(ran).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let accounts: Vec<CliAccount> = list
        .iter()
        .filter_map(|a| {
            let id = a["account"].as_str()?;
            Some(account(id, id, CliState::Ready, a["status"].as_str() == Some("ACTIVE")))
        })
        .collect();
    if accounts.is_empty() {
        return Checked { state: Some(CliState::SignedOut), accounts, detail: state_detail("gcloud", CliState::SignedOut) };
    }
    Checked { state: Some(CliState::Ready), accounts, detail: None }
}

// ---- az -------------------------------------------------------------------------------

/// `az account list --all -o json`: subscriptions.
pub fn az_accounts(ran: &Ran) -> Checked {
    if !ran.ok {
        return failed("az", ran);
    }
    let list = json(ran).and_then(|v| v.as_array().cloned()).unwrap_or_default();
    let accounts: Vec<CliAccount> = list
        .iter()
        .filter_map(|s| {
            let id = s["id"].as_str()?;
            let name = s["name"].as_str().unwrap_or(id);
            let user = s["user"]["name"].as_str().unwrap_or("");
            let label = if user.is_empty() { name.to_string() } else { format!("{name} ({user})") };
            let enabled = s["state"].as_str().is_none_or(|st| st.eq_ignore_ascii_case("enabled"));
            Some(account(id, &label, if enabled { CliState::Ready } else { CliState::Error }, s["isDefault"].as_bool() == Some(true)))
        })
        .collect();
    if accounts.is_empty() {
        return Checked { state: Some(CliState::SignedOut), accounts, detail: state_detail("az", CliState::SignedOut) };
    }
    Checked { state: Some(CliState::Ready), accounts, detail: None }
}

// ---- gh -------------------------------------------------------------------------------

/// `gh auth status --hostname github.com` (text; `gh` prints it on stdout in
/// new versions and stderr in old ones).
pub fn gh_status(ran: &Ran) -> Checked {
    let text = ran.both();
    let mut accounts = Vec::new();
    let mut active_next = false;
    let mut bad: Option<CliState> = None;
    for line in text.lines() {
        let l = line.trim();
        if let Some(rest) = l.split("account ").nth(1).filter(|_| l.contains("Logged in to")) {
            let name = rest.split_whitespace().next().unwrap_or("").to_string();
            if !name.is_empty() {
                accounts.push(account(&name, &name, CliState::Ready, false));
                active_next = true;
            }
        } else if l.starts_with("X Failed to log in") || l.contains("token in") && l.contains("is invalid") {
            bad = Some(CliState::Expired);
            if let Some(rest) = l.split("account ").nth(1) {
                let name = rest.split_whitespace().next().unwrap_or("").to_string();
                if !name.is_empty() {
                    accounts.push(account(&name, &name, CliState::Expired, false));
                }
            }
        } else if l.contains("Active account: true") && active_next {
            if let Some(a) = accounts.last_mut() {
                a.active = true;
            }
        }
    }
    if accounts.is_empty() {
        let state = if ran.ok { CliState::SignedOut } else { classify_failure(&text) };
        let state = if state == CliState::Error && text.to_ascii_lowercase().contains("not logged") { CliState::SignedOut } else { state };
        return Checked { state: Some(state), accounts, detail: state_detail("gh", state) };
    }
    let state = if accounts.iter().any(|a| a.active && a.state == CliState::Ready) || bad.is_none() { CliState::Ready } else { CliState::Expired };
    Checked { state: Some(state), detail: state_detail("gh", state), accounts }
}

// ---- tailscale ------------------------------------------------------------------------

/// `tailscale status --json`.
pub fn tailscale_status(ran: &Ran) -> Checked {
    let Some(v) = json(ran) else {
        if !ran.ok {
            let t = ran.both().to_ascii_lowercase();
            if t.contains("failed to connect") || t.contains("is tailscale running") || t.contains("not running") {
                return Checked { state: Some(CliState::Error), accounts: Vec::new(), detail: Some("Tailscale isn't running. Start the Tailscale app, then click Check.".into()) };
            }
            return failed("tailscale", ran);
        }
        return Checked { state: Some(CliState::Error), accounts: Vec::new(), detail: state_detail("tailscale", CliState::Error) };
    };
    let backend = v["BackendState"].as_str().unwrap_or("");
    let tailnet = v["CurrentTailnet"]["Name"].as_str().unwrap_or("").to_string();
    let label = if tailnet.is_empty() { "this tailnet".to_string() } else { tailnet.clone() };
    match backend {
        "Running" => Checked { state: Some(CliState::Ready), accounts: vec![account(&label, &label, CliState::Ready, true)], detail: None },
        "NeedsLogin" | "NoState" => Checked { state: Some(CliState::SignedOut), accounts: Vec::new(), detail: state_detail("tailscale", CliState::SignedOut) },
        "NeedsMachineAuth" => Checked { state: Some(CliState::Error), accounts: Vec::new(), detail: Some("An admin has to approve this device in the Tailscale admin console.".into()) },
        "Stopped" => Checked { state: Some(CliState::Error), accounts: vec![account(&label, &label, CliState::Error, true)], detail: Some("Tailscale is turned off. Turn it on, then click Check.".into()) },
        _ => Checked { state: Some(CliState::Error), accounts: Vec::new(), detail: Some("Tailscale is starting. Click Check in a moment.".into()) },
    }
}

// ---- doctl ----------------------------------------------------------------------------

/// `doctl account get -o json`.
pub fn doctl_account(ran: &Ran) -> Checked {
    if !ran.ok {
        return failed("doctl", ran);
    }
    let v = json(ran).unwrap_or(Value::Null);
    let email = v["email"].as_str().unwrap_or("this account");
    Checked { state: Some(CliState::Ready), accounts: vec![account(email, email, CliState::Ready, true)], detail: None }
}

// ---- hcloud ---------------------------------------------------------------------------

/// `hcloud context active`: the context's name, or nothing.
pub fn hcloud_context(ran: &Ran) -> Checked {
    let name = ran.stdout.trim();
    if !ran.ok || name.is_empty() {
        let state = if ran.ok { CliState::SignedOut } else { classify_failure(&ran.both()) };
        let state = if state == CliState::Error { CliState::SignedOut } else { state };
        return Checked { state: Some(state), accounts: Vec::new(), detail: state_detail("hcloud", state) };
    }
    Checked { state: Some(CliState::Ready), accounts: vec![account(name, name, CliState::Ready, true)], detail: None }
}

// ---- render ---------------------------------------------------------------------------

/// `render whoami -o json`.
pub fn render_whoami(ran: &Ran) -> Checked {
    if !ran.ok {
        return failed("render", ran);
    }
    let v = json(ran).unwrap_or(Value::Null);
    let who = v["email"].as_str().or_else(|| v["name"].as_str()).unwrap_or("this account");
    Checked { state: Some(CliState::Ready), accounts: vec![account(who, who, CliState::Ready, true)], detail: None }
}

// ---- hs -------------------------------------------------------------------------------

/// HubSpot portals from `hs accounts list` (a text table): rows whose cells
/// hold a numeric portal id. `(default)` marks the default portal.
pub fn hs_portals(text: &str) -> Vec<(String, String, bool)> {
    let mut out = Vec::new();
    for line in text.lines() {
        let cells: Vec<&str> = line.split(['│', '|', '║']).map(str::trim).filter(|c| !c.is_empty()).collect();
        let Some(id_at) = cells.iter().position(|c| c.len() >= 3 && c.len() <= 20 && c.chars().all(|ch| ch.is_ascii_digit())) else {
            continue;
        };
        let id = cells[id_at].to_string();
        let raw_name = if id_at > 0 { cells[0] } else { cells.get(1).copied().unwrap_or("") };
        let default = line.contains("(default)");
        let name = raw_name.replace("(default)", "").trim().to_string();
        if !out.iter().any(|(i, _, _): &(String, String, bool)| *i == id) {
            out.push((id, if name.is_empty() { "HubSpot portal".into() } else { name }, default));
        }
    }
    out.truncate(500);
    out
}

pub fn hs_accounts(ran: &Ran) -> Checked {
    if !ran.ok {
        return failed("hs", ran);
    }
    let portals = hs_portals(&ran.stdout);
    if portals.is_empty() {
        return Checked { state: Some(CliState::SignedOut), accounts: Vec::new(), detail: Some("The HubSpot CLI has no portals yet. Click Sign in (runs `hs init`).".into()) };
    }
    let accounts = portals.iter().map(|(id, name, d)| account(id, &format!("{name} ({id})"), CliState::Ready, *d)).collect();
    Checked { state: Some(CliState::Ready), accounts, detail: None }
}
