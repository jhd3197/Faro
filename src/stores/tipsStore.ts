import { create } from "zustand";
import { ipc } from "@/lib/ipc";

// One-time pointers to features, shown inside the real UI the first time they
// apply (Plan 32 Phase 4). Stored under "discovery*" keys beside the welcome
// state so Reset tips and Show welcome live together. Tips are for people
// starting out: someone who already had connections when tips first loaded
// gets every tip marked seen, never "first transfer" on their thousandth.
export type TipId = "first-connect" | "first-ssh" | "first-transfer" | "first-site";
export const ALL_TIPS: TipId[] = ["first-connect", "first-ssh", "first-transfer", "first-site"];
const SEEN_KEY = "discoveryTipsSeen";
const OFF_KEY = "discoveryTipsOff";

export const useTips = create<{
  loaded: boolean;
  enabled: boolean;
  seen: TipId[];
  /** Event tips raised this session (a transfer finished, a site was saved). */
  triggered: TipId[];
  init: () => Promise<void>;
  trigger: (id: TipId) => void;
  markSeen: (id: TipId) => void;
  setEnabled: (enabled: boolean) => void;
  reset: () => void;
}>((set, get) => ({
  loaded: false,
  enabled: true,
  seen: [],
  triggered: [],
  init: async () => {
    if (get().loaded) return;
    try {
      const settings = await ipc.settingsGetAll();
      let seen: TipId[] = [];
      if (settings[SEEN_KEY] === undefined) {
        const profiles = await ipc.listProfiles();
        seen = profiles.length > 0 ? [...ALL_TIPS] : [];
        void ipc.settingsSet(SEEN_KEY, JSON.stringify(seen)).catch(() => {});
      } else {
        try { seen = JSON.parse(settings[SEEN_KEY]); } catch { seen = [...ALL_TIPS]; }
      }
      set({ seen: Array.isArray(seen) ? seen : [...ALL_TIPS], enabled: settings[OFF_KEY] !== "true", loaded: true });
    } catch {
      // Unreadable settings: show nothing rather than repeat tips every launch.
      set({ loaded: false });
    }
  },
  trigger: (id) => {
    if (!get().triggered.includes(id)) set({ triggered: [...get().triggered, id] });
  },
  markSeen: (id) => {
    if (get().seen.includes(id)) return;
    const seen = [...get().seen, id];
    set({ seen });
    void ipc.settingsSet(SEEN_KEY, JSON.stringify(seen)).catch(() => {});
  },
  setEnabled: (enabled) => {
    set({ enabled });
    void ipc.settingsSet(OFF_KEY, enabled ? "false" : "true").catch(() => {});
  },
  reset: () => {
    set({ seen: [], enabled: true });
    void ipc.settingsSet(SEEN_KEY, "[]").catch(() => {});
    void ipc.settingsSet(OFF_KEY, "false").catch(() => {});
  },
}));
