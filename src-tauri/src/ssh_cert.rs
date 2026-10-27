//! OpenSSH user certificates (issue #55): a private key plus the
//! `-cert.pub` an SSH CA signed for it. Covers teams running their own CA
//! (Vault, step-ca, Teleport) and Cloudflare Access short-lived certificates,
//! which `cloudflared access ssh-gen` issues on every connect.

use anyhow::{bail, Context, Result};
use russh_keys::key::KeyPair;
use ssh_key::Certificate;
use std::path::{Path, PathBuf};

/// Who signed a certificate, for the messages when a server refuses it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Issuer {
    /// A certificate file next to the key: the team's own SSH CA.
    File,
    Cloudflare,
}

pub fn parse_cert(text: &str) -> Result<Certificate> {
    Certificate::from_openssh(text.trim()).map_err(|e| anyhow::anyhow!("not an OpenSSH certificate ({e})"))
}

/// A private key from PEM text. Besides what russh reads, this takes the
/// SEC1 `EC PRIVATE KEY` PEM that `cloudflared access ssh-gen` writes.
pub fn decode_key(pem: &str, passphrase: Option<&str>) -> Result<KeyPair> {
    if pem.contains("-----BEGIN EC PRIVATE KEY-----") {
        use p256::pkcs8::{EncodePrivateKey, LineEnding};
        let key = p256::SecretKey::from_sec1_pem(pem).map_err(|e| anyhow::anyhow!("unsupported EC key ({e}); only P-256 is read"))?;
        let pkcs8 = key.to_pkcs8_pem(LineEnding::LF).map_err(|e| anyhow::anyhow!("re-encode EC key: {e}"))?;
        return russh_keys::decode_secret_key(&pkcs8, None).context("decode EC key");
    }
    Ok(russh_keys::decode_secret_key(pem, passphrase)?)
}

/// Whether `cert` certifies `key`'s public half.
pub fn matches(key: &KeyPair, cert: &Certificate) -> bool {
    use russh_keys::PublicKeyBase64;
    let key_blob = key.clone_public_key().ok().map(|k| k.public_key_base64());
    let cert_blob = ssh_key::PublicKey::from(cert.public_key().clone())
        .to_openssh()
        .ok()
        .and_then(|line| line.split_whitespace().nth(1).map(String::from));
    matches!((key_blob, cert_blob), (Some(a), Some(b)) if a == b)
}

/// Where OpenSSH looks for a key's certificate: `<key>-cert.pub`.
pub fn default_cert_path(key_path: &Path) -> PathBuf {
    let mut s = key_path.as_os_str().to_owned();
    s.push("-cert.pub");
    PathBuf::from(s)
}

/// The certificate to offer with the key at `key_path`: `cert_path` when set,
/// else `<key>-cert.pub` if there is one. A chosen certificate that can't be
/// read or is for another key is an error; a stray default one is skipped.
pub fn load_for_key(key_path: &Path, cert_path: Option<&str>, key: &KeyPair) -> Result<Option<Certificate>> {
    let explicit = cert_path.map(str::trim).filter(|s| !s.is_empty());
    let path = match explicit {
        Some(p) => crate::keys::expand_tilde(p),
        None => default_cert_path(key_path),
    };
    if explicit.is_none() && !path.is_file() {
        return Ok(None);
    }
    let read = std::fs::read_to_string(&path)
        .with_context(|| format!("read certificate {}", path.display()))
        .and_then(|text| parse_cert(&text).with_context(|| format!("read certificate {}", path.display())));
    match read {
        Ok(cert) if matches(key, &cert) => Ok(Some(cert)),
        Ok(_) if explicit.is_some() => {
            bail!("the certificate {} is for a different key than {}", path.display(), key_path.display())
        }
        Err(e) if explicit.is_some() => Err(e),
        Ok(_) => Ok(None),
        Err(e) => {
            tracing::debug!(error = %format!("{e:#}"), "skipping the key's default certificate");
            Ok(None)
        }
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn listed(principals: &[String]) -> String {
    principals.iter().map(|p| format!("`{p}`")).collect::<Vec<_>>().join(", ")
}

/// Why a server most likely refused `cert` for `username`, as the error to
/// show. Worked out before the attempt (russh only answers yes or no).
pub fn refusal(cert: &Certificate, username: &str, issuer: Issuer) -> String {
    let principals = cert.valid_principals();
    if cert.valid_before() <= now() {
        return match issuer {
            Issuer::Cloudflare => "the Cloudflare certificate had already expired; check this computer's clock".into(),
            Issuer::File => "the SSH certificate has expired; get a new one from your SSH CA".into(),
        };
    }
    if !principals.is_empty() && !principals.iter().any(|p| p == username) {
        return match issuer {
            Issuer::Cloudflare => format!(
                "Cloudflare issued a certificate for {}, but the server refused it for user `{username}`. \
                 Add {} to the server's principals file, or log in as {}.",
                listed(principals),
                listed(principals),
                listed(principals)
            ),
            Issuer::File => format!(
                "the SSH certificate is for {}, but the server refused it for user `{username}`. \
                 Log in as one of those, or get a certificate that includes `{username}`.",
                listed(principals)
            ),
        };
    }
    match issuer {
        Issuer::Cloudflare => format!(
            "the server refused the Cloudflare certificate for `{username}`. Check that its sshd trusts \
             the Access application's CA (TrustedUserCAKeys) and maps the principal to this user."
        ),
        Issuer::File => format!(
            "the server refused the SSH certificate for `{username}`. Check that its sshd trusts \
             the CA that signed it (TrustedUserCAKeys)."
        ),
    }
}

// ---- Cloudflare short-lived certificates ------------------------------------

/// cloudflared's config folder, with home found the way cloudflared finds it:
/// `HOME` first, then (on Windows) `USERPROFILE`. `ssh-gen` writes there.
pub fn cloudflared_dir() -> Option<PathBuf> {
    #[cfg(test)]
    if let Some(dir) = tests::CLOUDFLARED_DIR.lock().unwrap().clone() {
        return Some(dir);
    }
    let env = |k: &str| std::env::var_os(k).filter(|v| !v.is_empty()).map(PathBuf::from);
    let home = env("HOME").or_else(|| if cfg!(windows) { env("USERPROFILE") } else { None }).or_else(dirs::home_dir)?;
    Some(home.join(".cloudflared"))
}

/// The key file `ssh-gen` writes for `hostname`: `<host><path>-cf_key`,
/// slashes as dashes. Its certificate is the same plus `-cert.pub`.
pub fn ssh_gen_key_name(hostname: &str) -> String {
    let h = hostname.trim();
    let h = h.strip_prefix("https://").or_else(|| h.strip_prefix("http://")).unwrap_or(h);
    format!("{}-cf_key", h.trim_end_matches('/').replace('/', "-"))
}

/// Read and delete the key and certificate `ssh-gen` left in `dir`.
pub fn take_ssh_gen_output(dir: &Path, hostname: &str) -> Result<(KeyPair, Certificate)> {
    let key_path = dir.join(ssh_gen_key_name(hostname));
    let cert_path = default_cert_path(&key_path);
    let mut pub_path = key_path.clone().into_os_string();
    pub_path.push(".pub");
    let read = (|| {
        let pem = std::fs::read_to_string(&key_path).with_context(|| format!("read {}", key_path.display()))?;
        let cert = std::fs::read_to_string(&cert_path).with_context(|| format!("read {}", cert_path.display()))?;
        Ok::<_, anyhow::Error>((decode_key(&pem, None)?, parse_cert(&cert)?))
    })();
    // Temporary by design: a fresh pair is issued on every connect.
    for p in [&key_path, &cert_path, &PathBuf::from(pub_path)] {
        let _ = std::fs::remove_file(p);
    }
    let (key, cert) = read.context("cloudflared didn't leave a usable SSH certificate")?;
    if !matches(&key, &cert) {
        bail!("the Cloudflare certificate doesn't match its key (another connection replaced it); try again");
    }
    Ok((key, cert))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const OPENSSH_PEM: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";

    /// Stands in for `~/.cloudflared`, so tests never touch the real one.
    pub(crate) static CLOUDFLARED_DIR: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

    /// A CA, a user key and a certificate for it, made with ssh-key.
    pub(crate) fn issue(principals: &[&str], valid_for: i64) -> (KeyPair, String, ssh_key::PrivateKey) {
        use ssh_key::{certificate, rand_core::OsRng, Algorithm, PrivateKey};
        let ca = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
        let user = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
        let now = now();
        let before = (now as i64 + valid_for).max(1) as u64;
        let mut b = certificate::Builder::new_with_random_nonce(&mut OsRng, user.public_key(), now.saturating_sub(60).min(before - 1), before).unwrap();
        b.cert_type(certificate::CertType::User).unwrap().key_id("test").unwrap();
        if principals.is_empty() {
            b.all_principals_valid().unwrap();
        }
        for p in principals {
            b.valid_principal(*p).unwrap();
        }
        let cert = b.sign(&ca).unwrap().to_openssh().unwrap();
        let pem = user.to_openssh(ssh_key::LineEnding::LF).unwrap();
        assert!(pem.starts_with(OPENSSH_PEM));
        (russh_keys::decode_secret_key(&pem, None).unwrap(), cert, user)
    }

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("faro-cert-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn a_certificate_is_matched_to_its_key() {
        let (key, cert, _) = issue(&["jane"], 300);
        let (other, _, _) = issue(&["jane"], 300);
        let cert = parse_cert(&cert).unwrap();
        assert!(matches(&key, &cert));
        assert!(!matches(&other, &cert));
    }

    #[test]
    fn the_default_certificate_sits_next_to_the_key() {
        let dir = scratch("default");
        let (key, cert, _) = issue(&["jane"], 300);
        let key_path = dir.join("id_ed25519");
        assert!(load_for_key(&key_path, None, &key).unwrap().is_none(), "no file, no certificate");
        std::fs::write(dir.join("id_ed25519-cert.pub"), &cert).unwrap();
        assert!(load_for_key(&key_path, None, &key).unwrap().is_some());
        // A stray default certificate for another key is skipped...
        let (other, _, _) = issue(&["jane"], 300);
        assert!(load_for_key(&key_path, None, &other).unwrap().is_none());
        // ...but a chosen one is an error.
        let chosen = dir.join("id_ed25519-cert.pub").to_string_lossy().into_owned();
        let err = load_for_key(&key_path, Some(&chosen), &other).unwrap_err();
        assert!(err.to_string().contains("is for a different key"), "{err:#}");
        let err = load_for_key(&key_path, Some("/nope/x-cert.pub"), &key).unwrap_err();
        assert!(err.to_string().contains("read certificate"), "{err:#}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn refusals_name_the_principal_and_the_user() {
        let (_, cert, _) = issue(&["jane.doe"], 300);
        let cert = parse_cert(&cert).unwrap();
        assert_eq!(
            refusal(&cert, "deploy", Issuer::Cloudflare),
            "Cloudflare issued a certificate for `jane.doe`, but the server refused it for user `deploy`. \
             Add `jane.doe` to the server's principals file, or log in as `jane.doe`."
        );
        assert!(refusal(&cert, "jane.doe", Issuer::Cloudflare).contains("TrustedUserCAKeys"));
        assert!(refusal(&cert, "deploy", Issuer::File).contains("get a certificate that includes `deploy`"));
        let (_, expired, _) = issue(&["jane.doe"], -30);
        assert!(refusal(&parse_cert(&expired).unwrap(), "jane.doe", Issuer::File).contains("expired"));
        let (_, any, _) = issue(&[], 300);
        assert!(refusal(&parse_cert(&any).unwrap(), "deploy", Issuer::File).contains("TrustedUserCAKeys"));
    }

    #[test]
    fn ssh_gen_file_names_follow_cloudflared() {
        assert_eq!(ssh_gen_key_name("ssh.example.com"), "ssh.example.com-cf_key");
        assert_eq!(ssh_gen_key_name("https://ssh.example.com/"), "ssh.example.com-cf_key");
        assert_eq!(ssh_gen_key_name("https://example.com/ssh"), "example.com-ssh-cf_key");
    }

    /// What `ssh-gen` writes: a SEC1 P-256 key, read and then removed.
    #[test]
    fn ssh_gen_output_is_read_then_deleted() {
        use p256::elliptic_curve::sec1::ToEncodedPoint;
        use ssh_key::{certificate, public::EcdsaPublicKey, rand_core::OsRng, Algorithm, PrivateKey};
        let dir = scratch("sshgen");
        let secret = p256::SecretKey::random(&mut OsRng);
        let sec1 = secret.to_sec1_pem(p256::pkcs8::LineEnding::LF).unwrap();
        assert!(sec1.contains("BEGIN EC PRIVATE KEY"));
        let point = secret.public_key().to_encoded_point(false);
        let public = ssh_key::public::KeyData::Ecdsa(EcdsaPublicKey::from_sec1_bytes(point.as_bytes()).unwrap());
        let ca = PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap();
        let mut b = certificate::Builder::new_with_random_nonce(&mut OsRng, public, now() - 60, now() + 180).unwrap();
        b.cert_type(certificate::CertType::User).unwrap().key_id("jane.doe@example.com").unwrap();
        b.valid_principal("jane.doe").unwrap();
        let cert = b.sign(&ca).unwrap().to_openssh().unwrap();
        let host = "ssh.example.com";
        std::fs::write(dir.join("ssh.example.com-cf_key"), sec1.as_bytes()).unwrap();
        std::fs::write(dir.join("ssh.example.com-cf_key-cert.pub"), &cert).unwrap();
        std::fs::write(dir.join("ssh.example.com-cf_key.pub"), "x").unwrap();
        let (key, cert) = take_ssh_gen_output(&dir, host).unwrap();
        assert!(matches!(key, KeyPair::EC { .. }));
        assert_eq!(cert.valid_principals(), ["jane.doe".to_string()]);
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "nothing is left behind");
        let err = take_ssh_gen_output(&dir, host).unwrap_err();
        assert!(err.to_string().contains("didn't leave a usable SSH certificate"), "{err:#}");
        let _ = std::fs::remove_dir_all(dir);
    }
}
