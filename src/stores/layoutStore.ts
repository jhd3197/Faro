import { create } from "zustand";
import type { ConnectionProfile, ImporterKind, ManagedToolId } from "@/lib/types";
import {
  normalizeSettingsTarget,
  type SettingsSectionId,
  type SettingsTarget,
} from "@/lib/settingsNav";

// Which app-level modal is open (mutually exclusive). Centralized here so the
// command palette, keyboard shortcuts and title-bar menus can all open them
// without prop-threading through App.
export type AppDialog =
  | "welcome"
  | "whatsNew"
  | "settings"
  | "newConnection"
  | "import"
  | "about"
  | "agentBridge"
  | "grant"
  | "export"
  | "invite"
  | "moveToCloudflare"
  | "clis";

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

  // Where Settings should land. Set by openSettings; cleared by a generic
  // open (the gear, Preferences, "Open Settings") so those stay on Appearance.
  settingsTarget: SettingsTarget | null;
  openSettings: (
    target: SettingsSectionId | string | { section: string; focus?: string; query?: string }
  ) => void;

  // Prefill for the New Connection editor, set by a faro:// deep link so the
  // editor opens pointed at the right server (never auto-connecting). Cleared
  // when the editor closes.
  connectionPrefill: Partial<ConnectionProfile> | null;
  openNewConnection: (prefill?: Partial<ConnectionProfile>) => void;

  // A saved connection whose editor should open (the rail owns that editor).
  editProfileId: string | null;
  openEditProfile: (id: string | null) => void;

  // Seed for the grant consent dialog (faro://grant deep link). Cleared when
  // the dialog closes.
  grantPrefill: GrantPrefill | null;
  openGrant: (prefill: GrantPrefill) => void;

  // Seed for the Export dialog; null = every connection. The Import dialog's
  // `importFile` opens it on the Faro tab with that file (a dropped `.faro`).
  exportRequest: ExportRequest | null;
  openExport: (req?: ExportRequest) => void;
  importFile: string | null;
  /** The tab Import opens on (the welcome screen links straight to a source). */
  importTab: ImporterKind | null;
  openImport: (file?: string, tab?: ImporterKind) => void;
  // Connections the Invite dialog shares (one server, or a folder's).
  inviteIds: string[];
  openInvite: (ids: string[]) => void;
  // The direct connection "Move behind Cloudflare" starts from.
  moveProfileId: string | null;
  openMoveToCloudflare: (id: string) => void;

  // The CLIs page (Plan 35): which CLI it opens on, and the Import dialog's
  // "From your CLIs" seed. Closing an import started there returns to it.
  cliSelect: ManagedToolId | null;
  openClis: (id?: ManagedToolId) => void;
  importCli: { tool: ManagedToolId; account?: string } | null;
  openImportCli: (tool?: ManagedToolId, account?: string) => void;
  returnTo: AppDialog | null;

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
  openDialog: (d) => set({ dialog: d, settingsTarget: null, returnTo: null }),
  closeDialog: () =>
    set((s) => ({
      dialog: s.returnTo && s.returnTo !== s.dialog ? s.returnTo : null,
      returnTo: null,
      settingsTarget: null,
      connectionPrefill: null,
      grantPrefill: null,
      exportRequest: null,
      importFile: null,
      importTab: null,
      importCli: null,
      inviteIds: [],
      moveProfileId: null,
    })),

  settingsTarget: null,
  openSettings: (target) => {
    const next = normalizeSettingsTarget(target);
    if (!next) return;
    set({ dialog: "settings", settingsTarget: next });
  },

  connectionPrefill: null,
  openNewConnection: (prefill) =>
    set({ dialog: "newConnection", connectionPrefill: prefill ?? null }),

  editProfileId: null,
  openEditProfile: (id) => set({ editProfileId: id }),

  grantPrefill: null,
  openGrant: (prefill) => set({ dialog: "grant", grantPrefill: prefill }),

  exportRequest: null,
  openExport: (req) => set({ dialog: "export", exportRequest: req ?? null }),
  importFile: null,
  importTab: null,
  openImport: (file, tab) => set({ dialog: "import", importFile: file ?? null, importTab: file ? "faro" : tab ?? null }),
  inviteIds: [],
  openInvite: (ids) => set({ dialog: "invite", inviteIds: ids }),
  moveProfileId: null,
  openMoveToCloudflare: (id) => set({ dialog: "moveToCloudflare", moveProfileId: id }),

  cliSelect: null,
  openClis: (id) => set({ dialog: "clis", cliSelect: id ?? null, settingsTarget: null, returnTo: null }),
  importCli: null,
  openImportCli: (tool, account) =>
    set((s) => ({
      dialog: "import",
      importTab: "cli",
      importFile: null,
      importCli: tool ? { tool, account } : null,
      returnTo: s.dialog === "clis" ? "clis" : null,
      cliSelect: s.dialog === "clis" ? tool ?? s.cliSelect : s.cliSelect,
    })),
  returnTo: null,

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
