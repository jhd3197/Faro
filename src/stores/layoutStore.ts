import { create } from "zustand";
import type { ConnectionProfile } from "@/lib/types";

// Which app-level modal is open (mutually exclusive). Centralized here so the
// command palette, keyboard shortcuts and title-bar menus can all open them
// without prop-threading through App.
export type AppDialog =
  | "settings"
  | "newConnection"
  | "import"
  | "about"
  | "agentBridge"
  | "grant"
  | "export"
  | "invite";

/** What the Export dialog starts with: the connections to tick and format. */
export interface ExportRequest {
  ids: string[];
  format: "faro" | "openssh";
  /** Names the file, e.g. the connection or group exported. */
  label?: string;
}

/** Seed for the grant consent dialog, parsed from a faro://grant deep link. */
export interface GrantPrefill {
  issuer: string;
  token: string;
  name?: string;
}

interface LayoutState {
  terminalOpen: boolean;
  setTerminalOpen: (open: boolean) => void;
  toggleTerminal: () => void;

  // The Agent console is a dockable bottom panel (not a modal) so it can sit
  // open alongside the file browser and the Bridge control panel.
  consoleOpen: boolean;
  setConsoleOpen: (open: boolean) => void;
  toggleConsole: () => void;

  // The agent panel docked on the right of the file browser (pending
  // approvals, access for the focused server, live activity).
  agentDrawerOpen: boolean;
  setAgentDrawerOpen: (open: boolean) => void;
  toggleAgentDrawer: () => void;

  dialog: AppDialog | null;
  openDialog: (d: AppDialog) => void;
  closeDialog: () => void;

  // Prefill for the New Connection editor, set by a faro:// deep link so the
  // editor opens pointed at the right server (never auto-connecting). Cleared
  // when the editor closes.
  connectionPrefill: Partial<ConnectionProfile> | null;
  openNewConnection: (prefill?: Partial<ConnectionProfile>) => void;

  // Seed for the grant consent dialog (faro://grant deep link). Cleared when
  // the dialog closes.
  grantPrefill: GrantPrefill | null;
  openGrant: (prefill: GrantPrefill) => void;

  // Seed for the Export dialog; null = every connection. The Import dialog's
  // `importFile` opens it on the Faro tab with that file (a dropped `.faro`).
  exportRequest: ExportRequest | null;
  openExport: (req?: ExportRequest) => void;
  importFile: string | null;
  openImport: (file?: string) => void;
  // Connections the Invite dialog shares (one server, or a folder's).
  inviteIds: string[];
  openInvite: (ids: string[]) => void;

  // When true, the file browser shows the LOCAL filesystem instead of the
  // active server. Toggled by the rail's "Local" home bubble; cleared when a
  // server bubble is selected.
  browseLocal: boolean;
  setBrowseLocal: (v: boolean) => void;

  // A one-shot "show this path in the file browser" request (from the Disk
  // Usage explorer's "Reveal" action). The active browser consumes it and
  // clears it. `path` is the directory to open (a file's parent).
  revealTarget: { sessionId: string; path: string } | null;
  requestReveal: (sessionId: string, path: string) => void;
  clearReveal: () => void;

  paletteOpen: boolean;
  setPaletteOpen: (v: boolean) => void;
  togglePalette: () => void;

  shortcutsOpen: boolean;
  setShortcutsOpen: (v: boolean) => void;

  // Zen mode: only the file panes (plus any dock the user opens on purpose).
  // Toggle through `lib/windowMode`, which also handles full screen.
  zen: boolean;
  setZen: (v: boolean) => void;
}

export const useLayout = create<LayoutState>((set) => ({
  terminalOpen: false,
  setTerminalOpen: (open) => set({ terminalOpen: open }),
  toggleTerminal: () => set((s) => ({ terminalOpen: !s.terminalOpen })),

  consoleOpen: false,
  setConsoleOpen: (open) => set({ consoleOpen: open }),
  toggleConsole: () => set((s) => ({ consoleOpen: !s.consoleOpen })),

  agentDrawerOpen: false,
  setAgentDrawerOpen: (open) => set({ agentDrawerOpen: open }),
  toggleAgentDrawer: () => set((s) => ({ agentDrawerOpen: !s.agentDrawerOpen })),

  dialog: null,
  openDialog: (d) => set({ dialog: d }),
  closeDialog: () =>
    set({ dialog: null, connectionPrefill: null, grantPrefill: null, exportRequest: null, importFile: null, inviteIds: [] }),

  connectionPrefill: null,
  openNewConnection: (prefill) =>
    set({ dialog: "newConnection", connectionPrefill: prefill ?? null }),

  grantPrefill: null,
  openGrant: (prefill) => set({ dialog: "grant", grantPrefill: prefill }),

  exportRequest: null,
  openExport: (req) => set({ dialog: "export", exportRequest: req ?? null }),
  importFile: null,
  openImport: (file) => set({ dialog: "import", importFile: file ?? null }),
  inviteIds: [],
  openInvite: (ids) => set({ dialog: "invite", inviteIds: ids }),

  browseLocal: false,
  setBrowseLocal: (v) => set({ browseLocal: v }),

  revealTarget: null,
  requestReveal: (sessionId, path) => set({ revealTarget: { sessionId, path } }),
  clearReveal: () => set({ revealTarget: null }),

  paletteOpen: false,
  setPaletteOpen: (v) => set({ paletteOpen: v }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),

  shortcutsOpen: false,
  setShortcutsOpen: (v) => set({ shortcutsOpen: v }),

  zen: false,
  setZen: (v) => set({ zen: v }),
}));
