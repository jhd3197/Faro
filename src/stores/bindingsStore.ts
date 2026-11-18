import { create } from "zustand";
import { ipc } from "@/lib/ipc";

// Keyboard-shortcut override layer (Plan 15 Phase 1). Default combos live in the
// command registry (src/lib/commands.tsx) and the file-browser catalog
// (src/lib/fileBrowserKeys.ts); this store holds only the user's *overrides*,
// keyed by command/action id. The effective binding is `override ?? default`
// (see effectiveCombo in src/lib/keybindings.ts).
//
// Persistence rides Plan 12's settings substrate — one `shortcut.<id>` row per
// override in faro.db. Because the pre-paint injector emits every settings row
// onto `window.__FARO_SETTINGS__`, overrides seed synchronously before first
// paint (no theme-flash-style async gap), and the encrypted backup carries them
// for free (it snapshots faro.db). No new backend beyond `settings_delete`.

/** faro.db key prefix for a shortcut override. */
export const SHORTCUT_PREFIX = "shortcut.";
/** faro.db key of the master "Enable keyboard shortcuts" switch. */
export const SHORTCUTS_ENABLED_KEY = "keyboard.enabled";

/** An override value of "" means the command is explicitly unbound (no
 *  shortcut); a non-empty string is the replacement combo; an absent id falls
 *  back to the registry default. */
type Overrides = Record<string, string>;

interface BindingsState {
  overrides: Overrides;
  /** Master switch. Off = no shortcut fires anywhere and no hints are shown;
   *  the overrides are kept for when it comes back on. */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  /** Set (or replace) an override. Pass "" to explicitly unbind. */
  setOverride: (id: string, combo: string) => void;
  /** Drop the override so the built-in default applies again. */
  clearOverride: (id: string) => void;
  /** Remove every override (Reset all to defaults). */
  resetAll: () => void;
  /** Reconcile from faro.db — for popouts/mock that miss the pre-paint inject. */
  hydrate: () => Promise<void>;
}

/** Seed synchronously from the Rust pre-paint injection. Injected values are
 *  already JSON-parsed (see build_settings_init_script), so a shortcut row is a
 *  plain combo string. Absent in popouts / mock builds → {}. */
function seedFromInjection(): Overrides {
  const out: Overrides = {};
  try {
    const inj = (globalThis as { __FARO_SETTINGS__?: unknown }).__FARO_SETTINGS__;
    if (inj && typeof inj === "object") {
      for (const [k, v] of Object.entries(inj as Record<string, unknown>)) {
        if (k.startsWith(SHORTCUT_PREFIX) && typeof v === "string") {
          out[k.slice(SHORTCUT_PREFIX.length)] = v;
        }
      }
    }
  } catch {
    // ignore
  }
  return out;
}

function seedEnabled(): boolean {
  try {
    const inj = (globalThis as { __FARO_SETTINGS__?: Record<string, unknown> }).__FARO_SETTINGS__;
    const v = inj?.[SHORTCUTS_ENABLED_KEY];
    return typeof v === "boolean" ? v : true;
  } catch {
    return true;
  }
}

function persistSet(id: string, combo: string) {
  ipc.settingsSet(SHORTCUT_PREFIX + id, JSON.stringify(combo)).catch(() => {
    // no backend (mock) — the in-memory override still applies this session
  });
}

function persistDelete(id: string) {
  ipc.settingsDelete(SHORTCUT_PREFIX + id).catch(() => {});
}

export const useBindings = create<BindingsState>((set, get) => ({
  overrides: seedFromInjection(),
  enabled: seedEnabled(),

  setEnabled: (on) => {
    set({ enabled: on });
    ipc.settingsSet(SHORTCUTS_ENABLED_KEY, JSON.stringify(on)).catch(() => {});
  },

  setOverride: (id, combo) => {
    set((s) => ({ overrides: { ...s.overrides, [id]: combo } }));
    persistSet(id, combo);
  },

  clearOverride: (id) => {
    set((s) => {
      if (!(id in s.overrides)) return s;
      const next = { ...s.overrides };
      delete next[id];
      return { overrides: next };
    });
    persistDelete(id);
  },

  resetAll: () => {
    const ids = Object.keys(get().overrides);
    set({ overrides: {} });
    for (const id of ids) persistDelete(id);
  },

  hydrate: async () => {
    try {
      const raw = await ipc.settingsGetAll();
      const next: Overrides = {};
      let enabled = true;
      for (const [k, v] of Object.entries(raw)) {
        if (k === SHORTCUTS_ENABLED_KEY) {
          try {
            enabled = JSON.parse(v) !== false;
          } catch {
            // keep the default
          }
          continue;
        }
        if (!k.startsWith(SHORTCUT_PREFIX)) continue;
        try {
          const parsed = JSON.parse(v);
          if (typeof parsed === "string") {
            next[k.slice(SHORTCUT_PREFIX.length)] = parsed;
          }
        } catch {
          // skip a corrupt row
        }
      }
      set({ overrides: next, enabled });
    } catch {
      // no backend — ignore
    }
  },
}));

// Windows that never receive the pre-paint injection (popouts, mock builds)
// seed from faro.db right after boot, mirroring settingsStore.
function hasInjection(): boolean {
  try {
    return !!(globalThis as { __FARO_SETTINGS__?: unknown }).__FARO_SETTINGS__;
  } catch {
    return false;
  }
}
if (!hasInjection()) {
  void useBindings.getState().hydrate();
}
