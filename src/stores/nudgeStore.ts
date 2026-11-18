import { create } from "zustand";

/**
 * Dismissed nudges, remembered per item: closing "needs root" on one server
 * hides it there only, and "Not now" on a faro-cli update hides that version
 * only. Ids are `<nudge>:<item>` (see nudgeId). Kept in localStorage, newest
 * first and bounded, so a long-lived install doesn't grow it forever.
 * Settings › Reset tips clears it along with the tips.
 */
const KEY = "faro.nudges.dismissed.v1";
const MAX = 300;

/** The id of one nudge about one item (a server, a version…). */
export const nudgeId = (nudge: string, item: string) => `${nudge}:${item}`;

function load(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function save(ids: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(ids));
  } catch {
    // quota / private mode: the dismissal holds for this session only
  }
}

export const useNudges = create<{
  dismissed: string[];
  dismiss: (id: string) => void;
  reset: () => void;
}>((set, get) => ({
  dismissed: load(),
  dismiss: (id) => {
    const dismissed = [id, ...get().dismissed.filter((d) => d !== id)].slice(0, MAX);
    save(dismissed);
    set({ dismissed });
  },
  reset: () => {
    save([]);
    set({ dismissed: [] });
  },
}));

/** Whether the nudge `id` was dismissed (reactive). */
export function useNudgeDismissed(id: string | null): boolean {
  return useNudges((s) => (id ? s.dismissed.includes(id) : false));
}
