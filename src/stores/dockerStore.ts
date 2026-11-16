import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import type {
  DockerAccess,
  DockerContainer,
  DockerDiskUse,
  DockerImage,
  DockerNetwork,
  DockerStats,
  DockerVolume,
  Elevate,
  SessionId,
} from "@/lib/types";

// Docker manager (Plan 31): the Docker tab of the Server view. One session at
// a time, like the view itself. Lists are fetched on demand; the components
// decide when (and whether a timer is allowed — see DockerTab).

export type DockerSection = "containers" | "images" | "volumes" | "networks";

/** CPU history kept per container for its sparkline. */
export const STATS_CAPACITY = 60;

interface DockerState {
  sessionId: SessionId | null;
  section: DockerSection;

  access: DockerAccess | null;
  accessError: string | null;

  containers: DockerContainer[] | null;
  /** Latest stats by container name. */
  stats: Record<string, DockerStats>;
  /** CPU % history by container name, newest last. */
  cpuHistory: Record<string, number[]>;
  images: DockerImage[] | null;
  volumes: DockerVolume[] | null;
  networks: DockerNetwork[] | null;
  diskUse: DockerDiskUse[];

  /** What the last failed list said. */
  error: string | null;
  loading: boolean;

  /** Point the store at a session, dropping another session's data. */
  init: (sessionId: SessionId) => Promise<void>;
  setSection: (section: DockerSection) => void;
  /** Containers, then their stats (which take Docker a couple of seconds). */
  refreshContainers: (elevate: Elevate, opts?: { quiet?: boolean }) => Promise<void>;
  refreshImages: (elevate: Elevate) => Promise<void>;
  refreshVolumes: (elevate: Elevate) => Promise<void>;
  refreshNetworks: (elevate: Elevate) => Promise<void>;
  refreshDiskUse: (elevate: Elevate) => Promise<void>;
  /** Forget a session's data (it disconnected). */
  dropSession: (sessionId: SessionId) => void;
}

const EMPTY = {
  access: null,
  accessError: null,
  containers: null,
  stats: {},
  cpuHistory: {},
  images: null,
  volumes: null,
  networks: null,
  diskUse: [],
  error: null,
  loading: false,
};

export const useDocker = create<DockerState>((set, get) => {
  /** Run a list call for the current session; ignore it if we moved on. */
  const load = async <T,>(
    fetch: (sessionId: SessionId) => Promise<T>,
    apply: (value: T) => Partial<DockerState>,
    quiet = false
  ) => {
    const sessionId = get().sessionId;
    if (!sessionId) return;
    if (!quiet) set({ loading: true });
    try {
      const value = await fetch(sessionId);
      if (get().sessionId === sessionId) set({ ...apply(value), error: null });
    } catch (e) {
      if (get().sessionId === sessionId) set({ error: String(e) });
    } finally {
      if (get().sessionId === sessionId) set({ loading: false });
    }
  };

  return {
    sessionId: null,
    section: "containers",
    ...EMPTY,

    init: async (sessionId) => {
      if (get().sessionId !== sessionId) set({ ...EMPTY, sessionId, section: "containers" });
      if (get().access) return;
      try {
        const access = await ipc.dockerAccess(sessionId);
        if (get().sessionId === sessionId) set({ access, accessError: null });
      } catch (e) {
        if (get().sessionId === sessionId) set({ accessError: String(e) });
      }
    },

    setSection: (section) => set({ section }),

    refreshContainers: async (elevate, opts) => {
      await load(
        (sid) => ipc.dockerContainers(sid, elevate),
        (containers) => ({ containers }),
        opts?.quiet
      );
      const sessionId = get().sessionId;
      if (!sessionId || !get().containers?.some((c) => c.state === "running")) return;
      try {
        const rows = await ipc.dockerStats(sessionId, elevate);
        if (get().sessionId !== sessionId) return;
        const stats: Record<string, DockerStats> = {};
        const cpuHistory: Record<string, number[]> = {};
        const prev = get().cpuHistory;
        for (const r of rows) {
          stats[r.name] = r;
          cpuHistory[r.name] = [...(prev[r.name] ?? []), r.cpuPct].slice(-STATS_CAPACITY);
        }
        set({ stats, cpuHistory });
      } catch {
        // Stats are a bonus on top of the list; keep the last good ones.
      }
    },

    refreshImages: (elevate) =>
      load((sid) => ipc.dockerImages(sid, elevate), (images) => ({ images })),
    refreshVolumes: (elevate) =>
      load((sid) => ipc.dockerVolumes(sid, elevate), (volumes) => ({ volumes })),
    refreshNetworks: (elevate) =>
      load((sid) => ipc.dockerNetworks(sid, elevate), (networks) => ({ networks })),
    refreshDiskUse: async (elevate) => {
      const sessionId = get().sessionId;
      if (!sessionId) return;
      try {
        const diskUse = await ipc.dockerDiskUse(sessionId, elevate);
        if (get().sessionId === sessionId) set({ diskUse });
      } catch {
        // Only used to say what a prune would reclaim.
      }
    },

    dropSession: (sessionId) => {
      if (get().sessionId === sessionId) set({ ...EMPTY, sessionId: null });
    },
  };
});

/** Containers that mount a volume, by name. */
export function containersUsingVolume(containers: DockerContainer[] | null, volume: string): string[] {
  return (containers ?? []).filter((c) => c.mounts.includes(volume)).map((c) => c.name);
}

/** Containers attached to a network, by name. */
export function containersOnNetwork(containers: DockerContainer[] | null, network: string): string[] {
  return (containers ?? []).filter((c) => c.networks.includes(network)).map((c) => c.name);
}

/** Containers created from an image, matched the ways `docker ps` names one. */
export function containersUsingImage(
  containers: DockerContainer[] | null,
  image: DockerImage
): string[] {
  const ref = `${image.repository}:${image.tag}`;
  const shortId = image.id.replace(/^sha256:/, "");
  return (containers ?? [])
    .filter(
      (c) =>
        c.image === ref ||
        (image.tag === "latest" && c.image === image.repository) ||
        c.image === image.id ||
        (c.image.length >= 12 && shortId.startsWith(c.image))
    )
    .map((c) => c.name);
}
