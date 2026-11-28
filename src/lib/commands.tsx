import type { ReactNode } from "react";
import {
  Plug,
  Unplug,
  Download,
  Plus,
  Settings as SettingsIcon,
  Info,
  TerminalSquare,
  ArrowDownUp,
  RefreshCw,
  Keyboard,
  Palette,
  SunMoon,
  Radio,
  Wand2,
  Braces,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Maximize2,
  X,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Eraser,
  TextSelect,
  ClipboardCopy,
  Save,
  RadioTower,
  ToggleLeft,
  Lock,
  Pin,
  CopyPlus,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Search,
  Fullscreen,
  Focus,
  PanelRight,
  Activity,
  PanelLeft,
  Images,
} from "lucide-react";
import { toggleFullscreen, toggleZen } from "@/lib/windowMode";
import { useConnections } from "@/stores/connectionsStore";
import { useIndex } from "@/stores/indexStore";
import { useTransfers } from "@/stores/transfersStore";
import { useLayout } from "@/stores/layoutStore";
import {
  useSettings,
  APP_THEMES,
  stepUiZoom,
} from "@/stores/settingsStore";
import { useSkills } from "@/stores/skillsStore";
import { useSnippets } from "@/stores/snippetsStore";
import { useTerminals, dockTabsOf } from "@/stores/terminalsStore";
import { openLocalTerminal } from "@/lib/localTerminal";
import {
  clearTerminal,
  copyTerminalOutput,
  saveTerminalOutput,
  selectAllTerminal,
  toggleBroadcast,
} from "@/lib/terminalActions";
import { LOCAL_SESSION } from "@/lib/types";
import { useServerView } from "@/stores/serverViewStore";
import { TERMINAL_CHORDS, termTabCommandId } from "@/lib/terminalChords";
import { SETTINGS_SECTIONS, settingsCommandId } from "@/lib/settingsNav";
import { SETTINGS_REGISTRY } from "@/lib/settingsRegistry";
import { SETTINGS_DEFAULTS, applySetting, type PersistedSettings } from "@/stores/settingsStore";
import { COMMAND_COMBOS } from "@/lib/bindingCatalog";
import { useFocusedItem } from "@/stores/focusStore";
import { toast } from "@/stores/toastStore";

export interface Command {
  id: string;
  title: string;
  group: string;
  icon?: ReactNode;
  combo?: string; // canonical, e.g. "mod+t"
  keywords?: string;
  enabled?: boolean; // default true
  /** Listed in Settings › Keyboard even without a default combo. */
  bindable?: boolean;
  /** Only offered once something is typed (one entry per setting would
   *  otherwise bury the list an empty palette shows). */
  searchOnly?: boolean;
  run: () => void;
}

// Single source of truth for app actions. Reads stores directly and returns
// freshly-bound command objects, so the palette, the shortcut hook and the
// cheat-sheet all stay in sync with current state.
export function useCommands(): Command[] {
  const profiles = useConnections((s) => s.profiles);
  const activeSessionId = useConnections((s) => s.activeSessionId);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const connect = useConnections((s) => s.connect);
  const disconnect = useConnections((s) => s.disconnect);
  const reconnect = useConnections((s) => s.reconnect);

  const togglePanel = useTransfers((s) => s.togglePanel);

  const toggleTerminal = useLayout((s) => s.toggleTerminal);
  const terminalOpen = useLayout((s) => s.terminalOpen);
  const toggleConsole = useLayout((s) => s.toggleConsole);
  const toggleAgentDrawer = useLayout((s) => s.toggleAgentDrawer);
  const zen = useLayout((s) => s.zen);
  const openDialog = useLayout((s) => s.openDialog);
  const openSettings = useLayout((s) => s.openSettings);
  const setShortcutsOpen = useLayout((s) => s.setShortcutsOpen);
  const openSkills = useSkills((s) => s.openPanel);
  const snippets = useSnippets((s) => s.snippets);

  const settingValues = useSettings() as unknown as Record<string, unknown>;
  const appTheme = useSettings((s) => s.appTheme);
  const setAppTheme = useSettings((s) => s.setAppTheme);
  const uiZoom = useSettings((s) => s.uiZoom);
  const setUiZoom = useSettings((s) => s.setUiZoom);

  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const supportsTerminal = activeProfile?.protocol === "sftp";
  const serverViewOpen = useServerView((s) => s.open);
  const railExpanded = useSettings((s) => s.railExpanded);
  const setRailExpanded = useSettings((s) => s.setRailExpanded);
  const focused = useFocusedItem((s) => s.item);
  const focusedSession = focused?.kind === "file" ? focused.sessionId : null;
  const sessions = useConnections((s) => s.sessions);
  const focusedProfileId = sessions.find((x) => x.sessionId === focusedSession)?.profileId;
  const focusedShell =
    focused?.kind === "file" &&
    focused.isDir &&
    (focused.sessionId === LOCAL_SESSION ||
      profiles.find((p) => p.id === focusedProfileId)?.protocol === "sftp");

  const cmds: Command[] = [
    {
      id: "new-connection",
      title: "New Connection…",
      group: "File",
      icon: <Plus size={14} />,
      combo: "mod+n",
      run: () => openDialog("newConnection"),
    },
    {
      id: "import",
      title: "Import Connections…",
      group: "File",
      icon: <Download size={14} />,
      run: () => openDialog("import"),
    },
    {
      id: "settings",
      title: "Open Settings",
      group: "General",
      icon: <SettingsIcon size={14} />,
      combo: "mod+,",
      run: () => openDialog("settings"),
    },
    ...SETTINGS_SECTIONS.map((sec) => ({
      id: settingsCommandId(sec.id),
      title: sec.label,
      group: "Settings",
      icon: <SettingsIcon size={14} />,
      keywords: `settings preferences ${sec.keywords}`,
      run: () => openSettings(sec.id),
    })),
    {
      id: "shortcuts",
      title: "Keyboard Shortcuts",
      group: "General",
      icon: <Keyboard size={14} />,
      combo: "mod+/",
      run: () => setShortcutsOpen(true),
    },
    {
      id: "agent-bridge",
      title: "Agent Bridge…",
      group: "General",
      icon: <Radio size={14} />,
      keywords: "agent bridge mcp claude code remote exec",
      run: () => openDialog("agentBridge"),
    },
    {
      id: "clis",
      title: "CLIs…",
      group: "General",
      icon: <TerminalSquare size={14} />,
      keywords: "cli command line tools aws gcloud azure az gh github tailscale doctl digitalocean hcloud hetzner render hubspot hs shopify cloudflared 1password bitwarden sign in login import",
      run: () => openDialog("clis"),
    },
    {
      id: "fleet-skills",
      title: "Fleet Skills…",
      group: "General",
      icon: <Wand2 size={14} />,
      keywords: "skill skills fleet automation run command multi server mcp agent",
      run: () => openSkills(),
    },
    {
      id: "index-search",
      title: "Search indexed files…",
      group: "General",
      icon: <Images size={14} />,
      keywords: "index photos images library date camera tag search find media dam",
      run: () => useIndex.getState().openSearch(),
    },
    {
      id: "snippets",
      title: "Snippets…",
      group: "General",
      icon: <Braces size={14} />,
      keywords: "snippet snippets command template variable insert manage terminal",
      run: () => useSnippets.getState().openPanel(),
    },
    {
      id: "agent-console",
      title: "Toggle Agent console (live)",
      group: "General",
      icon: <TerminalSquare size={14} />,
      keywords: "agent console live output stream terminal bridge watch dock",
      run: () => toggleConsole(),
    },
    {
      id: "welcome",
      title: "Welcome — Get Connected",
      keywords: "welcome onboarding get started import first connection",
      group: "General",
      icon: <Info size={14} />,
      run: () => openDialog("welcome"),
    },
    {
      id: "whats-new",
      title: "What's New",
      group: "General",
      icon: <Info size={14} />,
      run: () => openDialog("whatsNew"),
    },
    {
      id: "about",
      title: "About Faro",
      group: "General",
      icon: <Info size={14} />,
      run: () => openDialog("about"),
    },
    {
      id: "reload",
      title: "Reload Window",
      group: "General",
      icon: <RefreshCw size={14} />,
      combo: "mod+r",
      run: () => window.location.reload(),
    },
    {
      id: "toggle-transfers",
      title: "Toggle Transfer Panel",
      group: "View",
      icon: <ArrowDownUp size={14} />,
      combo: "mod+t",
      run: togglePanel,
    },
    {
      id: "toggle-terminal",
      title: "Toggle Terminal",
      group: "View",
      icon: <TerminalSquare size={14} />,
      combo: COMMAND_COMBOS["toggle-terminal"],
      run: toggleTerminal,
    },
    {
      id: "new-local-terminal",
      title: "New Local Terminal",
      group: "View",
      icon: <TerminalSquare size={14} />,
      keywords: "terminal shell local powershell bash zsh cmd wsl this computer",
      bindable: true,
      run: () => void openLocalTerminal(),
    },
    {
      id: "open-terminal-here",
      title: "Open Terminal in Focused Folder",
      group: "View",
      icon: <TerminalSquare size={14} />,
      keywords: "terminal shell here cd folder focused",
      bindable: true,
      enabled: !!focusedShell,
      run: () => {
        if (focused?.kind !== "file" || !focused.isDir) return;
        if (focused.sessionId === LOCAL_SESSION) {
          void openLocalTerminal({ cwd: focused.path });
          return;
        }
        useLayout.getState().setTerminalOpen(true);
        const quoted = "'" + focused.path.replace(/'/g, "'\\''") + "'";
        useTerminals.getState().openTab(focused.sessionId, `cd ${quoted}\n`);
      },
    },
    {
      id: "toggle-rail",
      title: railExpanded ? "Collapse Server Rail" : "Expand Server Rail",
      group: "View",
      icon: <PanelLeft size={14} />,
      combo: COMMAND_COMBOS["toggle-rail"],
      keywords: "rail sidebar servers collapse expand pin",
      run: () => setRailExpanded(!railExpanded),
    },
    {
      id: "server-view",
      title: serverViewOpen ? "Close Server View" : "Server View",
      group: "View",
      icon: <Activity size={14} />,
      keywords:
        "server dashboard monitor cpu memory ram network load services systemd ports firewall metrics",
      enabled: !!activeSessionId && supportsTerminal,
      run: () => {
        const view = useServerView.getState();
        if (view.open) view.close();
        else if (activeSessionId) void view.openFor(activeSessionId);
      },
    },
    {
      id: "toggle-fullscreen",
      title: "Toggle Full Screen",
      group: "View",
      icon: <Fullscreen size={14} />,
      combo: "f11",
      keywords: "full screen fullscreen maximize window",
      run: () => void toggleFullscreen(),
    },
    {
      id: "toggle-zen",
      title: zen ? "Leave Zen Mode" : "Zen Mode",
      group: "View",
      icon: <Focus size={14} />,
      combo: "mod+alt+z",
      keywords: "zen focus distraction free minimal hide sidebar menus panes",
      run: () => void toggleZen(),
    },
    {
      id: "toggle-agent-panel",
      title: "Toggle Agent Panel",
      group: "View",
      icon: <PanelRight size={14} />,
      combo: "mod+shift+a",
      keywords: "agent panel drawer approvals access",
      run: toggleAgentDrawer,
    },
    {
      id: "switch-theme",
      title: "Toggle Light / Dark Theme",
      group: "View",
      icon: <SunMoon size={14} />,
      combo: "mod+shift+t",
      run: () => useSettings.getState().toggleLightDark(),
    },
    {
      id: "zoom-in",
      title: "Zoom In",
      group: "View",
      icon: <ZoomIn size={14} />,
      combo: "mod+=",
      keywords: "zoom scale bigger larger font size ui",
      run: () => setUiZoom(stepUiZoom(uiZoom, 1)),
    },
    {
      id: "zoom-out",
      title: "Zoom Out",
      group: "View",
      icon: <ZoomOut size={14} />,
      combo: "mod+-",
      keywords: "zoom scale smaller font size ui",
      run: () => setUiZoom(stepUiZoom(uiZoom, -1)),
    },
    {
      id: "zoom-reset",
      title: "Actual Size",
      group: "View",
      icon: <Search size={14} />,
      combo: "mod+0",
      keywords: "zoom reset 100% scale ui",
      enabled: uiZoom !== 100,
      run: () => setUiZoom(100),
    },
  ];

  // Every setting is reachable by name: an on/off setting flips right here,
  // anything else opens Settings searching for it.
  for (const entry of SETTINGS_REGISTRY) {
    if (!(entry.key in SETTINGS_DEFAULTS)) continue;
    const section = SETTINGS_SECTIONS.find((s) => s.id === entry.section)?.label ?? "";
    const keywords = `setting settings preference option ${section} ${entry.keywords ?? ""}`;
    if (entry.kind === "toggle") {
      const on = !!settingValues[entry.key];
      cmds.push({
        id: `setting:${entry.key}`,
        title: `${entry.label}: turn ${on ? "off" : "on"}`,
        group: "Settings",
        icon: <ToggleLeft size={14} />,
        keywords: `${keywords} toggle enable disable`,
        searchOnly: true,
        run: () => void applySetting(entry.key as keyof PersistedSettings, !on as never),
      });
    } else {
      cmds.push({
        id: `setting:${entry.key}`,
        title: `Setting: ${entry.label}`,
        group: "Settings",
        icon: <SettingsIcon size={14} />,
        keywords,
        searchOnly: true,
        run: () => openSettings({ section: entry.section, query: entry.label }),
      });
    }
  }

  // Terminal split controls — only while a terminal is on screen. They act on
  // the active tab's active pane; the chords are swallowed by xterm (see
  // terminalChords) so they never reach the shell.
  const terminalActive = terminalOpen;
  const activeTab = () => {
    const t = useTerminals.getState();
    return t.tabs.find((x) => x.id === t.activeId) ?? null;
  };
  cmds.push(
    {
      id: "term-split-right",
      title: "Terminal: Split right",
      group: "Terminal",
      icon: <SplitSquareHorizontal size={14} />,
      combo: TERMINAL_CHORDS.splitRight,
      enabled: terminalActive,
      run: () => {
        const tab = activeTab();
        if (tab) useTerminals.getState().splitActivePane(tab.id, "row");
      },
    },
    {
      id: "term-split-down",
      title: "Terminal: Split down",
      group: "Terminal",
      icon: <SplitSquareVertical size={14} />,
      combo: TERMINAL_CHORDS.splitDown,
      enabled: terminalActive,
      run: () => {
        const tab = activeTab();
        if (tab) useTerminals.getState().splitActivePane(tab.id, "col");
      },
    },
    {
      id: "term-zoom-pane",
      title: "Terminal: Zoom / unzoom pane",
      group: "Terminal",
      icon: <Maximize2 size={14} />,
      combo: TERMINAL_CHORDS.zoom,
      enabled: terminalActive,
      run: () => {
        const tab = activeTab();
        if (tab) useTerminals.getState().toggleZoom(tab.id);
      },
    },
    {
      id: "term-close-pane",
      title: "Terminal: Close pane",
      group: "Terminal",
      icon: <X size={14} />,
      combo: TERMINAL_CHORDS.closePane,
      enabled: terminalActive,
      run: () => {
        const tab = activeTab();
        if (!tab) return;
        if (tab.locked && tab.root.kind === "leaf") {
          toast.info("This tab is locked", "Unlock it to close it.");
          return;
        }
        useTerminals.getState().closePane(tab.id, tab.activePaneId);
      },
    }
  );

  // Terminal tab strip: reopen, jump, cycle, move. Same rule as the split
  // chords — live only while the terminal is on screen, and kept from the
  // shell by terminalChords.
  const strip = () => {
    const t = useTerminals.getState();
    const tabs = dockTabsOf(t.tabs, supportsTerminal ? activeSessionId : null);
    return { t, tabs, at: tabs.findIndex((x) => x.id === t.activeId) };
  };
  const goTo = (pick: (n: number, at: number) => number) => {
    const { t, tabs, at } = strip();
    if (tabs.length === 0) return;
    const tab = tabs[pick(tabs.length, at)];
    if (tab) t.setActive(tab.id);
  };
  const shift = (by: number) => {
    const { t, tabs, at } = strip();
    if (at >= 0) t.moveTab(tabs[at].id, at + by);
  };
  cmds.push({
    id: "term-reopen-tab",
    title: "Terminal: Reopen closed tab",
    group: "Terminal",
    icon: <RotateCcw size={14} />,
    combo: TERMINAL_CHORDS.reopenTab,
    keywords: "undo close restore tab shell",
    enabled: terminalActive,
    run: () => {
      const t = useTerminals.getState();
      const current = t.tabs.find((x) => x.id === t.activeId)?.sessionId;
      const tab = t.reopenClosed(current ?? activeSessionId ?? LOCAL_SESSION);
      if (!tab) toast.info("No closed tabs to reopen");
    },
  });
  for (let n = 1; n <= 8; n++) {
    cmds.push({
      id: termTabCommandId(n),
      title: `Terminal: Go to tab ${n}`,
      group: "Terminal",
      icon: <TerminalSquare size={14} />,
      combo: `mod+${n}`,
      enabled: terminalActive,
      run: () => goTo((len) => (n <= len ? n - 1 : -1)),
    });
  }
  cmds.push(
    {
      id: "term-tab-last",
      title: "Terminal: Go to last tab",
      group: "Terminal",
      icon: <TerminalSquare size={14} />,
      combo: TERMINAL_CHORDS.lastTab,
      enabled: terminalActive,
      run: () => goTo((len) => len - 1),
    },
    {
      id: "term-tab-prev",
      title: "Terminal: Previous tab",
      group: "Terminal",
      icon: <ChevronLeft size={14} />,
      combo: TERMINAL_CHORDS.prevTab,
      enabled: terminalActive,
      run: () => goTo((len, at) => (at - 1 + len) % len),
    },
    {
      id: "term-tab-next",
      title: "Terminal: Next tab",
      group: "Terminal",
      icon: <ChevronRight size={14} />,
      combo: TERMINAL_CHORDS.nextTab,
      enabled: terminalActive,
      run: () => goTo((len, at) => (at + 1) % len),
    },
    {
      id: "term-tab-move-left",
      title: "Terminal: Move tab left",
      group: "Terminal",
      icon: <ChevronsLeft size={14} />,
      bindable: true,
      enabled: terminalActive,
      run: () => shift(-1),
    },
    {
      id: "term-tab-move-right",
      title: "Terminal: Move tab right",
      group: "Terminal",
      icon: <ChevronsRight size={14} />,
      bindable: true,
      enabled: terminalActive,
      run: () => shift(1),
    }
  );

  cmds.push(
    {
      id: "term-clear",
      title: "Terminal: Clear",
      group: "Terminal",
      icon: <Eraser size={14} />,
      combo: TERMINAL_CHORDS.clear,
      keywords: "clear wipe scrollback screen reset cls",
      enabled: terminalActive,
      run: () => clearTerminal(),
    },
    {
      id: "term-select-all",
      title: "Terminal: Select all output",
      group: "Terminal",
      icon: <TextSelect size={14} />,
      keywords: "select all output scrollback",
      bindable: true,
      enabled: terminalActive,
      run: () => selectAllTerminal(),
    },
    {
      id: "term-copy-output",
      title: "Terminal: Copy all output",
      group: "Terminal",
      icon: <ClipboardCopy size={14} />,
      keywords: "copy output scrollback clipboard log",
      bindable: true,
      enabled: terminalActive,
      run: () => void copyTerminalOutput(),
    },
    {
      id: "term-save-output",
      title: "Terminal: Save output to file…",
      group: "Terminal",
      icon: <Save size={14} />,
      keywords: "save export output scrollback log file",
      bindable: true,
      enabled: terminalActive,
      run: () => void saveTerminalOutput(),
    },
    {
      id: "term-lock-tab",
      title: "Terminal: Lock / unlock tab",
      group: "Terminal",
      icon: <Lock size={14} />,
      keywords: "lock protect close accident tab",
      bindable: true,
      enabled: terminalActive,
      run: () => {
        const tab = activeTab();
        if (tab) useTerminals.getState().toggleLock(tab.id);
      },
    },
    {
      id: "term-pin-tab",
      title: "Terminal: Pin / unpin tab",
      group: "Terminal",
      icon: <Pin size={14} />,
      keywords: "pin keep first tab",
      bindable: true,
      enabled: terminalActive,
      run: () => {
        const tab = activeTab();
        if (tab) useTerminals.getState().togglePin(tab.id);
      },
    },
    {
      id: "term-duplicate-tab",
      title: "Terminal: Duplicate tab",
      group: "Terminal",
      icon: <CopyPlus size={14} />,
      keywords: "duplicate clone copy tab shell same server",
      bindable: true,
      enabled: terminalActive,
      run: () => {
        const tab = activeTab();
        if (tab) useTerminals.getState().duplicateTab(tab.id);
      },
    },
    {
      id: "term-broadcast",
      title: "Terminal: Toggle broadcast input",
      group: "Terminal",
      icon: <RadioTower size={14} />,
      keywords: "broadcast type every pane all panes multi synchronize input",
      bindable: true,
      enabled: terminalActive,
      run: () => toggleBroadcast(),
    }
  );

  if (activeSessionId) {
    cmds.push({
      id: "disconnect",
      title: "Disconnect",
      group: "Connection",
      icon: <Unplug size={14} />,
      run: () => disconnect(),
    });
    cmds.push({
      id: "reconnect",
      title: "Reconnect",
      group: "Connection",
      icon: <RefreshCw size={14} />,
      combo: COMMAND_COMBOS.reconnect,
      run: () => reconnect().catch(() => {}),
    });
  }

  for (const p of profiles) {
    cmds.push({
      id: `connect:${p.id}`,
      title: `Connect: ${p.name}`,
      group: "Connection",
      icon: <Plug size={14} />,
      keywords: `${p.username} ${p.host} ${p.protocol}`,
      enabled: activeProfileId !== p.id,
      run: () => {
        connect(p.id).catch(() => {});
      },
    });
  }

  for (const t of APP_THEMES) {
    cmds.push({
      id: `theme:${t.value}`,
      title: `Theme: ${t.label}`,
      group: "Theme",
      icon: <Palette size={14} />,
      enabled: appTheme !== t.value,
      run: () => setAppTheme(t.value),
    });
  }

  // Snippet insert commands — only actionable when a shell is available. The
  // insert targets the focused terminal; the store toasts if there's none.
  for (const s of snippets) {
    cmds.push({
      id: `snippet:${s.id}`,
      title: `Insert snippet: ${s.name}`,
      group: "Snippets",
      icon: <Braces size={14} />,
      keywords: `snippet ${s.folder ?? ""} ${s.body}`,
      enabled: !!activeSessionId && supportsTerminal,
      run: () => useSnippets.getState().requestInsert(s),
    });
  }

  return cmds;
}
