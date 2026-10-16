pub mod filezilla;
pub mod openssh;
pub mod putty;

use crate::profiles::{AuthMethod, ConnectionProfile};
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
            proxy: None,
            jump_profile: None,
            jump_via: None,
        }
    }
}
