//! Connection checks use the real route and trust prompts. Reports contain
//! controlled descriptions only: never backend error strings, hosts or secrets.
use crate::profiles::{ConnectionProfile, JumpVia};
use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticStep {
    label: String,
    ok: bool,
    detail: String,
    elapsed_ms: u64,
}

#[derive(Debug, Default, Serialize)]
pub struct DiagnosticReport {
    pub ok: bool,
    steps: Vec<DiagnosticStep>,
}

impl DiagnosticReport {
    fn record(&mut self, label: &str, started: Instant, result: anyhow::Result<()>) -> bool {
        let ok = result.is_ok();
        let detail = match result {
            Ok(()) => "Passed".into(),
            Err(e) => guidance(&format!("{e:#}")),
        };
        self.steps.push(DiagnosticStep {
            label: label.into(),
            ok,
            detail,
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
        ok
    }
}

fn guidance(message: &str) -> String {
    use crate::error::{classify_message, ErrorKind};
    let lower = message.to_lowercase();
    if [
        "host key",
        "host-key",
        "fingerprint",
        "certificate",
        "untrusted",
    ]
    .iter()
    .any(|s| lower.contains(s))
    {
        return "Server identity could not be verified. Compare its fingerprint or certificate with your administrator before changing trust settings.".into();
    }
    match classify_message(message) {
        ErrorKind::Auth => "Sign-in failed. Check the username, credential source, key, and any required second factor.",
        ErrorKind::Permission => "Access was denied. Check the account's permissions for this operation.",
        ErrorKind::NotFound => "The requested location was not found. Check the starting folder or resource.",
        ErrorKind::Timeout => "The check timed out. Check the route, firewall, service availability, and configured timeout.",
        ErrorKind::Network => "The network connection failed. Check the address, port, DNS, proxy, and gateway route.",
        ErrorKind::Unsupported => "This connection does not support the requested check. Review its protocol and configuration.",
        ErrorKind::Conflict => "The current connection settings conflict. Review the selected route and saved profile.",
        ErrorKind::Other => "The check failed. Review the connection settings and local Faro logs; logs may contain private endpoint details.",
    }.into()
}

fn gateways(
    profile: &ConnectionProfile,
    out: &mut Vec<ConnectionProfile>,
    depth: usize,
) -> anyhow::Result<()> {
    match &profile.jump_via {
        Some(JumpVia::Broken(_)) => anyhow::bail!("conflict in saved gateway route"),
        Some(JumpVia::Profile(gateway)) => {
            anyhow::ensure!(
                depth < crate::profiles::MAX_JUMP_HOPS,
                "conflict: gateway chain too long"
            );
            gateways(gateway, out, depth + 1)?;
            out.push((**gateway).clone());
        }
        None => {
            if let Some(host) = profile.jump_host.as_ref().filter(|s| !s.is_empty()) {
                let mut gateway = profile.clone();
                gateway.host = host.clone();
                gateway.port = profile.jump_port.unwrap_or(22);
                gateway.username = profile
                    .jump_username
                    .clone()
                    .unwrap_or_else(|| profile.username.clone());
                gateway.jump_host = None;
                gateway.jump_profile = None;
                gateway.default_remote_path = None;
                out.push(gateway);
            }
        }
    }
    Ok(())
}

pub async fn run(
    profile: ConnectionProfile,
    app: tauri::AppHandle,
    state: &crate::AppState,
) -> DiagnosticReport {
    let mut report = DiagnosticReport::default();
    let profile = state.profiles.with_jump_resolved(profile).await;
    let mut hops = Vec::new();
    if !report.record(
        "Gateway configuration",
        Instant::now(),
        gateways(&profile, &mut hops, 0),
    ) {
        return report;
    }
    let first = hops.first().unwrap_or(&profile);
    // Probe only endpoints whose first hop is direct. A direct probe of a
    // proxied/private destination would produce a misleading failure.
    if first.agent_relay.is_none() && first.proxy.is_none()
        && first.proxy_command.is_none()
        && matches!(
            first.protocol.as_str(),
            "sftp" | "ssh" | "" | "ftp" | "ftps" | "faro-agent"
        )
    {
        let started = Instant::now();
        let addresses = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::net::lookup_host((first.host.as_str(), first.port)),
        )
        .await;
        let addresses: anyhow::Result<Vec<_>> = match addresses {
            Ok(Ok(a)) => {
                let a: Vec<_> = a.collect();
                if a.is_empty() {
                    Err(anyhow::anyhow!("DNS network lookup returned no addresses"))
                } else {
                    Ok(a)
                }
            }
            Ok(Err(e)) => Err(e.into()),
            Err(_) => Err(anyhow::anyhow!("DNS timeout")),
        };
        let resolved = addresses.as_ref().map(|a| !a.is_empty()).unwrap_or(false);
        if !report.record(
            "First-hop DNS",
            started,
            addresses
                .as_ref()
                .map(|_| ())
                .map_err(|e| anyhow::anyhow!("{e}")),
        ) || !resolved
        {
            return report;
        }
        let started = Instant::now();
        let addresses = addresses.unwrap();
        let tcp = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::net::TcpStream::connect(addresses.as_slice()),
        )
        .await;
        if !report.record(
            "First-hop TCP",
            started,
            match tcp {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(e)) => Err(e.into()),
                Err(_) => Err(anyhow::anyhow!("TCP timeout")),
            },
        ) {
            return report;
        }
    }
    for (index, hop) in hops.into_iter().enumerate() {
        let started = Instant::now();
        let result = state.sessions.connect(hop, app.clone()).await;
        let result = match result {
            Ok(id) => state.sessions.disconnect(&id).await,
            Err(e) => Err(e),
        };
        if !report.record(
            &format!("Gateway {} connection and sign-in", index + 1),
            started,
            result,
        ) {
            return report;
        }
    }
    let started = Instant::now();
    let requested_path = profile.default_remote_path.clone();
    let connected = state.sessions.connect(profile, app).await;
    let id = match connected {
        Ok(id) => {
            report.record("Destination connection and sign-in", started, Ok(()));
            id
        }
        Err(e) => {
            report.record("Destination connection and sign-in", started, Err(e));
            return report;
        }
    };
    let started = Instant::now();
    let result = match state.sessions.get(&id).await {
        Some(session) => {
            let path = requested_path.unwrap_or_else(|| match session.as_ref() {
                crate::session::Session::Agent(agent) => agent.system_info.home_dir.clone(),
                _ if matches!(session.protocol(), "sftp" | "ssh" | "") => ".".into(),
                _ => "/".into(),
            });
            match tokio::time::timeout(
                Duration::from_secs(30),
                crate::commands::fs_for_session(&session).list_dir(&path),
            )
            .await
            {
                Ok(result) => result.map(|_| ()),
                Err(_) => Err(anyhow::anyhow!("folder access timeout")),
            }
        }
        None => Err(anyhow::anyhow!("connection closed")),
    };
    report.ok = report.record("Starting folder access", started, result);
    let _ = state.sessions.disconnect(&id).await;
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostics_never_copy_private_error_details() {
        for error in [
            "authentication failed password=secret on private.example",
            "host key changed for private.example",
            "timeout token=secret",
            "unknown private.example secret",
        ] {
            let advice = guidance(error);
            assert!(!advice.contains("secret"));
            assert!(!advice.contains("private.example"));
        }
    }
    #[test]
    fn diagnostics_preserve_failed_step_without_claiming_success() {
        let mut report = DiagnosticReport::default();
        assert!(!report.record(
            "Sign-in",
            Instant::now(),
            Err(anyhow::anyhow!("authentication failed"))
        ));
        assert!(!report.ok);
        assert!(!report.steps[0].ok);
    }
}
