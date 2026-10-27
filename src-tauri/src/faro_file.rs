//! `.faro` connection files (issue #58): export connections and groups, and
//! read them back in the Import dialog, so they move between machines and
//! teammates.
//!
//! A plain file is versioned JSON ([`FaroFile`]) with every connection's
//! settings and none of its secrets: passwords, key passphrases, proxy
//! passwords and Access service-token secrets are blanked, and a key kept in
//! the keychain becomes "needs a key". Key file paths stay, as hints, since
//! they are machine-specific. With **Include secrets** the same JSON carries
//! them, and the file is encrypted with a passphrase in the backup's container
//! format (`backup::seal`) under its own magic.
//!
//! [`to_openssh_config`] writes the SSH connections as `Host` blocks instead,
//! in a form the OpenSSH importer reads back with the same routes.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::importers::ProfilePreview;
use crate::profiles::{AuthMethod, ConnectionProfile, ProxyCommandKind, ProxyKind};

/// Magic of an encrypted `.faro` file; a plain one is JSON.
pub const MAGIC: &[u8; 8] = b"FAROCON\x01";
pub const FORMAT: &str = "faro-connections";
pub const VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaroFile {
    pub format: String,
    pub version: u32,
    pub exported_ms: i64,
    /// Whether the connections carry their secrets (the file is encrypted).
    #[serde(default)]
    pub secrets: bool,
    pub connections: Vec<Exported>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Exported {
    #[serde(flatten)]
    pub profile: ConnectionProfile,
    /// Private key of a `KeyRef` login (from the keychain), secrets only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_material: Option<String>,
}

/// What an export wrote, for the dialog's result line.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub connections: usize,
    /// Jump hosts added because a chosen connection goes through them.
    pub added_jumps: Vec<String>,
    /// Connections left out (OpenSSH export: not SSH).
    pub skipped: Vec<String>,
}

/// `ids` plus every jump host they go through, in store order. A connection
/// without its bastion would arrive with a broken route.
pub fn with_jump_hosts<'a>(
    all: &'a [ConnectionProfile],
    ids: &[String],
) -> (Vec<&'a ConnectionProfile>, Vec<String>) {
    let mut want: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut added = Vec::new();
    let mut queue: Vec<&str> = ids.iter().map(String::as_str).collect();
    while let Some(id) = queue.pop() {
        let Some(p) = all.iter().find(|p| p.id == id) else { continue };
        if let Some(jump) = p.jump_profile.as_deref().filter(|j| !j.is_empty()) {
            if let Some(bastion) = all.iter().find(|b| b.id == jump) {
                if want.insert(bastion.id.as_str()) {
                    added.push(bastion.name.clone());
                    queue.push(bastion.id.as_str());
                }
            }
        }
    }
    (all.iter().filter(|p| want.contains(p.id.as_str())).collect(), added)
}

/// Blank every secret a profile can hold.
pub fn strip_secrets(p: &mut ConnectionProfile) {
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

/// Build the file for `ids` (and their jump hosts). `key_for` looks up a
/// `KeyRef` login's private key, asked only when `secrets` is on.
pub fn build(
    all: &[ConnectionProfile],
    ids: &[String],
    secrets: bool,
    key_for: impl Fn(&str) -> Option<String>,
) -> (FaroFile, ExportSummary) {
    let (chosen, added_jumps) = with_jump_hosts(all, ids);
    let connections: Vec<Exported> = chosen
        .into_iter()
        .map(|p| {
            let mut profile = p.clone();
            profile.jump_via = None;
            profile.sort_order = None;
            // Auto-connecting someone else's server on their next launch
            // would be a surprise.
            profile.auto_connect = None;
            let mut key_material = None;
            if let AuthMethod::KeyRef { key_ref } = &profile.auth {
                key_material = secrets.then(|| key_for(key_ref)).flatten();
                if key_material.is_none() {
                    profile.auth = AuthMethod::Key { path: String::new(), passphrase: None, cert_path: None };
                }
            }
            if !secrets {
                strip_secrets(&mut profile);
            }
            Exported { profile, key_material }
        })
        .collect();
    let summary = ExportSummary { connections: connections.len(), added_jumps, skipped: Vec::new() };
    let file = FaroFile {
        format: FORMAT.into(),
        version: VERSION,
        exported_ms: crate::db::now_ms(),
        secrets,
        connections,
    };
    (file, summary)
}

/// Serialize `file`, encrypted when it carries secrets.
pub fn encode(file: &FaroFile, passphrase: Option<&str>) -> Result<Vec<u8>> {
    let json = serde_json::to_vec_pretty(file).context("serialize connections")?;
    if !file.secrets {
        return Ok(json);
    }
    match passphrase.filter(|p| !p.is_empty()) {
        Some(pass) => crate::backup::seal(MAGIC, pass, &json),
        None => bail!("a passphrase is required to export secrets"),
    }
}

pub fn is_encrypted(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

/// Parse a `.faro` file's bytes, decrypting with `passphrase` if needed.
pub fn decode(bytes: &[u8], passphrase: Option<&str>) -> Result<FaroFile> {
    let json = if is_encrypted(bytes) {
        let Some(pass) = passphrase.filter(|p| !p.is_empty()) else {
            bail!("this file is encrypted; enter its passphrase");
        };
        crate::backup::unseal(MAGIC, "a Faro connections file", pass, bytes)?
    } else {
        bytes.to_vec()
    };
    let value: serde_json::Value =
        serde_json::from_slice(&json).context("not a Faro connections file (it isn't valid JSON)")?;
    if value.get("format").and_then(|f| f.as_str()) != Some(FORMAT) {
        bail!("not a Faro connections file");
    }
    let version = value.get("version").and_then(|v| v.as_u64()).unwrap_or(0);
    if version > VERSION as u64 {
        bail!("this file was made by a newer version of Faro (format {version}); update Faro to import it");
    }
    serde_json::from_value(value).context("not a Faro connections file")
}

pub fn read(path: &Path, passphrase: Option<&str>) -> Result<FaroFile> {
    let bytes = std::fs::read(path).with_context(|| format!("Couldn't read {}", path.display()))?;
    decode(&bytes, passphrase)
}

/// What a connection still needs before it can log in on this machine:
/// `key` (no key file here), `password`, `sign-in` (cloud drive OAuth),
/// `token secret` (Access service token).
pub fn needs(p: &ConnectionProfile, has_key_material: bool) -> Vec<String> {
    let oauth = crate::session::oauth_token_service(&p.protocol).is_some();
    let mut out: Vec<String> = Vec::new();
    match &p.auth {
        AuthMethod::Key { path, .. } if path.trim().is_empty() || !crate::keys::expand_tilde(path).is_file() => {
            out.push("key".into())
        }
        AuthMethod::KeyRef { .. } if !has_key_material => out.push("key".into()),
        AuthMethod::Password { password } if password.is_empty() && !oauth && p.protocol != "faro-agent" => {
            out.push("password".into())
        }
        _ => {}
    }
    if oauth {
        out.push("sign-in".into());
    }
    let token = p.proxy_command.as_ref().filter(|c| c.kind == ProxyCommandKind::Cloudflare);
    if token.is_some_and(|c| {
        c.service_token_id.as_deref().is_some_and(|id| !id.is_empty())
            && c.service_token_secret.as_deref().map_or(true, str::is_empty)
    }) {
        out.push("token secret".into());
    }
    out
}

/// One preview per connection, with jump hosts linked inside the file and,
/// for a bastion left out of the import, by name.
pub fn previews(file: FaroFile) -> Vec<ProfilePreview> {
    let names: HashMap<String, String> =
        file.connections.iter().map(|c| (c.profile.id.clone(), c.profile.name.clone())).collect();
    let mut out: Vec<ProfilePreview> = file
        .connections
        .into_iter()
        .map(|c| {
            let p = c.profile;
            let mut v = ProfilePreview::new(p.name.clone());
            v.protocol = p.protocol.clone();
            v.host = p.host.clone();
            v.port = p.port;
            v.username = p.username.clone();
            if let AuthMethod::Key { path, .. } = &p.auth {
                v.identity_file = Some(path.clone()).filter(|p| !p.is_empty());
            }
            v.note = p.group.clone().map(|g| format!("group: {g}"));
            v.proxy = p.proxy.clone();
            v.proxy_command = p.proxy_command.clone();
            v.jump_name = p.jump_profile.as_ref().and_then(|j| names.get(j).cloned());
            v.needs = needs(&p, c.key_material.is_some());
            v.key_material = c.key_material;
            v.profile = Some(p);
            v
        })
        .collect();
    // File ids -> preview ids, for the jump links.
    let ids: HashMap<String, String> = out
        .iter()
        .filter_map(|v| Some((v.profile.as_ref()?.id.clone(), v.preview_id.clone())))
        .collect();
    for v in &mut out {
        let jump = v.profile.as_ref().and_then(|p| p.jump_profile.clone());
        v.jump_preview_id = jump.and_then(|j| ids.get(&j).cloned());
    }
    out
}

// ---- OpenSSH config ----

fn is_ssh(p: &ConnectionProfile) -> bool {
    matches!(p.protocol.as_str(), "sftp" | "ssh" | "")
}

/// A `Host` alias for `name`: spaces and odd characters become `-`.
fn alias_for(name: &str, used: &mut HashSet<String>) -> String {
    let mut base: String = name
        .trim()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect();
    while base.contains("--") {
        base = base.replace("--", "-");
    }
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() { "server".to_string() } else { base };
    let mut alias = base.clone();
    let mut n = 2;
    while !used.insert(alias.to_ascii_lowercase()) {
        alias = format!("{base}-{n}");
        n += 1;
    }
    alias
}

/// Quote a value with spaces, as OpenSSH reads it.
fn quoted(v: &str) -> String {
    if v.contains(char::is_whitespace) {
        format!("\"{v}\"")
    } else {
        v.to_string()
    }
}

/// `Host` blocks for the SSH connections among `ids` (and their jump hosts).
/// Other protocols are skipped and named in the summary.
pub fn to_openssh_config(all: &[ConnectionProfile], ids: &[String]) -> (String, ExportSummary) {
    let (chosen, added_jumps) = with_jump_hosts(all, ids);
    let mut used = HashSet::new();
    let mut aliases: HashMap<&str, String> = HashMap::new();
    let mut skipped = Vec::new();
    for p in &chosen {
        if is_ssh(p) {
            aliases.insert(p.id.as_str(), alias_for(&p.name, &mut used));
        } else {
            skipped.push(p.name.clone());
        }
    }
    let mut out = String::from("# Exported from Faro. Passwords and other secrets are not included.\n");
    let mut count = 0;
    for p in chosen.iter().filter(|p| is_ssh(p)) {
        count += 1;
        let alias = &aliases[p.id.as_str()];
        out.push('\n');
        if alias != p.name.trim() {
            out.push_str(&format!("# {}\n", p.name.trim()));
        }
        out.push_str(&format!("Host {alias}\n"));
        out.push_str(&format!("  HostName {}\n", p.host));
        if !p.username.is_empty() {
            out.push_str(&format!("  User {}\n", p.username));
        }
        if p.port != 22 && p.port != 0 {
            out.push_str(&format!("  Port {}\n", p.port));
        }
        // The Access application: `%h` when it is the host itself.
        let access = match &p.proxy_command {
            Some(cmd) if cmd.kind == ProxyCommandKind::Cloudflare => {
                Some(cmd.hostname.clone().filter(|h| !h.is_empty()).unwrap_or_else(|| "%h".into()))
            }
            _ => None,
        };
        match &p.auth {
            AuthMethod::Key { path, cert_path, .. } => {
                if !path.is_empty() {
                    out.push_str(&format!("  IdentityFile {}\n", quoted(path)));
                }
                if let Some(cert) = cert_path.as_deref().filter(|c| !c.is_empty()) {
                    out.push_str(&format!("  CertificateFile {}\n", quoted(cert)));
                }
            }
            AuthMethod::Agent => out.push_str("  IdentityAgent SSH_AUTH_SOCK\n"),
            // cloudflared writes the short-lived pair here (see `ssh_cert.rs`).
            AuthMethod::CloudflareCert => {
                let h = access.as_deref().unwrap_or("%h");
                out.push_str(&format!("  IdentityFile ~/.cloudflared/{h}-cf_key\n"));
                out.push_str(&format!("  CertificateFile ~/.cloudflared/{h}-cf_key-cert.pub\n"));
            }
            _ => {}
        }
        // OpenSSH uses the first of ProxyJump / ProxyCommand it sees, and a
        // Faro proxy only applies to a connection's first hop anyway.
        let mut jumped = true;
        if let Some(jump) = p.jump_profile.as_deref().and_then(|j| aliases.get(j)) {
            out.push_str(&format!("  ProxyJump {jump}\n"));
        } else if let Some(host) = p.jump_host.as_deref().filter(|h| !h.is_empty()) {
            let user = p.jump_username.as_deref().filter(|u| !u.is_empty());
            let port = p.jump_port.filter(|&port| port != 22);
            out.push_str(&format!(
                "  ProxyJump {}{host}{}\n",
                user.map(|u| format!("{u}@")).unwrap_or_default(),
                port.map(|p| format!(":{p}")).unwrap_or_default(),
            ));
        } else {
            jumped = false;
        }
        match (&p.proxy_command, access.as_deref()) {
            _ if jumped => {}
            (Some(cmd), Some(h)) => {
                out.push_str(&format!("  ProxyCommand cloudflared access ssh --hostname {h}\n"));
                if cmd.service_token_id.as_deref().is_some_and(|id| !id.is_empty()) {
                    out.push_str("  # Uses an Access service token in Faro; its secret is not exported.\n");
                }
            }
            (Some(cmd), None) if !cmd.command.is_empty() => {
                out.push_str(&format!("  ProxyCommand {}\n", cmd.command));
            }
            _ => {
                if let Some(proxy) = &p.proxy {
                    let x = match proxy.kind {
                        ProxyKind::Socks5 => "5",
                        ProxyKind::Http => "connect",
                    };
                    out.push_str(&format!("  ProxyCommand nc -X {x} -x {}:{} %h %p\n", proxy.host, proxy.port));
                }
            }
        }
        // OpenSSH has to ask cloudflared for the certificate itself: the
        // exec runs while matching, once HostName is known.
        if matches!(p.auth, AuthMethod::CloudflareCert) {
            let h = access.as_deref().unwrap_or("%h");
            out.push_str(&format!("\nMatch host {} exec \"cloudflared access ssh-gen --hostname {h}\"\n", p.host));
        }
    }
    (out, ExportSummary { connections: count, added_jumps, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{ProxyCommandConfig, ProxyConfig};

    fn profile(id: &str, name: &str, auth: AuthMethod) -> ConnectionProfile {
        let mut p = crate::importers::ProfilePreview::new(name).into_profile();
        p.id = id.into();
        p.host = format!("{id}.example.com");
        p.username = "deploy".into();
        p.auth = auth;
        p
    }

    fn sample() -> Vec<ConnectionProfile> {
        let mut bastion = profile("b", "Bastion", AuthMethod::Agent);
        bastion.group = Some("Prod".into());
        let mut app = profile("a", "App server", AuthMethod::Password { password: "hunter2".into() });
        app.jump_profile = Some("b".into());
        app.group = Some("Prod".into());
        app.auto_connect = Some(true);
        bastion.proxy = Some(ProxyConfig {
            kind: ProxyKind::Socks5,
            host: "proxy".into(),
            port: 1080,
            username: Some("pu".into()),
            password: Some("pp".into()),
        });
        let mut cf = profile("c", "cf box", AuthMethod::CloudflareCert);
        cf.proxy_command = Some(ProxyCommandConfig {
            kind: ProxyCommandKind::Cloudflare,
            command: String::new(),
            hostname: None,
            service_token_id: Some("id.access".into()),
            service_token_secret: Some("tokSECRET".into()),
        });
        let keyed = profile(
            "k",
            "keyed",
            AuthMethod::Key { path: "/keys/id_ed25519".into(), passphrase: Some("pw".into()), cert_path: None },
        );
        let granted = profile("g", "granted", AuthMethod::KeyRef { key_ref: "grant-key:g".into() });
        let mut s3 = profile("s", "bucket", AuthMethod::Password { password: "s3secret".into() });
        s3.protocol = "s3".into();
        vec![bastion, app, cf, keyed, granted, s3]
    }

    fn all_ids(v: &[ConnectionProfile]) -> Vec<String> {
        v.iter().map(|p| p.id.clone()).collect()
    }

    #[test]
    fn plain_export_has_no_secrets() {
        let all = sample();
        let (file, summary) = build(&all, &all_ids(&all), false, |_| Some("PEM".into()));
        assert_eq!(summary.connections, 6);
        let json = String::from_utf8(encode(&file, None).unwrap()).unwrap();
        for secret in ["hunter2", "\"pp\"", "tokSECRET", "\"pw\"", "s3secret", "PEM"] {
            assert!(!json.contains(secret), "{secret} leaked:\n{json}");
        }
        // Settings and routes are all there.
        for kept in ["\"jumpProfile\": \"b\"", "\"group\": \"Prod\"", "id.access", "/keys/id_ed25519", "\"kind\": \"cloudflarecert\""] {
            assert!(json.contains(kept), "{kept} missing:\n{json}");
        }
        assert!(!json.contains("autoConnect"));
        let back = decode(json.as_bytes(), None).unwrap();
        // A keychain key without its secret becomes "needs a key".
        let granted = back.connections.iter().find(|c| c.profile.id == "g").unwrap();
        assert!(matches!(&granted.profile.auth, AuthMethod::Key { path, .. } if path.is_empty()));
    }

    #[test]
    fn encrypted_export_round_trips_secrets() {
        let all = sample();
        let (file, _) = build(&all, &all_ids(&all), true, |r| (r == "grant-key:g").then(|| "PEM".into()));
        assert!(encode(&file, None).is_err(), "secrets need a passphrase");
        let bytes = encode(&file, Some("correct horse")).unwrap();
        assert!(is_encrypted(&bytes));
        assert!(!String::from_utf8_lossy(&bytes).contains("hunter2"));
        assert!(decode(&bytes, None).unwrap_err().to_string().contains("passphrase"));
        assert!(decode(&bytes, Some("wrong")).unwrap_err().to_string().contains("wrong password"));
        let back = decode(&bytes, Some("correct horse")).unwrap();
        let get = |id: &str| back.connections.iter().find(|c| c.profile.id == id).unwrap();
        assert!(matches!(&get("a").profile.auth, AuthMethod::Password { password } if password == "hunter2"));
        assert_eq!(get("c").profile.proxy_command.as_ref().unwrap().service_token_secret.as_deref(), Some("tokSECRET"));
        assert_eq!(get("g").key_material.as_deref(), Some("PEM"));
        assert!(matches!(&get("g").profile.auth, AuthMethod::KeyRef { .. }));
    }

    #[test]
    fn exporting_one_connection_brings_its_jump_host() {
        let all = sample();
        let (file, summary) = build(&all, &["a".into()], false, |_| None);
        let ids: Vec<_> = file.connections.iter().map(|c| c.profile.id.as_str()).collect();
        assert_eq!(ids, ["b", "a"]);
        assert_eq!(summary.added_jumps, ["Bastion"]);
    }

    #[test]
    fn previews_link_jump_hosts_and_say_what_is_missing() {
        let all = sample();
        let (file, _) = build(&all, &all_ids(&all), false, |_| None);
        let previews = previews(file);
        let find = |n: &str| previews.iter().find(|p| p.name == n).unwrap();
        assert_eq!(find("App server").jump_preview_id.as_deref(), Some(find("Bastion").preview_id.as_str()));
        assert_eq!(find("App server").jump_name.as_deref(), Some("Bastion"));
        assert_eq!(find("App server").needs, ["password"]);
        assert_eq!(find("granted").needs, ["key"]);
        assert_eq!(find("keyed").needs, ["key"], "no /keys/id_ed25519 on this machine");
        assert_eq!(find("cf box").needs, ["token secret"]);
        assert!(find("Bastion").needs.is_empty(), "agent logins need nothing");

        // Baked into profiles: new ids, links remapped, everything else kept.
        let profiles = crate::importers::into_profiles(previews, &[]);
        let find = |n: &str| profiles.iter().find(|p| p.name == n).unwrap();
        assert_ne!(find("Bastion").id, "b");
        assert_eq!(find("App server").jump_profile.as_deref(), Some(find("Bastion").id.as_str()));
        assert_eq!(find("App server").group.as_deref(), Some("Prod"));
        assert_eq!(find("Bastion").proxy.as_ref().unwrap().port, 1080);
        assert!(matches!(find("cf box").auth, AuthMethod::CloudflareCert));
        assert_eq!(find("bucket").protocol, "s3");
    }

    #[test]
    fn rejects_other_files() {
        assert!(decode(b"Host x\n", None).unwrap_err().to_string().contains("not a Faro connections file"));
        assert!(decode(br#"{"format":"other"}"#, None).is_err());
        let newer = br#"{"format":"faro-connections","version":99,"exportedMs":0,"connections":[]}"#;
        assert!(decode(newer, None).unwrap_err().to_string().contains("newer version"));
    }

    #[test]
    fn openssh_config_round_trips_through_the_importer() {
        let all = sample();
        let (text, summary) = to_openssh_config(&all, &all_ids(&all));
        assert_eq!(summary.skipped, ["bucket"]);
        assert_eq!(summary.connections, 5);
        assert!(!text.contains("hunter2") && !text.contains("tokSECRET"));
        assert!(text.contains("Host App-server\n"), "{text}");
        assert!(text.contains("  ProxyJump Bastion\n"), "{text}");
        assert!(text.contains("Match host c.example.com exec \"cloudflared access ssh-gen --hostname %h\""), "{text}");

        let previews = crate::importers::openssh::parse(&text, "t".into());
        let profiles = crate::importers::into_profiles(previews, &[]);
        let find = |n: &str| profiles.iter().find(|p| p.name == n).unwrap_or_else(|| panic!("{n} in\n{text}"));
        let app = find("App-server");
        assert_eq!((app.host.as_str(), app.username.as_str()), ("a.example.com", "deploy"));
        assert_eq!(app.jump_profile.as_deref(), Some(find("Bastion").id.as_str()));
        assert_eq!(find("Bastion").proxy.as_ref().map(|p| (p.kind, p.port)), Some((ProxyKind::Socks5, 1080)));
        assert!(matches!(find("Bastion").auth, AuthMethod::Agent));
        let cf = find("cf-box");
        assert!(matches!(cf.auth, AuthMethod::CloudflareCert), "{:?}", cf.auth);
        assert_eq!(cf.proxy_command.as_ref().map(|c| c.kind), Some(ProxyCommandKind::Cloudflare));
        assert!(matches!(&find("keyed").auth, AuthMethod::Key { path, .. } if path == "/keys/id_ed25519"));
    }
}
