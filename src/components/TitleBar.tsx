import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Sun,
  Moon,
  Settings as SettingsIcon,
  Minus,
  Square,
  Copy as CopySquares,
  X,
  Plus,
  Download,
  TerminalSquare,
  ArrowDownUp,
  Github,
  Info,
  ExternalLink,
  RefreshCw,
  Command as CommandIcon,
  Keyboard,
  Radio,
  ZoomIn,
  ZoomOut,
  Search,
} from "lucide-react";
import { useSettings, stepUiZoom } from "@/stores/settingsStore";
import { useLayout } from "@/stores/layoutStore";
import { useTransfers } from "@/stores/transfersStore";
import { useResolvedCommands } from "@/lib/keybindings";
import { formatCombo } from "@/lib/shortcuts";
import { cn } from "@/lib/cn";
import { openExternal } from "@/lib/openExternal";

const APP_VERSION = "v1.3";
const REPO_URL = "https://github.com/jhd3197/faro";

/// Single custom title bar — replaces the OS chrome + the old app header.
/// Draggable region via `data-tauri-drag-region` (Tauri picks it up); the
/// menu buttons and window controls explicitly opt out via `data-no-drag`
/// (handled by them being interactive elements — Tauri skips drag handling
/// when the event target is a button or has the explicit attribute).
export function TitleBar() {
  const appTheme = useSettings((s) => s.appTheme);
  const setAppTheme = useSettings((s) => s.setAppTheme);
  const uiZoom = useSettings((s) => s.uiZoom);
  const setUiZoom = useSettings((s) => s.setUiZoom);
  const toggleTerminal = useLayout((s) => s.toggleTerminal);
  const openDialog = useLayout((s) => s.openDialog);
  const togglePalette = useLayout((s) => s.togglePalette);
  const setShortcutsOpen = useLayout((s) => s.setShortcutsOpen);
  const togglePanel = useTransfers((s) => s.togglePanel);
  const [maximized, setMaximized] = useState(false);

  // Menu shortcut labels read the same effective (override-aware) combos as the
  // palette and cheat-sheet, so a remap in Settings shows up here too.
  const commands = useResolvedCommands();
  const comboOf = (id: string) => {
    const c = commands.find((x) => x.id === id);
    return c?.combo ? formatCombo(c.combo) : undefined;
  };

  // Track window state so the maximize icon flips to "restore" when needed.
  useEffect(() => {
    const win = getCurrentWindow();
    win.isMaximized().then(setMaximized).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaximized).catch(() => {});
    });
    return () => {
      unlisten.then((u) => u()).catch(() => {});
    };
  }, []);

  const win = getCurrentWindow();
  const minimize = () => win.minimize();
  const toggleMaximize = () => win.toggleMaximize();
  const close = () => win.close();
  const switchTheme = () =>
    setAppTheme(appTheme === "light" ? "dark" : "light");

  const menus: MenuSpec[] = [
    {
      label: "File",
      items: [
        {
          label: "New connection",
          icon: <Plus size={11} />,
          shortcut: comboOf("new-connection"),
          onClick: () => openDialog("newConnection"),
        },
        {
          label: "Import connections…",
          icon: <Download size={11} />,
          onClick: () => openDialog("import"),
        },
        { kind: "sep" },
        {
          label: "Quit",
          shortcut: "Alt+F4",
          onClick: close,
        },
      ],
    },
    {
      label: "Edit",
      items: [
        {
          label: "Preferences…",
          icon: <SettingsIcon size={11} />,
          shortcut: comboOf("settings"),
          onClick: () => openDialog("settings"),
        },
        { kind: "sep" },
        {
          label: "Reload window",
          icon: <RefreshCw size={11} />,
          shortcut: comboOf("reload"),
          onClick: () => window.location.reload(),
        },
      ],
    },
    {
      label: "View",
      items: [
        {
          label: "Command palette…",
          icon: <CommandIcon size={11} />,
          shortcut: formatCombo("mod+k"),
          onClick: togglePalette,
        },
        { kind: "sep" },
        {
          label: "Toggle terminal",
          icon: <TerminalSquare size={11} />,
          shortcut: comboOf("toggle-terminal"),
          onClick: toggleTerminal,
        },
        {
          label: "Toggle transfer queue",
          icon: <ArrowDownUp size={11} />,
          shortcut: comboOf("toggle-transfers"),
          onClick: togglePanel,
        },
        { kind: "sep" },
        {
          label: "Agent Bridge…",
          icon: <Radio size={11} />,
          onClick: () => openDialog("agentBridge"),
        },
        { kind: "sep" },
        {
          label: appTheme === "light" ? "Switch to dark theme" : "Switch to light theme",
          icon: appTheme === "light" ? <Moon size={11} /> : <Sun size={11} />,
          shortcut: comboOf("switch-theme"),
          onClick: switchTheme,
        },
        { kind: "sep" },
        {
          label: "Zoom in",
          icon: <ZoomIn size={11} />,
          shortcut: comboOf("zoom-in"),
          onClick: () => setUiZoom(stepUiZoom(uiZoom, 1)),
        },
        {
          label: "Zoom out",
          icon: <ZoomOut size={11} />,
          shortcut: comboOf("zoom-out"),
          onClick: () => setUiZoom(stepUiZoom(uiZoom, -1)),
        },
        {
          label: "Actual size",
          icon: <Search size={11} />,
          shortcut: comboOf("zoom-reset"),
          onClick: () => setUiZoom(100),
        },
      ],
    },
    {
      label: "Help",
      items: [
        {
          label: "Keyboard shortcuts",
          icon: <Keyboard size={11} />,
          shortcut: comboOf("shortcuts"),
          onClick: () => setShortcutsOpen(true),
        },
        {
          label: "About Faro",
          icon: <Info size={11} />,
          onClick: () => openDialog("about"),
        },
        { kind: "sep" },
        {
          label: "GitHub repository",
          icon: <Github size={11} />,
          onClick: () => openExternal(REPO_URL),
          rightIcon: <ExternalLink size={9} />,
        },
        {
          label: "Report an issue",
          onClick: () => openExternal(`${REPO_URL}/issues/new`),
          rightIcon: <ExternalLink size={9} />,
        },
      ],
    },
  ];

  return (
    <div
      data-tauri-drag-region
      className="flex h-9 shrink-0 select-none items-center gap-1 border-b border-border bg-bg-panel px-2"
    >
      <Logo />
      <span
        className="text-[13px] font-semibold tracking-tight"
        data-tauri-drag-region
      >
        Faro
      </span>
      <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent">
        {APP_VERSION}
      </span>

      <MenuBar menus={menus} />

      <div className="flex-1" data-tauri-drag-region />

      {/* Light/dark now lives in Settings → Appearance (Mode); the View menu
          item + Ctrl+Shift+T still toggle it for quick access. */}
      <IconButton onClick={() => openDialog("settings")} title="Settings">
        <SettingsIcon size={13} />
      </IconButton>

      <div className="ml-1 flex h-9 items-stretch">
        <WindowButton onClick={minimize} title="Minimize">
          <Minus size={12} />
        </WindowButton>
        <WindowButton onClick={toggleMaximize} title={maximized ? "Restore" : "Maximize"}>
          {maximized ? <CopySquares size={11} /> : <Square size={11} />}
        </WindowButton>
        <WindowButton onClick={close} title="Close" danger>
          <X size={13} />
        </WindowButton>
      </div>
    </div>
  );
}

// ---- Menu primitives ---------------------------------------------------

type MenuItem =
  | {
      kind?: "item";
      label: string;
      icon?: React.ReactNode;
      rightIcon?: React.ReactNode;
      shortcut?: string;
      onClick: () => void;
    }
  | { kind: "sep" };

interface MenuSpec {
  label: string;
  items: MenuItem[];
}

function MenuBar({ menus }: { menus: MenuSpec[] }) {
  // `open` is the index of the currently-open menu (-1 = none). Hover-switch
  // works once any menu is open, matching Windows/Office behaviour.
  const [open, setOpen] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open < 0) return;
    const onDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(-1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(-1);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="ml-2 flex items-center">
      {menus.map((m, i) => (
        <div key={m.label} className="relative">
          <button
            aria-haspopup="true"
            aria-expanded={open === i}
            onClick={() => setOpen(open === i ? -1 : i)}
            onMouseEnter={() => {
              if (open >= 0) setOpen(i);
            }}
            className={cn(
              "rounded px-2 py-0.5 text-[12px] transition-colors",
              open === i
                ? "bg-bg-hover text-text"
                : "text-text-muted hover:bg-bg-hover hover:text-text"
            )}
          >
            {m.label}
          </button>
          {open === i && (
            <MenuDropdown items={m.items} onClose={() => setOpen(-1)} />
          )}
        </div>
      ))}
    </div>
  );
}

function MenuDropdown({
  items,
  onClose,
}: {
  items: MenuItem[];
  onClose: () => void;
}) {
  return (
    <div
      role="menu"
      className="anim-modal absolute left-0 top-7 z-menu min-w-[14rem] overflow-hidden rounded-md border border-border bg-bg-panel shadow-elev-3"
    >
      {items.map((item, i) => {
        if ("kind" in item && item.kind === "sep") {
          return (
            <div
              key={`sep-${i}`}
              role="separator"
              className="my-0.5 h-px bg-border-subtle"
            />
          );
        }
        const it = item as Extract<MenuItem, { label: string }>;
        return (
          <button
            key={it.label + i}
            role="menuitem"
            onClick={() => {
              onClose();
              // Defer the action one tick so the dropdown unmounts before the
              // handler runs anything (e.g. an alert / dialog).
              setTimeout(it.onClick, 0);
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] text-text-muted transition-colors hover:bg-bg-hover hover:text-text"
          >
            <span className="flex h-3 w-3 items-center justify-center">
              {it.icon}
            </span>
            <span className="flex-1">{it.label}</span>
            {it.rightIcon && (
              <span className="text-text-dim">{it.rightIcon}</span>
            )}
            {it.shortcut && (
              <span className="ml-2 font-mono text-[10px] text-text-dim">
                {it.shortcut}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ---- Window control buttons --------------------------------------------

function WindowButton({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={cn(
        "flex h-9 w-11 items-center justify-center text-text-muted transition-colors",
        danger
          ? "hover:bg-danger hover:text-white"
          : "hover:bg-bg-hover hover:text-text"
      )}
    >
      {children}
    </button>
  );
}

function IconButton({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text"
    >
      {children}
    </button>
  );
}

// ---- Logo --------------------------------------------------------------

function Logo() {
  return (
    <div className="ml-1 mr-1 flex h-5 w-5 items-center justify-center rounded-md text-white shadow-elev-1 btn-accent">
      <svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor">
        <path
          d="M9 5.5 L15 4 L15 8 L9 6.5 Z"
          fill="rgb(252 211 77)"
          opacity="0.85"
        />
        <path d="M5 4.2 L7 2.5 L9 4.2 Z" />
        <rect x="5.4" y="4.2" width="3.2" height="2" rx="0.2" />
        <path d="M5 6.2 L9 6.2 L9.4 13.5 L4.6 13.5 Z" />
        <rect x="4.6" y="9" width="4.8" height="0.7" fill="rgb(20 22 36)" />
      </svg>
    </div>
  );
}
