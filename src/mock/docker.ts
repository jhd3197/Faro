// Mock of the Docker manager backend and live logs (Plan 31) for the demo
// build: a made-up Docker host whose containers really change state when the
// UI acts on them, so the headless tests can assert on the round trip.
// Everything here is fictional.
import { emit } from "./event";

type Args = Record<string, any>;

const MB = 1000 * 1000;

/** What the UI asked the backend to do, for the tests to inspect. */
export const calls = {
  actions: [] as { id: string; action: string; elevate: string }[],
  removes: [] as { kind: string; id: string; elevate: string }[],
  prunes: [] as { kind: string; elevate: string }[],
  follows: [] as { key: string; elevate: string }[],
  stops: [] as string[],
  tails: 0,
  reads: [] as { cmd: string; elevate: string }[],
};

/** Test hook: change how the daemon is reached (e.g. `{ mode: "needsRoot" }`). */
let accessOverride: Record<string, unknown> = {};
export function setAccess(patch: Record<string, unknown>) {
  accessOverride = patch;
}

interface MockContainer {
  id: string;
  name: string;
  image: string;
  command: string;
  createdAt: string;
  runningFor: string;
  ports: string;
  state: string;
  status: string;
  networks: string[];
  mounts: string[];
  project: string | null;
  service: string | null;
}

const c = (
  id: string,
  name: string,
  image: string,
  state: string,
  status: string,
  extra: Partial<MockContainer> = {}
): MockContainer => ({
  id,
  name,
  image,
  command: "docker-entrypoint.sh",
  createdAt: "2026-11-02 08:14:03 +0000 UTC",
  runningFor: "13 days ago",
  ports: "",
  state,
  status,
  networks: ["bridge"],
  mounts: [],
  project: null,
  service: null,
  ...extra,
});

function seed(): MockContainer[] {
  return [
    c("a1f0c2d9e8b7", "shop-db-1", "postgres:16", "running", "Up 13 days (healthy)", {
      ports: "127.0.0.1:5432->5432/tcp",
      networks: ["shop_default"],
      mounts: ["shop_pgdata"],
      project: "shop",
      service: "db",
    }),
    c("b2e1d3c0f9a8", "shop-web-1", "ghcr.io/acme/shop-web:1.42.0", "running", "Up 2 hours", {
      ports: "0.0.0.0:8080->3000/tcp",
      networks: ["shop_default"],
      project: "shop",
      service: "web",
    }),
    c("c3d2e4b1a0f9", "shop-worker-1", "ghcr.io/acme/shop-web:1.42.0", "restarting", "Restarting (1) 12 seconds ago", {
      networks: ["shop_default"],
      project: "shop",
      service: "worker",
    }),
    c("d4c3f5a2b1e0", "cache", "redis:7-alpine", "running", "Up 13 days", {
      ports: "127.0.0.1:6379->6379/tcp",
      mounts: ["cache-data"],
    }),
    c("e5b4a6c3d2f1", "nightly-backup", "alpine:3.20", "exited", "Exited (0) 9 hours ago", {
      mounts: ["/srv/backups"],
    }),
  ];
}

let containers = seed();
let volumes = [
  { name: "cache-data", driver: "local", mountpoint: "/var/lib/docker/volumes/cache-data/_data", size: 48 * MB, links: 1 },
  { name: "old-uploads", driver: "local", mountpoint: "/var/lib/docker/volumes/old-uploads/_data", size: 912 * MB, links: 0 },
  { name: "shop_pgdata", driver: "local", mountpoint: "/var/lib/docker/volumes/shop_pgdata/_data", size: 3400 * MB, links: 1 },
];
let networks = [
  { id: "n-bridge", name: "bridge", driver: "bridge", scope: "local", builtin: true },
  { id: "n-host", name: "host", driver: "host", scope: "local", builtin: true },
  { id: "n-none", name: "none", driver: "null", scope: "local", builtin: true },
  { id: "n-legacy", name: "legacy-net", driver: "bridge", scope: "local", builtin: false },
  { id: "n-shop", name: "shop_default", driver: "bridge", scope: "local", builtin: false },
];
let images = [
  { id: "sha256:9f1c0d3e5a7b2468ace013579bdf02468ace013579bdf02468ace013579bdf024", repository: "alpine", tag: "3.20", size: 7.8 * MB, createdSince: "5 months ago", createdAt: "2026-06-10 11:02:44 +0000 UTC" },
  { id: "sha256:1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809", repository: "ghcr.io/acme/shop-web", tag: "1.42.0", size: 412 * MB, createdSince: "2 hours ago", createdAt: "2026-11-15 17:40:12 +0000 UTC" },
  { id: "sha256:77aa66bb55cc44dd33ee22ff1100998877aa66bb55cc44dd33ee22ff11009988", repository: "ghcr.io/acme/shop-web", tag: "1.41.3", size: 409 * MB, createdSince: "9 days ago", createdAt: "2026-11-06 09:15:00 +0000 UTC" },
  { id: "sha256:0e1d2c3b4a5968778695a4b3c2d1e0f90e1d2c3b4a5968778695a4b3c2d1e0f9", repository: "postgres", tag: "16", size: 431 * MB, createdSince: "3 weeks ago", createdAt: "2026-10-24 03:21:08 +0000 UTC" },
  { id: "sha256:5544332211ffeeddccbbaa99887766555544332211ffeeddccbbaa9988776655", repository: "redis", tag: "7-alpine", size: 41 * MB, createdSince: "6 weeks ago", createdAt: "2026-10-03 14:00:31 +0000 UTC" },
];

/** Test hook: put the made-up host back the way it started. */
export function reset() {
  containers = seed();
  accessOverride = {};
  for (const k of ["actions", "removes", "prunes", "follows", "stops", "reads"] as const) calls[k].length = 0;
  calls.tails = 0;
}

let tick = 0;
function stats() {
  tick += 1;
  const wave = (period: number, phase = 0) => (Math.sin((tick + phase) / period) + 1) / 2;
  return containers
    .filter((x) => x.state === "running")
    .map((x, i) => ({
      id: x.id,
      name: x.name,
      cpuPct: 1.5 + wave(2 + i, i * 3) * (x.name.includes("web") ? 62 : 9),
      memUsed: (60 + i * 140 + wave(7, i) * 20) * 1024 * 1024,
      memLimit: 8 * 1024 * 1024 * 1024,
      netRx: 120_000 * (i + 1),
      netTx: 48_000 * (i + 1),
      blockRead: 0,
      blockWrite: 4096 * i,
      pids: 3 + i * 4,
    }));
}

function find(id: string) {
  return containers.find((x) => x.id === id || x.name === id);
}

function inspect(id: string) {
  const x = find(id);
  if (!x) throw `Error response from daemon: No such container: ${id}`;
  return {
    id: `${x.id}${"0".repeat(52)}`,
    name: x.name,
    image: x.image,
    command: x.name === "cache" ? "redis-server --appendonly yes" : "docker-entrypoint.sh postgres",
    created: "2026-11-02T08:14:03.118Z",
    status: x.state,
    health: x.status.includes("healthy") ? "healthy" : null,
    startedAt: "2026-11-02T08:14:04.902Z",
    finishedAt: "0001-01-01T00:00:00Z",
    exitCode: 0,
    restartCount: x.state === "restarting" ? 14 : 0,
    restartPolicy: "unless-stopped",
    env: [
      ["POSTGRES_PASSWORD", "correct-horse-battery"],
      ["POSTGRES_DB", "shop"],
      ["PATH", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin"],
      ["EMPTY_FLAG", ""],
    ],
    labels: [
      ["com.docker.compose.project", x.project ?? ""],
      ["com.docker.compose.service", x.service ?? ""],
    ].filter(([, v]) => v),
    mounts: [
      ...x.mounts
        .filter((m) => !m.startsWith("/"))
        .map((m) => ({ kind: "volume", source: `/var/lib/docker/volumes/${m}/_data`, destination: "/var/lib/data", rw: true, name: m })),
      { kind: "bind", source: "/srv/shop/config", destination: "/etc/app", rw: false, name: null },
    ],
    networks: x.networks.map((n, i) => [n, `172.18.0.${i + 2}`]),
    ports: x.ports
      ? [{ container: x.ports.split("->")[1], host: x.ports.split("->")[0] }]
      : [],
  };
}

const followTimers = new Map<string, number>();
function stopFollow(sessionId: string, key: string, stopped: boolean) {
  const k = `${sessionId}|${key}`;
  const id = followTimers.get(k);
  if (id === undefined) return;
  window.clearInterval(id);
  followTimers.delete(k);
  emit("stream://ended", { sessionId, key, stopped, reason: null });
}

/** Start emitting a made-up log for `key`, replacing the session's follow. */
export function startFollow(sessionId: string, key: string, elevate: string, label: string) {
  calls.follows.push({ key, elevate });
  for (const k of [...followTimers.keys()]) {
    if (k.startsWith(`${sessionId}|`)) stopFollow(sessionId, k.slice(sessionId.length + 1), true);
  }
  let n = 0;
  const batch = (count: number) => {
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      n += 1;
      const ts = `2026-11-15T19:${String(10 + (n % 50)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}Z`;
      lines.push(
        n % 7 === 0
          ? `${ts} \x1b[33mWARN\x1b[0m ${label}: slow query took ${200 + n}ms`
          : `${ts} \x1b[32mINFO\x1b[0m ${label}: handled request #${n}`
      );
    }
    emit("stream://lines", { sessionId, key, lines, dropped: 0 });
  };
  window.setTimeout(() => batch(12), 20);
  followTimers.set(`${sessionId}|${key}`, window.setInterval(() => batch(2), 200));
}

/** Handle a `docker_*` or `follow_*` command; `undefined` means "not ours". */
export function handle(cmd: string, a: Args): unknown {
  switch (cmd) {
    case "docker_access":
      return { mode: "direct", version: "27.3.1", error: null, ...accessOverride };
    case "docker_containers":
      calls.reads.push({ cmd, elevate: a.elevate });
      return containers.map((x) => ({ ...x }));
    case "docker_stats":
      return stats();
    case "docker_inspect":
      return inspect(a.id);
    case "docker_container_action": {
      calls.actions.push({ id: a.id, action: a.action, elevate: a.elevate });
      const x = find(a.id);
      if (!x) return { ok: false, output: `Error response from daemon: No such container: ${a.id}` };
      if (a.action === "remove") containers = containers.filter((y) => y !== x);
      else if (a.action === "stop" || a.action === "kill") Object.assign(x, { state: "exited", status: "Exited (137) 1 second ago" });
      else if (a.action === "pause") Object.assign(x, { state: "paused", status: "Up 13 days (Paused)" });
      else Object.assign(x, { state: "running", status: "Up 1 second" });
      return { ok: true, output: x.name };
    }
    case "docker_logs_start":
      startFollow(a.sessionId, `docker:${a.id}`, a.elevate, find(a.id)?.name ?? a.id);
      return null;
    case "docker_logs_tail":
      calls.tails += 1;
      return [1, 2, 3].map((i) => `2026-11-15T19:0${i}:00Z INFO tail line ${i} of ${find(a.id)?.name}`).join("\n");
    case "follow_stop":
      calls.stops.push(a.key);
      stopFollow(a.sessionId, a.key, true);
      return null;
    case "docker_images":
      return images.map((x) => ({ ...x }));
    case "docker_volumes":
      return volumes.map((x) => ({ ...x }));
    case "docker_networks":
      return networks.map((x) => ({ ...x }));
    case "docker_disk_use":
      return [
        { kind: "Images", totalCount: String(images.length), active: "4", size: "1.3GB", reclaimable: "409MB (31%)" },
        { kind: "Containers", totalCount: String(containers.length), active: "3", size: "12.4MB", reclaimable: "1.1MB (8%)" },
        { kind: "Local Volumes", totalCount: String(volumes.length), active: "2", size: "4.36GB", reclaimable: "912MB (20%)" },
        { kind: "Build Cache", totalCount: "0", active: "0", size: "0B", reclaimable: "0B" },
      ];
    case "docker_remove": {
      calls.removes.push({ kind: a.kind, id: a.id, elevate: a.elevate });
      if (a.kind === "volume") {
        const users = containers.filter((x) => x.mounts.includes(a.id));
        if (users.length) return { ok: false, output: `Error response from daemon: remove ${a.id}: volume is in use - [${users[0].id}]` };
        volumes = volumes.filter((v) => v.name !== a.id);
      } else if (a.kind === "network") {
        networks = networks.filter((n) => n.name !== a.id);
      } else {
        images = images.filter((i) => `${i.repository}:${i.tag}` !== a.id && i.id !== a.id);
      }
      return { ok: true, output: a.id };
    }
    case "docker_prune": {
      calls.prunes.push({ kind: a.kind, elevate: a.elevate });
      if (a.kind === "containers") containers = containers.filter((x) => x.state !== "exited");
      return { ok: true, output: "Deleted Containers:\ne5b4a6c3d2f1\n\nTotal reclaimed space: 1.1MB" };
    }
    default:
      return undefined;
  }
}
