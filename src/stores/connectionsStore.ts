import { create } from "zustand";
import { blockingProblems } from "@/lib/cliUsage";
import { useClis } from "./cliStore";
import { ipc } from "@/lib/ipc";
import { toast } from "./toastStore";
import { toastError, messageOf, kindOf } from "@/lib/errors";
import type { ConnectFailure } from "@/lib/railOps";
import type { ConnectionProfile, ProfileOrganization, SessionId } from "@/lib/types";
import { useTerminals } from "./terminalsStore";
import { useServerView } from "./serverViewStore";
import { useDocker } from "./dockerStore";
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
  organizationHistory: { before: ProfileOrganization[]; after: ProfileOrganization[] }[];
  undoOrganization: () => Promise<void>;
  /** Every live connection, in the order they were opened. */
  sessions: LiveSession[];
  /** The focused session — drives the browser, terminal and status bar. */
  activeSessionId: SessionId | null;
  /** Profile of the focused session; kept in sync with activeSessionId. */
  activeProfileId: string | null;
  connecting: boolean;
  reordering: boolean;
  error: string | null;
  /** How the last connect attempt failed, per profile, for this run only.
   *  Cleared when that profile connects. Drives the rail's broken marker. */
  connectFailures: Record<string, ConnectFailure>;

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
  organizationHistory: [],
  sessions: [],
  activeSessionId: null,
  activeProfileId: null,
  connecting: false,
  reordering: false,
  error: null,
  connectFailures: {},

  loadProfiles: async () => {
    const profiles = await ipc.listProfiles();
    set({ profiles });
  },

  saveProfile: async (p) => {
    await ipc.saveProfile(p);
    // An edited profile gets a fresh start: its last failure may be fixed.
    if (get().connectFailures[p.id]) {
      set(s => {
        const { [p.id]: _cleared, ...connectFailures } = s.connectFailures;
        return { connectFailures };
      });
    }
    await get().loadProfiles();
  },

  saveProfiles: async (ps) => {
    if (get().reordering) return;
    set({ reordering: true });
    const after = ps.map(organizationOf);
    const expected = ps.map(p => get().profiles.find(old => old.id === p.id)).filter((p): p is ConnectionProfile => !!p).map(organizationOf);
    try {
      const before = await ipc.organizeProfiles(after, expected);
      set(s => ({ organizationHistory: [...s.organizationHistory.slice(-19), { before, after }] }));
      await get().loadProfiles();
    } catch (e) { toastError(e, "Couldn't update organization"); }
    finally { set({ reordering: false }); }
  },

  undoOrganization: async () => {
    const history = get().organizationHistory;
    const action = history.at(-1);
    if (!action || get().reordering) return;
    set({ reordering: true });
    try {
      await ipc.organizeProfiles(action.before, action.after);
      set({ organizationHistory: history.slice(0, -1) });
      await get().loadProfiles();
    } catch (e) { toastError(e, "Couldn't undo organization"); }
    finally { set({ reordering: false }); }
  },

  reorderProfiles: async (ids, groupChange) => {
    const positions = new Map(ids.map((id, index) => [id, index]));
    await get().saveProfiles(get().profiles.map(p => ({
      ...p,
      sortOrder: positions.get(p.id) ?? p.sortOrder,
      ...(groupChange?.id === p.id ? { group: groupChange.group } : {}),
    })));
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
      // A CLI this connection needs is known to be signed out, expired or
      // missing (Plan 35): say so with the fix instead of a failed connect.
      const needed = get().profiles.find((p) => p.id === profileId);
      const blocked = needed ? blockingProblems(needed, get().profiles, useClis.getState().statuses)[0] : undefined;
      if (needed && blocked) {
        const who = blocked.use.account && blocked.use.account !== "default" ? ` for ${blocked.use.account}` : "";
        const message =
          blocked.state === "missing"
            ? `It needs ${blocked.status.name}, which isn't installed.`
            : blocked.state === "expired"
              ? `Your ${blocked.status.name} login${who} expired.`
              : `Nobody is signed in to ${blocked.status.name}${who}.`;
        set((s) => ({ connectFailures: { ...s.connectFailures, [profileId]: { kind: "auth", message } } }));
        toast.warning(
          `${needed.name} needs ${blocked.status.name}`,
          message,
          blocked.state === "missing" || !blocked.status.signIn
            ? { label: "Open CLIs", clis: { tool: blocked.status.id } }
            : { label: "Sign in", clis: { tool: blocked.status.id, signIn: true, account: blocked.use.account !== "default" ? blocked.use.account : undefined } },
          { id: `connect:${profileId}` }
        );
        throw new Error(message);
      }
      set({ connecting: true, error: null });
      const profile = get().profiles.find(p => p.id === profileId);
      pending = (async () => {
        try {
          const sessionId = await ipc.connect(profileId);
          set(s => {
            const { [profileId]: _cleared, ...connectFailures } = s.connectFailures;
            return { sessions: [...s.sessions, { sessionId, profileId }], connectFailures };
          });
          toast.success("Connected", profile ? `${profile.name} — ${profile.username}@${profile.host}` : undefined);
        } catch (e) {
          set(s => ({
            error: messageOf(e),
            connectFailures: { ...s.connectFailures, [profileId]: { kind: kindOf(e), message: messageOf(e) } },
          }));
          // Retries and auto-connects of the same server replace one toast.
          toastError(e, profile ? `Couldn't connect to ${profile.name}` : "Connection failed", { id: `connect:${profileId}` });
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
    useServerView.getState().dropSession(sid);
    useDocker.getState().dropSession(sid);
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

function organizationOf(p: ConnectionProfile): ProfileOrganization { return { id: p.id, group: p.group, sortOrder: p.sortOrder }; }
