import { create } from "zustand";
import { ipc, onCliStatus, onToolStatus } from "@/lib/ipc";
import { toastError } from "@/lib/errors";
import type { CliToolStatus, ManagedToolId } from "@/lib/types";

// The CLIs page's state (Plan 35): every CLI Faro uses, as last checked.
// Account checks run in the backend on a schedule for CLIs connections use;
// here they run when the page opens or a person clicks Check.

interface CliStoreState {
  statuses: Record<string, CliToolStatus>;
  /** Display order from the backend. */
  order: ManagedToolId[];
  loaded: boolean;
  /** Tools with an account check running. */
  checking: Record<string, boolean>;
  init: () => Promise<() => void>;
  refresh: () => Promise<void>;
  check: (id: ManagedToolId) => Promise<CliToolStatus | null>;
  /** Check every installed CLI with an account (the page's "Check all"). */
  checkAll: () => Promise<void>;
  signIn: (id: ManagedToolId, account?: string) => Promise<void>;
  setAllowed: (id: ManagedToolId, account: string, allowed: boolean) => Promise<void>;
  put: (s: CliToolStatus) => void;
}

export const useClis = create<CliStoreState>((set, get) => ({
  statuses: {},
  order: [],
  loaded: false,
  checking: {},

  put: (s) =>
    set((st) => ({
      statuses: { ...st.statuses, [s.id]: s },
      order: st.order.includes(s.id) ? st.order : [...st.order, s.id],
    })),

  init: async () => {
    await get().refresh();
    const offs = await Promise.all([
      onCliStatus((s) => get().put(s)),
      // Installing or picking a copy changes "installed": re-read that tool.
      onToolStatus((t) => {
        if (get().statuses[t.id]) void ipc.cliStatuses().then((all) => all.filter((s) => s.id === t.id).forEach(get().put));
      }),
    ]);
    return () => offs.forEach((off) => off());
  },

  refresh: async () => {
    try {
      const all = await ipc.cliStatuses();
      set((st) => {
        const statuses: Record<string, CliToolStatus> = {};
        // Keep a newer check result the event already delivered.
        for (const s of all) statuses[s.id] = (st.statuses[s.id]?.checkedAt ?? 0) > s.checkedAt ? st.statuses[s.id] : s;
        return { statuses, order: all.map((s) => s.id), loaded: true };
      });
    } catch {
      set({ loaded: true });
    }
  },

  check: async (id) => {
    set((st) => ({ checking: { ...st.checking, [id]: true } }));
    try {
      const s = await ipc.cliCheck(id);
      get().put(s);
      return s;
    } catch (e) {
      toastError(e, `Couldn't check ${get().statuses[id]?.name ?? id}`);
      return null;
    } finally {
      set((st) => ({ checking: { ...st.checking, [id]: false } }));
    }
  },

  checkAll: async () => {
    const ids = get().order.filter((id) => get().statuses[id]?.installed && get().statuses[id]?.hasAccount);
    await Promise.all(ids.map((id) => get().check(id)));
  },

  signIn: async (id, account) => {
    try {
      await ipc.cliSignIn(id, account);
    } catch (e) {
      toastError(e, "Couldn't start the sign-in");
    }
  },

  setAllowed: async (id, account, allowed) => {
    try {
      get().put(await ipc.cliSetAllowed(id, account, allowed));
    } catch (e) {
      toastError(e, "Couldn't save that");
    }
  },
}));
