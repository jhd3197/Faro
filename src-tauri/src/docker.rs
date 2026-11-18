//! Docker manager backend (Plan 31): containers, images, volumes and networks
//! on an SSH host, through the `docker` CLI's JSON output. Nothing is
//! installed on the host and the Docker socket is never exposed.
//!
//! Every list is `docker … --format '{{json .}}'`, one JSON object per line.
//! Field sets differ between Docker releases, so every field is optional and
//! a line that doesn't parse is skipped, never fatal (sudo and PTY noise land
//! in the same stream).
//!
//! Commands take the frontend's [`Elevate`]: a user in the `docker` group
//! needs none, otherwise the call goes through sudo like the Server view's
//! other root reads ([`crate::sysmon::run_as`]).
//!
//! Names and ids come from the remote host and end up on a shell command
//! line, so each is validated and single-quoted before use.

use std::time::Duration;

use anyhow::{bail, Result};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};

use crate::cf_setup::sh_quote;
use crate::session::SshSession;
use crate::sysmon::{err, merged, run_as, run_as_for, ssh_for, ActionResult, Elevate};
use crate::AppState;

/// Stopping waits out a container's grace period; pruning can take a while.
const ACTION_TIMEOUT: Duration = Duration::from_secs(120);

// ---------- access ----------

/// How this user reaches the Docker daemon.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DockerAccess {
    /// `direct` (in the docker group or root), `sudo` (passwordless sudo
    /// works), `needsRoot` (the socket refused us and sudo wants a password)
    /// or `unavailable` (no daemon to talk to).
    pub mode: String,
    /// Server version, when it answered.
    pub version: String,
    /// What Docker said, when it didn't.
    pub error: Option<String>,
}

const VERSION_CMD: &str = "docker version --format '{{.Server.Version}}' 2>&1";

/// Whether a failed `docker` call was refused for lack of privilege (as
/// opposed to a daemon that isn't running).
fn is_permission_error(text: &str) -> bool {
    let t = text.to_lowercase();
    t.contains("permission denied") || t.contains("got permission denied") || t.contains("access is denied")
}

async fn access(ssh: &SshSession) -> Result<DockerAccess> {
    let out = run_as(ssh, VERSION_CMD, Elevate::None).await?;
    if out.exit_code == Some(0) {
        return Ok(DockerAccess { mode: "direct".into(), version: out.stdout.trim().into(), error: None });
    }
    let said = merged(&out);
    if !is_permission_error(&said) {
        return Ok(DockerAccess { mode: "unavailable".into(), version: String::new(), error: Some(said) });
    }
    let sudo = run_as(ssh, VERSION_CMD, Elevate::Sudo).await?;
    if sudo.exit_code == Some(0) {
        return Ok(DockerAccess { mode: "sudo".into(), version: sudo.stdout.trim().into(), error: None });
    }
    Ok(DockerAccess { mode: "needsRoot".into(), version: String::new(), error: Some(said) })
}

// ---------- parsing helpers ----------

/// One JSON object per line; lines that aren't one are skipped.
fn parse_json_lines<T: DeserializeOwned>(out: &str) -> Vec<T> {
    out.lines()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// `12.5MiB`, `1.94GiB`, `862B`, `1.2kB`, `7.8MB` → bytes. Docker prints
/// memory in binary units and sizes / IO in decimal ones.
fn parse_size(s: &str) -> Option<u64> {
    let s = s.trim();
    let split = s.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    let value: f64 = s[..split].parse().ok()?;
    let mult: f64 = match s[split..].trim().to_ascii_lowercase().as_str() {
        "b" => 1.0,
        "kb" => 1e3,
        "mb" => 1e6,
        "gb" => 1e9,
        "tb" => 1e12,
        "kib" => 1024.0,
        "mib" => 1024.0 * 1024.0,
        "gib" => 1024.0 * 1024.0 * 1024.0,
        "tib" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => return None,
    };
    Some((value * mult).round() as u64)
}

/// `12.5MiB / 1.94GiB` → (left, right) in bytes; a side that doesn't parse is 0.
fn parse_pair(s: &str) -> (u64, u64) {
    let (a, b) = s.split_once('/').unwrap_or((s, ""));
    (parse_size(a).unwrap_or(0), parse_size(b).unwrap_or(0))
}

fn parse_pct(s: &str) -> f32 {
    s.trim().trim_end_matches('%').parse().unwrap_or(0.0)
}

/// The value of one label in Docker's `k=v,k2=v2` label string.
fn label(labels: &str, key: &str) -> Option<String> {
    labels
        .split(',')
        .find_map(|kv| kv.strip_prefix(key)?.strip_prefix('='))
        .map(str::to_string)
        .filter(|v| !v.is_empty())
}

fn split_list(s: &str) -> Vec<String> {
    s.split(',').map(str::trim).filter(|x| !x.is_empty()).map(str::to_string).collect()
}

/// A container, volume or network name or id: Docker's own character set.
fn valid_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && s.len() <= 255
        && chars.all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
}

/// An image id or reference (`sha256:…`, `registry:5000/team/app:1.2`).
fn valid_image_ref(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphanumeric())
        && s.len() <= 512
        && chars.all(|c| c.is_ascii_alphanumeric() || "_.-:/@".contains(c))
}

fn checked(name: &str) -> Result<String> {
    if !valid_name(name) {
        bail!("not a valid Docker name or id: {name}");
    }
    Ok(sh_quote(name))
}

// ---------- containers ----------

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
struct PsRow {
    #[serde(rename = "ID")]
    id: String,
    names: String,
    image: String,
    command: String,
    created_at: String,
    running_for: String,
    ports: String,
    state: String,
    status: String,
    networks: String,
    mounts: String,
    labels: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Container {
    pub id: String,
    pub name: String,
    pub image: String,
    pub command: String,
    pub created_at: String,
    pub running_for: String,
    pub ports: String,
    /// `running`, `exited`, `paused`, `restarting`, `created`, `dead`.
    pub state: String,
    /// Docker's own wording, e.g. `Up 2 hours (healthy)`.
    pub status: String,
    pub networks: Vec<String>,
    /// Volume names and bind sources, as `docker ps` lists them.
    pub mounts: Vec<String>,
    /// Compose project and service, from the standard labels.
    pub project: Option<String>,
    pub service: Option<String>,
}

/// Older Docker has no `State` column; read it off the status wording.
fn state_from_status(status: &str) -> &'static str {
    let s = status.to_ascii_lowercase();
    if s.contains("(paused)") {
        "paused"
    } else if s.starts_with("up") {
        "running"
    } else if s.starts_with("restarting") {
        "restarting"
    } else if s.starts_with("created") {
        "created"
    } else if s.starts_with("dead") {
        "dead"
    } else {
        "exited"
    }
}

fn parse_containers(out: &str) -> Vec<Container> {
    let mut list: Vec<Container> = parse_json_lines::<PsRow>(out)
        .into_iter()
        .filter(|r| !r.id.is_empty())
        .map(|r| Container {
            state: if r.state.is_empty() { state_from_status(&r.status).to_string() } else { r.state },
            project: label(&r.labels, "com.docker.compose.project"),
            service: label(&r.labels, "com.docker.compose.service"),
            networks: split_list(&r.networks),
            mounts: split_list(&r.mounts),
            command: r.command.trim_matches('"').to_string(),
            name: r.names.split(',').next().unwrap_or("").to_string(),
            id: r.id,
            image: r.image,
            created_at: r.created_at,
            running_for: r.running_for,
            ports: r.ports,
            status: r.status,
        })
        .collect();
    // Compose projects together, then by name.
    list.sort_by(|a, b| {
        (a.project.is_none(), &a.project, &a.name).cmp(&(b.project.is_none(), &b.project, &b.name))
    });
    list
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
struct StatsRow {
    #[serde(rename = "ID")]
    id: String,
    name: String,
    #[serde(rename = "CPUPerc")]
    cpu_perc: String,
    mem_usage: String,
    #[serde(rename = "NetIO")]
    net_io: String,
    #[serde(rename = "BlockIO")]
    block_io: String,
    #[serde(rename = "PIDs")]
    pids: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStats {
    pub id: String,
    pub name: String,
    pub cpu_pct: f32,
    pub mem_used: u64,
    pub mem_limit: u64,
    pub net_rx: u64,
    pub net_tx: u64,
    pub block_read: u64,
    pub block_write: u64,
    pub pids: u32,
}

fn parse_stats(out: &str) -> Vec<ContainerStats> {
    parse_json_lines::<StatsRow>(out)
        .into_iter()
        .filter(|r| !r.id.is_empty() || !r.name.is_empty())
        .map(|r| {
            let (mem_used, mem_limit) = parse_pair(&r.mem_usage);
            let (net_rx, net_tx) = parse_pair(&r.net_io);
            let (block_read, block_write) = parse_pair(&r.block_io);
            ContainerStats {
                id: r.id,
                name: r.name,
                cpu_pct: parse_pct(&r.cpu_perc),
                mem_used,
                mem_limit,
                net_rx,
                net_tx,
                block_read,
                block_write,
                pids: r.pids.trim().parse().unwrap_or(0),
            }
        })
        .collect()
}

// ---------- inspect ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Mount {
    /// `bind`, `volume`, `tmpfs`.
    pub kind: String,
    /// Host path (bind) or the volume's data directory.
    pub source: String,
    pub destination: String,
    pub rw: bool,
    /// The volume's name, for volume mounts.
    pub name: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PortBinding {
    /// `80/tcp`.
    pub container: String,
    /// `0.0.0.0:8080`, or empty when the port is exposed but not published.
    pub host: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetail {
    pub id: String,
    pub name: String,
    pub image: String,
    pub command: String,
    pub created: String,
    pub status: String,
    pub health: Option<String>,
    pub started_at: String,
    pub finished_at: String,
    pub exit_code: i64,
    pub restart_count: i64,
    pub restart_policy: String,
    /// `KEY=value` split at the first `=`. Values can be secrets; the UI
    /// masks them until asked.
    pub env: Vec<(String, String)>,
    pub labels: Vec<(String, String)>,
    pub mounts: Vec<Mount>,
    /// Network name and the container's address on it.
    pub networks: Vec<(String, String)>,
    pub ports: Vec<PortBinding>,
}

fn text(v: &Value, path: &[&str]) -> String {
    path.iter().try_fold(v, |v, k| v.get(k)).and_then(Value::as_str).unwrap_or("").to_string()
}

fn int(v: &Value, path: &[&str]) -> i64 {
    path.iter().try_fold(v, |v, k| v.get(k)).and_then(Value::as_i64).unwrap_or(0)
}

/// `docker inspect <container>` prints a one-element JSON array.
fn parse_inspect(out: &str) -> Result<ContainerDetail> {
    let start = out.find('[').ok_or_else(|| anyhow::anyhow!("{}", out.trim()))?;
    let v: Value = serde_json::from_str(&out[start..])?;
    let c = v.get(0).ok_or_else(|| anyhow::anyhow!("no such container"))?;

    let mut command = text(c, &["Path"]);
    if let Some(args) = c.get("Args").and_then(Value::as_array) {
        for a in args.iter().filter_map(Value::as_str) {
            command.push(' ');
            command.push_str(a);
        }
    }
    let env = c
        .pointer("/Config/Env")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|kv| match kv.split_once('=') {
                    Some((k, v)) => (k.to_string(), v.to_string()),
                    None => (kv.to_string(), String::new()),
                })
                .collect()
        })
        .unwrap_or_default();
    let mut labels: Vec<(String, String)> = c
        .pointer("/Config/Labels")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect())
        .unwrap_or_default();
    labels.sort();
    let mounts = c
        .get("Mounts")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|m| Mount {
                    kind: text(m, &["Type"]),
                    source: text(m, &["Source"]),
                    destination: text(m, &["Destination"]),
                    rw: m.get("RW").and_then(Value::as_bool).unwrap_or(true),
                    name: Some(text(m, &["Name"])).filter(|n| !n.is_empty()),
                })
                .collect()
        })
        .unwrap_or_default();
    let mut networks: Vec<(String, String)> = c
        .pointer("/NetworkSettings/Networks")
        .and_then(Value::as_object)
        .map(|o| o.iter().map(|(name, n)| (name.clone(), text(n, &["IPAddress"]))).collect())
        .unwrap_or_default();
    networks.sort();
    let mut ports: Vec<PortBinding> = Vec::new();
    if let Some(o) = c.pointer("/NetworkSettings/Ports").and_then(Value::as_object) {
        for (container, binds) in o {
            match binds.as_array().filter(|b| !b.is_empty()) {
                Some(binds) => {
                    for b in binds {
                        let (ip, port) = (text(b, &["HostIp"]), text(b, &["HostPort"]));
                        // IPv6 hosts need brackets to be readable next to a port.
                        let host = if ip.contains(':') { format!("[{ip}]:{port}") } else { format!("{ip}:{port}") };
                        ports.push(PortBinding { container: container.clone(), host });
                    }
                }
                None => ports.push(PortBinding { container: container.clone(), host: String::new() }),
            }
        }
    }
    ports.sort_by(|a, b| a.container.cmp(&b.container).then_with(|| a.host.cmp(&b.host)));

    Ok(ContainerDetail {
        id: text(c, &["Id"]),
        name: text(c, &["Name"]).trim_start_matches('/').to_string(),
        image: text(c, &["Config", "Image"]),
        command,
        created: text(c, &["Created"]),
        status: text(c, &["State", "Status"]),
        health: Some(text(c, &["State", "Health", "Status"])).filter(|h| !h.is_empty()),
        started_at: text(c, &["State", "StartedAt"]),
        finished_at: text(c, &["State", "FinishedAt"]),
        exit_code: int(c, &["State", "ExitCode"]),
        restart_count: int(c, &["RestartCount"]),
        restart_policy: text(c, &["HostConfig", "RestartPolicy", "Name"]),
        env,
        labels,
        mounts,
        networks,
        ports,
    })
}

// ---------- images, volumes, networks, disk use ----------

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
struct ImageRow {
    #[serde(rename = "ID")]
    id: String,
    repository: String,
    tag: String,
    size: String,
    created_since: String,
    created_at: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Image {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: u64,
    pub created_since: String,
    pub created_at: String,
}

fn parse_images(out: &str) -> Vec<Image> {
    let mut list: Vec<Image> = parse_json_lines::<ImageRow>(out)
        .into_iter()
        .filter(|r| !r.id.is_empty())
        .map(|r| Image {
            size: parse_size(&r.size).unwrap_or(0),
            id: r.id,
            repository: r.repository,
            tag: r.tag,
            created_since: r.created_since,
            created_at: r.created_at,
        })
        .collect();
    list.sort_by(|a, b| (&a.repository, &a.tag).cmp(&(&b.repository, &b.tag)));
    list
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
struct VolumeRow {
    name: String,
    driver: String,
    mountpoint: String,
    size: String,
    links: Value,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    /// Bytes used, when `docker system df -v` could say.
    pub size: Option<u64>,
    /// How many containers reference it, when known.
    pub links: Option<u32>,
}

fn volume_from(r: VolumeRow) -> Volume {
    let links = match &r.links {
        Value::Number(n) => n.as_u64().map(|n| n as u32),
        Value::String(s) => s.trim().parse().ok(),
        _ => None,
    };
    Volume { size: parse_size(&r.size), links, name: r.name, driver: r.driver, mountpoint: r.mountpoint }
}

/// `docker volume ls` rows, with sizes and link counts filled in from the
/// `Volumes` array of `docker system df -v --format '{{json .}}'` when given.
fn parse_volumes(ls: &str, df_verbose: &str) -> Vec<Volume> {
    let mut list: Vec<Volume> =
        parse_json_lines::<VolumeRow>(ls).into_iter().filter(|r| !r.name.is_empty()).map(volume_from).collect();
    let detailed: Vec<Volume> = df_verbose
        .lines()
        .map(str::trim)
        .filter(|l| l.starts_with('{'))
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| v.get("Volumes").cloned())
        .filter_map(|v| serde_json::from_value::<Vec<VolumeRow>>(v).ok())
        .flatten()
        .map(volume_from)
        .collect();
    for v in &mut list {
        if let Some(d) = detailed.iter().find(|d| d.name == v.name) {
            v.size = d.size.or(v.size);
            v.links = d.links.or(v.links);
        }
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    list
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, rename_all = "PascalCase")]
struct NetworkRow {
    #[serde(rename = "ID")]
    id: String,
    name: String,
    driver: String,
    scope: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub id: String,
    pub name: String,
    pub driver: String,
    pub scope: String,
    /// `bridge`, `host` and `none` come with Docker and cannot be removed.
    pub builtin: bool,
}

fn is_builtin_network(name: &str) -> bool {
    matches!(name, "bridge" | "host" | "none")
}

fn parse_networks(out: &str) -> Vec<Network> {
    let mut list: Vec<Network> = parse_json_lines::<NetworkRow>(out)
        .into_iter()
        .filter(|r| !r.name.is_empty())
        .map(|r| Network { builtin: is_builtin_network(&r.name), id: r.id, name: r.name, driver: r.driver, scope: r.scope })
        .collect();
    list.sort_by(|a, b| (!a.builtin, &a.name).cmp(&(!b.builtin, &b.name)));
    list
}

/// One row of `docker system df`: what a prune of that kind could reclaim.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default, rename_all(serialize = "camelCase", deserialize = "PascalCase"))]
pub struct DiskUse {
    /// `Images`, `Containers`, `Local Volumes`, `Build Cache`.
    #[serde(rename(serialize = "kind", deserialize = "Type"))]
    pub kind: String,
    pub total_count: String,
    pub active: String,
    pub size: String,
    pub reclaimable: String,
}

// ---------- commands ----------

#[tauri::command]
pub async fn docker_access(session_id: String, state: State<'_, AppState>) -> Result<DockerAccess, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    access(&ssh).await.map_err(err)
}

/// Run a read-only docker command; a non-zero exit is an error carrying what
/// Docker said.
async fn read(ssh: &SshSession, script: &str, elevate: Elevate) -> Result<String> {
    let out = run_as(ssh, script, elevate).await?;
    if out.exit_code != Some(0) && !out.stdout.contains('{') {
        bail!("{}", merged(&out));
    }
    Ok(out.stdout)
}

const PS_CMD: &str = "docker ps -a --no-trunc --format '{{json .}}'";
const STATS_CMD: &str = "docker stats --no-stream --no-trunc --format '{{json .}}'";

#[tauri::command]
pub async fn docker_containers(
    session_id: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<Vec<Container>, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    Ok(parse_containers(&read(&ssh, PS_CMD, elevate).await.map_err(err)?))
}

#[tauri::command]
pub async fn docker_stats(
    session_id: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<Vec<ContainerStats>, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    Ok(parse_stats(&read(&ssh, STATS_CMD, elevate).await.map_err(err)?))
}

#[tauri::command]
pub async fn docker_inspect(
    session_id: String,
    id: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<ContainerDetail, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let script = format!("docker inspect {}", checked(&id).map_err(err)?);
    let out = run_as(&ssh, &script, elevate).await.map_err(err)?;
    if out.exit_code != Some(0) {
        return Err(merged(&out));
    }
    parse_inspect(&out.stdout).map_err(err)
}

/// The docker subcommand for a container action. `remove` forces, because a
/// running container can't be removed otherwise and the UI has confirmed.
fn container_action_script(action: &str, id: &str) -> Result<String> {
    let id = checked(id)?;
    Ok(match action {
        "start" | "stop" | "restart" | "pause" | "unpause" | "kill" => format!("docker {action} {id}"),
        "remove" => format!("docker rm -f {id}"),
        other => bail!("unsupported container action {other}"),
    })
}

async fn act(ssh: &SshSession, script: &str, elevate: Elevate) -> Result<ActionResult> {
    let out = run_as_for(ssh, script, elevate, ACTION_TIMEOUT).await?;
    Ok(ActionResult { ok: out.exit_code == Some(0), output: merged(&out) })
}

#[tauri::command]
pub async fn docker_container_action(
    session_id: String,
    id: String,
    action: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<ActionResult, String> {
    let script = container_action_script(&action, &id).map_err(err)?;
    let ssh = ssh_for(&state, &session_id).await?;
    act(&ssh, &script, elevate).await.map_err(err)
}

/// The command a live log runs. `None` when it can't follow: a stream has no
/// way to answer sudo's password prompt.
fn logs_command(id: &str, tail: u32, elevate: Elevate, follow: bool) -> Result<Option<String>> {
    let id = checked(id)?;
    // A follow replaces its shell (`exec`), so the stream is one process
    // (two under sudo) and nothing is left holding the pipe when it stops.
    let prefix = match (elevate, follow) {
        (Elevate::Password, true) => return Ok(None),
        (Elevate::Sudo, true) => "exec sudo -n ",
        (_, true) => "exec ",
        _ => "",
    };
    let follow = if follow { "--follow " } else { "" };
    // Containers write to both streams; show them together.
    Ok(Some(format!("{prefix}docker logs {follow}--tail {tail} --timestamps {id} 2>&1")))
}

/// Follow a container's log. Lines arrive as `stream://lines` with the key
/// `docker:<id>`. Errors when this session can only reach Docker through a
/// sudo password: use [`docker_logs_tail`] there.
#[tauri::command]
pub async fn docker_logs_start(
    session_id: String,
    id: String,
    tail: Option<u32>,
    elevate: Elevate,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let tail = tail.unwrap_or(200).min(5000);
    let Some(command) = logs_command(&id, tail, elevate, true).map_err(err)? else {
        return Err("a live log can't answer sudo's password prompt".into());
    };
    let ssh = ssh_for(&state, &session_id).await?;
    crate::logfollow::start(&state.streams, app, ssh, format!("docker:{id}"), &command, elevate == Elevate::Sudo)
        .await
        .map_err(err)
}

/// The last `tail` lines of a container's log, without following.
#[tauri::command]
pub async fn docker_logs_tail(
    session_id: String,
    id: String,
    tail: Option<u32>,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let tail = tail.unwrap_or(500).min(5000);
    let command = logs_command(&id, tail, elevate, false).map_err(err)?.unwrap_or_default();
    let ssh = ssh_for(&state, &session_id).await?;
    let out = run_as(&ssh, &command, elevate).await.map_err(err)?;
    Ok(merged(&out))
}

#[tauri::command]
pub async fn docker_images(
    session_id: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<Vec<Image>, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let out = read(&ssh, "docker images --no-trunc --format '{{json .}}'", elevate).await.map_err(err)?;
    Ok(parse_images(&out))
}

#[tauri::command]
pub async fn docker_volumes(
    session_id: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<Vec<Volume>, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let ls = read(&ssh, "docker volume ls --format '{{json .}}'", elevate).await.map_err(err)?;
    // Sizes are a bonus: an older Docker without the verbose JSON still lists.
    let df = read(&ssh, "docker system df -v --format '{{json .}}'", elevate).await.unwrap_or_default();
    Ok(parse_volumes(&ls, &df))
}

#[tauri::command]
pub async fn docker_networks(
    session_id: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<Vec<Network>, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let out = read(&ssh, "docker network ls --no-trunc --format '{{json .}}'", elevate).await.map_err(err)?;
    Ok(parse_networks(&out))
}

#[tauri::command]
pub async fn docker_disk_use(
    session_id: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<Vec<DiskUse>, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let out = read(&ssh, "docker system df --format '{{json .}}'", elevate).await.map_err(err)?;
    Ok(parse_json_lines(&out))
}

/// The command that removes one image, volume or network.
fn remove_script(kind: &str, id: &str) -> Result<String> {
    Ok(match kind {
        "image" => {
            if !valid_image_ref(id) {
                bail!("not a valid image reference: {id}");
            }
            format!("docker rmi {}", sh_quote(id))
        }
        "volume" => format!("docker volume rm {}", checked(id)?),
        "network" => {
            if is_builtin_network(id) {
                bail!("{id} is one of Docker's built-in networks");
            }
            format!("docker network rm {}", checked(id)?)
        }
        other => bail!("unsupported resource {other}"),
    })
}

#[tauri::command]
pub async fn docker_remove(
    session_id: String,
    kind: String,
    id: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<ActionResult, String> {
    let script = remove_script(&kind, &id).map_err(err)?;
    let ssh = ssh_for(&state, &session_id).await?;
    act(&ssh, &script, elevate).await.map_err(err)
}

/// One resource type per call; there is no "prune everything".
fn prune_script(kind: &str) -> Result<&'static str> {
    Ok(match kind {
        "containers" => "docker container prune -f",
        "images" => "docker image prune -f",
        "volumes" => "docker volume prune -f",
        "networks" => "docker network prune -f",
        other => bail!("unsupported prune target {other}"),
    })
}

#[tauri::command]
pub async fn docker_prune(
    session_id: String,
    kind: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<ActionResult, String> {
    let script = prune_script(&kind).map_err(err)?;
    let ssh = ssh_for(&state, &session_id).await?;
    act(&ssh, script, elevate).await.map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PS: &str = r#"{"Command":"\"sleep infinity\"","CreatedAt":"2026-11-16 01:40:19 +0000 UTC","ID":"3ab2fee06d52","Image":"busybox","Labels":"com.docker.compose.project=shop,com.docker.compose.service=db","LocalVolumes":"0","Mounts":"","Names":"shop-db-1","Networks":"bridge","Platform":{"architecture":"amd64","os":"linux"},"Ports":"","RunningFor":"1 second ago","Size":"4.1kB (virtual 4.61MB)","State":"running","Status":"Up 1 second"}
[sudo] password for ops:
{"Command":"\"sleep infinity\"","ID":"aaa111","Image":"busybox","Labels":"","Mounts":"lab-data,/srv/lab-site","Names":"lab-idle","Networks":"lab-net","Ports":"127.0.0.1:8088->80/tcp","State":"running","Status":"Up 2 hours"}
{"ID":"bbb222","Image":"busybox","Names":"lab-stopped","Status":"Exited (3) 4 minutes ago"}
not json at all
{"ID":"ccc333","Names":"old-paused","Status":"Up 3 days (Paused)"}"#;

    #[test]
    fn containers_parse_and_group_by_compose_project() {
        let c = parse_containers(PS);
        let names: Vec<&str> = c.iter().map(|x| x.name.as_str()).collect();
        // The compose project first, then the rest by name; noise lines skipped.
        assert_eq!(names, vec!["shop-db-1", "lab-idle", "lab-stopped", "old-paused"]);
        assert_eq!(c[0].project.as_deref(), Some("shop"));
        assert_eq!(c[0].service.as_deref(), Some("db"));
        assert_eq!(c[0].command, "sleep infinity");
        assert_eq!(c[1].mounts, vec!["lab-data", "/srv/lab-site"]);
        assert_eq!(c[1].networks, vec!["lab-net"]);
        assert_eq!(c[1].ports, "127.0.0.1:8088->80/tcp");
        assert_eq!(c[1].project, None);
        // No State column on old Docker: read it off the status.
        assert_eq!(c[2].state, "exited");
        assert_eq!(c[3].state, "paused");
    }

    #[test]
    fn sizes_parse_in_both_unit_families() {
        assert_eq!(parse_size("862B"), Some(862));
        assert_eq!(parse_size("1.2kB"), Some(1200));
        assert_eq!(parse_size("7.8MB"), Some(7_800_000));
        assert_eq!(parse_size("500KiB"), Some(512_000));
        assert_eq!(parse_size("12.5MiB"), Some(13_107_200));
        assert_eq!(parse_size("1.94GiB"), Some(2_083_059_139));
        assert_eq!(parse_size("0B"), Some(0));
        assert_eq!(parse_size("N/A"), None);
        assert_eq!(parse_size(""), None);
        assert_eq!(parse_pair("12.5MiB / 1.94GiB"), (13_107_200, 2_083_059_139));
        assert_eq!(parse_pair("-- / --"), (0, 0));
        assert_eq!(parse_pct("0.15%"), 0.15);
        assert_eq!(parse_pct("--"), 0.0);
    }

    #[test]
    fn stats_rows_parse() {
        let out = r#"{"BlockIO":"4.1kB / 0B","CPUPerc":"12.50%","Container":"3ab2","ID":"3ab2","MemPerc":"0.00%","MemUsage":"500KiB / 62.37GiB","Name":"shop-db-1","NetIO":"862B / 126B","PIDs":"3"}
{"BlockIO":"-- / --","CPUPerc":"--","ID":"dead","MemUsage":"-- / --","Name":"gone","NetIO":"-- / --","PIDs":"--"}"#;
        let s = parse_stats(out);
        assert_eq!(s.len(), 2);
        assert_eq!(s[0].cpu_pct, 12.5);
        assert_eq!(s[0].mem_used, 512_000);
        assert_eq!((s[0].net_rx, s[0].net_tx), (862, 126));
        assert_eq!((s[0].block_read, s[0].pids), (4100, 3));
        // A container that vanished mid-sample reports dashes: zeros, not a failure.
        assert_eq!((s[1].cpu_pct, s[1].mem_used, s[1].pids), (0.0, 0, 0));
    }

    #[test]
    fn inspect_parses_the_parts_the_drawer_shows() {
        let out = r#"[{"Id":"aaa111","Created":"2026-11-16T01:40:19Z","Path":"sleep","Args":["infinity"],
          "State":{"Status":"running","ExitCode":0,"StartedAt":"2026-11-16T01:40:20Z","FinishedAt":"0001-01-01T00:00:00Z","Health":{"Status":"healthy"}},
          "Name":"/lab-idle","RestartCount":2,
          "HostConfig":{"RestartPolicy":{"Name":"unless-stopped"}},
          "Mounts":[{"Type":"volume","Name":"lab-data","Source":"/var/lib/docker/volumes/lab-data/_data","Destination":"/data","RW":true},
                    {"Type":"bind","Source":"/srv/lab-site","Destination":"/site","RW":false}],
          "Config":{"Image":"busybox","Env":["LAB_TOKEN=s3cret=value","MODE=idle","EMPTY"],"Labels":{"b":"2","a":"1"}},
          "NetworkSettings":{"Ports":{"80/tcp":[{"HostIp":"127.0.0.1","HostPort":"8088"},{"HostIp":"::1","HostPort":"8088"}],"443/tcp":null},
                             "Networks":{"lab-net":{"IPAddress":"172.18.0.2"}}}}]"#;
        let d = parse_inspect(out).unwrap();
        assert_eq!((d.name.as_str(), d.image.as_str(), d.command.as_str()), ("lab-idle", "busybox", "sleep infinity"));
        assert_eq!((d.status.as_str(), d.health.as_deref(), d.restart_count), ("running", Some("healthy"), 2));
        assert_eq!(d.restart_policy, "unless-stopped");
        // Only the first `=` splits: a value may contain more.
        assert_eq!(d.env[0], ("LAB_TOKEN".into(), "s3cret=value".into()));
        assert_eq!(d.env[2], ("EMPTY".into(), String::new()));
        assert_eq!(d.labels, vec![("a".into(), "1".into()), ("b".into(), "2".into())]);
        assert_eq!(d.mounts[0].name.as_deref(), Some("lab-data"));
        assert_eq!((d.mounts[1].kind.as_str(), d.mounts[1].rw, d.mounts[1].name.as_deref()), ("bind", false, None));
        assert_eq!(d.networks, vec![("lab-net".into(), "172.18.0.2".into())]);
        let ports: Vec<(&str, &str)> = d.ports.iter().map(|p| (p.container.as_str(), p.host.as_str())).collect();
        assert_eq!(ports, vec![("443/tcp", ""), ("80/tcp", "127.0.0.1:8088"), ("80/tcp", "[::1]:8088")]);

        assert!(parse_inspect("Error: No such object: nope").is_err());
        assert!(parse_inspect("[]").is_err());
    }

    #[test]
    fn images_volumes_networks_parse() {
        let images = parse_images(
            r#"{"Containers":"0","CreatedAt":"2026-05-13 02:21:49 +0000 UTC","CreatedSince":"6 months ago","Digest":"<none>","ID":"sha256:a46257e0","Repository":"busybox","SharedSize":"N/A","Size":"6.81MB","Tag":"latest","UniqueSize":"N/A"}"#,
        );
        assert_eq!((images[0].repository.as_str(), images[0].tag.as_str(), images[0].size), ("busybox", "latest", 6_810_000));

        let ls = r#"{"Driver":"local","Links":"N/A","Mountpoint":"/var/lib/docker/volumes/lab-data/_data","Name":"lab-data","Size":"N/A"}
{"Driver":"local","Links":"N/A","Mountpoint":"/var/lib/docker/volumes/lab-orphan/_data","Name":"lab-orphan","Size":"N/A"}"#;
        let df = r#"{"Images":[],"Containers":[],"Volumes":[{"Driver":"local","Links":"1","Name":"lab-data","Size":"12.5MB"},{"Links":0,"Name":"lab-orphan","Size":"0B"}],"BuildCache":[]}"#;
        let v = parse_volumes(ls, df);
        assert_eq!((v[0].name.as_str(), v[0].size, v[0].links), ("lab-data", Some(12_500_000), Some(1)));
        assert_eq!((v[1].size, v[1].links), (Some(0), Some(0)));
        // Without the verbose listing the volumes still show, sizes unknown.
        let bare = parse_volumes(ls, "docker: unknown flag");
        assert_eq!((bare.len(), bare[0].size, bare[0].links), (2, None, None));

        let n = parse_networks(
            r#"{"Driver":"bridge","ID":"n2","Name":"lab-net","Scope":"local"}
{"Driver":"bridge","ID":"n1","Name":"bridge","Scope":"local"}"#,
        );
        assert_eq!((n[0].name.as_str(), n[0].builtin), ("bridge", true));
        assert_eq!((n[1].name.as_str(), n[1].builtin), ("lab-net", false));

        let du: Vec<DiskUse> = parse_json_lines(
            r#"{"Active":"1","Reclaimable":"13.63kB (0%)","Size":"6.823MB","TotalCount":"1","Type":"Images"}"#,
        );
        assert_eq!((du[0].kind.as_str(), du[0].reclaimable.as_str()), ("Images", "13.63kB (0%)"));
    }

    #[test]
    fn hostile_names_never_reach_the_shell() {
        for bad in ["", "-rf", "a b", "x;reboot", "$(id)", "a'b", "a\nb", "../etc", "a|b", "`id`"] {
            assert!(!valid_name(bad), "{bad:?}");
            assert!(container_action_script("stop", bad).is_err(), "{bad:?}");
            assert!(remove_script("volume", bad).is_err(), "{bad:?}");
            assert!(logs_command(bad, 10, Elevate::None, true).is_err(), "{bad:?}");
        }
        assert!(valid_name("shop-web-1") && valid_name("3ab2fee06d52") && valid_name("my_vol.2"));
        assert!(valid_image_ref("sha256:a46257e0") && valid_image_ref("registry:5000/team/app:1.2"));
        assert!(!valid_image_ref("busybox; rm -rf /") && !valid_image_ref("-x"));
    }

    #[test]
    fn scripts_are_what_the_ui_says_they_are() {
        assert_eq!(container_action_script("restart", "web").unwrap(), "docker restart 'web'");
        assert_eq!(container_action_script("remove", "web").unwrap(), "docker rm -f 'web'");
        assert!(container_action_script("exec", "web").is_err());
        assert_eq!(remove_script("image", "sha256:ab").unwrap(), "docker rmi 'sha256:ab'");
        assert_eq!(remove_script("network", "lab-net").unwrap(), "docker network rm 'lab-net'");
        assert!(remove_script("network", "bridge").is_err(), "built-in networks stay");
        assert!(remove_script("container", "web").is_err());
        assert_eq!(prune_script("volumes").unwrap(), "docker volume prune -f");
        assert!(prune_script("system").is_err(), "no prune-everything");

        assert_eq!(
            logs_command("web", 200, Elevate::Sudo, true).unwrap().unwrap(),
            "exec sudo -n docker logs --follow --tail 200 --timestamps 'web' 2>&1"
        );
        assert_eq!(
            logs_command("web", 50, Elevate::None, false).unwrap().unwrap(),
            "docker logs --tail 50 --timestamps 'web' 2>&1"
        );
        // A stream can't answer sudo's prompt.
        assert_eq!(logs_command("web", 200, Elevate::Password, true).unwrap(), None);
    }

    #[test]
    fn access_errors_are_told_apart() {
        assert!(is_permission_error(
            "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock"
        ));
        assert!(!is_permission_error("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"));
        assert!(!is_permission_error("sh: 1: docker: not found"));
    }
}

/// Live checks against a real Docker host (Plan 31 verification). Ignored by
/// default; start `scripts/server-lab.yml`, run `lab-docker-up` in it, then:
///
/// ```text
/// FARO_LIVE_SFTP=127.0.0.1:2225:dock:lab-pass \
///   cargo test -p faro --lib docker::live_tests -- --ignored --nocapture --test-threads 1
/// ```
///
/// Run it as `dock` (docker group), `admin` (passwordless sudo) and `ops`
/// (sudo with a password) to cover every way of reaching the daemon.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::session::Session;
    use crate::stream_exec::{StreamKind, StreamManager};
    use std::sync::{Arc, Mutex};

    async fn ssh() -> Arc<SshSession> {
        let session = crate::transfer::live_tests::sftp_session().await.expect("FARO_LIVE_SFTP");
        let Session::Ssh(ssh) = &*session else { unreachable!() };
        ssh.clone()
    }

    /// The access mode and the elevation the UI would then use.
    async fn reach(ssh: &SshSession) -> (DockerAccess, Elevate) {
        let a = access(ssh).await.unwrap();
        let elevate = match a.mode.as_str() {
            "direct" => Elevate::None,
            "sudo" => Elevate::Sudo,
            _ => Elevate::Password,
        };
        (a, elevate)
    }

    async fn containers(ssh: &SshSession, e: Elevate) -> Vec<Container> {
        parse_containers(&read(ssh, PS_CMD, e).await.unwrap())
    }

    /// Run a docker command the lab needs for setup, as whoever we are.
    async fn sh(ssh: &SshSession, script: &str, e: Elevate) -> String {
        merged(&run_as_for(ssh, script, e, ACTION_TIMEOUT).await.unwrap())
    }

    #[tokio::test]
    #[ignore = "needs FARO_LIVE_SFTP pointing at the Docker lab host"]
    async fn live_lists_inspect_and_stats() {
        let ssh = ssh().await;
        let (a, e) = reach(&ssh).await;
        println!("access: {a:?} elevate: {e:?}");
        assert_ne!(a.mode, "unavailable", "{:?}", a.error);

        let list = containers(&ssh, e).await;
        println!("{} containers: {:?}", list.len(), list.iter().map(|c| (&c.name, &c.state)).collect::<Vec<_>>());
        let by = |name: &str| list.iter().find(|c| c.name == name).unwrap_or_else(|| panic!("{name} missing"));
        assert_eq!(by("lab-logger").state, "running");
        assert_eq!(by("lab-stopped").state, "exited");
        assert_eq!(by("shop-web-1").project.as_deref(), Some("shop"));
        assert_eq!(by("shop-db-1").service.as_deref(), Some("db"));
        assert!(by("lab-idle").mounts.iter().any(|m| m == "lab-data"), "{:?}", by("lab-idle").mounts);
        assert!(by("lab-idle").networks.contains(&"lab-net".to_string()));
        assert!(by("lab-idle").ports.contains("8088"), "{}", by("lab-idle").ports);
        assert_eq!(list[0].project.as_deref(), Some("shop"), "compose projects sort first");

        let stats = parse_stats(&read(&ssh, STATS_CMD, e).await.unwrap());
        let logger = stats.iter().find(|s| s.name == "lab-logger").expect("stats for lab-logger");
        println!("lab-logger stats: {logger:?}");
        assert!(logger.mem_used > 0 && logger.mem_limit > logger.mem_used && logger.pids >= 1);
        assert!(stats.iter().all(|s| s.name != "lab-stopped"), "stopped containers have no stats");

        let script = format!("docker inspect {}", checked("lab-idle").unwrap());
        let d = parse_inspect(&run_as(&ssh, &script, e).await.unwrap().stdout).unwrap();
        println!("inspect: {d:?}");
        assert_eq!((d.name.as_str(), d.status.as_str()), ("lab-idle", "running"));
        assert_eq!(d.command, "sleep infinity");
        assert_eq!(d.restart_policy, "unless-stopped");
        assert!(d.env.contains(&("LAB_TOKEN".into(), "s3cret-value".into())));
        assert!(d.mounts.iter().any(|m| m.kind == "volume" && m.name.as_deref() == Some("lab-data") && m.destination == "/data"));
        assert!(d.mounts.iter().any(|m| m.kind == "bind" && m.source == "/srv/lab-site" && !m.rw));
        assert!(d.ports.iter().any(|p| p.container == "80/tcp" && p.host == "127.0.0.1:8088"), "{:?}", d.ports);
        assert!(d.networks.iter().any(|(n, ip)| n == "lab-net" && !ip.is_empty()));

        let images = parse_images(&read(&ssh, "docker images --no-trunc --format '{{json .}}'", e).await.unwrap());
        assert!(images.iter().any(|i| i.repository == "busybox" && i.size > 0), "{images:?}");
        let ls = read(&ssh, "docker volume ls --format '{{json .}}'", e).await.unwrap();
        let df = read(&ssh, "docker system df -v --format '{{json .}}'", e).await.unwrap_or_default();
        let volumes = parse_volumes(&ls, &df);
        println!("volumes: {volumes:?}");
        let vol = |n: &str| volumes.iter().find(|v| v.name == n).unwrap_or_else(|| panic!("{n} missing"));
        assert_eq!(vol("lab-data").links, Some(1), "the verbose listing should say who uses it");
        assert_eq!(vol("lab-orphan").links, Some(0));
        assert!(vol("lab-data").mountpoint.ends_with("/lab-data/_data"));
        let networks = parse_networks(&read(&ssh, "docker network ls --no-trunc --format '{{json .}}'", e).await.unwrap());
        assert!(networks.iter().any(|n| n.name == "lab-net" && !n.builtin));
        assert!(networks.iter().any(|n| n.name == "bridge" && n.builtin));
        let du: Vec<DiskUse> = parse_json_lines(&read(&ssh, "docker system df --format '{{json .}}'", e).await.unwrap());
        println!("disk use: {du:?}");
        assert!(du.iter().any(|d| d.kind == "Images") && du.iter().any(|d| d.kind == "Local Volumes"));
    }

    #[tokio::test]
    #[ignore = "needs FARO_LIVE_SFTP pointing at the Docker lab host"]
    async fn live_actions_and_removals() {
        let ssh = ssh().await;
        let (_, e) = reach(&ssh).await;
        sh(&ssh, "docker rm -f lab-tmp >/dev/null 2>&1; docker volume rm lab-tmpvol >/dev/null 2>&1; docker network rm lab-tmpnet >/dev/null 2>&1; true", e).await;
        let made = sh(&ssh, "docker run -d --name lab-tmp busybox sleep infinity && docker volume create lab-tmpvol && docker network create lab-tmpnet", e).await;
        println!("setup: {made}");
        let state = |list: &[Container]| list.iter().find(|c| c.name == "lab-tmp").map(|c| c.state.clone());

        assert_eq!(state(&containers(&ssh, e).await).as_deref(), Some("running"));
        for (action, want) in [("pause", "paused"), ("unpause", "running"), ("kill", "exited"), ("start", "running"), ("restart", "running"), ("stop", "exited")] {
            let res = act(&ssh, &container_action_script(action, "lab-tmp").unwrap(), e).await.unwrap();
            assert!(res.ok, "{action}: {}", res.output);
            assert_eq!(state(&containers(&ssh, e).await).as_deref(), Some(want), "after {action}");
        }
        // A running container is removed too: the UI confirmed, so it forces.
        act(&ssh, &container_action_script("start", "lab-tmp").unwrap(), e).await.unwrap();
        let res = act(&ssh, &container_action_script("remove", "lab-tmp").unwrap(), e).await.unwrap();
        assert!(res.ok, "{}", res.output);
        assert_eq!(state(&containers(&ssh, e).await), None, "the container is gone");

        // Docker's own refusal comes back as a failed action, not an error.
        let refused = act(&ssh, &remove_script("volume", "lab-data").unwrap(), e).await.unwrap();
        println!("removing a volume in use: {}", refused.output);
        assert!(!refused.ok && refused.output.contains("in use"), "{}", refused.output);

        for (kind, id) in [("volume", "lab-tmpvol"), ("network", "lab-tmpnet")] {
            let res = act(&ssh, &remove_script(kind, id).unwrap(), e).await.unwrap();
            assert!(res.ok, "{kind}: {}", res.output);
        }
        let left = sh(&ssh, "docker volume ls -q; docker network ls --format '{{.Name}}'", e).await;
        assert!(!left.contains("lab-tmpvol") && !left.contains("lab-tmpnet"), "{left}");
    }

    #[tokio::test]
    #[ignore = "needs FARO_LIVE_SFTP pointing at the Docker lab host"]
    async fn live_log_follow_streams_and_dies_when_stopped() {
        let ssh = ssh().await;
        let (a, e) = reach(&ssh).await;
        let followers = "pgrep -fc 'docker logs --follo[w]' || true";
        let count = |ssh: Arc<SshSession>| async move {
            run_as(&ssh, followers, Elevate::None).await.unwrap().stdout.trim().parse::<usize>().unwrap_or(0)
        };

        let Some(command) = logs_command("lab-logger", 5, e, true).unwrap() else {
            // sudo with a password: no follow, the tail still works.
            assert_eq!(a.mode, "needsRoot");
            let tail = logs_command("lab-logger", 20, e, false).unwrap().unwrap();
            let text = merged(&run_as(&ssh, &tail, e).await.unwrap());
            println!("tail (no follow on this host):\n{text}");
            assert!(text.contains("tick") && text.contains("warn"), "{text}");
            return;
        };
        assert_eq!(count(ssh.clone()).await, 0, "a follow from an earlier run is still alive");

        let streams = StreamManager::new();
        let lines: Arc<Mutex<Vec<String>>> = Arc::default();
        let sink = lines.clone();
        let id = streams
            .start(ssh.clone(), StreamKind::Follow, &command, e == Elevate::Sudo, move |l| sink.lock().unwrap().push(l.to_string()), |_| {})
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(3500)).await;
        let got = lines.lock().unwrap().clone();
        println!("{} lines, last: {:?}", got.len(), got.last());
        // 5 lines of tail plus about one of each stream per second.
        assert!(got.len() >= 8, "expected the tail and live lines, got {}", got.len());
        assert!(got.iter().any(|l| l.contains("tick")) && got.iter().any(|l| l.contains("warn")), "both streams");
        assert!(got[0].starts_with("20"), "lines carry timestamps: {}", got[0]);
        // One `docker logs`, plus the `sudo` in front of it when elevated.
        let want = if e == Elevate::Sudo { 2 } else { 1 };
        assert_eq!(count(ssh.clone()).await, want, "follower processes on the host");

        streams.stop(&id).await;
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert_eq!(count(ssh.clone()).await, 0, "the follower outlived its stream ({:?})", a.mode);
        let frozen = lines.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(lines.lock().unwrap().len(), frozen, "lines kept arriving after stop");
    }

    /// Regression: stopping a follow that runs under sudo once ran
    /// `sudo kill -TERM -<pgid>`, which the procps `kill` binary reads as pid
    /// -1 — it took down every process on the host. The container here is
    /// quiet, so the follower can only end by being signalled, and the Docker
    /// daemon plus an unrelated canary process must come through untouched.
    #[tokio::test]
    #[ignore = "needs FARO_LIVE_SFTP pointing at the Docker lab host"]
    async fn live_stopping_a_follow_signals_only_the_follower() {
        let ssh = ssh().await;
        let (a, e) = reach(&ssh).await;
        let Some(command) = logs_command("lab-idle", 5, e, true).unwrap() else {
            println!("no follow on this host ({}): nothing to stop", a.mode);
            return;
        };
        let one = |ssh: Arc<SshSession>, script: &'static str| async move {
            run_as(&ssh, script, Elevate::None).await.unwrap().stdout.trim().to_string()
        };
        // An unrelated process of the same user, in its own session.
        one(ssh.clone(), "setsid sleep 7654 >/dev/null 2>&1 &").await;
        let canary = "pgrep -fc 'sleep 765[4]' || true";
        let daemon = "pidof dockerd; systemctl show -p ActiveEnterTimestamp --value docker";
        let followers = "pgrep -fc 'docker logs --follo[w]' || true";
        assert_eq!(one(ssh.clone(), canary).await, "1");
        let daemon_before = one(ssh.clone(), daemon).await;
        assert!(!daemon_before.is_empty());

        let streams = StreamManager::new();
        let id = streams
            .start(ssh.clone(), StreamKind::Follow, &command, e == Elevate::Sudo, |_| {}, |_| {})
            .await
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_ne!(one(ssh.clone(), followers).await, "0", "the follower should be running");

        streams.stop(&id).await;
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(one(ssh.clone(), followers).await, "0", "a quiet follower must be killed, not left to linger");
        assert_eq!(one(ssh.clone(), canary).await, "1", "stopping the follow signalled an unrelated process");
        assert_eq!(one(ssh.clone(), daemon).await, daemon_before, "stopping the follow disturbed the Docker daemon");
        assert_eq!(state_of(&ssh, e, "lab-logger").await, "running", "other containers must keep running");

        one(ssh.clone(), "pkill -f 'sleep 765[4]' || true").await;
    }

    async fn state_of(ssh: &SshSession, e: Elevate, name: &str) -> String {
        containers(ssh, e).await.iter().find(|c| c.name == name).map(|c| c.state.clone()).unwrap_or_default()
    }
}
