pub mod filezilla;
pub mod openssh;
pub mod putty;

use crate::profiles::{AuthMethod, ConnectionProfile, ProxyCommandConfig, ProxyConfig};
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A profile-shaped record produced by an importer. We don't dump it
/// straight into the store — the frontend lets the user pick which entries
/// to actually save, plus rename or tweak any of them before committing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilePreview {
    /// Stable identifier for the lifetime of this dialog — lets the UI track
    /// selection without depending on the (mutable) name.
    pub preview_id: String,
    pub name: String,
    pub protocol: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// Path to a private key file if the source recorded one. We don't read
    /// the key contents — the user gets the path and we set up a Key auth
    /// pointing at it. Empty means password auth (which won't ship a
    /// password — the user fills it in).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub identity_file: Option<String>,
    /// OpenSSH `CertificateFile` for that key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate_file: Option<String>,
    /// Free-form note shown next to the preview row. Importers use this for
    /// "from ~/.ssh/config", "site folder: Personal/Work", etc.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    /// FTP character set carried over from the source (FileZilla's
    /// per-site "Charset" setting). `None` means auto.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ftp_encoding: Option<String>,
    /// FTP active (PORT) mode carried over from the source. `None` = passive.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ftp_active_mode: Option<bool>,
    /// Proxy carried over from the source (OpenSSH `ProxyCommand nc -X ...`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<ProxyConfig>,
    /// A `ProxyCommand` that isn't a plain proxy or jump host (cloudflared,
    /// AWS SSM, ...), run as the SSH transport.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_command: Option<ProxyCommandConfig>,
    /// Jump host (OpenSSH `ProxyJump`): the bastion's preview in the same
    /// import, and its name for matching an existing profile when that
    /// preview isn't imported.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_preview_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jump_name: Option<String>,
    /// Log in with the SSH agent (OpenSSH `IdentityAgent`, no `IdentityFile`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub agent: bool,
    /// Log in with a Cloudflare short-lived certificate (cloudflared's
    /// `%h-cf_key` behind `cloudflared access ssh`).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub cloudflare_cert: bool,
    /// The whole connection, from a `.faro` file: imported as is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<ConnectionProfile>,
    /// A `KeyRef` login's private key, from an encrypted `.faro` file.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_material: Option<String>,
    /// What the connection still needs here (`key`, `password`, `sign-in`,
    /// `token secret`), shown as badges. See `faro_file::needs`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub needs: Vec<String>,
    /// An existing connection with the same name or host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict: Option<Conflict>,
    /// What to do about `conflict`, chosen in the dialog.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<Resolution>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conflict {
    pub id: String,
    pub name: String,
    /// Matched by name (else by host, port and user).
    pub by_name: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Resolution {
    Skip,
    /// A new connection, renamed "<name> (copy)" when the names clash.
    Copy,
    /// Overwrite the existing connection, keeping its saved secrets when the
    /// import has none.
    Replace,
}

/// Point each preview at an existing connection it would duplicate: same
/// name (ignoring case), else same protocol, host, port and user.
pub fn mark_conflicts(previews: &mut [ProfilePreview], existing: &[ConnectionProfile]) {
    let norm = |s: &str| s.trim().to_lowercase();
    for p in previews {
        let by_name = existing.iter().find(|e| norm(&e.name) == norm(&p.name));
        let by_host = || {
            existing.iter().find(|e| {
                !p.host.is_empty()
                    && norm(&e.host) == norm(&p.host)
                    && e.port == p.port
                    && e.username == p.username
                    && e.protocol == p.protocol
            })
        };
        p.conflict = by_name
            .map(|e| (e, true))
            .or_else(|| by_host().map(|e| (e, false)))
            .map(|(e, by_name)| Conflict { id: e.id.clone(), name: e.name.clone(), by_name });
    }
}

impl ProfilePreview {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            preview_id: Uuid::new_v4().to_string(),
            name: name.into(),
            protocol: "sftp".into(),
            host: String::new(),
            port: 22,
            username: String::new(),
            identity_file: None,
            certificate_file: None,
            note: None,
            ftp_encoding: None,
            ftp_active_mode: None,
            proxy: None,
            proxy_command: None,
            jump_preview_id: None,
            jump_name: None,
            agent: false,
            cloudflare_cert: false,
            profile: None,
            key_material: None,
            needs: Vec::new(),
            conflict: None,
            resolution: None,
        }
    }

    /// Bake the preview into a real ConnectionProfile. The user can edit it
    /// further from the connection sidebar; here we just produce a sensible
    /// default with an empty password / passphrase.
    pub fn into_profile(self) -> ConnectionProfile {
        if let Some(mut profile) = self.profile {
            profile.id = Uuid::new_v4().to_string();
            profile.name = self.name;
            // Re-linked by `into_profiles`.
            profile.jump_profile = None;
            profile.jump_via = None;
            profile.sort_order = None;
            return profile;
        }
        let auth = if self.cloudflare_cert {
            AuthMethod::CloudflareCert
        } else if self.agent {
            AuthMethod::Agent
        } else if let Some(path) = self.identity_file.clone() {
            AuthMethod::Key {
                path,
                passphrase: None,
                cert_path: self.certificate_file.clone(),
            }
        } else {
            AuthMethod::Password {
                password: String::new(),
            }
        };
        ConnectionProfile {
            id: Uuid::new_v4().to_string(),
            name: self.name,
            protocol: self.protocol,
            host: self.host,
            port: self.port,
            username: self.username,
            auth,
            default_remote_path: None,
            default_local_path: None,
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
            ftp_encoding: self.ftp_encoding,
            ftp_active_mode: self.ftp_active_mode,
            ftp_max_connections: None,
            ftp_segments: None,
            proxy: self.proxy,
            jump_profile: None,
            jump_via: None,
            proxy_command: self.proxy_command,
            oauth_client_id: None,
            cf_forwards: Vec::new(),
        }
    }
}

/// Bake a batch of previews into profiles, linking jump hosts: to the
/// bastion's profile from the same batch, else to an existing SSH profile of
/// the same name. A bastion found in neither leaves the profile direct.
pub fn into_profiles(previews: Vec<ProfilePreview>, existing: &[ConnectionProfile]) -> Vec<ConnectionProfile> {
    into_profiles_with_keys(previews, existing).into_iter().map(|(p, _)| p).collect()
}

/// [`into_profiles`], applying each preview's conflict resolution (skipped
/// ones are left out), and returning the private key a `KeyRef` login brought.
pub fn into_profiles_with_keys(
    previews: Vec<ProfilePreview>,
    existing: &[ConnectionProfile],
) -> Vec<(ConnectionProfile, Option<String>)> {
    let previews: Vec<ProfilePreview> = previews
        .into_iter()
        .filter(|p| !(p.conflict.is_some() && p.resolution == Some(Resolution::Skip)))
        .collect();
    let links: Vec<(Option<String>, Option<String>)> = previews
        .iter()
        .map(|p| (p.jump_preview_id.clone(), p.jump_name.clone()))
        .collect();
    let ids: Vec<String> = previews.iter().map(|p| p.preview_id.clone()).collect();
    let mut keys: Vec<Option<String>> = Vec::with_capacity(previews.len());
    let mut profiles: Vec<ConnectionProfile> = previews
        .into_iter()
        .map(|mut p| {
            keys.push(p.key_material.take());
            let conflict = p.conflict.take();
            let resolution = p.resolution;
            let mut profile = p.into_profile();
            match (conflict, resolution) {
                (Some(c), Some(Resolution::Replace)) => {
                    if let Some(old) = existing.iter().find(|e| e.id == c.id) {
                        keep_secrets(&mut profile, old);
                        profile.sort_order = old.sort_order;
                    }
                    profile.id = c.id;
                }
                (Some(c), Some(Resolution::Copy)) if c.by_name => {
                    profile.name = format!("{} (copy)", profile.name);
                }
                _ => {}
            }
            profile
        })
        .collect();
    let by_preview: HashMap<String, String> = ids
        .into_iter()
        .zip(profiles.iter().map(|p| p.id.clone()))
        .collect();
    for (profile, (preview_id, name)) in profiles.iter_mut().zip(links) {
        profile.jump_profile = preview_id
            .and_then(|id| by_preview.get(&id).cloned())
            .or_else(|| {
                let name = name?;
                existing
                    .iter()
                    .find(|e| e.name == name && matches!(e.protocol.as_str(), "sftp" | "ssh" | ""))
                    .map(|e| e.id.clone())
            });
    }
    profiles.into_iter().zip(keys).collect()
}

/// Carry `old`'s saved secrets into a replacement that came without them.
fn keep_secrets(new: &mut ConnectionProfile, old: &ConnectionProfile) {
    match (&mut new.auth, &old.auth) {
        (AuthMethod::Password { password }, AuthMethod::Password { password: kept }) if password.is_empty() => {
            *password = kept.clone()
        }
        (AuthMethod::Key { passphrase, .. }, AuthMethod::Key { passphrase: kept, .. }) if passphrase.is_none() => {
            *passphrase = kept.clone()
        }
        _ => {}
    }
    if let (Some(proxy), Some(kept)) = (new.proxy.as_mut(), old.proxy.as_ref()) {
        if proxy.password.is_none() && proxy.host == kept.host {
            proxy.password = kept.password.clone();
        }
    }
    if let (Some(cmd), Some(kept)) = (new.proxy_command.as_mut(), old.proxy_command.as_ref()) {
        if cmd.service_token_secret.is_none() && cmd.service_token_id == kept.service_token_id {
            cmd.service_token_secret = kept.service_token_secret.clone();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn into_profiles_links_jump_hosts() {
        let cfg = concat!(
            "Host bastion\n HostName b\n",
            "Host app\n HostName a\n ProxyJump bastion\n",
        );
        let profiles = into_profiles(openssh::parse(cfg, "t".into()), &[]);
        let find = |n: &str| profiles.iter().find(|p| p.name == n).unwrap();
        assert_eq!(find("app").jump_profile.as_deref(), Some(find("bastion").id.as_str()));
        assert!(find("bastion").jump_profile.is_none());

        // The bastion preview left out of the import: an existing SSH
        // profile of the same name is used instead.
        let mut existing = find("bastion").clone();
        existing.id = "existing-id".into();
        let app: Vec<_> = openssh::parse(cfg, "t".into())
            .into_iter()
            .filter(|p| p.name == "app")
            .collect();
        let profiles = into_profiles(app.clone(), std::slice::from_ref(&existing));
        assert_eq!(profiles[0].jump_profile.as_deref(), Some("existing-id"));
        assert!(into_profiles(app, &[])[0].jump_profile.is_none());
    }

    #[test]
    fn conflicts_skip_copy_or_replace() {
        let mut existing = ProfilePreview::new("Web").into_profile();
        existing.host = "web.example".into();
        existing.auth = AuthMethod::Password { password: "saved".into() };
        existing.sort_order = Some(4);
        let mut other = ProfilePreview::new("Other name").into_profile();
        other.host = "db.example".into();
        let existing = vec![existing, other];

        let cfg = "Host web\n HostName web.example\nHost db2\n HostName db.example\nHost new\n HostName n\n";
        let mut previews = openssh::parse(cfg, "t".into());
        mark_conflicts(&mut previews, &existing);
        let find = |n: &str| previews.iter().find(|p| p.name == n).unwrap();
        assert!(find("web").conflict.as_ref().is_some_and(|c| c.by_name && c.id == existing[0].id));
        assert!(find("db2").conflict.as_ref().is_some_and(|c| !c.by_name && c.id == existing[1].id));
        assert!(find("new").conflict.is_none());

        let with = |r: Resolution| {
            let ps: Vec<_> = previews
                .iter()
                .cloned()
                .map(|mut p| {
                    p.resolution = Some(r);
                    p
                })
                .collect();
            into_profiles(ps, &existing)
        };
        assert_eq!(with(Resolution::Skip).len(), 1, "only the new one");
        let copies = with(Resolution::Copy);
        assert!(copies.iter().any(|p| p.name == "web (copy)"));
        assert!(copies.iter().any(|p| p.name == "db2"), "a host match keeps its name");
        assert!(copies.iter().all(|p| p.id != existing[0].id));
        let replaced = with(Resolution::Replace);
        let web = replaced.iter().find(|p| p.id == existing[0].id).unwrap();
        assert_eq!(web.name, "web");
        assert_eq!(web.sort_order, Some(4));
        assert!(matches!(&web.auth, AuthMethod::Password { password } if password == "saved"));
    }

    #[test]
    fn openssh_agent_and_cloudflare_cert_logins() {
        let cfg = concat!(
            "Host agent\n HostName a\n IdentityAgent SSH_AUTH_SOCK\n",
            "Host cf\n HostName c\n ProxyCommand cloudflared access ssh --hostname %h\n",
            " IdentityFile ~/.cloudflared/%h-cf_key\n CertificateFile ~/.cloudflared/%h-cf_key-cert.pub\n",
            "Match host c exec \"cloudflared access ssh-gen --hostname %h\"\n",
            " User not-for-cf\n",
        );
        let profiles = into_profiles(openssh::parse(cfg, "t".into()), &[]);
        let find = |n: &str| profiles.iter().find(|p| p.name == n).unwrap();
        assert!(matches!(find("agent").auth, AuthMethod::Agent));
        assert!(matches!(find("cf").auth, AuthMethod::CloudflareCert));
        assert_eq!(find("cf").username, "", "the Match block's User isn't the Host block's");
    }
}
