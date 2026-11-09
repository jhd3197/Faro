//! Machine-local credential adapters. Profiles carry references, never commands.
//! Only adapters explicitly installed on this computer may execute.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf, process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CredentialRef { pub provider: String, pub item: String }

#[derive(Deserialize)]
pub struct Provider { pub program: PathBuf, pub args: Vec<String> }

pub fn config_path() -> Result<PathBuf> {
    let dir = std::env::var("FARO_DATA_DIR").ok().filter(|s| !s.is_empty()).map(PathBuf::from)
        .or_else(|| dirs::data_dir().map(|p| p.join("com.juandenis.faro"))).context("No application data directory")?;
    Ok(dir.join("credential-providers.json"))
}

pub fn providers() -> Result<BTreeMap<String, Provider>> {
    let path = config_path()?;
    if !path.exists() { return Ok(BTreeMap::new()); }
    serde_json::from_slice(&std::fs::read(path)?).context("Invalid local credential adapter configuration")
}

pub async fn resolve(reference: &CredentialRef) -> Result<String> {
    anyhow::ensure!(!reference.item.is_empty() && reference.item.len() <= 4096 && !reference.item.starts_with('-') && !reference.item.contains(['\0', '\r', '\n']), "Invalid credential reference");
    let providers = providers()?;
    let provider = providers.get(&reference.provider).context("Credential adapter is not configured on this computer; configure it before connecting")?;
    run(provider, &reference.item).await
}

async fn run(provider: &Provider, item: &str) -> Result<String> {
    anyhow::ensure!(provider.program.is_absolute(), "Credential adapter executable must use an absolute path");
    #[cfg(windows)]
    anyhow::ensure!(provider.program.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("exe")), "Credential adapter must be an executable, not a shell script");
    // Values are separate argv items. Never interpolate a reference into a shell.
    anyhow::ensure!(provider.args.iter().any(|a| a == "{item}"), "Credential adapter needs a separate {item} argument", item = "{item}");
    let mut command = tokio::process::Command::new(&provider.program);
    command.args(provider.args.iter().map(|a| if a == "{item}" { item } else { a.as_str() }))
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(|_| anyhow::anyhow!("Credential adapter could not start"))?;
    let mut stdout = child.stdout.take().context("Credential adapter stdout unavailable")?.take(65537);
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        anyhow::ensure!(bytes.len() <= 65536, "Credential adapter output exceeded the size limit");
        let status = child.wait().await?;
        anyhow::ensure!(status.success(), "Credential adapter failed; unlock it and verify the reference");
        let value = String::from_utf8(bytes).context("Credential adapter output is not UTF-8")?;
        let value = value.strip_suffix("\r\n").or_else(|| value.strip_suffix('\n')).unwrap_or(&value).to_string();
        anyhow::ensure!(!value.is_empty(), "Credential adapter returned an empty value");
        Ok::<_, anyhow::Error>(value)
    }).await;
    match result {
        Ok(Ok(value)) => Ok(value),
        other => {
            let _ = child.kill().await;
            // Do not copy provider output, process errors or reference values.
            match other { Ok(Err(_)) => anyhow::bail!("Credential adapter failed; unlock it and verify its configuration"), _ => anyhow::bail!("Credential adapter timed out") }
        }
    }
}

pub async fn resolve_profile(mut profile: crate::profiles::ConnectionProfile) -> Result<crate::profiles::ConnectionProfile> {
    // Resolve every gateway using its own reference as well as the destination.
    let mut current = &mut profile;
    for _ in 0..=crate::profiles::MAX_JUMP_HOPS {
        if let Some(reference) = &current.credential_ref {
            let value = resolve(reference).await?;
            match &mut current.auth {
                crate::profiles::AuthMethod::Password { password } => *password = value,
                crate::profiles::AuthMethod::Key { passphrase, .. } => *passphrase = Some(value),
                _ => anyhow::bail!("Credential references require password or key-file authentication"),
            }
        }
        match &mut current.jump_via { Some(crate::profiles::JumpVia::Profile(next)) => current = next, _ => return Ok(profile) }
    }
    anyhow::bail!("Credential gateway chain is too long")
}

/// A reference must never accidentally export a previously resolved value.
pub fn clear_embedded_secret(profile: &mut crate::profiles::ConnectionProfile) {
    if profile.credential_ref.is_some() {
        match &mut profile.auth {
            crate::profiles::AuthMethod::Password { password } => password.clear(),
            crate::profiles::AuthMethod::Key { passphrase, .. } => *passphrase = None,
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn credential_reference_rejects_option_injection_before_launch() {
        let result = resolve(&CredentialRef { provider: "missing".into(), item: "--execute=bad".into() }).await;
        assert!(result.unwrap_err().to_string().contains("Invalid credential reference"));
    }
    #[test]
    fn credential_reference_clears_embedded_secret_even_in_encrypted_export() {
        let profile: crate::profiles::ConnectionProfile = serde_json::from_value(serde_json::json!({
            "id":"ref", "name":"reference", "protocol":"sftp", "host":"localhost", "port":22, "username":"test",
            "auth":{"kind":"password", "password":"must-not-export"},
            "credentialRef":{"provider":"vault", "item":"login"}
        })).unwrap();
        let (file, _) = crate::faro_file::build(&[profile], &["ref".into()], true, |_| None);
        let json = serde_json::to_string(&file).unwrap();
        assert!(json.contains("credentialRef"));
        assert!(!json.contains("must-not-export"));
    }
    #[cfg(windows)]
    #[tokio::test]
    async fn credential_adapter_reads_value_without_a_console() {
        let script = std::env::temp_dir().join(format!("faro-credential-test-{}.ps1", uuid::Uuid::new_v4()));
        std::fs::write(&script, "param([string]$item)\n[Console]::Out.Write($item)").unwrap();
        let provider = Provider {
            program: PathBuf::from(std::env::var("SystemRoot").unwrap()).join("System32/WindowsPowerShell/v1.0/powershell.exe"),
            args: vec!["-NoProfile".into(), "-NonInteractive".into(), "-ExecutionPolicy".into(), "Bypass".into(), "-File".into(), script.to_string_lossy().into(), "{item}".into()],
        };
        let result = run(&provider, "test value with spaces").await;
        std::fs::remove_file(script).unwrap();
        assert_eq!(result.unwrap(), "test value with spaces");
    }
}
