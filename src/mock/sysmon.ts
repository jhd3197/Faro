// Mock of the Server view backend (Plan 30) for the demo build: a made-up
// Linux host whose sampler emits a steady, deterministic signal so the charts
// move and the headless tests can assert on them. Everything here is
// fictional.
import { emit } from "./event";

type Args = Record<string, any>;

const GB = 1024 ** 3;

/** What the UI asked the backend to do, for the tests to inspect. */
export const calls = {
  start: 0,
  stop: 0,
  actions: [] as { unit: string; action: string; elevate: string }[],
  reads: [] as { cmd: string; elevate: string }[],
};

/** Test hook: override parts of the next probe (e.g. `{ proc: false }`). */
let probeOverride: Record<string, unknown> = {};
export function setProbe(patch: Record<string, unknown>) {
  probeOverride = patch;
}

const timers = new Map<string, number>();
const ticks = new Map<string, number>();

function sample(sessionId: string) {
  const n = ticks.get(sessionId) ?? 0;
  ticks.set(sessionId, n + 1);
  const first = n === 0;
  const wave = (period: number, phase = 0) => (Math.sin((n + phase) / period) + 1) / 2;
  const cores = [0, 1, 2, 3].map((i) => 8 + wave(3 + i, i * 2) * 55);
  const rx = 40_000 + wave(4) * 900_000;
  const tx = 15_000 + wave(6, 3) * 240_000;
  emit("sysmon://sample", {
    sessionId,
    t: Date.now(),
    uptimeSecs: 1_234_567 + n * 2,
    cpuPct: first ? null : cores.reduce((a, b) => a + b, 0) / cores.length,
    iowaitPct: first ? null : wave(9) * 3,
    cores: first ? [] : cores,
    memTotal: 8 * GB,
    memUsed: (3.1 + wave(20) * 0.6) * GB,
    memAvailable: (4.9 - wave(20) * 0.6) * GB,
    swapTotal: 2 * GB,
    swapUsed: 0.2 * GB,
    load: [0.42 + wave(5), 0.38, 0.31],
    rxBps: first ? null : rx,
    txBps: first ? null : tx,
    ifaces: first
      ? []
      : [
          { name: "eth0", rxBps: rx, txBps: tx },
          { name: "docker0", rxBps: 1200, txBps: 900 },
        ],
  });
}

function stop(sessionId: string) {
  const id = timers.get(sessionId);
  if (id !== undefined) window.clearInterval(id);
  timers.delete(sessionId);
}

const UNITS = [
  { unit: "backup.service", load: "loaded", active: "failed", sub: "failed", description: "Nightly database backup" },
  { unit: "cron.service", load: "loaded", active: "active", sub: "running", description: "Regular background program processing daemon" },
  { unit: "docker.service", load: "loaded", active: "active", sub: "running", description: "Docker Application Container Engine" },
  { unit: "nginx.service", load: "loaded", active: "active", sub: "running", description: "A high performance web server and a reverse proxy server" },
  { unit: "postgresql@16-main.service", load: "loaded", active: "active", sub: "running", description: "PostgreSQL Cluster 16-main" },
  { unit: "ssh.service", load: "loaded", active: "active", sub: "running", description: "OpenBSD Secure Shell server" },
  { unit: "ufw.service", load: "loaded", active: "active", sub: "exited", description: "Uncomplicated firewall" },
  { unit: "apport.service", load: "loaded", active: "inactive", sub: "dead", description: "automatic crash report generation" },
];

const PORTS = [
  { proto: "tcp", address: "0.0.0.0", port: 22, process: "sshd", pid: 812 },
  { proto: "tcp", address: "::", port: 22, process: "sshd", pid: 812 },
  { proto: "udp", address: "127.0.0.53%lo", port: 53, process: "systemd-resolve", pid: 600 },
  { proto: "tcp", address: "0.0.0.0", port: 80, process: "nginx", pid: 901 },
  { proto: "tcp", address: "0.0.0.0", port: 443, process: "nginx", pid: 901 },
  { proto: "tcp", address: "127.0.0.1", port: 5432, process: "postgres", pid: 1104 },
  { proto: "tcp", address: "127.0.0.1", port: 6379, process: "", pid: null },
];

const UFW_RAW = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
80,443/tcp                 ALLOW IN    Anywhere
5432/tcp                   DENY IN     Anywhere
22/tcp (v6)                ALLOW IN    Anywhere (v6)`;

/** Handle a `sysmon_*` command; `undefined` means "not ours". */
export function handle(cmd: string, a: Args): unknown {
  switch (cmd) {
    case "sysmon_probe":
      return {
        os: "Linux",
        kernel: "6.8.0-45-generic",
        hostname: "web-01",
        distro: "Ubuntu 24.04.1 LTS",
        proc: true,
        systemd: true,
        docker: true,
        ports: "ss",
        firewall: ["ufw", "nft"],
        root: "sudo",
        hasPassword: false,
        ...probeOverride,
      };
    case "sysmon_start": {
      calls.start += 1;
      stop(a.sessionId);
      ticks.set(a.sessionId, 0);
      sample(a.sessionId);
      // Faster than the real 2 s so tests and screenshots fill quickly.
      timers.set(a.sessionId, window.setInterval(() => sample(a.sessionId), 250));
      return null;
    }
    case "sysmon_stop":
      calls.stop += 1;
      stop(a.sessionId);
      emit("sysmon://ended", { sessionId: a.sessionId, stopped: true, reason: null });
      return null;
    case "sysmon_disks":
      return [
        { filesystem: "/dev/vda1", mount: "/", total: 80 * GB, used: 31 * GB, available: 49 * GB },
        { filesystem: "/dev/vdb1", mount: "/var/lib/postgresql", total: 200 * GB, used: 163 * GB, available: 37 * GB },
        { filesystem: "/dev/vdc1", mount: "/srv/backups", total: 500 * GB, used: 468 * GB, available: 32 * GB },
      ];
    case "sysmon_services":
      return UNITS;
    case "sysmon_service_action": {
      calls.actions.push({ unit: a.unit, action: a.action, elevate: a.elevate });
      const u = UNITS.find((x) => x.unit === a.unit);
      if (u) {
        const up = a.action !== "stop";
        u.active = up ? "active" : "inactive";
        u.sub = up ? "running" : "dead";
      }
      return { ok: true, output: "" };
    }
    case "sysmon_service_logs":
      calls.reads.push({ cmd, elevate: a.elevate });
      return [
        `2026-11-15T09:12:01+0000 web-01 systemd[1]: Starting ${a.unit}...`,
        `2026-11-15T09:12:02+0000 web-01 systemd[1]: Started ${a.unit}.`,
        `2026-11-15T09:40:17+0000 web-01 ${String(a.unit).split(".")[0]}[901]: reloaded configuration`,
      ].join("\n");
    case "sysmon_ports":
      calls.reads.push({ cmd, elevate: a.elevate });
      return { ports: PORTS, note: null };
    case "sysmon_firewall":
      calls.reads.push({ cmd, elevate: a.elevate });
      if (a.tool === "ufw") {
        return {
          tool: "ufw",
          active: true,
          summary: [
            ["Logging", "on (low)"],
            ["Default", "deny (incoming), allow (outgoing), disabled (routed)"],
            ["New profiles", "skip"],
          ],
          rules: [
            { to: "22/tcp", action: "ALLOW IN", from: "Anywhere" },
            { to: "80,443/tcp", action: "ALLOW IN", from: "Anywhere" },
            { to: "5432/tcp", action: "DENY IN", from: "Anywhere" },
            { to: "22/tcp (v6)", action: "ALLOW IN", from: "Anywhere (v6)" },
          ],
          raw: UFW_RAW,
          failed: false,
        };
      }
      return {
        tool: a.tool,
        active: null,
        summary: [],
        rules: [],
        raw: "table inet filter {\n\tchain input {\n\t\ttype filter hook input priority filter; policy drop;\n\t\ttcp dport { 22, 80, 443 } accept\n\t}\n}",
        failed: false,
      };
    default:
      return undefined;
  }
}
