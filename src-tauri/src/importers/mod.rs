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
            note: None,
            ftp_encoding: None,
            ftp_active_mode: None,
            proxy: None,
            proxy_command: None,
            jump_preview_id: None,
            jump_name: None,
        }
    }

    /// Bake the preview into a real ConnectionProfile. The user can edit it
    /// further from the connection sidebar; here we just produce a sensible
    /// default with an empty password / passphrase.
    pub fn into_profile(self) -> ConnectionProfile {
        let auth = if let Some(path) = self.identity_file.clone() {
            AuthMethod::Key {
                path,
                passphrase: None,
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
        }
    }
}

/// Bake a batch of previews into profiles, linking jump hosts: to the
/// bastion's profile from the same batch, else to an existing SSH profile of
/// the same name. A bastion found in neither leaves the profile direct.
pub fn into_profiles(previews: Vec<ProfilePreview>, existing: &[ConnectionProfile]) -> Vec<ConnectionProfile> {
    let links: Vec<(Option<String>, Option<String>)> = previews
        .iter()
        .map(|p| (p.jump_preview_id.clone(), p.jump_name.clone()))
        .collect();
    let ids: Vec<String> = previews.iter().map(|p| p.preview_id.clone()).collect();
    let mut profiles: Vec<ConnectionProfile> = previews.into_iter().map(ProfilePreview::into_profile).collect();
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
    profiles
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
}
