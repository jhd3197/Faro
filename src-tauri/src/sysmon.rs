//! Server view backend (Plan 30): what a Linux host is doing right now, read
//! over the SSH session the connection already has. Nothing is installed on
//! the host.
//!
//! - [`sysmon_probe`] learns once per session what the host offers, so the UI
//!   hides what cannot work there.
//! - [`sysmon_start`] runs one long-lived sampler loop on a
//!   [`crate::stream_exec`] stream. It prints framed `/proc` snapshots; the
//!   parsers here turn consecutive snapshots into rates, emitted as
//!   `sysmon://sample`.
//! - Disks, services, listening ports and the firewall are one-shot execs.
//!
//! Everything that reads command output is a pure function over `&str` with
//! tests at the bottom, because the output differs between distributions.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::cf_setup::sh_quote;
use crate::session::{ExecOutput, SshSession};
use crate::stream_exec::StreamKind;
use crate::AppState;

/// sbin directories a non-login exec often lacks, where `ss`, `ufw`, `nft`
/// and friends live.
const PATH_PREFIX: &str = "PATH=\"$PATH:/usr/local/sbin:/usr/sbin:/sbin\"; export PATH; ";

const SHORT: Duration = Duration::from_secs(20);
const OUTPUT_CAP: usize = 2 << 20;

// ---------- probe ----------

/// What one host offers. Cached per session by the frontend.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostProbe {
    pub os: String,
    pub kernel: String,
    pub hostname: String,
    pub distro: String,
    /// `/proc/stat` is readable: live metrics work.
    pub proc: bool,
    /// systemd is PID 1 and `systemctl` is on PATH.
    pub systemd: bool,
    pub docker: bool,
    /// `ss` or `netstat`, whichever lists sockets here.
    pub ports: Option<String>,
    /// Firewall front ends present, most specific first.
    pub firewall: Vec<String>,
    /// `root` (already root), `sudo` (passwordless), `password` (sudo asks)
    /// or `none` (no sudo).
    pub root: String,
    /// The connection logged in with a password Faro could hand to sudo.
    pub has_password: bool,
}

const PROBE_SCRIPT: &str = r#"
echo "os=$(uname -s 2>/dev/null)"
echo "kernel=$(uname -r 2>/dev/null)"
echo "hostname=$(hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null)"
if [ -r /etc/os-release ]; then . /etc/os-release; echo "distro=$PRETTY_NAME"; fi
[ -r /proc/stat ] && echo proc=1
[ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && echo systemd=1
command -v docker >/dev/null 2>&1 && echo docker=1
if command -v ss >/dev/null 2>&1; then echo ports=ss
elif command -v netstat >/dev/null 2>&1; then echo ports=netstat; fi
command -v ufw >/dev/null 2>&1 && echo fw=ufw
command -v firewall-cmd >/dev/null 2>&1 && echo fw=firewalld
command -v nft >/dev/null 2>&1 && echo fw=nft
command -v iptables >/dev/null 2>&1 && echo fw=iptables
if [ "$(id -u 2>/dev/null)" = 0 ]; then echo root=root
elif ! command -v sudo >/dev/null 2>&1; then echo root=none
elif sudo -n true >/dev/null 2>&1; then echo root=sudo
else echo root=password; fi
true
"#;

fn parse_probe(out: &str) -> HostProbe {
    let mut p = HostProbe { root: "none".into(), ..Default::default() };
    for line in out.lines() {
        let Some((k, v)) = line.trim().split_once('=') else { continue };
        let v = v.trim();
        match k {
            "os" => p.os = v.into(),
            "kernel" => p.kernel = v.into(),
            "hostname" => p.hostname = v.into(),
            "distro" => p.distro = v.into(),
            "proc" => p.proc = v == "1",
            "systemd" => p.systemd = v == "1",
            "docker" => p.docker = v == "1",
            "ports" if !v.is_empty() => p.ports = Some(v.into()),
            "fw" if !v.is_empty() => p.firewall.push(v.into()),
            "root" if !v.is_empty() => p.root = v.into(),
            _ => {}
        }
    }
    p
}

// ---------- sampler: /proc parsing ----------

#[derive(Debug, Clone, Copy, Default, PartialEq)]
struct CpuTimes {
    /// user + nice + system + idle + iowait + irq + softirq + steal.
    total: u64,
    /// idle + iowait.
    idle: u64,
    iowait: u64,
}

#[derive(Debug, Clone, Default, PartialEq)]
struct NetCounter {
    name: String,
    rx: u64,
    tx: u64,
}

/// One raw `/proc` snapshot. Memory figures are kB as the kernel prints them.
#[derive(Debug, Clone, Default, PartialEq)]
struct RawSample {
    uptime: f64,
    cpu: CpuTimes,
    cores: Vec<CpuTimes>,
    mem_total: u64,
    mem_available: u64,
    swap_total: u64,
    swap_free: u64,
    load: [f32; 3],
    net: Vec<NetCounter>,
}

/// `cpu  …` (aggregate, index `None`) or `cpuN …` from `/proc/stat`.
fn parse_cpu_line(line: &str) -> Option<(Option<usize>, CpuTimes)> {
    let mut it = line.split_whitespace();
    let label = it.next()?.strip_prefix("cpu")?;
    let index = if label.is_empty() { None } else { Some(label.parse().ok()?) };
    let f: Vec<u64> = it.take(8).filter_map(|v| v.parse().ok()).collect();
    if f.len() < 4 {
        return None;
    }
    let iowait = f.get(4).copied().unwrap_or(0);
    Some((index, CpuTimes { total: f.iter().sum(), idle: f[3] + iowait, iowait }))
}

/// `  eth0: <rx bytes> … (8 rx fields) <tx bytes> …` from `/proc/net/dev`.
/// The two header lines have no colon and are skipped.
fn parse_net_line(line: &str) -> Option<NetCounter> {
    let (name, rest) = line.split_once(':')?;
    let f: Vec<u64> = rest.split_whitespace().filter_map(|v| v.parse().ok()).collect();
    if f.len() < 9 {
        return None;
    }
    Some(NetCounter { name: name.trim().to_string(), rx: f[0], tx: f[8] })
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
enum Section {
    #[default]
    None,
    Head,
    Mem,
    Load,
    Net,
}

/// Assembles the sampler loop's framed output into [`RawSample`]s. Lines it
/// doesn't recognise are skipped, never fatal.
#[derive(Default)]
struct BlockParser {
    section: Section,
    cur: RawSample,
    uptime_seen: bool,
    mem_free: u64,
    buffers: u64,
    cached: u64,
    reclaimable: u64,
    has_available: bool,
}

impl BlockParser {
    fn feed(&mut self, line: &str) -> Option<RawSample> {
        let line = line.trim();
        match line {
            "@@B" => {
                *self = Self { section: Section::Head, ..Default::default() };
                return None;
            }
            "@@M" => self.section = Section::Mem,
            "@@L" => self.section = Section::Load,
            "@@N" => self.section = Section::Net,
            "@@E" => {
                let done = self.section != Section::None && self.cur.cpu.total > 0;
                self.section = Section::None;
                if !done {
                    return None;
                }
                if !self.has_available {
                    self.cur.mem_available =
                        self.mem_free + self.buffers + self.cached + self.reclaimable;
                }
                return Some(std::mem::take(&mut self.cur));
            }
            _ => match self.section {
                Section::Head => self.head(line),
                Section::Mem => self.mem(line),
                Section::Load => {
                    let v: Vec<f32> =
                        line.split_whitespace().take(3).filter_map(|x| x.parse().ok()).collect();
                    if v.len() == 3 {
                        self.cur.load = [v[0], v[1], v[2]];
                    }
                }
                Section::Net => {
                    if let Some(n) = parse_net_line(line) {
                        self.cur.net.push(n);
                    }
                }
                Section::None => {}
            },
        }
        None
    }

    fn head(&mut self, line: &str) {
        if line.starts_with("cpu") {
            match parse_cpu_line(line) {
                Some((None, t)) => self.cur.cpu = t,
                Some((Some(_), t)) => self.cur.cores.push(t),
                None => {}
            }
        } else if !self.uptime_seen {
            if let Some(up) = line.split_whitespace().next().and_then(|v| v.parse().ok()) {
                self.cur.uptime = up;
                self.uptime_seen = true;
            }
        }
    }

    fn mem(&mut self, line: &str) {
        let Some((key, rest)) = line.split_once(':') else { return };
        let Some(kb) = rest.split_whitespace().next().and_then(|v| v.parse::<u64>().ok()) else {
            return;
        };
        match key {
            "MemTotal" => self.cur.mem_total = kb,
            "MemAvailable" => {
                self.cur.mem_available = kb;
                self.has_available = true;
            }
            "MemFree" => self.mem_free = kb,
            "Buffers" => self.buffers = kb,
            "Cached" => self.cached = kb,
            "SReclaimable" => self.reclaimable = kb,
            "SwapTotal" => self.cur.swap_total = kb,
            "SwapFree" => self.cur.swap_free = kb,
            _ => {}
        }
    }
}

// ---------- sampler: rates ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct IfaceRate {
    pub name: String,
    pub rx_bps: f64,
    pub tx_bps: f64,
}

/// One point on the Server view's charts. Rates are `None` on the first
/// sample, which has nothing to be compared with. Sizes are bytes.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub session_id: String,
    /// When Faro received it, Unix ms.
    pub t: i64,
    pub uptime_secs: f64,
    pub cpu_pct: Option<f32>,
    pub iowait_pct: Option<f32>,
    /// Per-core busy %, empty on the first sample.
    pub cores: Vec<f32>,
    pub mem_total: u64,
    pub mem_used: u64,
    pub mem_available: u64,
    pub swap_total: u64,
    pub swap_used: u64,
    pub load: [f32; 3],
    /// Bytes per second over the physical interfaces (see [`counts_in_total`]).
    pub rx_bps: Option<f64>,
    pub tx_bps: Option<f64>,
    pub ifaces: Vec<IfaceRate>,
}

/// Whether an interface belongs in the host total. Loopback is not network
/// traffic, and bridge / veth interfaces carry bytes that also cross a
/// physical interface, so counting them would double the figure.
fn counts_in_total(name: &str) -> bool {
    !(name == "lo"
        || name.starts_with("veth")
        || name.starts_with("docker")
        || name.starts_with("br-")
        || name.starts_with("virbr"))
}

fn busy_pct(prev: &CpuTimes, cur: &CpuTimes) -> f32 {
    let total = cur.total.saturating_sub(prev.total);
    if total == 0 {
        return 0.0;
    }
    let idle = cur.idle.saturating_sub(prev.idle).min(total);
    ((total - idle) as f64 / total as f64 * 100.0) as f32
}

/// Turn a snapshot (and the one before it) into a chart point.
fn derive(session_id: &str, t: i64, prev: Option<&RawSample>, cur: &RawSample) -> Sample {
    let mut s = Sample {
        session_id: session_id.to_string(),
        t,
        uptime_secs: cur.uptime,
        cpu_pct: None,
        iowait_pct: None,
        cores: Vec::new(),
        mem_total: cur.mem_total * 1024,
        mem_used: cur.mem_total.saturating_sub(cur.mem_available) * 1024,
        mem_available: cur.mem_available * 1024,
        swap_total: cur.swap_total * 1024,
        swap_used: cur.swap_total.saturating_sub(cur.swap_free) * 1024,
        load: cur.load,
        rx_bps: None,
        tx_bps: None,
        ifaces: Vec::new(),
    };
    let Some(prev) = prev else { return s };
    let dt = cur.uptime - prev.uptime;
    if dt <= 0.0 {
        return s;
    }

    s.cpu_pct = Some(busy_pct(&prev.cpu, &cur.cpu));
    let total = cur.cpu.total.saturating_sub(prev.cpu.total);
    if total > 0 {
        let io = cur.cpu.iowait.saturating_sub(prev.cpu.iowait).min(total);
        s.iowait_pct = Some((io as f64 / total as f64 * 100.0) as f32);
    }
    if prev.cores.len() == cur.cores.len() {
        s.cores = prev.cores.iter().zip(&cur.cores).map(|(p, c)| busy_pct(p, c)).collect();
    }

    let (mut rx, mut tx) = (0.0, 0.0);
    for n in &cur.net {
        if n.name == "lo" {
            continue;
        }
        let Some(p) = prev.net.iter().find(|p| p.name == n.name) else { continue };
        // A counter that went backwards wrapped or the interface was reset:
        // report nothing for this interval instead of a huge spike.
        if n.rx < p.rx || n.tx < p.tx {
            continue;
        }
        let rate = IfaceRate {
            name: n.name.clone(),
            rx_bps: (n.rx - p.rx) as f64 / dt,
            tx_bps: (n.tx - p.tx) as f64 / dt,
        };
        if counts_in_total(&n.name) {
            rx += rate.rx_bps;
            tx += rate.tx_bps;
        }
        s.ifaces.push(rate);
    }
    s.rx_bps = Some(rx);
    s.tx_bps = Some(tx);
    s
}

/// The loop the sampler stream runs. `/proc/uptime` is the sample clock, so
/// rates don't depend on network jitter or on `date` flags busybox lacks. The
/// loop ends on its own once nothing reads its output.
fn sampler_script(secs: u64) -> String {
    format!(
        "while :; do echo '@@B'; cat /proc/uptime; grep '^cpu' /proc/stat; \
         echo '@@M'; cat /proc/meminfo; echo '@@L'; cat /proc/loadavg; \
         echo '@@N'; cat /proc/net/dev; echo '@@E' || exit 0; sleep {secs}; done 2>/dev/null"
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EndedEvent {
    session_id: String,
    /// True when Faro stopped the sampler itself.
    stopped: bool,
    /// Why it ended otherwise, in words the view can show.
    reason: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ---------- one-shot helpers ----------

/// How to get root for a command. Chosen by the frontend from the probe:
/// already-root sessions need nothing, `sudo` is passwordless, and `password`
/// hands the connection's login password to sudo (the user confirms first).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Elevate {
    None,
    Sudo,
    Password,
}

/// Run `script` under `sh`, as root when asked.
async fn run_as(ssh: &SshSession, script: &str, elevate: Elevate) -> Result<ExecOutput> {
    let quoted = sh_quote(&format!("{PATH_PREFIX}{script}"));
    match elevate {
        Elevate::None => ssh.exec_bounded(&format!("sh -c {quoted}"), OUTPUT_CAP, SHORT, None).await,
        Elevate::Sudo => {
            ssh.exec_bounded(&format!("sudo -n sh -c {quoted}"), OUTPUT_CAP, SHORT, None).await
        }
        Elevate::Password => {
            let pw = crate::bridge::connection_password(ssh)
                .filter(|p| !p.is_empty())
                .ok_or_else(|| anyhow!("sudo needs a password and this connection has none saved"))?;
            let mut out = ssh
                .exec_sudo(&format!("sudo sh -c {quoted}"), &pw, OUTPUT_CAP, SHORT, None)
                .await?;
            // A PTY turns every newline into CRLF.
            out.stdout = out.stdout.replace("\r\n", "\n");
            Ok(out)
        }
    }
}

/// Run a read as root when asked, but fall back to the plain user if that
/// fails (not in sudoers, wrong password), so a refused sudo shows less
/// instead of nothing. The note says why the result is the unprivileged one.
async fn run_read(ssh: &SshSession, script: &str, elevate: Elevate) -> Result<(ExecOutput, Option<String>)> {
    let out = run_as(ssh, script, elevate).await?;
    if elevate == Elevate::None || out.exit_code == Some(0) {
        return Ok((out, None));
    }
    let why = merged(&out).lines().find(|l| !l.trim().is_empty()).unwrap_or("sudo failed").trim().to_string();
    let plain = run_as(ssh, script, Elevate::None).await?;
    Ok((plain, Some(format!("sudo did not run this ({why}); showing what this user can see."))))
}

fn merged(out: &ExecOutput) -> String {
    [out.stdout.trim_end(), out.stderr.trim_end()]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

async fn ssh_for(state: &State<'_, AppState>, session_id: &str) -> Result<std::sync::Arc<SshSession>, String> {
    state
        .sessions
        .get_ssh(session_id)
        .await
        .ok_or_else(|| "Server view needs an SSH connection".to_string())
}

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

// ---------- disks ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiskRow {
    pub filesystem: String,
    pub mount: String,
    pub total: u64,
    pub used: u64,
    pub available: u64,
}

/// `df -P -k` rows for real filesystems. Pseudo filesystems (tmpfs, snap
/// loop mounts, …) say nothing about disk space and are dropped.
fn parse_df(out: &str) -> Vec<DiskRow> {
    let mut rows = Vec::new();
    for line in out.lines().skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 6 {
            continue;
        }
        let (Ok(total), Ok(used), Ok(avail)) =
            (f[1].parse::<u64>(), f[2].parse::<u64>(), f[3].parse::<u64>())
        else {
            continue;
        };
        let fs = f[0];
        let mount = f[5..].join(" ");
        let pseudo = total == 0
            || matches!(fs, "tmpfs" | "devtmpfs" | "udev" | "none" | "shm" | "efivarfs" | "run" | "dev")
            || matches!(mount.as_str(), "/etc/hosts" | "/etc/hostname" | "/etc/resolv.conf")
            || mount.starts_with("/snap/")
            || mount.starts_with("/sys")
            || mount.starts_with("/proc")
            || mount.starts_with("/dev/")
            || mount.starts_with("/run/");
        if pseudo {
            continue;
        }
        rows.push(DiskRow {
            filesystem: fs.to_string(),
            mount,
            total: total * 1024,
            used: used * 1024,
            available: avail * 1024,
        });
    }
    rows
}

// ---------- services ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceUnit {
    pub unit: String,
    pub load: String,
    pub active: String,
    pub sub: String,
    pub description: String,
}

/// Rows of `systemctl list-units --type=service --all --no-legend --plain`,
/// failed units first, then running, then the rest, each group by name.
fn parse_units(out: &str) -> Vec<ServiceUnit> {
    let mut units: Vec<ServiceUnit> = out
        .lines()
        .filter_map(|line| {
            // Without `--plain` a failed unit is prefixed with a bullet.
            let line = line.trim_start().trim_start_matches(['●', '*', '×']).trim_start();
            let mut it = line.split_whitespace();
            let unit = it.next()?;
            if !unit.contains('.') {
                return None;
            }
            let (load, active, sub) = (it.next()?, it.next()?, it.next()?);
            Some(ServiceUnit {
                unit: unit.to_string(),
                load: load.to_string(),
                active: active.to_string(),
                sub: sub.to_string(),
                description: it.collect::<Vec<_>>().join(" "),
            })
        })
        .collect();
    let rank = |u: &ServiceUnit| match (u.active.as_str(), u.sub.as_str()) {
        ("failed", _) => 0,
        (_, "running") => 1,
        ("active", _) => 2,
        _ => 3,
    };
    units.sort_by(|a, b| rank(a).cmp(&rank(b)).then_with(|| a.unit.cmp(&b.unit)));
    units
}

/// A unit name safe to put on a command line: systemd's own character set.
fn valid_unit(unit: &str) -> bool {
    !unit.is_empty()
        && unit.len() <= 256
        && !unit.starts_with('-')
        && unit.chars().all(|c| c.is_ascii_alphanumeric() || "@_.:-\\".contains(c))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub ok: bool,
    pub output: String,
}

// ---------- listening ports ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ListeningPort {
    pub proto: String,
    pub address: String,
    pub port: u32,
    /// Empty when the socket belongs to another user and we aren't root.
    pub process: String,
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortsReport {
    pub ports: Vec<ListeningPort>,
    /// Set when root was asked for but the list is the plain user's view.
    pub note: Option<String>,
}

/// List listening sockets with `ss` or `netstat`.
async fn read_ports(ssh: &SshSession, tool: &str, elevate: Elevate) -> Result<PortsReport> {
    let (script, parse): (&str, fn(&str) -> Vec<ListeningPort>) = match tool {
        "ss" => ("ss -H -tulnp", parse_ss),
        "netstat" => ("netstat -tulnp 2>/dev/null", parse_netstat),
        other => bail!("unknown socket tool {other}"),
    };
    let (out, note) = run_read(ssh, script, elevate).await?;
    if out.exit_code != Some(0) && out.stdout.trim().is_empty() {
        bail!("{}", merged(&out));
    }
    Ok(PortsReport { ports: parse(&out.stdout), note })
}

/// The last `lines` journal lines for one unit.
async fn read_unit_logs(ssh: &SshSession, unit: &str, lines: u32, elevate: Elevate) -> Result<String> {
    let script = format!("journalctl -u {} -n {lines} --no-pager -o short-iso 2>&1", sh_quote(unit));
    let (out, note) = run_read(ssh, &script, elevate).await?;
    let text = merged(&out);
    Ok(match note {
        Some(n) => format!("[{n}]\n{text}"),
        None => text,
    })
}

/// `0.0.0.0:22`, `[::]:22`, `*:80`, `127.0.0.53%lo:53` → (address, port).
fn split_addr_port(s: &str) -> Option<(String, u32)> {
    let (addr, port) = s.rsplit_once(':')?;
    let port = port.parse().ok()?;
    Some((addr.trim_matches(['[', ']']).to_string(), port))
}

/// `ss -H -tulnp` rows.
fn parse_ss(out: &str) -> Vec<ListeningPort> {
    let mut ports = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 5 || !matches!(f[0], "tcp" | "udp") {
            continue;
        }
        let Some((address, port)) = split_addr_port(f[4]) else { continue };
        // users:(("sshd",pid=812,fd=3),("sshd",pid=813,fd=3))
        let users = f[5..].join(" ");
        let process = users
            .split_once("((\"")
            .and_then(|(_, r)| r.split_once('"'))
            .map(|(name, _)| name.to_string())
            .unwrap_or_default();
        let pid = users
            .split_once("pid=")
            .and_then(|(_, r)| r.split(|c: char| !c.is_ascii_digit()).next())
            .and_then(|d| d.parse().ok());
        ports.push(ListeningPort { proto: f[0].to_string(), address, port, process, pid });
    }
    sort_ports(&mut ports);
    ports
}

/// `netstat -tulnp` rows (net-tools and busybox).
fn parse_netstat(out: &str) -> Vec<ListeningPort> {
    let mut ports = Vec::new();
    for line in out.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 5 {
            continue;
        }
        let proto = match f[0] {
            p if p.starts_with("tcp") => "tcp",
            p if p.starts_with("udp") => "udp",
            _ => continue,
        };
        let Some((address, port)) = split_addr_port(f[3]) else { continue };
        // Last column is `812/sshd` or `-`.
        let (pid, process) = match f.last().and_then(|l| l.split_once('/')) {
            Some((pid, name)) => (pid.parse().ok(), name.to_string()),
            None => (None, String::new()),
        };
        ports.push(ListeningPort { proto: proto.to_string(), address, port, process, pid });
    }
    sort_ports(&mut ports);
    ports
}

fn sort_ports(ports: &mut Vec<ListeningPort>) {
    ports.sort_by(|a, b| {
        a.port.cmp(&b.port).then_with(|| a.proto.cmp(&b.proto)).then_with(|| a.address.cmp(&b.address))
    });
    ports.dedup();
}

// ---------- firewall (read-only) ----------

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FirewallRule {
    pub to: String,
    pub action: String,
    pub from: String,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FirewallReport {
    pub tool: String,
    /// Whether the firewall is on, when the tool says so.
    pub active: Option<bool>,
    /// Defaults and zone facts, as label / value pairs.
    pub summary: Vec<(String, String)>,
    /// Parsed rules (ufw, firewalld). Empty for nft / iptables: read `raw`.
    pub rules: Vec<FirewallRule>,
    pub raw: String,
    /// The command failed; `raw` holds what it said.
    pub failed: bool,
}

/// Split a row on runs of two or more spaces (ufw's column separator).
fn split_columns(line: &str) -> Vec<String> {
    let mut cols = Vec::new();
    let mut cur = String::new();
    let mut spaces = 0;
    for c in line.trim().chars() {
        if c == ' ' {
            spaces += 1;
            continue;
        }
        if spaces >= 2 && !cur.is_empty() {
            cols.push(std::mem::take(&mut cur));
        } else if spaces == 1 {
            cur.push(' ');
        }
        spaces = 0;
        cur.push(c);
    }
    if !cur.is_empty() {
        cols.push(cur);
    }
    cols
}

fn parse_ufw(out: &str, report: &mut FirewallReport) {
    let mut in_rules = false;
    for line in out.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if in_rules {
            let cols = split_columns(t);
            if cols.len() >= 3 {
                report.rules.push(FirewallRule {
                    to: cols[0].clone(),
                    action: cols[1].clone(),
                    from: cols[2..].join("  "),
                });
            }
        } else if t.starts_with("--") {
            in_rules = true;
        } else if let Some((k, v)) = t.split_once(':') {
            let v = v.trim();
            if k == "Status" {
                report.active = Some(v == "active");
            } else if matches!(k, "Default" | "Logging" | "New profiles") {
                report.summary.push((k.to_string(), v.to_string()));
            }
        }
    }
}

/// `firewall-cmd --state`, a `@@` line, then `firewall-cmd --list-all`.
fn parse_firewalld(out: &str, report: &mut FirewallReport) {
    let (state, list) = out.split_once("@@").unwrap_or((out, ""));
    report.active = Some(state.trim() == "running");
    if report.active != Some(true) {
        return; // `--list-all` only printed an error
    }
    let mut zone = String::new();
    let mut in_rich = false;
    for line in list.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if !line.starts_with([' ', '\t']) {
            zone = t.to_string();
            report.summary.push(("Zone".into(), zone.clone()));
            continue;
        }
        if in_rich && t.starts_with("rule ") {
            report.rules.push(FirewallRule { to: t.to_string(), action: "rich rule".into(), from: zone.clone() });
            continue;
        }
        let Some((k, v)) = t.split_once(':') else { continue };
        let v = v.trim();
        in_rich = k == "rich rules";
        match k {
            "services" | "ports" | "protocols" | "source-ports" => {
                for item in v.split_whitespace() {
                    report.rules.push(FirewallRule {
                        to: item.to_string(),
                        action: "allow".into(),
                        from: zone.clone(),
                    });
                }
            }
            "target" | "interfaces" | "sources" | "forward-ports" | "masquerade" | "icmp-blocks"
                if !v.is_empty() =>
            {
                report.summary.push((k.to_string(), v.to_string()));
            }
            _ => {}
        }
    }
}

fn firewall_script(tool: &str) -> Result<&'static str> {
    Ok(match tool {
        "ufw" => "ufw status verbose",
        "firewalld" => "firewall-cmd --state 2>&1; echo '@@'; firewall-cmd --list-all 2>&1",
        "nft" => "nft list ruleset",
        "iptables" => "iptables -S",
        other => bail!("unknown firewall tool {other}"),
    })
}

fn build_firewall_report(tool: &str, out: &ExecOutput) -> FirewallReport {
    let raw = merged(out);
    let mut report = FirewallReport { tool: tool.to_string(), raw, ..Default::default() };
    // firewalld's script ends on `--list-all`, whose status is the one we get.
    report.failed = out.exit_code != Some(0) && tool != "firewalld";
    if report.failed {
        return report;
    }
    match tool {
        "ufw" => parse_ufw(&out.stdout, &mut report),
        "firewalld" => parse_firewalld(&out.stdout, &mut report),
        _ => {}
    }
    report
}

// ---------- commands ----------

#[tauri::command]
pub async fn sysmon_probe(session_id: String, state: State<'_, AppState>) -> Result<HostProbe, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let out = run_as(&ssh, PROBE_SCRIPT, Elevate::None).await.map_err(err)?;
    let mut probe = parse_probe(&out.stdout);
    probe.has_password = crate::bridge::connection_password(&ssh).is_some_and(|p| !p.is_empty());
    Ok(probe)
}

/// Start (or restart) this session's sampler. Samples arrive as
/// `sysmon://sample`; `sysmon://ended` says when and why it stopped.
#[tauri::command]
pub async fn sysmon_start(
    session_id: String,
    interval_ms: Option<u64>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let secs = (interval_ms.unwrap_or(2000) / 1000).clamp(1, 30);

    let mut parser = BlockParser::default();
    let mut prev: Option<RawSample> = None;
    let (line_app, line_sid) = (app.clone(), session_id.clone());
    let on_line = move |line: &str| {
        if let Some(raw) = parser.feed(line) {
            let sample = derive(&line_sid, now_ms(), prev.as_ref(), &raw);
            prev = Some(raw);
            let _ = line_app.emit("sysmon://sample", sample);
        }
    };
    let end_sid = session_id.clone();
    let on_end = move |end: crate::stream_exec::StreamEnd| {
        let reason = if end.stopped {
            None
        } else if !end.stderr.is_empty() {
            Some(end.stderr)
        } else {
            Some(match end.exit_code {
                Some(code) => format!("the sampler exited with status {code}"),
                None => "the connection dropped".to_string(),
            })
        };
        let _ = app.emit(
            "sysmon://ended",
            EndedEvent { session_id: end_sid, stopped: end.stopped, reason },
        );
    };

    state
        .streams
        .start(ssh, StreamKind::Sampler, &sampler_script(secs), on_line, on_end)
        .await
        .map(|_| ())
        .map_err(|e| {
            let text = format!("{e:#}");
            // sshd refuses a channel past `MaxSessions`; say what to do about it.
            if text.to_lowercase().contains("open") && text.to_lowercase().contains("fail") {
                format!(
                    "The server refused another channel ({text}). It limits how many a \
                     connection can hold; close a terminal pane and try again."
                )
            } else {
                text
            }
        })
}

#[tauri::command]
pub async fn sysmon_stop(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.streams.stop_kind(&session_id, StreamKind::Sampler).await;
    Ok(())
}

#[tauri::command]
pub async fn sysmon_disks(session_id: String, state: State<'_, AppState>) -> Result<Vec<DiskRow>, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let out = run_as(&ssh, "df -P -k", Elevate::None).await.map_err(err)?;
    Ok(parse_df(&out.stdout))
}

#[tauri::command]
pub async fn sysmon_services(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<ServiceUnit>, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    let out = run_as(
        &ssh,
        "systemctl list-units --type=service --all --no-legend --no-pager --plain",
        Elevate::None,
    )
    .await
    .map_err(err)?;
    if out.exit_code != Some(0) && out.stdout.trim().is_empty() {
        return Err(merged(&out));
    }
    Ok(parse_units(&out.stdout))
}

/// Start, stop, restart or reload one unit.
#[tauri::command]
pub async fn sysmon_service_action(
    session_id: String,
    unit: String,
    action: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<ActionResult, String> {
    if !matches!(action.as_str(), "start" | "stop" | "restart" | "reload") {
        return Err(format!("unsupported action {action}"));
    }
    if !valid_unit(&unit) {
        return Err(format!("not a valid unit name: {unit}"));
    }
    let ssh = ssh_for(&state, &session_id).await?;
    let script = format!("systemctl {action} {}", sh_quote(&unit));
    let out = run_as(&ssh, &script, elevate).await.map_err(err)?;
    Ok(ActionResult { ok: out.exit_code == Some(0), output: merged(&out) })
}

/// The last `lines` journal lines for one unit.
#[tauri::command]
pub async fn sysmon_service_logs(
    session_id: String,
    unit: String,
    lines: Option<u32>,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<String, String> {
    if !valid_unit(&unit) {
        return Err(format!("not a valid unit name: {unit}"));
    }
    let ssh = ssh_for(&state, &session_id).await?;
    let n = lines.unwrap_or(200).clamp(1, 5000);
    read_unit_logs(&ssh, &unit, n, elevate).await.map_err(err)
}

#[tauri::command]
pub async fn sysmon_ports(
    session_id: String,
    tool: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<PortsReport, String> {
    let ssh = ssh_for(&state, &session_id).await?;
    read_ports(&ssh, &tool, elevate).await.map_err(err)
}

#[tauri::command]
pub async fn sysmon_firewall(
    session_id: String,
    tool: String,
    elevate: Elevate,
    state: State<'_, AppState>,
) -> Result<FirewallReport, String> {
    let script = firewall_script(&tool).map_err(err)?;
    let ssh = ssh_for(&state, &session_id).await?;
    let out = run_as(&ssh, script, elevate).await.map_err(err)?;
    Ok(build_firewall_report(&tool, &out))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_all(p: &mut BlockParser, text: &str) -> Vec<RawSample> {
        text.lines().filter_map(|l| p.feed(l)).collect()
    }

    const BLOCK_A: &str = "@@B
1000.00 3900.00
cpu  1000 0 500 8000 400 0 100 0 0 0
cpu0 600 0 300 3800 200 0 100 0 0 0
cpu1 400 0 200 4200 200 0 0 0 0 0
@@M
MemTotal:        8000000 kB
MemFree:         1000000 kB
MemAvailable:    6000000 kB
Buffers:          200000 kB
Cached:          3000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
@@L
0.50 0.40 0.30 2/345 6789
@@N
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 50 0 0 0 0 0 0 5000 50 0 0 0 0 0 0
  eth0: 100000 900 0 0 0 0 0 0 40000 700 0 0 0 0 0 0
veth1a: 7000 70 0 0 0 0 0 0 9000 90 0 0 0 0 0 0
@@E
";

    const BLOCK_B: &str = "@@B
1002.00 3903.00
cpu  1100 0 550 8250 400 0 100 0 0 0
cpu0 700 0 350 3850 200 0 100 0 0 0
cpu1 400 0 200 4400 200 0 0 0 0 0
@@M
MemTotal:        8000000 kB
MemAvailable:    5000000 kB
SwapTotal:       2000000 kB
SwapFree:        1500000 kB
@@L
0.60 0.42 0.31 3/345 6790
@@N
    lo: 9000 90 0 0 0 0 0 0 9000 90 0 0 0 0 0 0
  eth0: 300000 1900 0 0 0 0 0 0 60000 900 0 0 0 0 0 0
veth1a: 8000 80 0 0 0 0 0 0 9500 95 0 0 0 0 0 0
@@E
";

    #[test]
    fn block_parser_reads_a_snapshot() {
        let mut p = BlockParser::default();
        let got = feed_all(&mut p, BLOCK_A);
        assert_eq!(got.len(), 1);
        let s = &got[0];
        assert_eq!(s.uptime, 1000.0);
        assert_eq!(s.cpu, CpuTimes { total: 10000, idle: 8400, iowait: 400 });
        assert_eq!(s.cores.len(), 2);
        assert_eq!((s.mem_total, s.mem_available), (8_000_000, 6_000_000));
        assert_eq!((s.swap_total, s.swap_free), (2_000_000, 1_500_000));
        assert_eq!(s.load, [0.5, 0.4, 0.3]);
        assert_eq!(s.net.len(), 3);
        assert_eq!(s.net[1], NetCounter { name: "eth0".into(), rx: 100_000, tx: 40_000 });
    }

    #[test]
    fn rates_come_from_two_snapshots() {
        let mut p = BlockParser::default();
        let a = feed_all(&mut p, BLOCK_A).remove(0);
        let b = feed_all(&mut p, BLOCK_B).remove(0);

        let first = derive("s", 1, None, &a);
        assert_eq!(first.cpu_pct, None);
        assert_eq!(first.rx_bps, None);
        assert_eq!(first.mem_used, 2_000_000 * 1024);
        assert_eq!(first.swap_used, 500_000 * 1024);

        let s = derive("s", 2, Some(&a), &b);
        // 400 jiffies passed, 250 of them idle.
        assert_eq!(s.cpu_pct, Some(37.5));
        assert_eq!(s.iowait_pct, Some(0.0));
        assert_eq!(s.cores, vec![75.0, 0.0]);
        // eth0 only: loopback is skipped and veth is not in the total.
        assert_eq!(s.rx_bps, Some(100_000.0));
        assert_eq!(s.tx_bps, Some(10_000.0));
        assert_eq!(s.ifaces.len(), 2);
        assert_eq!(s.mem_used, 3_000_000 * 1024);
    }

    #[test]
    fn wrapped_counter_reports_nothing_instead_of_a_spike() {
        let mut p = BlockParser::default();
        let a = feed_all(&mut p, BLOCK_A).remove(0);
        let mut b = feed_all(&mut p, BLOCK_B).remove(0);
        b.net[1].rx = 10; // eth0 went backwards
        let s = derive("s", 2, Some(&a), &b);
        assert_eq!(s.rx_bps, Some(0.0));
        assert!(s.ifaces.iter().all(|i| i.name != "eth0"));
    }

    #[test]
    fn old_kernel_without_memavailable_estimates_it() {
        let block = "@@B\n10.0 1.0\ncpu  1 0 1 8 0 0 0 0\n@@M\nMemTotal: 1000 kB\nMemFree: 100 kB\n\
                     Buffers: 50 kB\nCached: 300 kB\nSReclaimable: 50 kB\n@@L\n0 0 0 1/1 1\n@@N\n@@E\n";
        let s = feed_all(&mut BlockParser::default(), block).remove(0);
        assert_eq!(s.mem_available, 500);
    }

    #[test]
    fn noise_and_a_torn_block_do_not_yield_a_sample() {
        let mut p = BlockParser::default();
        assert!(feed_all(&mut p, "garbage\n@@E\n@@B\n5.0 1.0\n@@M\n@@E\n").is_empty());
        // A block cut off by a restart is discarded when the next one begins.
        let torn = format!("@@B\n1.0 1.0\ncpu  9 9 9 9\n{BLOCK_A}");
        assert_eq!(feed_all(&mut p, &torn).len(), 1);
    }

    #[test]
    fn probe_output_maps_to_capabilities() {
        let p = parse_probe(
            "os=Linux\nkernel=6.8.0\nhostname=web-1\ndistro=Ubuntu 24.04 LTS\nproc=1\nsystemd=1\n\
             ports=ss\nfw=ufw\nfw=nft\nfw=iptables\nroot=sudo\n",
        );
        assert_eq!(p.os, "Linux");
        assert_eq!(p.distro, "Ubuntu 24.04 LTS");
        assert!(p.proc && p.systemd && !p.docker);
        assert_eq!(p.ports.as_deref(), Some("ss"));
        assert_eq!(p.firewall, vec!["ufw", "nft", "iptables"]);
        assert_eq!(p.root, "sudo");

        let bsd = parse_probe("os=FreeBSD\nkernel=14.0\nroot=none\n");
        assert!(!bsd.proc && !bsd.systemd && bsd.ports.is_none() && bsd.firewall.is_empty());
    }

    #[test]
    fn df_keeps_real_filesystems() {
        let out = "Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/sda1         41152736 12345678  26700000      32% /
tmpfs              4000000        0   4000000       0% /dev/shm
/dev/loop3           65536    65536         0     100% /snap/core20/2318
/dev/sdb1        103081248 51540624  46280000      53% /mnt/my data
overlay           41152736 12345678  26700000      32% /var/lib/docker/overlay2/abc/merged
/dev/sdd          41152736 12345678  26700000      32% /etc/hosts
";
        let rows = parse_df(out);
        let mounts: Vec<&str> = rows.iter().map(|r| r.mount.as_str()).collect();
        assert_eq!(mounts, vec!["/", "/mnt/my data", "/var/lib/docker/overlay2/abc/merged"]);
        assert_eq!(rows[0].total, 41_152_736 * 1024);
        assert_eq!(rows[0].used, 12_345_678 * 1024);
    }

    #[test]
    fn units_parse_and_failed_sort_first() {
        let out = "  cron.service            loaded active   running Regular background program processing daemon
  nginx.service           loaded failed   failed  A high performance web server
  apparmor.service        loaded active   exited  Load AppArmor profiles
● broken.service          not-found inactive dead   broken.service
  ssh.service             loaded active   running OpenBSD Secure Shell server
";
        let u = parse_units(out);
        let names: Vec<&str> = u.iter().map(|x| x.unit.as_str()).collect();
        assert_eq!(
            names,
            vec!["nginx.service", "cron.service", "ssh.service", "apparmor.service", "broken.service"]
        );
        assert_eq!(u[0].description, "A high performance web server");
        assert_eq!((u[4].load.as_str(), u[4].sub.as_str()), ("not-found", "dead"));
    }

    #[test]
    fn unit_names_are_validated() {
        assert!(valid_unit("nginx.service"));
        assert!(valid_unit("getty@tty1.service"));
        assert!(valid_unit("systemd-fsck@dev-disk-by\\x2duuid-1234.service"));
        for bad in ["", "-x.service", "a b.service", "x;reboot", "$(id).service", "a'b", "a\nb"] {
            assert!(!valid_unit(bad), "{bad:?}");
        }
    }

    #[test]
    fn ss_rows_parse() {
        let out = "udp   UNCONN 0      0      127.0.0.53%lo:53         0.0.0.0:*    users:((\"systemd-resolve\",pid=600,fd=13))
tcp   LISTEN 0      4096         0.0.0.0:22         0.0.0.0:*    users:((\"sshd\",pid=812,fd=3))
tcp   LISTEN 0      511                *:80               *:*    users:((\"nginx\",pid=901,fd=6),(\"nginx\",pid=900,fd=6))
tcp   LISTEN 0      4096            [::]:22            [::]:*
";
        let p = parse_ss(out);
        assert_eq!(p.len(), 4);
        assert_eq!(
            p[0],
            ListeningPort { proto: "tcp".into(), address: "0.0.0.0".into(), port: 22, process: "sshd".into(), pid: Some(812) }
        );
        // No `users:` column without root: the process stays blank.
        assert_eq!((p[1].address.as_str(), p[1].process.as_str(), p[1].pid), ("::", "", None));
        assert_eq!((p[2].port, p[2].proto.as_str(), p[2].process.as_str()), (53, "udp", "systemd-resolve"));
        assert_eq!((p[3].address.as_str(), p[3].port, p[3].pid), ("*", 80, Some(901)));
    }

    #[test]
    fn netstat_rows_parse() {
        let out = "Active Internet connections (only servers)
Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name
tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      812/sshd
tcp6       0      0 :::8080                 :::*                    LISTEN      -
udp        0      0 0.0.0.0:68              0.0.0.0:*                           600/dhclient
";
        let p = parse_netstat(out);
        assert_eq!(p.len(), 3);
        assert_eq!((p[0].port, p[0].process.as_str(), p[0].pid), (22, "sshd", Some(812)));
        assert_eq!((p[1].port, p[1].proto.as_str(), p[1].process.as_str()), (68, "udp", "dhclient"));
        assert_eq!((p[2].address.as_str(), p[2].port, p[2].pid), ("::", 8080, None));
    }

    fn out(stdout: &str, code: i32) -> ExecOutput {
        ExecOutput {
            stdout: stdout.into(),
            stderr: String::new(),
            exit_code: Some(code),
            truncated: false,
            timed_out: false,
            killed: false,
        }
    }

    #[test]
    fn ufw_report_parses_rules_and_defaults() {
        let text = "Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
80,443/tcp                 ALLOW IN    10.0.0.0/8
22/tcp (v6)                ALLOW IN    Anywhere (v6)
";
        let r = build_firewall_report("ufw", &out(text, 0));
        assert_eq!(r.active, Some(true));
        assert!(!r.failed);
        assert_eq!(r.summary[1], ("Default".into(), "deny (incoming), allow (outgoing), disabled (routed)".into()));
        assert_eq!(r.rules.len(), 3);
        assert_eq!(r.rules[1], FirewallRule { to: "80,443/tcp".into(), action: "ALLOW IN".into(), from: "10.0.0.0/8".into() });
        assert_eq!(r.rules[2].to, "22/tcp (v6)");

        let off = build_firewall_report("ufw", &out("Status: inactive\n", 0));
        assert_eq!((off.active, off.rules.len()), (Some(false), 0));
    }

    #[test]
    fn firewalld_report_parses_zone() {
        let text = "running
@@
public (active)
  target: default
  interfaces: eth0
  sources:
  services: dhcpv6-client ssh
  ports: 8080/tcp 9000-9010/udp
  masquerade: no
  rich rules:
\trule family=\"ipv4\" source address=\"10.0.0.5\" accept
";
        let r = build_firewall_report("firewalld", &out(text, 0));
        assert_eq!(r.active, Some(true));
        assert_eq!(r.summary[0], ("Zone".into(), "public (active)".into()));
        assert!(r.summary.contains(&("interfaces".into(), "eth0".into())));
        let tos: Vec<&str> = r.rules.iter().map(|x| x.to.as_str()).collect();
        assert_eq!(tos[..4], ["dhcpv6-client", "ssh", "8080/tcp", "9000-9010/udp"]);
        assert_eq!(r.rules[4].action, "rich rule");

        let down = build_firewall_report("firewalld", &out("not running\n@@\nFirewallD is not running\n", 252));
        assert_eq!(down.active, Some(false));
        assert!(down.rules.is_empty());
    }

    #[test]
    fn failed_firewall_read_keeps_the_message() {
        let r = build_firewall_report("ufw", &out("ERROR: You need to be root to run this script\n", 1));
        assert!(r.failed);
        assert!(r.raw.contains("need to be root"));
        assert!(firewall_script("rm -rf /").is_err());
    }

    #[test]
    fn sampler_script_uses_whole_seconds() {
        assert!(sampler_script(2).contains("sleep 2;"));
    }
}

/// Live checks against a real Linux host (Plan 30 verification). Ignored by
/// default; start `scripts/server-lab.yml`, then:
///
/// ```text
/// FARO_LIVE_SFTP=127.0.0.1:2225:admin:lab-pass FARO_LIVE_UNIT=lab-web.service \
///   cargo test -p faro --lib sysmon::live_tests -- --ignored --nocapture --test-threads 1
/// ```
///
/// `FARO_LIVE_UNIT` names a unit that is safe to restart; without it the
/// restart check is skipped.
#[cfg(test)]
mod live_tests {
    use super::*;
    use crate::session::Session;
    use crate::stream_exec::{StreamEnd, StreamManager};
    use std::sync::{Arc, Mutex};

    async fn ssh() -> Arc<SshSession> {
        let session = crate::transfer::live_tests::sftp_session().await.expect("FARO_LIVE_SFTP");
        let Session::Ssh(ssh) = &*session else { unreachable!() };
        ssh.clone()
    }

    /// How many sampler loops are running on the host right now.
    async fn loops(ssh: &SshSession) -> usize {
        // The bracket keeps pgrep from matching its own command line.
        let out = run_as(ssh, "pgrep -fc 'cat /proc/uptim[e]' || true", Elevate::None).await.unwrap();
        out.stdout.trim().parse().unwrap_or(0)
    }

    fn elevate_for(probe: &HostProbe) -> Elevate {
        match probe.root.as_str() {
            "sudo" => Elevate::Sudo,
            "password" if probe.has_password => Elevate::Password,
            _ => Elevate::None,
        }
    }

    async fn probe(ssh: &SshSession) -> HostProbe {
        let out = run_as(ssh, PROBE_SCRIPT, Elevate::None).await.unwrap();
        let mut p = parse_probe(&out.stdout);
        p.has_password = crate::bridge::connection_password(ssh).is_some();
        p
    }

    /// Start a sampler the way `sysmon_start` does, collecting instead of emitting.
    async fn start(
        streams: &StreamManager,
        ssh: &Arc<SshSession>,
        samples: &Arc<Mutex<Vec<Sample>>>,
        ended: &Arc<Mutex<Option<StreamEnd>>>,
    ) -> String {
        let (sink, end_sink) = (samples.clone(), ended.clone());
        let mut parser = BlockParser::default();
        let mut prev: Option<RawSample> = None;
        streams
            .start(
                ssh.clone(),
                StreamKind::Sampler,
                &sampler_script(1),
                move |line| {
                    if let Some(raw) = parser.feed(line) {
                        sink.lock().unwrap().push(derive("live", now_ms(), prev.as_ref(), &raw));
                        prev = Some(raw);
                    }
                },
                move |end| *end_sink.lock().unwrap() = Some(end),
            )
            .await
            .expect("start sampler")
    }

    #[tokio::test]
    #[ignore = "needs FARO_LIVE_SFTP pointing at a Linux host"]
    async fn live_sampler_streams_and_dies_when_stopped() {
        let ssh = ssh().await;
        let p = probe(&ssh).await;
        println!("probe: {p:?}");
        assert_eq!(p.os, "Linux");
        assert!(p.proc, "no /proc/stat on this host");
        assert_eq!(loops(&ssh).await, 0, "a sampler from an earlier run is still alive");

        let streams = StreamManager::new();
        let samples: Arc<Mutex<Vec<Sample>>> = Arc::default();
        let ended: Arc<Mutex<Option<StreamEnd>>> = Arc::default();

        let id = start(&streams, &ssh, &samples, &ended).await;
        tokio::time::sleep(Duration::from_millis(3600)).await;
        let got = samples.lock().unwrap().clone();
        println!("{} samples, last: {:?}", got.len(), got.last());
        assert!(got.len() >= 3, "expected a sample a second, got {}", got.len());
        assert_eq!(got[0].cpu_pct, None, "the first sample has nothing to compare with");
        let last = got.last().unwrap();
        let cpu = last.cpu_pct.expect("later samples carry a CPU figure");
        assert!((0.0..=100.0).contains(&cpu), "cpu {cpu}");
        assert!(!last.cores.is_empty() && last.cores.iter().all(|c| (0.0..=100.0).contains(c)));
        assert!(last.mem_total > 0 && last.mem_used <= last.mem_total);
        assert!(last.rx_bps.is_some() && last.uptime_secs > 0.0);
        assert_eq!(loops(&ssh).await, 1, "one loop on the host while sampling");

        // Starting again replaces the running sampler instead of adding one.
        let id2 = start(&streams, &ssh, &samples, &ended).await;
        assert_ne!(id, id2);
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(loops(&ssh).await, 1, "restart must not leave the old loop behind");

        // Stopping kills the remote loop, even though it is asleep right now.
        streams.stop(&id2).await;
        let end = ended.lock().unwrap().clone().expect("on_end ran");
        assert!(end.stopped, "{end:?}");
        assert_eq!(loops(&ssh).await, 0, "the sampler outlived its stream");
        let frozen = samples.lock().unwrap().len();
        tokio::time::sleep(Duration::from_millis(1500)).await;
        assert_eq!(samples.lock().unwrap().len(), frozen, "samples kept arriving after stop");

        // `stop_session` (what disconnect calls) does the same.
        start(&streams, &ssh, &samples, &ended).await;
        tokio::time::sleep(Duration::from_millis(1200)).await;
        assert_eq!(loops(&ssh).await, 1);
        streams.stop_session(&ssh.id).await;
        assert_eq!(loops(&ssh).await, 0, "stop_session left a sampler running");
    }

    #[tokio::test]
    #[ignore = "needs FARO_LIVE_SFTP pointing at a Linux host"]
    async fn live_disks_services_ports_firewall() {
        let ssh = ssh().await;
        let p = probe(&ssh).await;
        let elevate = elevate_for(&p);
        let root = elevate != Elevate::None || p.root == "root";
        println!("probe: {p:?}, elevate: {elevate:?}");

        let disks = parse_df(&run_as(&ssh, "df -P -k", Elevate::None).await.unwrap().stdout);
        println!("disks: {disks:?}");
        assert!(disks.iter().any(|d| d.mount == "/" && d.total > 0), "no root filesystem row");

        if p.systemd {
            let list = "systemctl list-units --type=service --all --no-legend --no-pager --plain";
            let units = parse_units(&run_as(&ssh, list, Elevate::None).await.unwrap().stdout);
            println!("{} units, first: {:?}", units.len(), units.first());
            assert!(units.len() > 3);
            assert!(units.iter().all(|u| valid_unit(&u.unit)), "a listed unit failed validation");

            if let Ok(unit) = std::env::var("FARO_LIVE_UNIT") {
                let show = format!("systemctl show -p MainPID --value {}", sh_quote(&unit));
                let before = run_as(&ssh, &show, Elevate::None).await.unwrap().stdout.trim().to_string();
                let restart = format!("systemctl restart {}", sh_quote(&unit));
                let out = run_as(&ssh, &restart, elevate).await.unwrap();
                assert_eq!(out.exit_code, Some(0), "restart failed: {}", merged(&out));
                let after = run_as(&ssh, &show, Elevate::None).await.unwrap().stdout.trim().to_string();
                println!("{unit}: MainPID {before} -> {after}");
                assert_ne!(before, after, "the unit kept its pid: it was not restarted");

                let text = read_unit_logs(&ssh, &unit, 20, elevate).await.unwrap();
                assert!(text.contains("Started") || text.contains("Stopped"), "journal: {text}");
            }
        }

        if let Some(tool) = p.ports.as_deref() {
            let report = read_ports(&ssh, tool, elevate).await.unwrap();
            println!("ports: {:?} note: {:?}", report.ports, report.note);
            assert!(!report.ports.is_empty(), "no listening sockets parsed");
            if root && report.note.is_none() {
                assert!(
                    report.ports.iter().any(|x| x.proto == "tcp" && x.process.contains("sshd")),
                    "root should see sshd's listening socket by name"
                );
            }
        }

        for tool in &p.firewall {
            let out = run_as(&ssh, firewall_script(tool).unwrap(), elevate).await.unwrap();
            let report = build_firewall_report(tool, &out);
            println!(
                "{tool}: active={:?} failed={} rules={} summary={:?}",
                report.active,
                report.failed,
                report.rules.len(),
                report.summary
            );
            if p.root == "root" || p.root == "sudo" {
                assert!(!report.failed, "{tool} could not be read as root: {}", report.raw);
            }
            if tool == "ufw" && report.active == Some(true) {
                assert!(!report.rules.is_empty(), "active ufw with no parsed rules:\n{}", report.raw);
            }
        }
    }
}
