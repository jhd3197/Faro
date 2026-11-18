import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import { onBeforeClose } from "@/lib/closeGuard";

/**
 * Sizes of the resizable regions around the file browser (preview panel,
 * agent drawer, terminal / console / transfer docks), which of them are
 * collapsed to a strip, and the file-list column widths. One JSON row in
 * faro.db, seeded from the pre-paint injection so panels open at their saved
 * size on the first frame; without the injection (a secondary window, the
 * browser mock) it hydrates from the backend and `ready` flips when done.
 *
 * The dual-pane split ratio itself lives in the session snapshot.
 */

export const PANEL_SIZES_KEY = "layout.panels";
const SAVE_DELAY_MS = 300;

export interface PanelState {
  /** Expanded size in px (width or height, per panel). */
  size?: number;
  collapsed?: boolean;
}

/** Column weights (percent of the list width) keyed by column id. */
export type ColumnWidths = Record<string, number>;

interface Saved {
  panels: Record<string, PanelState>;
  columns: ColumnWidths | null;
}

interface PanelSizesState extends Saved {
  /** True once the saved sizes are known (render panels only then). */
  ready: boolean;
  setSize: (id: string, size: number) => void;
  setCollapsed: (id: string, collapsed: boolean) => void;
  /** Size and collapsed state in one write (a drag that ends collapsed). */
  setPanel: (id: string, next: PanelState) => void;
  resetPanel: (id: string) => void;
  setColumns: (widths: ColumnWidths | null) => void;
  hydrate: () => Promise<void>;
  flush: () => Promise<void>;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

export function parsePanelSizes(raw: unknown): Saved {
  let value = raw;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  const out: Saved = { panels: {}, columns: null };
  if (!value || typeof value !== "object") return out;
  const o = value as Record<string, unknown>;
  if (o.panels && typeof o.panels === "object") {
    for (const [id, p] of Object.entries(o.panels as Record<string, unknown>)) {
      if (!p || typeof p !== "object") continue;
      const q = p as Record<string, unknown>;
      const size = num(q.size);
      out.panels[id] = { ...(size !== undefined && { size }), ...(q.collapsed === true && { collapsed: true }) };
    }
  }
  if (o.columns && typeof o.columns === "object") {
    const cols: ColumnWidths = {};
    for (const [k, v] of Object.entries(o.columns as Record<string, unknown>)) {
      const n = num(v);
      if (n !== undefined && n > 0 && n <= 100) cols[k] = n;
    }
    if (Object.keys(cols).length) out.columns = cols;
  }
  return out;
}

function injected(): Saved | null {
  const inj = (globalThis as { __FARO_SETTINGS__?: Record<string, unknown> }).__FARO_SETTINGS__;
  if (!inj) return null;
  return parsePanelSizes(inj[PANEL_SIZES_KEY]);
}

let timer: ReturnType<typeof setTimeout> | undefined;
let dirty = false;

function schedule() {
  dirty = true;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void usePanelSizes.getState().flush(); }, SAVE_DELAY_MS);
}

const initial = injected();

export const usePanelSizes = create<PanelSizesState>((set, get) => ({
  panels: initial?.panels ?? {},
  columns: initial?.columns ?? null,
  ready: !!initial,

  setSize: (id, size) => get().setPanel(id, { ...get().panels[id], size: Math.round(size) }),
  setCollapsed: (id, collapsed) => get().setPanel(id, { ...get().panels[id], collapsed }),
  setPanel: (id, next) => {
    const prev = get().panels[id] ?? {};
    const merged: PanelState = { size: next.size ?? prev.size, collapsed: next.collapsed ?? prev.collapsed };
    if (merged.size === prev.size && !!merged.collapsed === !!prev.collapsed) return;
    set((s) => ({ panels: { ...s.panels, [id]: merged } }));
    schedule();
  },
  resetPanel: (id) => {
    if (!get().panels[id]) return;
    set((s) => {
      const panels = { ...s.panels };
      delete panels[id];
      return { panels };
    });
    schedule();
  },
  setColumns: (widths) => {
    set({ columns: widths && Object.keys(widths).length ? widths : null });
    schedule();
  },

  hydrate: async () => {
    try {
      const all = await ipc.settingsGetAll();
      // Keep anything changed while the load was in flight.
      if (!dirty) set(parsePanelSizes(all[PANEL_SIZES_KEY]));
    } catch {
      // No backend: defaults.
    } finally {
      set({ ready: true });
    }
  },

  flush: async () => {
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (!dirty) return;
    dirty = false;
    const { panels, columns } = get();
    await ipc.settingsSet(PANEL_SIZES_KEY, JSON.stringify({ panels, columns })).catch(() => { dirty = true; });
  },
}));

if (!initial) void usePanelSizes.getState().hydrate();
onBeforeClose(() => usePanelSizes.getState().flush());
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => { void usePanelSizes.getState().flush(); });
}
