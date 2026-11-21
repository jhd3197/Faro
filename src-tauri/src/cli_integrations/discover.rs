//! Servers, buckets and portals a CLI's account can reach, as import
//! previews. Nothing here connects or changes anything; the person picks
//! what to save in the import picker.

use super::{args, classify_failure, display_name, run, CliState, Ran, DISCOVER_TIMEOUT, LIST_CAP, SMALL_CAP};
use crate::importers::{Conflict, ProfilePreview, Resolution};
use crate::profiles::ConnectionProfile;
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Value};

/// At most this many previews per CLI per run.
pub const MAX_PREVIEWS: usize = 500;
/// Azure containers are listed for this many storage accounts.
const MAX_AZURE_ACCOUNTS: usize = 20;

pub async fn discover(id: &str, account: Option<&str>) -> Result<Vec<ProfilePreview>> {
    let account = account.map(str::trim).filter(|a| !a.is_empty());
    if let Some(a) = account {
        anyhow::ensure!(super::plain_arg(a) || id == "tailscale" || id == "doctl" || id == "render", "That account name can't be passed to {} safely", display_name(id));
    }
    let mut out = match id {
        "aws" => aws(account.ok_or_else(|| anyhow!("Pick an AWS profile"))?).await?,
        "gcloud" => gcloud(account).await?,
        "az" => az(account.ok_or_else(|| anyhow!("Pick an Azure subscription"))?).await?,
        "tailscale" => tailscale(&need(id, run(id, &args(&["status", "--json"]), DISCOVER_TIMEOUT, LIST_CAP).await?)?),
        "doctl" => doctl(&need(id, run(id, &args(&["compute", "droplet", "list", "-o", "json"]), DISCOVER_TIMEOUT, LIST_CAP).await?)?, account.unwrap_or("")),
        "hcloud" => hcloud(&need(id, run(id, &args(&["server", "list", "-o", "json"]), DISCOVER_TIMEOUT, LIST_CAP).await?)?, account.unwrap_or("")),
        "render" => render(&need(id, run(id, &args(&["services", "-o", "json"]), DISCOVER_TIMEOUT, LIST_CAP).await?)?, account.unwrap_or("")),
        "hs" => hs(&need(id, run(id, &args(&["accounts", "list"]), DISCOVER_TIMEOUT, SMALL_CAP).await?)?),
        other => bail!("{} can't list connections", display_name(other)),
    };
    out.truncate(MAX_PREVIEWS);
    Ok(out)
}

/// A failed run as Faro's sentence.
fn need(id: &str, ran: Ran) -> Result<Ran> {
    if ran.ok {
        return Ok(ran);
    }
    Err(failure(id, &ran))
}

pub fn failure(id: &str, ran: &Ran) -> anyhow::Error {
    let name = display_name(id);
    match classify_failure(&ran.both()) {
        CliState::Expired => anyhow!("Your {name} login expired. Sign in on the CLIs page, then try again."),
        CliState::SignedOut => anyhow!("Nobody is signed in to {name}. Sign in on the CLIs page, then try again."),
        _ => anyhow!("{name} couldn't list anything for this account. Check that it works in a terminal, then try again."),
    }
}

fn parse(ran: &Ran) -> Value {
    serde_json::from_str(ran.stdout.trim()).unwrap_or(Value::Null)
}

fn s<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}

/// A preview carrying the whole connection.
fn preview(profile: Value, note: String, needs: &[&str]) -> Option<ProfilePreview> {
    let profile: ConnectionProfile = serde_json::from_value(profile).ok()?;
    let mut p = ProfilePreview::new(profile.name.clone());
    p.protocol = profile.protocol.clone();
    p.host = profile.host.clone();
    p.port = profile.port;
    p.username = profile.username.clone();
    p.note = Some(note);
    p.needs = needs.iter().map(|n| n.to_string()).collect();
    p.profile = Some(profile);
    Some(p)
}

fn source(tool: &str, account: &str, remote_id: &str) -> Value {
    json!({ "tool": tool, "account": account, "remoteId": remote_id })
}

fn ssh(name: &str, host: &str, user: &str, group: &str, src: Value) -> Value {
    json!({
        "id": "", "name": name, "protocol": "sftp", "host": host, "port": 22, "username": user,
        "auth": { "kind": "password", "password": "" },
        "group": group, "cliSource": src,
    })
}

// ---- aws ------------------------------------------------------------------------------

async fn aws(profile: &str) -> Result<Vec<ProfilePreview>> {
    let p = |a: &[&str]| {
        let mut v = args(a);
        v.extend(args(&["--profile", profile, "--output", "json"]));
        v
    };
    let region = run("aws", &args(&["configure", "get", "region", "--profile", profile]), DISCOVER_TIMEOUT, SMALL_CAP)
        .await
        .ok()
        .filter(|r| r.ok)
        .map(|r| r.stdout.trim().to_string())
        .filter(|r| super::plain_arg(r))
        .unwrap_or_else(|| "us-east-1".to_string());
    let with_region = |a: &[&str]| {
        let mut v = p(a);
        v.extend(args(&["--region", &region]));
        v
    };
    let (a_buckets, a_ec2, a_ssm) = (
        p(&["s3api", "list-buckets"]),
        with_region(&["ec2", "describe-instances", "--filters", "Name=instance-state-name,Values=running"]),
        with_region(&["ssm", "describe-instance-information"]),
    );
    let (buckets, ec2, ssm) = tokio::join!(
        run("aws", &a_buckets, DISCOVER_TIMEOUT, LIST_CAP),
        run("aws", &a_ec2, DISCOVER_TIMEOUT, LIST_CAP),
        run("aws", &a_ssm, DISCOVER_TIMEOUT, LIST_CAP),
    );
    let (buckets, ec2) = (buckets?, ec2?);
    if !buckets.ok && !ec2.ok {
        return Err(failure("aws", if classify_failure(&buckets.both()) != CliState::Error { &buckets } else { &ec2 }));
    }
    let ssm_ids: Vec<String> = ssm.ok().filter(|r| r.ok).map(|r| aws_ssm_ids(&parse(&r))).unwrap_or_default();
    let mut out = aws_buckets(&parse(&buckets), profile, &region);
    out.extend(aws_instances(&parse(&ec2), &ssm_ids, profile, &region));
    Ok(out)
}

pub fn aws_ssm_ids(v: &Value) -> Vec<String> {
    v["InstanceInformationList"]
        .as_array()
        .map(|l| l.iter().filter(|i| s(i, "PingStatus") != "ConnectionLost").map(|i| s(i, "InstanceId").to_string()).collect())
        .unwrap_or_default()
}

pub fn aws_buckets(v: &Value, profile: &str, default_region: &str) -> Vec<ProfilePreview> {
    let group = format!("AWS · {profile}");
    v["Buckets"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| {
            let name = s(b, "Name");
            if name.is_empty() {
                return None;
            }
            let region = Some(s(b, "BucketRegion")).filter(|r| !r.is_empty()).unwrap_or(default_region);
            preview(
                json!({
                    "id": "", "name": name, "protocol": "s3", "host": "", "port": 443, "username": "",
                    "auth": { "kind": "password", "password": "" },
                    "bucket": name, "region": region, "group": group,
                    "cliAuth": { "tool": "aws", "account": profile },
                    "cliSource": source("aws", profile, &format!("s3:{name}")),
                }),
                format!("S3 bucket · {region} · signs in with AWS profile {profile}"),
                &[],
            )
        })
        .collect()
}

pub fn aws_instances(v: &Value, ssm_ids: &[String], profile: &str, region: &str) -> Vec<ProfilePreview> {
    let group = format!("AWS · {profile}");
    let mut out = Vec::new();
    for r in v["Reservations"].as_array().into_iter().flatten() {
        for i in r["Instances"].as_array().into_iter().flatten() {
            let id = s(i, "InstanceId");
            if id.is_empty() {
                continue;
            }
            let name = i["Tags"]
                .as_array()
                .and_then(|t| t.iter().find(|t| s(t, "Key") == "Name"))
                .map(|t| s(t, "Value").to_string())
                .filter(|n| !n.is_empty())
                .unwrap_or_else(|| id.to_string());
            let public = Some(s(i, "PublicDnsName")).filter(|h| !h.is_empty()).or(Some(s(i, "PublicIpAddress")).filter(|h| !h.is_empty()));
            let windows = s(i, "Platform").eq_ignore_ascii_case("windows");
            let user = if windows { "" } else { "ec2-user" };
            let src = source("aws", profile, &format!("ec2:{id}"));
            let (mut profile_json, note) = if ssm_ids.iter().any(|s| s == id) {
                let mut p = ssh(&name, id, user, &group, src);
                p["proxyCommand"] = json!({ "kind": "awsSsm", "target": id, "cliAccount": profile, "region": region });
                (p, format!("EC2 {id} · through AWS SSM (no open port 22) · {region}"))
            } else if let Some(host) = public {
                (ssh(&name, host, user, &group, src), format!("EC2 {id} · public address · {region}"))
            } else {
                continue;
            };
            if let Some(key) = Some(s(i, "KeyName")).filter(|k| !k.is_empty()) {
                profile_json["notes"] = json!(format!("EC2 key pair: {key}"));
            }
            out.extend(preview(profile_json, note, &["key"]));
        }
    }
    out
}

// ---- gcloud ---------------------------------------------------------------------------

async fn gcloud(account: Option<&str>) -> Result<Vec<ProfilePreview>> {
    let with = |a: &[&str]| {
        let mut v = args(a);
        v.push("--format=json".into());
        if let Some(acct) = account {
            v.push(format!("--account={acct}"));
        }
        v
    };
    let (a_vms, a_buckets) = (with(&["compute", "instances", "list"]), with(&["storage", "buckets", "list"]));
    let (vms, buckets) = tokio::join!(
        run("gcloud", &a_vms, DISCOVER_TIMEOUT, LIST_CAP),
        run("gcloud", &a_buckets, DISCOVER_TIMEOUT, LIST_CAP),
    );
    let (vms, buckets) = (vms?, buckets?);
    if !vms.ok && !buckets.ok {
        return Err(failure("gcloud", &vms));
    }
    let acct = account.unwrap_or("");
    let mut out = gcloud_buckets(&parse(&buckets), acct);
    out.extend(gcloud_instances(&parse(&vms), acct));
    Ok(out)
}

/// `projects/<p>/zones/<z>/instances/<n>` pieces of a selfLink.
fn after<'a>(link: &'a str, key: &str) -> &'a str {
    link.split('/').skip_while(|p| *p != key).nth(1).unwrap_or("")
}

pub fn gcloud_instances(v: &Value, account: &str) -> Vec<ProfilePreview> {
    let mut out = Vec::new();
    for i in v.as_array().into_iter().flatten() {
        let name = s(i, "name");
        if name.is_empty() || !matches!(s(i, "status"), "RUNNING" | "") {
            continue;
        }
        let link = s(i, "selfLink");
        let project = after(link, "projects");
        let zone = Some(after(link, "zones")).filter(|z| !z.is_empty()).unwrap_or_else(|| s(i, "zone").rsplit('/').next().unwrap_or(""));
        let nat = i["networkInterfaces"][0]["accessConfigs"][0]["natIP"].as_str().unwrap_or("");
        let group = if project.is_empty() { "Google Cloud".to_string() } else { format!("Google Cloud · {project}") };
        let src = source("gcloud", account, &format!("gce:{project}/{zone}/{name}"));
        let (p, note) = if nat.is_empty() {
            let mut p = ssh(name, name, "", &group, src);
            p["proxyCommand"] = json!({ "kind": "gcpIap", "target": name, "region": zone, "project": project, "cliAccount": account });
            (p, format!("Compute Engine · through IAP · {zone}"))
        } else {
            (ssh(name, nat, "", &group, src), format!("Compute Engine · public address · {zone}"))
        };
        out.extend(preview(p, note, &["key"]));
    }
    out
}

pub fn gcloud_buckets(v: &Value, account: &str) -> Vec<ProfilePreview> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| {
            let name = Some(s(b, "name")).filter(|n| !n.is_empty()).or_else(|| s(b, "storage_url").strip_prefix("gs://").map(|n| n.trim_end_matches('/')))?;
            preview(
                json!({
                    "id": "", "name": name, "protocol": "gcs", "host": "", "port": 443, "username": "",
                    "auth": { "kind": "password", "password": "" },
                    "bucket": name, "group": "Google Cloud",
                    "cliAuth": { "tool": "gcloud", "account": account },
                    "cliSource": source("gcloud", account, &format!("gcs:{name}")),
                }),
                format!("Cloud Storage bucket · signs in with {}", if account.is_empty() { "the active gcloud account" } else { account }),
                &[],
            )
        })
        .collect()
}

// ---- az -------------------------------------------------------------------------------

async fn az(subscription: &str) -> Result<Vec<ProfilePreview>> {
    let sub = |a: &[&str]| {
        let mut v = args(a);
        v.extend(args(&["--subscription", subscription, "-o", "json"]));
        v
    };
    let (a_accounts, a_vms) = (sub(&["storage", "account", "list"]), sub(&["vm", "list", "-d"]));
    let (accounts, vms) = tokio::join!(
        run("az", &a_accounts, DISCOVER_TIMEOUT, LIST_CAP),
        run("az", &a_vms, DISCOVER_TIMEOUT, LIST_CAP),
    );
    let (accounts, vms) = (accounts?, vms?);
    if !accounts.ok && !vms.ok {
        return Err(failure("az", &accounts));
    }
    let names: Vec<String> = parse(&accounts)
        .as_array()
        .into_iter()
        .flatten()
        .map(|a| s(a, "name").to_string())
        .filter(|n| super::plain_arg(n))
        .take(MAX_AZURE_ACCOUNTS)
        .collect();
    let listings = futures::future::join_all(names.iter().map(|n| async move {
        let argv = sub(&["storage", "container", "list", "--account-name", n, "--auth-mode", "login"]);
        let ran = run("az", &argv, DISCOVER_TIMEOUT, LIST_CAP).await;
        (n.clone(), ran.ok().filter(|r| r.ok).map(|r| parse(&r)).unwrap_or(Value::Null))
    }))
    .await;
    let mut out = Vec::new();
    for (account, containers) in &listings {
        out.extend(az_containers(containers, account, subscription));
    }
    out.extend(az_vms(&parse(&vms), subscription));
    Ok(out)
}

pub fn az_containers(v: &Value, storage_account: &str, subscription: &str) -> Vec<ProfilePreview> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|c| {
            let name = s(c, "name");
            if name.is_empty() {
                return None;
            }
            preview(
                json!({
                    "id": "", "name": format!("{storage_account}/{name}"), "protocol": "azure", "host": "", "port": 443, "username": "",
                    "auth": { "kind": "password", "password": "" },
                    "account": storage_account, "bucket": name, "group": "Azure",
                    "cliAuth": { "tool": "az", "account": subscription },
                    "cliSource": source("az", subscription, &format!("blob:{storage_account}/{name}")),
                }),
                "Azure Blob container · signs in with the Azure CLI".into(),
                &[],
            )
        })
        .collect()
}

pub fn az_vms(v: &Value, subscription: &str) -> Vec<ProfilePreview> {
    v.as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let name = s(m, "name");
            let host = Some(s(m, "fqdns").split(',').next().unwrap_or("").trim()).filter(|h| !h.is_empty()).or(Some(s(m, "publicIps").split(',').next().unwrap_or("").trim()).filter(|h| !h.is_empty()))?;
            let user = m["osProfile"]["adminUsername"].as_str().unwrap_or("");
            let id = Some(s(m, "vmId")).filter(|i| !i.is_empty()).unwrap_or(name);
            preview(ssh(name, host, user, "Azure", source("az", subscription, &format!("vm:{id}"))), format!("Azure VM · {}", s(m, "location")), &["key"])
        })
        .collect()
}

// ---- tailscale ------------------------------------------------------------------------

pub fn tailscale(ran: &Ran) -> Vec<ProfilePreview> {
    let v = parse(ran);
    let tailnet = v["CurrentTailnet"]["Name"].as_str().unwrap_or("").to_string();
    let group = if tailnet.is_empty() { "Tailscale".to_string() } else { format!("Tailscale · {tailnet}") };
    let mut peers: Vec<&Value> = v["Peer"].as_object().map(|m| m.values().collect()).unwrap_or_default();
    peers.sort_by_key(|p| (!p["Online"].as_bool().unwrap_or(false), s(p, "HostName").to_lowercase()));
    peers
        .into_iter()
        .filter(|p| !matches!(s(p, "OS").to_ascii_lowercase().as_str(), "ios" | "android" | "tvos"))
        .filter_map(|p| {
            let dns = s(p, "DNSName").trim_end_matches('.');
            let ip = p["TailscaleIPs"][0].as_str().unwrap_or("");
            let host = if dns.is_empty() { ip } else { dns };
            let name = Some(s(p, "HostName")).filter(|n| !n.is_empty()).unwrap_or(host);
            if host.is_empty() {
                return None;
            }
            let online = p["Online"].as_bool().unwrap_or(false);
            let id = Some(s(p, "ID")).filter(|i| !i.is_empty()).unwrap_or(host);
            let mut pv = preview(
                ssh(name, host, "", &group, source("tailscale", &tailnet, &format!("node:{id}"))),
                format!("{} · {}", if online { "online" } else { "offline" }, s(p, "OS")),
                &["key"],
            )?;
            // Offline peers are listed but not preselected (the UI reads this).
            if !online {
                pv.needs.push("offline".into());
            }
            Some(pv)
        })
        .collect()
}

// ---- doctl / hcloud / render ------------------------------------------------------------

pub fn doctl(ran: &Ran, account: &str) -> Vec<ProfilePreview> {
    parse(ran)
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|d| {
            let ip = d["networks"]["v4"].as_array()?.iter().find(|n| s(n, "type") == "public").map(|n| s(n, "ip_address").to_string())?;
            let name = s(d, "name");
            let region = d["region"]["slug"].as_str().unwrap_or("");
            preview(ssh(name, &ip, "root", "DigitalOcean", source("doctl", account, &format!("droplet:{}", d["id"]))), format!("Droplet · {region}"), &["key"])
        })
        .collect()
}

pub fn hcloud(ran: &Ran, account: &str) -> Vec<ProfilePreview> {
    parse(ran)
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|srv| {
            let ip = srv["public_net"]["ipv4"]["ip"].as_str().filter(|i| !i.is_empty()).map(str::to_string).or_else(|| {
                // An IPv6-only server: the /64 network's ::1.
                srv["public_net"]["ipv6"]["ip"].as_str().map(|n| n.split('/').next().unwrap_or("").to_string() + "1").filter(|i| i.len() > 1)
            })?;
            let name = s(srv, "name");
            let location = srv["datacenter"]["location"]["name"].as_str().unwrap_or("");
            preview(ssh(name, &ip, "root", "Hetzner", source("hcloud", account, &format!("server:{}", srv["id"]))), format!("Hetzner server · {location}"), &["key"])
        })
        .collect()
}

/// Every `sshAddress` (`srv-…@ssh.<region>.render.com`) in the services list,
/// whatever nesting the CLI uses.
fn find_ssh(v: &Value) -> Option<&str> {
    match v {
        Value::Object(m) => m.get("sshAddress").and_then(Value::as_str).or_else(|| m.values().find_map(find_ssh)),
        Value::Array(a) => a.iter().find_map(find_ssh),
        _ => None,
    }
}

pub fn render(ran: &Ran, account: &str) -> Vec<ProfilePreview> {
    parse(ran)
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let svc = if item.get("service").is_some() { &item["service"] } else { item };
            let addr = find_ssh(svc)?;
            let (user, host) = addr.split_once('@')?;
            let name = Some(s(svc, "name")).filter(|n| !n.is_empty()).unwrap_or(user);
            let id = Some(s(svc, "id")).filter(|i| !i.is_empty()).unwrap_or(user);
            preview(ssh(name, host, user, "Render", source("render", account, &format!("service:{id}"))), "Render service · SSH with a key added to your Render account".into(), &["key"])
        })
        .collect()
}

// ---- hs -------------------------------------------------------------------------------

pub fn hs(ran: &Ran) -> Vec<ProfilePreview> {
    super::parse::hs_portals(&ran.stdout)
        .into_iter()
        .filter_map(|(id, name, _)| {
            preview(
                json!({
                    "id": "", "name": format!("{name} (HubSpot)"), "protocol": "hubspot", "host": "", "port": 443, "username": "",
                    "auth": { "kind": "password", "password": "" },
                    "group": "HubSpot", "notes": format!("Portal {id}"),
                    "cliSource": source("hs", &id, &format!("portal:{id}")),
                }),
                format!("HubSpot portal {id} · paste a private-app token after import"),
                &["token"],
            )
        })
        .collect()
}

// ---- Conflicts ------------------------------------------------------------------------

/// A preview of something imported before (same CLI and remote id) points
/// at that connection and defaults to updating it; the rest go through the
/// usual name/host matching.
pub fn mark_conflicts(previews: &mut [ProfilePreview], existing: &[ConnectionProfile]) {
    crate::importers::mark_conflicts(previews, existing);
    for p in previews.iter_mut() {
        let Some(src) = p.profile.as_ref().and_then(|pr| pr.cli_source.clone()) else { continue };
        if let Some(old) = existing.iter().find(|e| e.cli_source.as_ref().is_some_and(|o| o.tool == src.tool && o.remote_id == src.remote_id)) {
            p.conflict = Some(Conflict { id: old.id.clone(), name: old.name.clone(), by_name: false });
            p.resolution = Some(Resolution::Replace);
        }
    }
}

/// Updating a connection imported before: keep everything the person set and
/// take only what the CLI knows better (address, tunnel target, region).
pub fn refresh_merge(old: &ConnectionProfile, new: &ConnectionProfile) -> ConnectionProfile {
    let mut merged = old.clone();
    if !new.host.is_empty() {
        merged.host = new.host.clone();
    }
    if let (Some(o), Some(n)) = (merged.proxy_command.as_mut(), new.proxy_command.as_ref()) {
        if o.kind == n.kind {
            o.target = n.target.clone();
            o.region = n.region.clone();
            o.project = n.project.clone();
        }
    }
    if new.region.is_some() {
        merged.region = new.region.clone();
    }
    merged.cli_source = new.cli_source.clone();
    merged
}
