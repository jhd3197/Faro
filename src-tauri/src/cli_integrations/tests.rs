use super::*;
use crate::profiles::{CliAuth, ConnectionProfile, ProxyCommandConfig, ProxyCommandKind};
use serde_json::json;

fn ran(ok: bool, stdout: &str, stderr: &str) -> Ran {
    Ran { ok, stdout: stdout.into(), stderr: stderr.into() }
}

fn profile(v: serde_json::Value) -> ConnectionProfile {
    let mut base = json!({ "id": "p", "name": "p", "protocol": "sftp", "host": "h", "port": 22, "username": "u", "auth": { "kind": "password" } });
    for (k, val) in v.as_object().unwrap() {
        base[k] = val.clone();
    }
    serde_json::from_value(base).unwrap()
}

fn none() -> BTreeSet<String> {
    BTreeSet::new()
}

// ---- running ------------------------------------------------------------------------

#[test]
fn plain_args_refuse_anything_cmd_exe_reads() {
    for ok in ["client-a", "i-0abc123", "us-east-1", "--zone=us-central1-a", "https://storage.azure.com/", "a@b.com", "Name=x,Values=y"] {
        assert!(plain_arg(ok), "{ok}");
    }
    for bad in ["", "a b", "a&b", "a|b", "%PATH%", "a^b", "\"x\"", "a<b", "a>b", "!x!", "a\nb", "(x)"] {
        assert!(!plain_arg(bad), "{bad:?}");
    }
}

#[test]
fn npm_shim_entry_is_found_and_traversal_refused() {
    let dir = Path::new("C:/npm");
    let shim = "@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@shopify\\cli\\bin\\run.js\" %*\r\n";
    let entry = npm_shim_entry(shim, dir).unwrap();
    assert!(entry.to_string_lossy().replace('\\', "/").ends_with("node_modules/@shopify/cli/bin/run.js"));
    let old_style = "\"%~dp0\\node_modules\\@hubspot\\cli\\bin\\hs.js\" %*";
    assert!(npm_shim_entry(old_style, dir).is_some());
    assert!(npm_shim_entry("\"%dp0%\\..\\evil\\x.js\" %*", dir).is_none());
    assert!(npm_shim_entry("@echo %*", dir).is_none());
}

#[test]
fn failures_are_classified_without_copying_text() {
    assert_eq!(classify_failure("Error: your token is expired; run `render login` to get a new one"), CliState::Expired);
    assert_eq!(classify_failure("Error when retrieving token from sso: Token has expired and refresh failed"), CliState::Expired);
    assert_eq!(classify_failure("Unable to locate credentials. You can configure credentials by running \"aws configure\"."), CliState::SignedOut);
    assert_eq!(classify_failure("Please run 'az login' to setup account."), CliState::SignedOut);
    assert_eq!(classify_failure("You are not logged into any GitHub hosts. To log in, run: gh auth login"), CliState::SignedOut);
    assert_eq!(classify_failure("Error: Unable to initialize DigitalOcean API client: access token is required."), CliState::SignedOut);
    assert_eq!(classify_failure("segfault"), CliState::Error);
}

#[cfg(unix)]
fn fake_cli(dir: &Path, body: &str) -> PathBuf {
    use std::os::unix::fs::PermissionsExt;
    let p = dir.join("fake-cli");
    std::fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
    p
}

#[cfg(windows)]
fn fake_cli(dir: &Path, body: &str) -> PathBuf {
    let p = dir.join("fake-cli.cmd");
    std::fs::write(&p, format!("@echo off\r\n{body}\r\n")).unwrap();
    p
}

fn tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!("faro-cli-int-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[tokio::test]
async fn run_at_passes_argv_and_reads_stdout() {
    let d = tmp();
    let p = fake_cli(&d, if cfg!(windows) { "echo %1 %2 %3" } else { "echo \"$1\" \"$2\" \"$3\"" });
    let r = run_at(&p, "Fake", &args(&["sts", "--profile", "client-a"]), Duration::from_secs(20), SMALL_CAP, &[]).await.unwrap();
    assert!(r.ok);
    assert_eq!(r.stdout.trim(), "sts --profile client-a");
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn run_at_reports_failure_and_never_copies_output_into_errors() {
    let d = tmp();
    let p = fake_cli(&d, if cfg!(windows) { "echo SECRET-VALUE 1>&2\r\nexit /b 3" } else { "echo SECRET-VALUE >&2; exit 3" });
    let r = run_at(&p, "Fake", &args(&["x"]), Duration::from_secs(20), SMALL_CAP, &[]).await.unwrap();
    assert!(!r.ok);
    assert!(r.stderr.contains("SECRET-VALUE"));
    // The caller's sentence for this failure says nothing the CLI printed.
    let msg = format!("{:#}", discover::failure("tailscale", &r));
    assert!(!msg.contains("SECRET-VALUE"), "{msg}");
    let _ = std::fs::remove_dir_all(d);
}

#[tokio::test]
async fn run_at_times_out_and_caps_output() {
    let d = tmp();
    let slow = fake_cli(&d, if cfg!(windows) { "ping -n 6 127.0.0.1 >NUL" } else { "sleep 5" });
    let e = run_at(&slow, "Fake", &args(&["x"]), Duration::from_millis(500), SMALL_CAP, &[]).await.unwrap_err();
    assert!(format!("{e}").contains("didn't answer"), "{e}");
    let _ = std::fs::remove_file(&slow);
    let d2 = tmp();
    let loud = fake_cli(&d2, if cfg!(windows) { "for /L %%i in (1,1,400) do @echo 0123456789012345678901234567890123456789" } else { "i=0; while [ $i -lt 400 ]; do echo 0123456789012345678901234567890123456789; i=$((i+1)); done" });
    let e = run_at(&loud, "Fake", &args(&["x"]), Duration::from_secs(20), 1024, &[]).await.unwrap_err();
    assert!(format!("{e}").contains("more than Faro reads"), "{e}");
    let _ = std::fs::remove_dir_all(d);
    let _ = std::fs::remove_dir_all(d2);
}

#[cfg(windows)]
#[tokio::test]
async fn batch_files_get_plain_arguments_only() {
    let d = tmp();
    let p = fake_cli(&d, "echo %*");
    let e = run_at(&p, "Fake", &args(&["a & calc"]), Duration::from_secs(20), SMALL_CAP, &[]).await.unwrap_err();
    assert!(format!("{e}").contains("can't be given that value safely"));
    let _ = std::fs::remove_dir_all(d);
}

/// An npm shim runs as `node <entry>`, so values with spaces arrive intact
/// and cmd.exe never sees them.
#[cfg(windows)]
#[tokio::test]
async fn npm_shims_run_through_node() {
    if specs::find_on_path(&["node"]).is_none() {
        eprintln!("node not installed; skipped");
        return;
    }
    let d = tmp();
    let bin = d.join("node_modules").join("fake").join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::write(bin.join("run.js"), "process.stdout.write(JSON.stringify(process.argv.slice(2)))").unwrap();
    let shim = d.join("fake.cmd");
    std::fs::write(&shim, "@ECHO off\r\nGOTO start\r\n:start\r\nSETLOCAL\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\fake\\bin\\run.js\" %*\r\n").unwrap();
    let inv = invocation(&shim);
    assert!(!inv.batch);
    let r = run_at(&shim, "Fake", &args(&["a b", "c&d"]), Duration::from_secs(20), SMALL_CAP, &[]).await.unwrap();
    assert_eq!(r.stdout, r#"["a b","c&d"]"#);
    let _ = std::fs::remove_dir_all(d);
}

// ---- account checks -------------------------------------------------------------------

#[test]
fn aws_profiles_and_identity() {
    let p = parse::aws_profiles(&ran(true, "default\nclient-a\n\nbad name\n", ""));
    assert_eq!(p, vec!["default", "client-a"]);
    let ok = parse::aws_identity("client-a", &ran(true, r#"{"UserId":"X","Account":"123456789012","Arn":"arn:aws:iam::123456789012:user/j"}"#, ""));
    assert_eq!(ok.state, CliState::Ready);
    assert_eq!(ok.label, "client-a (123456789012)");
    let exp = parse::aws_identity("client-a", &ran(false, "", "Error when retrieving token from sso: Token has expired and refresh failed"));
    assert_eq!(exp.state, CliState::Expired);
    assert!(exp.detail.unwrap().contains("aws sso login --profile client-a"));
}

#[test]
fn overall_state_prefers_problems_on_used_accounts() {
    let a = |id: &str, st| CliAccount { id: id.into(), label: id.into(), state: st, detail: None, active: false, allowed: false };
    let accts = vec![a("default", CliState::Ready), a("client-a", CliState::Expired)];
    assert_eq!(parse::overall(&accts, &none()), CliState::Ready);
    let wanted: BTreeSet<String> = ["client-a".to_string()].into();
    assert_eq!(parse::overall(&accts, &wanted), CliState::Expired);
}

#[test]
fn gcloud_az_doctl_hcloud_render() {
    let g = parse::gcloud_accounts(&ran(true, r#"[{"account":"me@x.com","status":"ACTIVE"},{"account":"ci@p.iam.gserviceaccount.com","status":""}]"#, ""));
    assert_eq!(g.state, Some(CliState::Ready));
    assert!(g.accounts[0].active && !g.accounts[1].active);
    assert_eq!(parse::gcloud_accounts(&ran(true, "[]", "")).state, Some(CliState::SignedOut));

    let az = parse::az_accounts(&ran(true, r#"[{"id":"sub-1","name":"Prod","isDefault":true,"state":"Enabled","user":{"name":"me@x.com"}}]"#, ""));
    assert_eq!(az.accounts[0].label, "Prod (me@x.com)");
    assert!(az.accounts[0].active);
    assert_eq!(parse::az_accounts(&ran(false, "", "Please run 'az login' to setup account.")).state, Some(CliState::SignedOut));

    assert_eq!(parse::doctl_account(&ran(true, r#"{"email":"me@x.com","status":"active"}"#, "")).accounts[0].id, "me@x.com");
    assert_eq!(parse::hcloud_context(&ran(true, "work\n", "")).accounts[0].id, "work");
    assert_eq!(parse::hcloud_context(&ran(true, "", "")).state, Some(CliState::SignedOut));
    // The real Render CLI v2.28 answer when its token ran out.
    assert_eq!(parse::render_whoami(&ran(false, "", "Error: your token is expired; run `render login` to get a new one")).state, Some(CliState::Expired));
}

#[test]
fn gh_status_text_from_gh_2_87() {
    let out = "github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Active account: true\n  - Git operations protocol: https\n  - Token: gho_************************************\n";
    let c = parse::gh_status(&ran(true, out, ""));
    assert_eq!(c.state, Some(CliState::Ready));
    assert_eq!(c.accounts[0].id, "octo");
    assert!(c.accounts[0].active);
    // The token itself never becomes part of an account or detail.
    assert!(!format!("{c:?}").contains("gho_"));
    let bad = "github.com\n  X Failed to log in to github.com account octo (keyring)\n  - Active account: true\n  - The token in keyring is invalid.\n";
    assert_eq!(parse::gh_status(&ran(false, "", bad)).state, Some(CliState::Expired));
    let none = parse::gh_status(&ran(false, "", "You are not logged into any GitHub hosts. To log in, run: gh auth login"));
    assert_eq!(none.state, Some(CliState::SignedOut));
}

#[test]
fn tailscale_states() {
    let running = json!({ "BackendState": "Running", "CurrentTailnet": { "Name": "acme.ts.net" }, "Peer": {} }).to_string();
    let c = parse::tailscale_status(&ran(true, &running, ""));
    assert_eq!(c.state, Some(CliState::Ready));
    assert_eq!(c.accounts[0].id, "acme.ts.net");
    let login = json!({ "BackendState": "NeedsLogin" }).to_string();
    assert_eq!(parse::tailscale_status(&ran(true, &login, "")).state, Some(CliState::SignedOut));
    let down = parse::tailscale_status(&ran(false, "", "failed to connect to local tailscaled; it doesn't appear to be running"));
    assert_eq!(down.state, Some(CliState::Error));
    assert!(down.detail.unwrap().contains("isn't running"));
}

#[test]
fn hs_portal_table() {
    let table = "Accounts from config:\n┌──────────────────────┬──────────┬──────────────────────┐\n│ Name                 │ ID       │ Auth Type            │\n├──────────────────────┼──────────┼──────────────────────┤\n│ Acme Prod (default)  │ 12345678 │ PERSONAL_ACCESS_KEY  │\n│ Acme Sandbox         │ 87654321 │ PERSONAL_ACCESS_KEY  │\n└──────────────────────┴──────────┴──────────────────────┘\n";
    let p = parse::hs_portals(table);
    assert_eq!(p, vec![("12345678".into(), "Acme Prod".into(), true), ("87654321".into(), "Acme Sandbox".into(), false)]);
    let c = parse::hs_accounts(&ran(true, table, ""));
    assert_eq!(c.accounts.len(), 2);
    assert!(c.accounts[0].active);
    assert_eq!(parse::hs_accounts(&ran(true, "No accounts\n", "")).state, Some(CliState::SignedOut));
}

#[test]
fn version_parsers() {
    assert_eq!(specs::slash_version("aws-cli/2.15.30 Python/3.11.8 Windows/10 exe/AMD64").as_deref(), Some("2.15.30"));
    assert_eq!(specs::az_version(r#"{"azure-cli": "2.55.0", "azure-cli-core": "2.55.0"}"#).as_deref(), Some("2.55.0"));
    assert_eq!(managed_tools::plain_version("render v2.28.0\n").as_deref(), Some("2.28.0"));
    assert_eq!(managed_tools::plain_version("gh version 2.87.0 (2026-02-18)").as_deref(), Some("2.87.0"));
}

#[test]
fn every_cli_is_registered_once_with_a_sign_in_or_none() {
    let ids = specs::all_cli_ids();
    let mut uniq = ids.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(ids.len(), uniq.len());
    for id in ["aws", "gcloud", "az", "gh", "tailscale", "doctl", "hcloud", "render", "hs", "shopify", "cloudflared", "op", "bw"] {
        assert!(ids.contains(&id), "{id}");
        assert!(!specs::docs_url(id).is_empty(), "{id}");
    }
    for id in specs::specs() {
        assert!(!id.feed.installable(), "{} must be detect-only", id.id);
        if specs::has_account(id.id) {
            assert!(specs::sign_in_args(id.id, None).is_some(), "{}", id.id);
        }
    }
    assert_eq!(specs::sign_in_display("aws", Some("client-a")).unwrap(), "aws sso login --profile client-a");
}

// ---- discovery ------------------------------------------------------------------------

#[test]
fn aws_discovery_builds_s3_and_ssm_connections() {
    let buckets = json!({ "Buckets": [{ "Name": "logs", "BucketRegion": "eu-west-1" }, { "Name": "assets" }] });
    let b = discover::aws_buckets(&buckets, "client-a", "us-east-2");
    assert_eq!(b.len(), 2);
    let p = b[0].profile.as_ref().unwrap();
    assert_eq!((p.protocol.as_str(), p.bucket.as_deref(), p.region.as_deref()), ("s3", Some("logs"), Some("eu-west-1")));
    assert_eq!(p.cli_auth, Some(CliAuth { tool: "aws".into(), account: "client-a".into() }));
    assert_eq!(b[1].profile.as_ref().unwrap().region.as_deref(), Some("us-east-2"));
    assert_eq!(p.cli_source.as_ref().unwrap().remote_id, "s3:logs");

    let ec2 = json!({ "Reservations": [{ "Instances": [
        { "InstanceId": "i-ssm", "Tags": [{ "Key": "Name", "Value": "web" }], "KeyName": "deploy" },
        { "InstanceId": "i-pub", "PublicIpAddress": "3.3.3.3" },
        { "InstanceId": "i-dark" }
    ]}]});
    let ssm = discover::aws_ssm_ids(&json!({ "InstanceInformationList": [{ "InstanceId": "i-ssm", "PingStatus": "Online" }] }));
    let i = discover::aws_instances(&ec2, &ssm, "client-a", "us-east-2");
    assert_eq!(i.len(), 2, "an instance with neither SSM nor a public address is left out");
    let web = i[0].profile.as_ref().unwrap();
    assert_eq!(web.name, "web");
    let pc = web.proxy_command.as_ref().unwrap();
    assert_eq!(pc.kind, ProxyCommandKind::AwsSsm);
    assert_eq!((pc.target.as_deref(), pc.cli_account.as_deref(), pc.region.as_deref()), (Some("i-ssm"), Some("client-a"), Some("us-east-2")));
    assert_eq!(web.notes.as_deref(), Some("EC2 key pair: deploy"));
    assert_eq!(i[1].profile.as_ref().unwrap().host, "3.3.3.3");
    assert!(i[1].profile.as_ref().unwrap().proxy_command.is_none());
}

#[test]
fn gcloud_az_discovery() {
    let vms = json!([
        { "name": "db", "status": "RUNNING", "selfLink": "https://compute.googleapis.com/compute/v1/projects/acme/zones/us-central1-a/instances/db", "networkInterfaces": [{ "networkIP": "10.0.0.2" }] },
        { "name": "web", "status": "RUNNING", "selfLink": "https://compute.googleapis.com/compute/v1/projects/acme/zones/us-central1-b/instances/web", "networkInterfaces": [{ "accessConfigs": [{ "natIP": "34.1.1.1" }] }] },
        { "name": "off", "status": "TERMINATED" }
    ]);
    let g = discover::gcloud_instances(&vms, "me@x.com");
    assert_eq!(g.len(), 2);
    let db = g[0].profile.as_ref().unwrap().proxy_command.clone().unwrap();
    assert_eq!(db.kind, ProxyCommandKind::GcpIap);
    assert_eq!((db.region.as_deref(), db.project.as_deref()), (Some("us-central1-a"), Some("acme")));
    assert_eq!(g[1].profile.as_ref().unwrap().host, "34.1.1.1");
    let gb = discover::gcloud_buckets(&json!([{ "name": "media" }, { "storage_url": "gs://raw/" }]), "me@x.com");
    assert_eq!(gb.iter().map(|p| p.profile.as_ref().unwrap().bucket.clone().unwrap()).collect::<Vec<_>>(), vec!["media", "raw"]);

    let c = discover::az_containers(&json!([{ "name": "backups" }]), "acmestore", "sub-1");
    let p = c[0].profile.as_ref().unwrap();
    assert_eq!((p.protocol.as_str(), p.account.as_deref(), p.bucket.as_deref()), ("azure", Some("acmestore"), Some("backups")));
    assert_eq!(p.cli_auth.as_ref().unwrap().account, "sub-1");
    let v = discover::az_vms(&json!([{ "name": "vm1", "publicIps": "20.1.1.1", "fqdns": "", "osProfile": { "adminUsername": "azureuser" } }]), "sub-1");
    assert_eq!((v[0].host.as_str(), v[0].username.as_str()), ("20.1.1.1", "azureuser"));
}

#[test]
fn tailscale_doctl_hcloud_render_hs_discovery() {
    let ts = json!({ "CurrentTailnet": { "Name": "acme.ts.net" }, "Peer": {
        "k1": { "ID": "n1", "HostName": "nas", "DNSName": "nas.acme.ts.net.", "OS": "linux", "Online": true, "TailscaleIPs": ["100.64.0.1"] },
        "k2": { "ID": "n2", "HostName": "phone", "DNSName": "phone.acme.ts.net.", "OS": "iOS", "Online": true },
        "k3": { "ID": "n3", "HostName": "old", "DNSName": "old.acme.ts.net.", "OS": "linux", "Online": false }
    }});
    let t = discover::tailscale(&ran(true, &ts.to_string(), ""));
    assert_eq!(t.iter().map(|p| p.host.as_str()).collect::<Vec<_>>(), vec!["nas.acme.ts.net", "old.acme.ts.net"]);
    assert!(t[1].needs.contains(&"offline".to_string()));

    let d = discover::doctl(&ran(true, &json!([{ "id": 7, "name": "api", "region": { "slug": "nyc3" }, "networks": { "v4": [{ "ip_address": "10.1.1.1", "type": "private" }, { "ip_address": "1.2.3.4", "type": "public" }] } }]).to_string(), ""), "me");
    assert_eq!((d[0].host.as_str(), d[0].username.as_str()), ("1.2.3.4", "root"));
    assert_eq!(d[0].profile.as_ref().unwrap().cli_source.as_ref().unwrap().remote_id, "droplet:7");

    let h = discover::hcloud(&ran(true, &json!([{ "id": 9, "name": "edge", "public_net": { "ipv4": null, "ipv6": { "ip": "2a01:4f8::/64" } }, "datacenter": { "location": { "name": "fsn1" } } }]).to_string(), ""), "work");
    assert_eq!(h[0].host, "2a01:4f8::1");

    let r = discover::render(&ran(true, &json!([{ "service": { "id": "srv-abc", "name": "api", "serviceDetails": { "sshAddress": "srv-abc@ssh.oregon.render.com" } } }, { "service": { "id": "srv-static", "name": "site" } }]).to_string(), ""), "me");
    assert_eq!(r.len(), 1);
    assert_eq!((r[0].host.as_str(), r[0].username.as_str()), ("ssh.oregon.render.com", "srv-abc"));

    let hs = discover::hs(&ran(true, "│ Acme │ 12345678 │ PERSONAL_ACCESS_KEY │\n", ""));
    let p = hs[0].profile.as_ref().unwrap();
    assert_eq!((p.protocol.as_str(), p.name.as_str()), ("hubspot", "Acme (HubSpot)"));
    assert!(hs[0].needs.contains(&"token".to_string()));
}

#[test]
fn reimport_updates_the_same_connection_and_keeps_edits() {
    let v = json!({ "Reservations": [{ "Instances": [{ "InstanceId": "i-1", "PublicIpAddress": "1.1.1.1", "Tags": [{ "Key": "Name", "Value": "web" }] }] }] });
    let first = discover::aws_instances(&v, &[], "a", "us-east-1");
    let mut saved = crate::importers::into_profiles(first, &[]);
    saved[0].name = "My web box".into();
    saved[0].username = "ubuntu".into();
    let moved = json!({ "Reservations": [{ "Instances": [{ "InstanceId": "i-1", "PublicIpAddress": "2.2.2.2", "Tags": [{ "Key": "Name", "Value": "web" }] }] }] });
    let mut again = discover::aws_instances(&moved, &[], "a", "us-east-1");
    discover::mark_conflicts(&mut again, &saved);
    assert_eq!(again[0].conflict.as_ref().unwrap().id, saved[0].id);
    assert_eq!(again[0].resolution, Some(crate::importers::Resolution::Replace));
    let out = crate::importers::into_profiles(again, &saved);
    assert_eq!(out.len(), 1);
    assert_eq!(out[0].id, saved[0].id);
    assert_eq!(out[0].host, "2.2.2.2");
    assert_eq!(out[0].name, "My web box");
    assert_eq!(out[0].username, "ubuntu");
}

// ---- credentials ----------------------------------------------------------------------

#[test]
fn credential_outputs_parse_and_debug_hides_them() {
    let aws = creds::parse(creds::Purpose::S3, r#"{"Version":1,"AccessKeyId":"AKIA1","SecretAccessKey":"sek","SessionToken":"tok","Expiration":"2030-01-01T00:00:00+00:00"}"#, 0).unwrap();
    assert_eq!(aws.expires_at, 1893456000);
    match &aws.secret {
        creds::Secret::Aws { key_id, token, .. } => assert_eq!((key_id.as_str(), token.as_deref()), ("AKIA1", Some("tok"))),
        _ => panic!(),
    }
    assert!(!format!("{aws:?}").contains("sek"));
    let static_keys = creds::parse(creds::Purpose::S3, r#"{"Version":1,"AccessKeyId":"AKIA1","SecretAccessKey":"sek"}"#, 100).unwrap();
    assert!(static_keys.expires_at > 100);
    let az = creds::parse(creds::Purpose::AzureStorage, r#"{"accessToken":"eyJ","expires_on":1900000000,"tokenType":"Bearer"}"#, 0).unwrap();
    assert_eq!(az.expires_at, 1900000000);
    assert!(creds::parse(creds::Purpose::GcpStorage, "ya29.abc\n", 10).is_some());
    assert!(creds::parse(creds::Purpose::GcpStorage, "ERROR: (gcloud) something", 10).is_none());
    assert!(creds::parse(creds::Purpose::S3, "not json", 0).is_none());
}

#[tokio::test]
async fn sign_in_needs_consent_and_consent_can_be_revoked() {
    let d = tmp();
    let auth = CliAuth { tool: "aws".into(), account: "client-a".into() };
    let e = creds::get(&d, &auth, creds::Purpose::S3).await.unwrap_err();
    assert!(format!("{e}").contains("isn't allowed"), "{e}");
    set_allowed(&d, "aws", "client-a", true).unwrap();
    assert!(is_allowed(&d, "aws", "client-a"));
    set_allowed(&d, "aws", "client-a", false).unwrap();
    assert!(!is_allowed(&d, "aws", "client-a"));
    assert!(set_allowed(&d, "nope", "x", true).is_err());
    let bad = CliAuth { tool: "aws".into(), account: "a b".into() };
    assert!(creds::get(&d, &bad, creds::Purpose::S3).await.is_err());
    let _ = std::fs::remove_dir_all(d);
}

#[test]
fn purposes_match_backends_only() {
    assert_eq!(creds::purpose_for("aws", "s3").unwrap(), creds::Purpose::S3);
    assert_eq!(creds::purpose_for("az", "azure").unwrap(), creds::Purpose::AzureStorage);
    assert_eq!(creds::purpose_for("gcloud", "gcs").unwrap(), creds::Purpose::GcpStorage);
    assert!(creds::purpose_for("aws", "azure").is_err());
}

// ---- usage ----------------------------------------------------------------------------

#[test]
fn usage_follows_every_route_and_jump_hosts() {
    let bastion = profile(json!({ "id": "b", "name": "bastion", "proxyCommand": { "kind": "cloudflare", "hostname": "ssh.acme.com" } }));
    let inner = profile(json!({ "id": "i", "name": "inner", "jumpProfile": "b", "credentialRef": { "provider": "1password", "item": "op://v/i/password" } }));
    let ssm = profile(json!({ "id": "s", "proxyCommand": { "kind": "awsSsm", "target": "i-1", "cliAccount": "client-a" } }));
    let iap = profile(json!({ "id": "g", "proxyCommand": { "kind": "gcpIap", "target": "db", "region": "z" } }));
    let line = profile(json!({ "id": "c", "proxyCommand": { "kind": "command", "command": "C:\\tools\\cloudflared.exe access ssh --hostname %h" } }));
    let s3 = profile(json!({ "id": "o", "protocol": "s3", "cliAuth": { "tool": "aws", "account": "" }, "cliSource": { "tool": "aws", "account": "x", "remoteId": "s3:b" } }));
    let all = vec![bastion.clone(), inner.clone(), ssm.clone(), iap.clone(), line.clone(), s3.clone()];

    let u = usage::profile_tools(&inner, &all);
    assert!(u.iter().any(|t| t.tool == "op" && t.how == usage::How::Secret && t.via.is_none()));
    assert!(u.iter().any(|t| t.tool == "cloudflared" && t.via.as_deref() == Some("bastion")));
    assert_eq!(usage::profile_tools(&ssm, &all)[0].account.as_deref(), Some("client-a"));
    assert_eq!(usage::profile_tools(&iap, &all)[0].tool, "gcloud");
    assert_eq!(usage::profile_tools(&line, &all)[0].tool, "cloudflared");
    let s = usage::profile_tools(&s3, &all);
    assert!(s.iter().any(|t| t.how == usage::How::SignIn && t.account.as_deref() == Some("default")));
    assert!(s.iter().any(|t| t.how == usage::How::Imported));

    let by = usage::accounts_by_tool(&all);
    assert_eq!(by["aws"], ["client-a".to_string(), "default".to_string()].into());
    let counts = usage::counts(&all);
    assert_eq!(counts["cloudflared"], 3, "bastion, inner (via the bastion) and the command line");
    assert_eq!(counts["aws"], 2);
}

#[test]
fn a_jump_loop_does_not_hang() {
    let a = profile(json!({ "id": "a", "jumpProfile": "b" }));
    let b = profile(json!({ "id": "b", "jumpProfile": "a", "proxyCommand": { "kind": "cloudflare" } }));
    let all = vec![a.clone(), b];
    assert_eq!(usage::profile_tools(&a, &all).len(), 1);
}

// ---- tunnels ----------------------------------------------------------------------------

fn pc(kind: ProxyCommandKind, target: Option<&str>, account: Option<&str>, region: Option<&str>, project: Option<&str>) -> ProxyCommandConfig {
    ProxyCommandConfig {
        kind,
        command: String::new(),
        hostname: None,
        service_token_id: None,
        service_token_secret: None,
        target: target.map(Into::into),
        cli_account: account.map(Into::into),
        region: region.map(Into::into),
        project: project.map(Into::into),
    }
}

#[test]
fn ssm_and_iap_build_argv_with_no_shell() {
    let ssm = crate::proxy_command::build(&pc(ProxyCommandKind::AwsSsm, Some("i-0abc"), Some("client-a"), Some("eu-west-1"), None), "ignored", 2222, "ec2-user").unwrap();
    assert_eq!(
        ssm.args,
        args(&["ssm", "start-session", "--target", "i-0abc", "--document-name", "AWS-StartSSHSession", "--parameters", "portNumber=2222", "--profile", "client-a", "--region", "eu-west-1"])
    );
    assert!(!ssm.cloudflared);
    // No target: the profile's host is the instance id.
    let host = crate::proxy_command::build(&pc(ProxyCommandKind::AwsSsm, None, None, None, None), "i-host", 22, "u").unwrap();
    assert_eq!(host.args[3], "i-host");

    let iap = crate::proxy_command::build(&pc(ProxyCommandKind::GcpIap, Some("db"), Some("me@x.com"), Some("us-central1-a"), Some("acme")), "db", 22, "u").unwrap();
    assert_eq!(
        iap.args,
        args(&["compute", "start-iap-tunnel", "db", "22", "--listen-on-stdin", "--zone=us-central1-a", "--verbosity=warning", "--project=acme", "--account=me@x.com"])
    );
    assert!(crate::proxy_command::build(&pc(ProxyCommandKind::GcpIap, Some("db"), None, None, None), "db", 22, "u").is_err(), "a zone is required");
}

#[test]
fn tunnel_fields_cannot_inject() {
    for bad in ["i-1 --profile evil", "i-1&calc", "--target=x", "$(id)", "a\"b"] {
        assert!(crate::proxy_command::build(&pc(ProxyCommandKind::AwsSsm, Some(bad), None, None, None), "h", 22, "u").is_err(), "{bad}");
        assert!(crate::proxy_command::build(&pc(ProxyCommandKind::GcpIap, Some("vm"), None, Some(bad), None), "h", 22, "u").is_err(), "{bad}");
    }
}

#[test]
fn profile_round_trips_new_fields() {
    let p = profile(json!({
        "proxyCommand": { "kind": "awsSsm", "target": "i-1", "cliAccount": "a", "region": "r" },
        "cliAuth": { "tool": "aws", "account": "a" },
        "cliSource": { "tool": "aws", "account": "a", "remoteId": "ec2:i-1" }
    }));
    let v = serde_json::to_value(&p).unwrap();
    assert_eq!(v["proxyCommand"]["kind"], "awsSsm");
    assert_eq!(v["cliAuth"]["tool"], "aws");
    assert_eq!(v["cliSource"]["remoteId"], "ec2:i-1");
    let plain = serde_json::to_value(profile(json!({}))).unwrap();
    assert!(plain.get("cliAuth").is_none() && plain.get("cliSource").is_none());
}
