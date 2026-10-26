use anyhow::{Context, Result};
use russh_keys::key::PublicKey;
use russh_keys::PublicKeyBase64;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

/// Path to `~/.ssh/known_hosts`. We use OpenSSH's standard location even on
/// Windows so users get the same file PuTTY-via-OpenSSH and ssh.exe already
/// touch. Hashed (`|1|salt|hash`) host lines are out of scope for v0.3 — we
/// match against unhashed `host` and `host,host2` entries only. Users with
/// HashKnownHosts=yes won't get matches; that's acceptable until v0.4.
pub fn known_hosts_path() -> Option<PathBuf> {
    let home = dirs::home_dir()?;
    Some(home.join(".ssh").join("known_hosts"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyStatus {
    /// File doesn't exist, or no entries match the host:port — caller must prompt.
    Unknown,
    /// Host is recorded with this exact key.
    Match,
    /// Host is recorded but with a different key — caller should refuse.
    Mismatch { stored_fingerprint: String },
}

pub fn check(host: &str, port: u16, key: &PublicKey) -> HostKeyStatus {
    let Some(path) = known_hosts_path() else {
        return HostKeyStatus::Unknown;
    };
    let Ok(contents) = std::fs::read_to_string(&path) else {
        return HostKeyStatus::Unknown;
    };
    check_contents(&contents, host, port, &key.public_key_base64())
}

fn check_contents(contents: &str, host: &str, port: u16, key_b64: &str) -> HostKeyStatus {
    let needles = host_needles(host, port);
    let names_host = |field: &str| {
        field
            .split(',')
            .any(|h| needles.iter().any(|n| n.eq_ignore_ascii_case(h)))
    };

    let mut matched = false;
    let mut stored_fp: Option<String> = None;
    for line in contents.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let Some(mut hosts_field) = parts.next() else { continue };
        // `@revoked` names a key that must never be accepted for these hosts.
        // `@cert-authority` (CA-signed host certs) isn't supported, so those
        // lines neither match nor conflict.
        let revoked = hosts_field == "@revoked";
        if hosts_field.starts_with('@') {
            if !revoked {
                continue;
            }
            let Some(next) = parts.next() else { continue };
            hosts_field = next;
        }
        let (Some(_keytype), Some(stored_b64)) = (parts.next(), parts.next()) else {
            continue;
        };

        if hosts_field.starts_with("|1|") || !names_host(hosts_field) {
            // Hashed host entries are out of scope for v0.3.
            continue;
        }
        if revoked {
            if stored_b64 == key_b64 {
                return HostKeyStatus::Mismatch {
                    stored_fingerprint: format!("{} (revoked)", fingerprint_b64(stored_b64)),
                };
            }
        } else if stored_b64 == key_b64 {
            matched = true;
        } else if stored_fp.is_none() {
            stored_fp = Some(fingerprint_b64(stored_b64));
        }
    }

    match (matched, stored_fp) {
        (true, _) => HostKeyStatus::Match,
        (false, Some(fp)) => HostKeyStatus::Mismatch { stored_fingerprint: fp },
        (false, None) => HostKeyStatus::Unknown,
    }
}

/// Append a host entry. Writes `host[:port] <type> <base64>` in OpenSSH's
/// non-standard-port form (`[host]:port`). Creates `~/.ssh` with `0700` on
/// unix if needed.
pub fn append(host: &str, port: u16, key: &PublicKey) -> Result<()> {
    let path = known_hosts_path().context("could not resolve ~/.ssh/known_hosts")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).ok();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700));
        }
    }
    let host_field = if port == 22 {
        host.to_string()
    } else {
        format!("[{host}]:{port}")
    };
    let line = format!(
        "{host_field} {} {}\n",
        crate::keys::type_token(key),
        key.public_key_base64()
    );

    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .with_context(|| format!("opening {} for append", path.display()))?;
    file.write_all(line.as_bytes())?;
    Ok(())
}

/// Compute the SHA-256 fingerprint of a public key in OpenSSH form:
/// `SHA256:<base64-no-padding>`.
pub fn fingerprint(key: &PublicKey) -> String {
    use sha2::{Digest, Sha256};
    let blob = key.public_key_bytes();
    let mut hasher = Sha256::new();
    hasher.update(&blob);
    let digest = hasher.finalize();
    let b64 = base64_no_pad(&digest);
    format!("SHA256:{b64}")
}

fn fingerprint_b64(stored_b64: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let Ok(raw) = base64::engine::general_purpose::STANDARD.decode(stored_b64) else {
        return "SHA256:<unparseable>".into();
    };
    let mut hasher = Sha256::new();
    hasher.update(&raw);
    let digest = hasher.finalize();
    format!("SHA256:{}", base64_no_pad(&digest))
}

fn base64_no_pad(bytes: &[u8]) -> String {
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD_NO_PAD.encode(bytes);
    b64
}

/// The host-field spellings that mean `host:port`, as OpenSSH reads them: a
/// bare `host` is port 22 only; any other port is `[host]:port`.
fn host_needles(host: &str, port: u16) -> Vec<String> {
    if port == 22 {
        vec![host.to_string(), format!("[{host}]:22")]
    } else {
        vec![format!("[{host}]:{port}")]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIA";
    const B: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIB";

    #[test]
    fn port_22_entry_does_not_match_other_ports() {
        let kh = format!("example.com ssh-ed25519 {A}\n");
        assert_eq!(check_contents(&kh, "example.com", 22, A), HostKeyStatus::Match);
        assert_eq!(check_contents(&kh, "example.com", 2222, B), HostKeyStatus::Unknown);
        let kh = format!("[example.com]:2222 ssh-ed25519 {A}\n");
        assert_eq!(check_contents(&kh, "example.com", 2222, A), HostKeyStatus::Match);
        assert_eq!(check_contents(&kh, "example.com", 22, A), HostKeyStatus::Unknown);
    }

    #[test]
    fn host_match_ignores_case() {
        let kh = format!("server.lan ssh-ed25519 {A}\n");
        assert_eq!(check_contents(&kh, "Server.LAN", 22, A), HostKeyStatus::Match);
        assert!(matches!(
            check_contents(&kh, "SERVER.lan", 22, B),
            HostKeyStatus::Mismatch { .. }
        ));
    }

    #[test]
    fn revoked_key_is_never_accepted() {
        let kh = format!("server.lan ssh-ed25519 {A}\n@revoked server.lan ssh-ed25519 {A}\n");
        assert!(matches!(
            check_contents(&kh, "server.lan", 22, A),
            HostKeyStatus::Mismatch { .. }
        ));
        // A revoked line for another key doesn't block a good one.
        let kh = format!("@revoked server.lan ssh-ed25519 {B}\nserver.lan ssh-ed25519 {A}\n");
        assert_eq!(check_contents(&kh, "server.lan", 22, A), HostKeyStatus::Match);
        let kh = format!("@cert-authority *.lan ssh-ed25519 {A}\n");
        assert_eq!(check_contents(&kh, "server.lan", 22, A), HostKeyStatus::Unknown);
    }
}
