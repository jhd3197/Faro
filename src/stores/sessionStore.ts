import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import { onBeforeClose } from "@/lib/closeGuard";
import { useConnections } from "./connectionsStore";
import { useSettings } from "./settingsStore";

/**
 * What the main window looked like when Faro last quit, so the next launch
 * opens where the user left off: the focused server (reconnected only if it
 * was connected and "Restore last session" is on), the dual-pane split and
 * the last Settings section.
 *
 * Everything is keyed by stable identity (profile id), never by runtime
 * session ids. The snapshot is versioned and validated on read; writes are
 * debounced, start only once the startup restore has finished (so a half-
 * restored state can't overwrite the saved one), and flush on close.
 */

export const SESSION_SNAPSHOT_KEY = "sessionSnapshot";
const VERSION = 1;
const SAVE_DELAY_MS = 400;

export interface SessionSnapshot {
  v: typeof VERSION;
  /** Last focused connection profile. */
  activeProfileId: string | null;
  /** Whether that profile had a live session at quit. */
  connected: boolean;
  /** Dual-pane split, left pane share (0.2–0.8). */
  splitRatio: number;
  /** Last Settings section shown. */
  settingsSection: string | null;
}

export const EMPTY_SNAPSHOT: SessionSnapshot = {
  v: VERSION,
  activeProfileId: null,
  connected: false,
  splitRatio: 0.5,
  settingsSection: null,
};

export function clampSplit(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(0.8, Math.max(0.2, ratio));
}

/** Accept only a well-formed snapshot of this version; fix up odd fields. */
export function parseSnapshot(raw: unknown): SessionSnapshot | null {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.v !== VERSION) return null;
  return {
    v: VERSION,
    activeProfileId: typeof o.activeProfileId === "string" && o.activeProfileId ? o.activeProfileId : null,
    connected: o.connected === true,
    splitRatio: typeof o.splitRatio === "number" ? clampSplit(o.splitRatio) : 0.5,
    settingsSection: typeof o.settingsSection === "string" && o.settingsSection ? o.settingsSection : null,
  };
}

/** The pre-paint settings snapshot carries this row too (main window only). */
function injected(): SessionSnapshot | null {
  const inj = (globalThis as { __FARO_SETTINGS__?: Record<string, unknown> }).__FARO_SETTINGS__;
  return inj ? parseSnapshot(inj[SESSION_SNAPSHOT_KEY]) : null;
}

interface SessionState {
  snapshot: SessionSnapshot;
  /** What was loaded at startup (the restore source). */
  loaded: SessionSnapshot | null;
  /** True once the startup restore has finished; saves wait for it. */
  restored: boolean;
  setSplitRatio: (ratio: number) => void;
  setSettingsSection: (section: string) => void;
  /** Load the saved snapshot (from the injection or faro.db). */
  load: () => Promise<SessionSnapshot | null>;
  /** Reconnect the last server if allowed, then start saving. */
  restore: () => Promise<void>;
  flush: () => Promise<void>;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;
let restoreStarted = false;

function schedule() {
  dirty = true;
  if (!useSession.getState().restored) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void useSession.getState().flush(); }, SAVE_DELAY_MS);
}

const initial = injected();

export const useSession = create<SessionState>((set, get) => ({
  snapshot: initial ?? EMPTY_SNAPSHOT,
  loaded: initial,
  restored: false,

  setSplitRatio: (ratio) => {
    const splitRatio = clampSplit(ratio);
    if (splitRatio === get().snapshot.splitRatio) return;
    set(s => ({ snapshot: { ...s.snapshot, splitRatio } }));
    schedule();
  },

  setSettingsSection: (section) => {
    if (section === get().snapshot.settingsSection) return;
    set(s => ({ snapshot: { ...s.snapshot, settingsSection: section } }));
    schedule();
  },

  load: async () => {
    if (get().loaded) return get().loaded;
    const all = await ipc.settingsGetAll().catch(() => ({}) as Record<string, string>);
    const loaded = parseSnapshot(all[SESSION_SNAPSHOT_KEY]);
    if (loaded) {
      // Keep anything the user already changed this launch.
      set(s => ({
        loaded,
        snapshot: dirty ? { ...loaded, splitRatio: s.snapshot.splitRatio, settingsSection: s.snapshot.settingsSection ?? loaded.settingsSection } : loaded,
      }));
    }
    return loaded;
  },

  restore: async () => {
    if (restoreStarted) return;
    restoreStarted = true;
    try {
      const saved = await get().load();
      const conns = useConnections.getState();
      if (saved?.activeProfileId && saved.connected && useSettings.getState().restoreLastSession) {
        if (!conns.profiles.length) await conns.loadProfiles().catch(() => {});
        const exists = useConnections.getState().profiles.some(p => p.id === saved.activeProfileId);
        if (exists) {
          const id = saved.activeProfileId;
          await useConnections.getState().connect(id).catch(() => {});
          // Servers flagged to auto-connect open alongside and each takes
          // focus as it lands; hand it back to the restored one afterwards.
          await connectionsSettled();
          const c = useConnections.getState();
          const session = c.sessions.find(x => x.profileId === id);
          if (session && c.activeSessionId !== session.sessionId) c.setActiveSession(session.sessionId);
        }
      }
    } finally {
      set({ restored: true });
      trackConnections();
      if (dirty) schedule();
    }
  },

  flush: async () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (!dirty) return;
    dirty = false;
    await ipc.settingsSet(SESSION_SNAPSHOT_KEY, JSON.stringify(get().snapshot)).catch(() => { dirty = true; });
  },
}));

/** Resolves once no connection is in flight (or after 20 s). */
function connectionsSettled(): Promise<void> {
  return new Promise(resolve => {
    let done = false;
    let unsub = () => {};
    const finish = () => { if (!done) { done = true; unsub(); clearTimeout(t); resolve(); } };
    const t = setTimeout(finish, 20_000);
    // Let a startup auto-connect that's about to begin get going first.
    setTimeout(() => {
      if (!useConnections.getState().connecting) finish();
      else unsub = useConnections.subscribe(s => { if (!s.connecting) finish(); });
    }, 300);
  });
}

let tracking = false;
/** Whitelisted trigger: only the focused profile and whether it's live. */
function trackConnections() {
  if (tracking) return;
  tracking = true;
  const apply = (activeProfileId: string | null, activeSessionId: string | null) => {
    const prev = useSession.getState().snapshot;
    const next = {
      ...prev,
      // Disconnecting everything keeps the last server, just not as "connected".
      activeProfileId: activeProfileId ?? prev.activeProfileId,
      connected: !!activeSessionId,
    };
    if (next.activeProfileId === prev.activeProfileId && next.connected === prev.connected) return;
    useSession.setState({ snapshot: next });
    schedule();
  };
  const c = useConnections.getState();
  apply(c.activeProfileId, c.activeSessionId);
  useConnections.subscribe((s, p) => {
    if (s.activeProfileId !== p.activeProfileId || s.activeSessionId !== p.activeSessionId) {
      apply(s.activeProfileId, s.activeSessionId);
    }
  });
}

onBeforeClose(() => useSession.getState().flush());
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => { void useSession.getState().flush(); });
}
