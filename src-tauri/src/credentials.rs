//! Service-credential storage in the OS keychain (Plan 12 Phase 1).
//!
//! The rule is strict: **credentials never cross the IPC boundary as values**.
//! The frontend can *write* a secret (one-way `set`) and *ask whether one
//! exists* (`has`), but never *read* it back. Rust fetches the value from the
//! keychain at the moment of use.
//!
//! This mirrors the OAuth-token path in `oauth.rs` — same `keyring` crate, same
//! native backends — but for non-profile service keys. Everything lives under
//! one service name, keyed by *purpose*.
//!
//! Because Windows DPAPI and macOS Keychain can't *enumerate* entries, every
//! write is also recorded in a small `faro.db` manifest (`db::record_keychain`)
//! so the encrypted backup (Phase 4) knows which entries to pull.

use anyhow::{anyhow, Context, Result};

/// The single keychain service that holds Faro's own service credentials.
/// Reverse-DNS so it's unambiguous in Credential Manager / Keychain Access.
pub const SERVICE: &str = "com.faro.credentials";

/// Keychain purpose for a connection profile's saved password, used when the
/// "store passwords in keychain" setting is on.
pub fn profile_password_purpose(profile_id: &str) -> String {
    format!("profile-password:{profile_id}")
}

/// Keychain purpose for a connection profile's SSH key passphrase.
pub fn profile_passphrase_purpose(profile_id: &str) -> String {
    format!("profile-passphrase:{profile_id}")
}

/// Keychain purpose for a connection profile's proxy password.
pub fn profile_proxy_password_purpose(profile_id: &str) -> String {
    format!("profile-proxy-password:{profile_id}")
}

/// Write (or overwrite) a secret for `purpose`. An empty value clears it.
pub fn set_secret(purpose: &str, value: &str) -> Result<()> {
    if value.is_empty() {
        delete_secret(purpose);
        return Ok(());
    }
    let entry = keyring::Entry::new(SERVICE, purpose).context("open keychain entry")?;
    entry
        .set_password(value)
        .context("write secret to keychain")?;
    Ok(())
}

/// Read a secret for `purpose`, or `None` if it was never set. Rust-only — this
/// is deliberately never exposed as a Tauri command.
pub fn get_secret(purpose: &str) -> Result<Option<String>> {
    let entry = keyring::Entry::new(SERVICE, purpose).context("open keychain entry")?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow!("read secret from keychain: {e}")),
    }
}

/// Remove a secret (best-effort — a missing entry is not an error).
pub fn delete_secret(purpose: &str) {
    if let Ok(entry) = keyring::Entry::new(SERVICE, purpose) {
        let _ = entry.delete_credential();
    }
}

/// Whether the OS keychain actually stores secrets on this machine: writes,
/// reads back and removes a throwaway entry. False on e.g. a Linux box with no
/// Secret Service running, where every keychain write fails.
pub fn keychain_works() -> bool {
    const PROBE: &str = "keychain-probe";
    let ok = set_secret(PROBE, "ok").is_ok()
        && matches!(get_secret(PROBE), Ok(Some(v)) if v == "ok");
    delete_secret(PROBE);
    ok
}

/// Linux only: earlier builds kept keychain entries in the kernel keyutils
/// store, which is cleared on reboot; the store is now Secret Service. Copies
/// each entry still in keyutils across, unless Secret Service already holds a
/// (newer) value. Returns true once every entry is handled, so the caller can
/// stop retrying.
#[cfg(target_os = "linux")]
pub fn persist_keyutils_entries(entries: &[(String, String)]) -> bool {
    use keyring::keyutils::KeyutilsCredential;
    let mut all_ok = true;
    for (service, account) in entries {
        let Ok(entry) = keyring::Entry::new(service, account) else {
            all_ok = false;
            continue;
        };
        match entry.get_password() {
            Ok(_) => continue,
            Err(keyring::Error::NoEntry) => {}
            // Secret Service unavailable: try again next launch.
            Err(_) => {
                all_ok = false;
                continue;
            }
        }
        let Ok(old) = KeyutilsCredential::new_with_target(None, service, account) else {
            continue;
        };
        let Ok(value) = keyring::Entry::new_with_credential(Box::new(old)).get_password() else {
            continue;
        };
        if let Err(e) = entry.set_password(&value) {
            eprintln!("keychain: couldn't persist {service}/{account}: {e}");
            all_ok = false;
        }
    }
    all_ok
}

#[cfg(not(target_os = "linux"))]
pub fn persist_keyutils_entries(_entries: &[(String, String)]) -> bool {
    true
}

/// Whether a secret exists for `purpose`. This is the only credential state the
/// frontend gets to see — enough to render a Set/••••/Clear affordance.
pub fn has_secret(purpose: &str) -> bool {
    matches!(get_secret(purpose), Ok(Some(_)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trips a secret through the real OS keychain. `#[ignore]`d because it
    /// touches the credential store (unavailable on headless CI); run locally
    /// with `cargo test -p faro -- --ignored credentials`.
    #[test]
    #[ignore = "touches the OS keychain"]
    fn secret_roundtrip() {
        let purpose = "faro-credentials-test-key";
        assert!(!has_secret(purpose));
        set_secret(purpose, "sk-test-123").unwrap();
        assert!(has_secret(purpose));
        assert_eq!(get_secret(purpose).unwrap().as_deref(), Some("sk-test-123"));
        // Empty value clears it.
        set_secret(purpose, "").unwrap();
        assert!(!has_secret(purpose));
        assert!(get_secret(purpose).unwrap().is_none());
    }

    /// The fresh-install probe sees a working keychain and leaves no entry.
    #[test]
    #[ignore = "touches the OS keychain"]
    fn keychain_works_and_cleans_up() {
        assert!(keychain_works());
        assert!(!has_secret("keychain-probe"));
    }
}
