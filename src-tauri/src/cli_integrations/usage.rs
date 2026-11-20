//! Which CLIs a connection depends on, and how. `src/lib/cliUsage.ts` mirrors
//! this for the UI; keep the two in step.

use crate::profiles::{AuthMethod, ConnectionProfile, ProxyCommandKind, MAX_JUMP_HOPS};
use serde::Serialize;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub enum How {
    /// The connection reaches its host through the CLI.
    Tunnel,
    /// Its password or passphrase comes from the CLI.
    Secret,
    /// It signs in with the CLI's login.
    SignIn,
    /// It was imported from the CLI.
    Imported,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUse {
    pub tool: String,
    pub how: How,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// The jump host this comes through, by name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<String>,
}

fn opt(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// The program a `ProxyCommand` line runs, as a tool id (`cloudflared`,
/// `aws`, `gcloud`).
fn command_tool(line: &str) -> Option<&'static str> {
    let first = line.split_whitespace().find(|w| *w != "exec")?.trim_matches(['"', '\'']);
    let base = first.rsplit(['/', '\\']).next()?.to_ascii_lowercase();
    let base = base.trim_end_matches(".exe").trim_end_matches(".cmd");
    ["cloudflared", "aws", "gcloud"].into_iter().find(|t| *t == base)
}

/// What this one profile itself uses (not its jump hosts).
fn own(p: &ConnectionProfile) -> Vec<ToolUse> {
    let mut out = Vec::new();
    let mut push = |tool: &str, how: How, account: Option<String>| out.push(ToolUse { tool: tool.into(), how, account, via: None });
    if let Some(pc) = &p.proxy_command {
        match pc.kind {
            ProxyCommandKind::Cloudflare => push("cloudflared", How::Tunnel, None),
            ProxyCommandKind::AwsSsm => push("aws", How::Tunnel, Some(opt(&pc.cli_account).unwrap_or_else(|| "default".into()))),
            ProxyCommandKind::GcpIap => push("gcloud", How::Tunnel, opt(&pc.cli_account)),
            ProxyCommandKind::Command => {
                if let Some(t) = command_tool(&pc.command) {
                    push(t, How::Tunnel, None);
                }
            }
        }
    }
    if matches!(p.auth, AuthMethod::CloudflareCert) && !matches!(p.proxy_command.as_ref().map(|c| c.kind), Some(ProxyCommandKind::Cloudflare)) {
        push("cloudflared", How::Tunnel, None);
    }
    if let Some(r) = &p.credential_ref {
        match r.provider.as_str() {
            "1password" => push("op", How::Secret, None),
            "bitwarden" => push("bw", How::Secret, None),
            _ => {}
        }
    }
    if let Some(a) = &p.cli_auth {
        let account = super::creds::account_key(&a.account).to_string();
        push(&a.tool, How::SignIn, Some(account));
    }
    if let Some(s) = &p.cli_source {
        push(&s.tool, How::Imported, Some(s.account.clone()).filter(|a| !a.is_empty()));
    }
    out
}

/// Every CLI `profile` depends on, its jump hosts' included.
pub fn profile_tools(profile: &ConnectionProfile, all: &[ConnectionProfile]) -> Vec<ToolUse> {
    let mut out = own(profile);
    let mut seen = vec![profile.id.clone()];
    let mut next = profile.jump_profile.clone();
    for _ in 0..MAX_JUMP_HOPS {
        let Some(id) = next.take() else { break };
        if seen.contains(&id) {
            break;
        }
        let Some(hop) = all.iter().find(|p| p.id == id) else { break };
        seen.push(id);
        for mut u in own(hop) {
            if u.how == How::Imported {
                continue;
            }
            u.via = Some(hop.name.clone());
            out.push(u);
        }
        next = hop.jump_profile.clone();
    }
    out.dedup();
    out
}

/// Per tool: the accounts connections use (`default` for the CLI's own).
/// Imports alone don't count: they need nothing at connect time.
pub fn accounts_by_tool(all: &[ConnectionProfile]) -> BTreeMap<String, BTreeSet<String>> {
    let mut out: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for p in all {
        for u in profile_tools(p, all) {
            if u.how == How::Imported {
                continue;
            }
            let set = out.entry(u.tool).or_default();
            if let Some(a) = u.account {
                set.insert(a);
            }
        }
    }
    out
}

/// How many connections use each tool (imports included).
pub fn counts(all: &[ConnectionProfile]) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    for p in all {
        let tools: BTreeSet<String> = profile_tools(p, all).into_iter().map(|u| u.tool).collect();
        for t in tools {
            *out.entry(t).or_insert(0) += 1;
        }
    }
    out
}
