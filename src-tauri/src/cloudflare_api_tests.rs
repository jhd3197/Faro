//! `cloudflare_api` against `examples/fake_cloudflare.rs`.

use super::*;
use std::io::BufRead;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;

pub(crate) fn fake_exe() -> PathBuf {
    static EXE: OnceLock<PathBuf> = OnceLock::new();
    EXE.get_or_init(|| {
        let status = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
            .args(["build", "-q", "-p", "faro", "--example", "fake_cloudflare"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .status()
            .expect("run cargo build --example fake_cloudflare");
        assert!(status.success(), "building the fake_cloudflare example failed");
        let exe = std::env::current_exe().unwrap();
        let profile_dir = exe.parent().unwrap().parent().unwrap();
        profile_dir.join("examples").join(format!("fake_cloudflare{}", std::env::consts::EXE_SUFFIX))
    })
    .clone()
}

/// A running fake API, killed on drop. `state` holds its store as JSON.
pub(crate) struct FakeCf {
    child: Child,
    pub base: String,
    pub state: PathBuf,

}

impl Drop for FakeCf {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

impl FakeCf {
    pub fn store(&self) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(&self.state).unwrap()).unwrap()
    }
    pub fn api(&self) -> Api {
        Api::with_base(&self.base, "test-token")
    }
}

pub(crate) const ACCOUNT: &str = "acc1";

pub(crate) fn start(name: &str, seed: serde_json::Value) -> FakeCf {
    let dir = std::env::temp_dir().join(format!("faro-cfapi-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut seed = seed;
    let base_seed = json!({
        "accounts": [{ "id": ACCOUNT, "name": "Example Co" }],
        "zones": [{ "id": "zone1", "name": "example.com", "account": { "id": ACCOUNT } }],
    });
    for (k, v) in base_seed.as_object().unwrap() {
        if seed.get(k).is_none() {
            seed[k] = v.clone();
        }
    }
    std::fs::write(dir.join("seed.json"), seed.to_string()).unwrap();
    let state = dir.join("state.json");
    let mut child = Command::new(fake_exe())
        .args(["--token", "test-token", "--seed"])
        .arg(dir.join("seed.json"))
        .arg("--state")
        .arg(&state)
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut line = String::new();
    std::io::BufReader::new(child.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let base = format!("{}/client/v4", line.trim().strip_prefix("listening ").unwrap());
    FakeCf { child, base, state }
}

#[tokio::test]
async fn verifies_the_token_and_lists_accounts() {
    let cf = start("verify", json!({}));
    cf.api().verify().await.unwrap();
    let accounts = cf.api().accounts().await.unwrap();
    assert_eq!(accounts[0].name, "Example Co");
    let zones = cf.api().zones(ACCOUNT).await.unwrap();
    assert_eq!(zones[0].name, "example.com");

    let wrong = Api::with_base(&cf.base, "nope").verify().await.unwrap_err().to_string();
    assert!(wrong.contains("refused the API token") && wrong.contains("permissions"), "{wrong}");
}

#[tokio::test]
async fn ssh_hostnames_come_from_tunnels_and_access_apps() {
    let tunnels = format!("accounts/{ACCOUNT}/cfd_tunnel");
    let cf = start(
        "hosts",
        json!({
            tunnels.clone(): [
                { "id": "t1", "name": "web-1", "status": "healthy",
                  "conns_active_at": "2026-10-01T00:00:00Z",
                  "connections": [
                    { "opened_at": "2026-09-01T00:00:00Z", "client_version": "2025.1.0", "colo_name": "old" },
                    { "opened_at": "2026-10-30T12:00:00Z", "client_version": "2026.8.2", "colo_name": "lhr01" },
                  ] },
                { "id": "t2", "name": "old", "status": "down", "deleted_at": "2020-01-01T00:00:00Z" },
            ],
            format!("{tunnels}/t1/configurations"): [{ "config": { "ingress": [
                { "hostname": "web-1-ssh.example.com", "service": "ssh://localhost:22" },
                { "hostname": "web-1-panel.example.com", "service": "http://localhost:8080" },
                { "service": "http_status:404" },
            ]}}],
            format!("accounts/{ACCOUNT}/access/apps"): [
                { "id": "app1", "name": "web-1 ssh", "domain": "web-1-ssh.example.com", "type": "self_hosted" },
                { "id": "app2", "name": "legacy", "domain": "legacy.example.com", "type": "ssh" },
                { "id": "app3", "name": "wiki", "domain": "wiki.example.com", "type": "self_hosted" },
            ],
        }),
    );
    let hosts = ssh_hostnames(&cf.api(), ACCOUNT).await.unwrap();
    let names: Vec<_> = hosts.iter().map(|h| h.hostname.as_str()).collect();
    assert_eq!(names, ["legacy.example.com", "web-1-ssh.example.com"], "{hosts:?}");
    let web = &hosts[1];
    assert_eq!(web.tunnel_status.as_deref(), Some("healthy"));
    assert_eq!(web.connector_version.as_deref(), Some("2026.8.2"));
    assert_eq!(web.connector_last_seen.as_deref(), Some("2026-10-30T12:00:00Z"));
    assert_eq!(web.app_id.as_deref(), Some("app1"));
    assert_eq!(hosts[0].tunnel_status, None);
    assert_eq!(hosts[0].connector_version, None);
}

#[tokio::test]
async fn service_tokens_come_back_once() {
    let cf = start("svc", json!({}));
    let v: Value = cf
        .api()
        .post(&format!("accounts/{ACCOUNT}/access/service_tokens"), json!({ "name": "Faro" }))
        .await
        .unwrap();
    assert!(v["client_id"].as_str().unwrap().ends_with(".access"));
    assert!(v["client_secret"].as_str().unwrap().starts_with("secret-"));
    let id = v["id"].as_str().unwrap();
    cf.api().delete(&format!("accounts/{ACCOUNT}/access/service_tokens/{id}")).await.unwrap();
    assert_eq!(cf.store()[format!("accounts/{ACCOUNT}/access/service_tokens")], json!([]));
}

#[test]
fn config_round_trips() {
    let dir = std::env::temp_dir().join(format!("faro-cfcfg-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    assert!(read_config(&dir).account_id.is_none());
    let cfg = Config {
        account_id: Some("a".into()),
        account_name: Some("A".into()),
        service_token_id: Some("st".into()),
        service_token_client_id: Some("st.access".into()),
    };
    write_config(&dir, &cfg).unwrap();
    let back = status(&dir);
    assert!(back.connected);
    assert_eq!(back.service_token_client_id.as_deref(), Some("st.access"));
    assert!(!back.permissions.is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}
