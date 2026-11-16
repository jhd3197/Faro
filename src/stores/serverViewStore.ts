import { create } from "zustand";
import { ipc, onSysmonEvent } from "@/lib/ipc";
import type {
  DiskRow,
  Elevate,
  HostProbe,
  SessionId,
  SysSample,
} from "@/lib/types";
import { useDiskScan } from "./diskScanStore";

// Server view (Plan 30): what a Linux host is doing right now, for one SSH
// session at a time. The view is an overlay in the same slot as Disk Usage.
//
// The metrics sampler holds one SSH channel for as long as it runs, and sshd
// caps channels per connection, so it runs only while the Overview tab is on
// screen: opening another tab, closing the view or dropping the session stops
// it. The chart history survives a tab switch and is cleared per session.

export type ServerTab = "overview" | "services" | "ports" | "firewall" | "docker";

/** Chart history kept: 300 samples is 10 minutes at the 2 s default. */
export const SAMPLE_CAPACITY = 300;
const SAMPLE_INTERVAL_MS = 2000;

export type SamplerState = "idle" | "starting" | "running" | "ended";

interface ServerViewState {
  open: boolean;
  sessionId: SessionId | null;
  tab: ServerTab;

  probe: HostProbe | null;
  probing: boolean;
  probeError: string | null;
  /** Probe results by session, so reopening the view doesn't re-run it. */
  probes: Record<string, HostProbe>;

  samples: SysSample[];
  sampler: SamplerState;
  /** Why the sampler stopped, when Faro didn't stop it. */
  samplerError: string | null;
  disks: DiskRow[];

  /** Sessions where the user agreed to hand the login password to sudo. */
  passwordSudo: Record<string, boolean>;

  unlisten: (() => void) | null;

  /** Open the view for a session (probing it the first time). */
  openFor: (sessionId: SessionId, tab?: ServerTab) => Promise<void>;
  close: () => void;
  /** Close the view if it is showing this session (it disconnected). */
  dropSession: (sessionId: SessionId) => void;
  setTab: (tab: ServerTab) => void;
  /** Start the sampler again after it ended. */
  resume: () => Promise<void>;
  refreshDisks: () => Promise<void>;
  allowPasswordSudo: () => void;
}

/** Tabs that can work on a host, in display order. */
export function visibleTabs(probe: HostProbe | null): ServerTab[] {
  if (!probe) return [];
  const tabs: ServerTab[] = [];
  if (probe.proc) tabs.push("overview");
  if (probe.systemd) tabs.push("services");
  if (probe.ports) tabs.push("ports");
  if (probe.firewall.length > 0) tabs.push("firewall");
  if (probe.docker) tabs.push("docker");
  return tabs;
}

/** How a command should get root on this host. Password sudo is used only
 *  once the user has agreed to it for this session. */
export function elevateFor(probe: HostProbe | null, passwordOk: boolean): Elevate {
  if (!probe) return "none";
  if (probe.root === "sudo") return "sudo";
  if (probe.root === "password" && passwordOk) return "password";
  return "none";
}

/** True when the host has root available to Faro right now. */
export function hasRoot(probe: HostProbe | null, passwordOk: boolean): boolean {
  if (!probe) return false;
  return probe.root === "root" || elevateFor(probe, passwordOk) !== "none";
}

export const useServerView = create<ServerViewState>((set, get) => {
  /** Run the sampler iff the Overview tab is showing; idempotent. */
  const syncSampler = async () => {
    const { open, sessionId, tab, probe, sampler } = get();
    const want = open && !!sessionId && tab === "overview" && !!probe?.proc;
    if (!sessionId) return;
    if (want && (sampler === "idle" || sampler === "ended")) {
      set({ sampler: "starting", samplerError: null });
      try {
        await ipc.sysmonStart(sessionId, SAMPLE_INTERVAL_MS);
        // A sample may already have flipped this to "running".
        if (get().sampler === "starting") set({ sampler: "running" });
        void get().refreshDisks();
      } catch (e) {
        set({ sampler: "ended", samplerError: String(e) });
      }
    } else if (!want && (sampler === "running" || sampler === "starting")) {
      set({ sampler: "idle" });
      ipc.sysmonStop(sessionId).catch(() => {});
    }
  };

  return {
    open: false,
    sessionId: null,
    tab: "overview",
    probe: null,
    probing: false,
    probeError: null,
    probes: {},
    samples: [],
    sampler: "idle",
    samplerError: null,
    disks: [],
    passwordSudo: {},
    unlisten: null,

    openFor: async (sessionId, tab) => {
      const prev = get();
      // Never stack on Disk Usage: both overlays use the same slot.
      if (useDiskScan.getState().open) useDiskScan.getState().close();
      if (prev.open && prev.sessionId === sessionId) {
        if (tab) get().setTab(tab);
        return;
      }
      if (prev.sessionId && prev.sampler !== "idle") {
        ipc.sysmonStop(prev.sessionId).catch(() => {});
      }
      prev.unlisten?.();

      const unlisten = await onSysmonEvent(
        (sample) => {
          if (sample.sessionId !== get().sessionId) return;
          set((s) => ({
            sampler: "running",
            samples:
              s.samples.length >= SAMPLE_CAPACITY
                ? [...s.samples.slice(s.samples.length - SAMPLE_CAPACITY + 1), sample]
                : [...s.samples, sample],
          }));
        },
        (ended) => {
          if (ended.sessionId !== get().sessionId) return;
          // A stop we asked for already set the state; only report surprises.
          if (!ended.stopped) {
            set({ sampler: "ended", samplerError: ended.reason });
          }
        }
      );

      const cached = prev.probes[sessionId] ?? null;
      set({
        open: true,
        sessionId,
        tab: tab ?? "overview",
        probe: cached,
        probing: !cached,
        probeError: null,
        samples: [],
        sampler: "idle",
        samplerError: null,
        disks: [],
        unlisten,
      });

      let probe = cached;
      if (!probe) {
        try {
          probe = await ipc.sysmonProbe(sessionId);
        } catch (e) {
          if (get().sessionId === sessionId) {
            set({ probing: false, probeError: String(e) });
          }
          return;
        }
        // The view may have moved on while the probe ran.
        if (get().sessionId !== sessionId || !get().open) return;
        set((s) => ({
          probe,
          probing: false,
          probes: { ...s.probes, [sessionId]: probe! },
        }));
      }
      // Land on a tab this host actually has.
      const tabs = visibleTabs(probe);
      if (tabs.length > 0 && !tabs.includes(get().tab)) set({ tab: tabs[0] });
      await syncSampler();
    },

    close: () => {
      const { sessionId, sampler, unlisten } = get();
      if (sessionId && sampler !== "idle") ipc.sysmonStop(sessionId).catch(() => {});
      unlisten?.();
      set({
        open: false,
        sessionId: null,
        probe: null,
        probing: false,
        probeError: null,
        samples: [],
        sampler: "idle",
        samplerError: null,
        disks: [],
        unlisten: null,
      });
    },

    dropSession: (sessionId) => {
      set((s) => {
        const { [sessionId]: _p, ...probes } = s.probes;
        const { [sessionId]: _s, ...passwordSudo } = s.passwordSudo;
        return { probes, passwordSudo };
      });
      if (get().sessionId === sessionId) {
        // The backend stops the sampler itself on disconnect.
        set({ sampler: "idle" });
        get().close();
      }
    },

    setTab: (tab) => {
      set({ tab });
      void syncSampler();
    },

    resume: async () => {
      await syncSampler();
    },

    refreshDisks: async () => {
      const sessionId = get().sessionId;
      if (!sessionId) return;
      try {
        const disks = await ipc.sysmonDisks(sessionId);
        if (get().sessionId === sessionId) set({ disks });
      } catch {
        // The filesystems table is secondary; keep the last good rows.
      }
    },

    allowPasswordSudo: () => {
      const sessionId = get().sessionId;
      if (!sessionId) return;
      set((s) => ({ passwordSudo: { ...s.passwordSudo, [sessionId]: true } }));
    },
  };
});
