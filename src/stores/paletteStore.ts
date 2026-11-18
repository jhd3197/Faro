import { create } from "zustand";
import { ipc } from "@/lib/ipc";

// Recently run palette commands, most recent first. The palette lists them
// when it opens with an empty query, so it is never a blank box. Stored as one
// JSON row in faro.db (like the shortcut overrides), seeded from the pre-paint
// injection where it exists and hydrated from the backend otherwise.

/** faro.db key of the recent-commands list. */
export const PALETTE_RECENT_KEY = "palette.recent";
/** How many recent commands are kept. */
export const RECENT_MAX = 8;

interface PaletteState {
  recent: string[];
  /** Move `id` to the front of the list and persist it. */
  record: (id: string) => void;
  clearRecent: () => void;
  hydrate: () => Promise<void>;
}

function clean(v: unknown): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string").slice(0, RECENT_MAX)
    : [];
}

function seed(): string[] {
  try {
    const inj = (globalThis as { __FARO_SETTINGS__?: Record<string, unknown> }).__FARO_SETTINGS__;
    return clean(inj?.[PALETTE_RECENT_KEY]);
  } catch {
    return [];
  }
}

function persist(ids: string[]) {
  ipc.settingsSet(PALETTE_RECENT_KEY, JSON.stringify(ids)).catch(() => {});
}

export const usePalette = create<PaletteState>((set, get) => ({
  recent: seed(),

  record: (id) => {
    const next = [id, ...get().recent.filter((x) => x !== id)].slice(0, RECENT_MAX);
    set({ recent: next });
    persist(next);
  },

  clearRecent: () => {
    set({ recent: [] });
    persist([]);
  },

  hydrate: async () => {
    try {
      const raw = await ipc.settingsGetAll();
      const v = raw[PALETTE_RECENT_KEY];
      if (v !== undefined) set({ recent: clean(JSON.parse(v)) });
    } catch {
      // no backend or a corrupt row: keep what we have
    }
  },
}));

if (!(globalThis as { __FARO_SETTINGS__?: unknown }).__FARO_SETTINGS__) {
  void usePalette.getState().hydrate();
}
