import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import { toast } from "./toastStore";
import { toastError, messageOf } from "@/lib/errors";
import type { ConnectionProfile, SessionId } from "@/lib/types";
import { useTerminals } from "./terminalsStore";
import { useSites } from "./sitesStore";

// Site shortcuts share their parent's in-flight connection as well as its session.
const pendingConnections = new Map<string, Promise<void>>();

// One live connection. The backend keeps every session alive in a map, so the
// app can hold several at once; this is the frontend's view of them.
export interface LiveSession {
  sessionId: SessionId;
  profileId: string;
}

interface ConnectionsState {
  profiles: ConnectionProfile[];
  /** Every live connection, in the order they were opened. */
  sessions: LiveSession[];
  /** The focused session — drives the browser, terminal and status bar. */
  activeSessionId: SessionId | null;
  /** Profile of the focused session; kept in sync with activeSessionId. */
  activeProfileId: string | null;
  connecting: boolean;
  reordering: boolean;
  error: string | null;

  loadProfiles: () => Promise<void>;
  saveProfile: (p: ConnectionProfile) => Promise<void>;
  /** Save several profiles with a single reload at the end (group rename etc). */
  saveProfiles: (ps: ConnectionProfile[]) => Promise<void>;
  /** Persist a drag-and-drop rail order (every profile id, display order).
   *  Optionally re-homes the dragged profile into a new group first. */
  reorderProfiles: (
    ids: string[],
    groupChange?: { id: string; group: string | undefined }
  ) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  /** Connect to a profile, or focus its existing session if already open. */
  connect: (profileId: string, options?: { focus?: boolean }) => Promise<void>;
  /** Disconnect one session (defaults to the active one). */
  disconnect: (sessionId?: SessionId) => Promise<void>;
  /** Drop a session (defaults to the active one) and open a fresh one to the
   *  same profile — recovers a stale or dropped connection in one step. */
  reconnect: (sessionId?: SessionId) => Promise<void>;
  /** Focus an already-open session. */
  setActiveSession: (sessionId: SessionId) => void;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  profiles: [],
  sessions: [],
  activeSessionId: null,
  activeProfileId: null,
  connecting: false,
  reordering: false,
  error: null,

  loadProfiles: async () => {
    const profiles = await ipc.listProfiles();
    set({ profiles });
  },

  saveProfile: async (p) => {
    await ipc.saveProfile(p);
    await get().loadProfiles();
  },

  saveProfiles: async (ps) => {
    for (const p of ps) await ipc.saveProfile(p);
    await get().loadProfiles();
  },

  reorderProfiles: async (ids, groupChange) => {
    if (get().reordering) return;
    const before = get().profiles;
    const positions = new Map(ids.map((id, index) => [id, index]));
    // Reflect the drop immediately; don't let overlapping saves race and put
    // an older order back on screen. Read the saved state again on failure.
    set({ reordering: true, profiles: before.map(p => ({
      ...p,
      sortOrder: positions.get(p.id) ?? p.sortOrder,
      ...(groupChange?.id === p.id ? { group: groupChange.group } : {}),
    })) });
    try {
      if (groupChange) {
        const p = before.find(x => x.id === groupChange.id);
        if (p) await ipc.saveProfile({ ...p, group: groupChange.group });
      }
      await ipc.reorderProfiles(ids);
    } catch (e) {
      try { await get().loadProfiles(); }
      catch { set({ profiles: before }); }
      throw e;
    } finally {
      set({ reordering: false });
    }
  },

  deleteProfile: async (id) => {
    await ipc.deleteProfile(id);
    await get().loadProfiles();
    try {
      await useSites.getState().removeForProfile(id);
    } catch (e) {
      toastError(e, "Couldn't remove this server's saved sites");
    }
  },

  connect: async (profileId, options) => {
    // Already connected to this profile? Just focus its tab.
    const existing = get().sessions.find((s) => s.profileId === profileId);
    if (existing) {
      if (options?.focus !== false) get().setActiveSession(existing.sessionId);
      return;
    }

    let pending = pendingConnections.get(profileId);
    if (!pending) {
      set({ connecting: true, error: null });
      const profile = get().profiles.find(p => p.id === profileId);
      pending = (async () => {
        try {
          const sessionId = await ipc.connect(profileId);
          set(s => ({ sessions: [...s.sessions, { sessionId, profileId }] }));
          toast.success("Connected", profile ? `${profile.name} — ${profile.username}@${profile.host}` : undefined);
        } catch (e) {
          set({ error: messageOf(e) });
          toastError(e, profile ? `Couldn't connect to ${profile.name}` : "Connection failed");
          throw e;
        } finally {
          pendingConnections.delete(profileId);
          set({ connecting: pendingConnections.size > 0 });
        }
      })();
      pendingConnections.set(profileId, pending);
    }
    await pending;
    if (options?.focus !== false) {
      const session = get().sessions.find(s => s.profileId === profileId);
      if (session) get().setActiveSession(session.sessionId);
    }
  },

  disconnect: async (sessionId) => {
    const sid = sessionId ?? get().activeSessionId;
    if (!sid) return;
    const target = get().sessions.find((s) => s.sessionId === sid);
    const profile = get().profiles.find((p) => p.id === target?.profileId);
    try {
      await ipc.disconnect(sid);
    } catch {
      // best effort — drop it locally regardless
    }
    useTerminals.getState().dropSessionTabs(sid);
    set((s) => {
      const sessions = s.sessions.filter((x) => x.sessionId !== sid);
      // If we closed the focused session, fall back to the most recent one.
      let activeSessionId = s.activeSessionId;
      let activeProfileId = s.activeProfileId;
      if (s.activeSessionId === sid) {
        const next = sessions[sessions.length - 1] ?? null;
        activeSessionId = next?.sessionId ?? null;
        activeProfileId = next?.profileId ?? null;
      }
      return { sessions, activeSessionId, activeProfileId };
    });
    void ipc.bridgeSetActiveSession(get().activeSessionId);
    toast.info("Disconnected", profile?.name);
  },

  reconnect: async (sessionId) => {
    const sid = sessionId ?? get().activeSessionId;
    const target = get().sessions.find((s) => s.sessionId === sid);
    if (!target) return;
    await get().disconnect(target.sessionId);
    await get().connect(target.profileId);
  },

  setActiveSession: (sessionId) => {
    const target = get().sessions.find((s) => s.sessionId === sessionId);
    if (!target) return;
    set({ activeSessionId: sessionId, activeProfileId: target.profileId });
    // Keep the Agent Bridge aware of which connection the user is focused on.
    void ipc.bridgeSetActiveSession(sessionId);
  },
}));
