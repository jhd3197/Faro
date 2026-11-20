import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import type { RuleSet } from "@/lib/types";

interface RulesState {
  sets: RuleSet[];
  loaded: boolean;
  load: () => Promise<void>;
  save: (set: RuleSet) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** Settings › Rules rule sets (persisted in `rules.json` by the backend). */
export const useRules = create<RulesState>((set) => ({
  sets: [],
  loaded: false,
  load: async () => {
    try {
      set({ sets: await ipc.rulesList(), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  save: async (rs) => set({ sets: await ipc.rulesSave(rs) }),
  remove: async (id) => set({ sets: await ipc.rulesDelete(id) }),
}));
