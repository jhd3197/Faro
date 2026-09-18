import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Palette, ArrowDownUp, FolderTree, TerminalSquare, Plug, Radio, Ban, Check, Info, MonitorSmartphone, FolderSync, ShieldAlert, Loader2, Keyboard } from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { ACCENTS } from "@/lib/accent";
import {
  useSettings,
  COLOR_THEMES,
  type AppTheme,
  type OverwritePolicy,
  type SortField,
  type SortDirection,
  type PaneViewMode,
  type PaneDensity,
  type BrowserLayout,
  type TerminalTheme,
} from "@/stores/settingsStore";
import { useBridge } from "@/stores/bridgeStore";
import { ipc } from "@/lib/ipc";
import { toast } from "@/stores/toastStore";
import { toastError } from "@/lib/errors";
import type { BackupSummary } from "@/lib/types";
import { open, save } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/cn";
import { RemoteControlSettings } from "./RemoteControlSettings";
import { SyncSettings } from "./SyncSettings";
import { CliUpdaterSettings } from "./CliUpdaterSettings";
import { KeyboardSettings } from "./KeyboardSettings";
import { AboutSettings } from "./AboutSettings";

interface Props {
  onClose: () => void;
}

type SectionId =
  | "appearance"
  | "transfers"
  | "panes"
  | "terminal"
  | "keyboard"
  | "connections"
  | "remoteControl"
  | "sync"
  | "bridge"
  | "cli"
  | "backup"
  | "about";

const SECTIONS: { id: SectionId; label: string; icon: React.ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette size={14} /> },
  { id: "transfers", label: "Transfers", icon: <ArrowDownUp size={14} /> },
  { id: "panes", label: "File panes", icon: <FolderTree size={14} /> },
  { id: "terminal", label: "Terminal", icon: <TerminalSquare size={14} /> },
  { id: "keyboard", label: "Keyboard", icon: <Keyboard size={14} /> },
  { id: "connections", label: "Connections", icon: <Plug size={14} /> },
  { id: "remoteControl", label: "Remote control", icon: <MonitorSmartphone size={14} /> },
  { id: "sync", label: "Folder Sync", icon: <FolderSync size={14} /> },
  { id: "bridge", label: "Agent Bridge", icon: <Radio size={14} /> },
  { id: "cli", label: "faro-cli", icon: <TerminalSquare size={14} /> },
  { id: "backup", label: "Backup", icon: <ShieldAlert size={14} /> },
  { id: "about", label: "About", icon: <Info size={14} /> },
];

export function Settings({ onClose }: Props) {
  const s = useSettings();

  // Agent Bridge approval policy lives in the Rust backend (it enforces it), so
  // these toggles read/write the same source as the Agent Bridge panel.
  const policy = useBridge((b) => b.status.policy);
  const setPolicy = useBridge((b) => b.setPolicy);
  const refreshBridge = useBridge((b) => b.refresh);
  useEffect(() => {
    refreshBridge();
  }, [refreshBridge]);

  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, { onClose });

  const [active, setActive] = useState<SectionId>("appearance");

  const renderContent = () => {
    switch (active) {
      case "appearance":
        return (
          <>
            <Field
              label="Mode"
              help="The light or dark base. Pick a named color palette below to override it."
            >
              <Segmented<AppTheme>
                value={s.appTheme}
                onChange={s.setAppTheme}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
              />
            </Field>
            <Field
              label="Accent color"
              help="The highlight color for buttons, links, focus rings, the active rail pill and selection. Layers on top of the mode and palette below."
            >
              <AccentGrid value={s.accentColor} onChange={s.setAccentColor} />
            </Field>
            <Field
              label="Color palette"
              help="Full presets that also re-tint the surfaces, not just the accent."
            >
              <ThemeGrid value={s.appTheme} onChange={s.setAppTheme} />
            </Field>
          </>
        );

      case "transfers":
        return (
          <>
            <Field label="When the destination already exists">
              <Segmented<OverwritePolicy>
                value={s.overwritePolicy}
                onChange={s.setOverwritePolicy}
                options={[
                  { value: "overwrite", label: "Overwrite" },
                  { value: "skip", label: "Skip" },
                  { value: "rename", label: "Rename" },
                ]}
              />
              <Help>
                The default action — applied for the rest of a batch after you
                choose “apply to all”, or to every transfer when the prompt below
                is off.{" "}
                {s.overwritePolicy === "overwrite" &&
                  "Overwrite replaces the existing file in place."}
                {s.overwritePolicy === "skip" &&
                  "Skip leaves the existing file alone and marks the transfer skipped."}
                {s.overwritePolicy === "rename" &&
                  "Rename appends _1, _2, … until a free name is found."}
              </Help>
            </Field>
            <ToggleField
              label="Ask before overwriting"
              help="Prompt before a transfer overwrites an existing file (overwrite / keep both / skip). Turn off to apply the default action above silently."
              checked={s.promptOnOverwrite}
              onChange={s.setPromptOnOverwrite}
            />
            <ToggleField
              label="Open the transfer panel automatically"
              help="When a new transfer starts, slide the bottom panel into view."
              checked={s.autoOpenTransferPanel}
              onChange={s.setAutoOpenTransferPanel}
            />
            <Field
              label="Concurrent transfers"
              help="How many transfers run at once. Extra transfers wait in a first-in, first-out queue."
            >
              <NumberInput
                min={1}
                max={32}
                value={s.transferConcurrency}
                onChange={s.setTransferConcurrency}
              />
            </Field>
            <Field
              label="Bandwidth limit"
              help="Global cap shared by all active transfers. 0 = unlimited."
            >
              <NumberInput
                min={0}
                max={1024 * 1024}
                value={s.transferThrottleKbps}
                onChange={s.setTransferThrottleKbps}
                suffix="KiB/s"
              />
            </Field>
            <ToggleField
              label="Delta sync (send only changed blocks)"
              help="Re-transferring a changed file sends just the differing blocks instead of the whole file. Only for Faro Agent connections, files ≥ 8 MB."
              checked={s.deltaSync}
              onChange={s.setDeltaSync}
            />
            <Field
              label="Download folder"
              help="Where downloads land. Leave blank to use your system Downloads folder."
            >
              <div className="flex w-full items-center gap-1.5">
                <input
                  value={s.defaultDownloadFolder}
                  onChange={(e) => s.setDefaultDownloadFolder(e.target.value)}
                  placeholder="System Downloads"
                  className="min-w-0 flex-1 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-sm outline-none focus:border-accent"
                />
                <button
                  onClick={async () => {
                    const picked = await open({
                      directory: true,
                      title: "Choose a download folder",
                    });
                    if (typeof picked === "string")
                      s.setDefaultDownloadFolder(picked);
                  }}
                  className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-sm text-text-muted hover:bg-bg-hover hover:text-text"
                >
                  Browse…
                </button>
                {s.defaultDownloadFolder && (
                  <button
                    onClick={() => s.setDefaultDownloadFolder("")}
                    className="shrink-0 rounded-md border border-border px-2 py-1.5 text-xs text-text-dim hover:text-text"
                    title="Reset to system Downloads"
                  >
                    Reset
                  </button>
                )}
              </div>
            </Field>
          </>
        );

      case "panes":
        return (
          <>
            <ToggleField
              label="Show hidden files"
              help="Files and directories whose name starts with a dot."
              checked={s.showHiddenFiles}
              onChange={s.setShowHiddenFiles}
            />
            <Field label="Default sort">
              <Select<SortField>
                value={s.sortField}
                onChange={s.setSortField}
                options={[
                  { value: "name", label: "Name" },
                  { value: "size", label: "Size" },
                  { value: "modified", label: "Modified" },
                ]}
              />
              <Segmented<SortDirection>
                value={s.sortDirection}
                onChange={s.setSortDirection}
                options={[
                  { value: "asc", label: "Asc" },
                  { value: "desc", label: "Desc" },
                ]}
              />
            </Field>
            <Field label="View" help="Switchable from the toolbar too.">
              <Segmented<PaneViewMode>
                value={s.paneViewMode}
                onChange={s.setPaneViewMode}
                options={[
                  { value: "details", label: "Details" },
                  { value: "list", label: "List" },
                  { value: "grid", label: "Grid" },
                ]}
              />
              <Segmented<PaneDensity>
                value={s.paneDensity}
                onChange={s.setPaneDensity}
                options={[
                  { value: "comfortable", label: "Comfortable" },
                  { value: "compact", label: "Compact" },
                ]}
              />
            </Field>
            <Field
              label="Browser layout"
              help="Single = one server-focused pane (Upload button). Split = local and remote side by side."
            >
              <Segmented<BrowserLayout>
                value={s.browserLayout}
                onChange={s.setBrowserLayout}
                options={[
                  { value: "single", label: "Single" },
                  { value: "dual", label: "Split" },
                ]}
              />
            </Field>
            <ToggleField
              label="Remote image previews"
              help="Show thumbnails for images on remote connections (SFTP, S3, FTP, …). Off by default — previews are fetched over the network, but only for the rows you scroll to, capped and cached. Local images always preview. Toggle per connection from the file toolbar."
              checked={s.remoteImagePreviews === "on"}
              onChange={(v) => s.setRemoteImagePreviews(v ? "on" : "off")}
            />
            <Field
              label="Default editor"
              help="Command used to open files for edit-in-place (e.g. code). Blank = your OS default app."
            >
              <div className="flex w-full items-center gap-1.5">
                <input
                  value={s.defaultEditor}
                  onChange={(e) => s.setDefaultEditor(e.target.value)}
                  placeholder="OS default app"
                  className="min-w-0 flex-1 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-sm outline-none focus:border-accent"
                />
                <button
                  onClick={() => s.setDefaultEditor("code")}
                  className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-sm text-text-muted hover:bg-bg-hover hover:text-text"
                  title="Use VS Code (the `code` command)"
                >
                  VS Code
                </button>
                {s.defaultEditor && (
                  <button
                    onClick={() => s.setDefaultEditor("")}
                    className="shrink-0 rounded-md border border-border px-2 py-1.5 text-xs text-text-dim hover:text-text"
                    title="Reset to OS default"
                  >
                    Reset
                  </button>
                )}
              </div>
            </Field>
          </>
        );

      case "terminal":
        return (
          <>
            <Field label="Font size">
              <NumberInput
                min={8}
                max={32}
                value={s.terminalFontSize}
                onChange={s.setTerminalFontSize}
                suffix="px"
              />
            </Field>
            <Field label="Font family">
              <Select<string>
                value={s.terminalFontFamily}
                onChange={s.setTerminalFontFamily}
                options={[
                  {
                    value:
                      '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace',
                    label: "JetBrains Mono",
                  },
                  {
                    value: '"Fira Code", Consolas, monospace',
                    label: "Fira Code",
                  },
                  {
                    value: '"Cascadia Code", Consolas, monospace',
                    label: "Cascadia Code",
                  },
                  {
                    value: "Menlo, Consolas, monospace",
                    label: "Menlo / Consolas",
                  },
                  { value: "monospace", label: "System default" },
                ]}
              />
            </Field>
            <Field label="Theme">
              <Select<TerminalTheme>
                value={s.terminalTheme}
                onChange={s.setTerminalTheme}
                options={[
                  { value: "dark", label: "Dark" },
                  { value: "light", label: "Light" },
                  { value: "dracula", label: "Dracula" },
                  { value: "solarized-dark", label: "Solarized Dark" },
                  { value: "gruvbox-dark", label: "Gruvbox Dark" },
                  { value: "onedark", label: "One Dark" },
                  { value: "rosepine", label: "Rosé Pine" },
                  { value: "everforest", label: "Everforest" },
                ]}
              />
              <Help>Applies live to open terminals.</Help>
            </Field>
            <Field label="Scrollback">
              <Select<number>
                value={s.terminalScrollback}
                onChange={s.setTerminalScrollback}
                options={[
                  { value: 1000, label: "1,000 lines" },
                  { value: 5000, label: "5,000 lines" },
                  { value: 10000, label: "10,000 lines" },
                  { value: 50000, label: "50,000 lines" },
                ]}
              />
              <Help>Takes effect on the next opened terminal.</Help>
            </Field>
            <ToggleField
              label="Copy on select"
              help="Copy the selected text to the clipboard the moment you select it in the terminal (PuTTY-style). Paste as usual with Ctrl/⌘+V or a right-click."
              checked={s.terminalCopyOnSelect}
              onChange={s.setTerminalCopyOnSelect}
            />
            <ToggleField
              label="Inline suggestions"
              help="As you type a command, show the most recent matching command from this server's history as dim ghost text — press → to accept it. History is kept locally per profile."
              checked={s.terminalSuggestions}
              onChange={s.setTerminalSuggestions}
            />
          </>
        );

      case "connections":
        return (
          <Field label="Default port for new profiles">
            <NumberInput
              min={1}
              max={65535}
              value={s.defaultPort}
              onChange={s.setDefaultPort}
            />
          </Field>
        );

      case "remoteControl":
        return <RemoteControlSettings />;

      case "cli":
        return <CliUpdaterSettings />;

      case "sync":
        return <SyncSettings />;

      case "bridge":
        return (
          <>
            <ToggleField
              label="Allow all — no prompts"
              help="Let connected AI agents run every request (commands, reads, transfers) on enabled sessions without asking. Most permissive."
              checked={policy.allowAll}
              onChange={(v) => setPolicy({ ...policy, allowAll: v })}
            />
            {!policy.allowAll && (
              <>
                <ToggleField
                  label="Auto-approve read-only operations"
                  help="List directories, read files and search run without asking. Downloads & uploads write to disk, so they still prompt unless Allow all is on."
                  checked={policy.autoRead}
                  onChange={(v) => setPolicy({ ...policy, autoRead: v })}
                />
                <ToggleField
                  label="Auto-approve safe shell commands"
                  help="Read-only commands (ls, cat, df, grep…) run without asking; anything that could change the server still prompts. Best-effort heuristic."
                  checked={policy.autoSafeExec}
                  onChange={(v) => setPolicy({ ...policy, autoSafeExec: v })}
                />
              </>
            )}
            <Help>
              与智能代理桥接面板相同的设置 — 对所有启用代理的会话生效，并在重启后保留。
            </Help>
          </>
        );

      case "keyboard":
        return <KeyboardSettings />;

      case "backup":
        return <BackupSettings />;

      case "about":
        return <AboutSettings />;
    }
  };

  const activeLabel = SECTIONS.find((sec) => sec.id === active)?.label;

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="anim-modal flex h-[34rem] max-h-[88vh] w-[52rem] max-w-[94vw] overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        {/* Left navigation — macOS / FileZilla-style section list. */}
        <nav className="flex w-48 shrink-0 flex-col gap-0.5 border-r border-border bg-bg-subtle/50 p-2">
          <div
            id={titleId}
            className="px-2 pb-2 pt-1 text-[15px] font-semibold tracking-tight"
          >
            Settings
          </div>
          {SECTIONS.map((sec) => {
            const on = active === sec.id;
            return (
              <button
                key={sec.id}
                onClick={() => setActive(sec.id)}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                  on
                    ? "bg-accent-soft text-accent"
                    : "text-text-muted hover:bg-bg-hover hover:text-text"
                )}
              >
                <span className={on ? "text-accent" : "text-text-dim"}>
                  {sec.icon}
                </span>
                <span className="truncate">{sec.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Content pane for the active section. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center border-b border-border px-6 py-3.5">
            <span className="text-sm font-semibold">{activeLabel}</span>
            <div className="flex-1" />
            <button
              onClick={onClose}
              className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text"
            >
              <X size={14} />
            </button>
          </div>

          <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
            {renderContent()}
          </div>

          <div className="flex items-center justify-between border-t border-border px-6 py-3">
            <span className="text-xs text-text-dim">
              Settings persist locally.
            </span>
            <button
              onClick={onClose}
              className="btn-accent rounded-md px-3.5 py-1.5 text-sm font-medium text-white"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// An (i) that reveals its help on hover/focus — replaces the always-on subtitle
// so titles stay clean. Portals to <body> so it's never clipped by the dialog's
// scroll area and sits above the modal.
function InfoTip({ text }: { text: string }) {
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(
    null
  );
  const ref = useRef<HTMLButtonElement>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setCoords({ left: r.left + r.width / 2, top: r.top - 6 });
  };
  const hide = () => setCoords(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-label="More info"
        className="inline-flex text-text-dim transition-colors hover:text-text"
      >
        <Info size={13} />
      </button>
      {coords &&
        createPortal(
          <span
            role="tooltip"
            style={{
              left: coords.left,
              top: coords.top,
              transform: "translate(-50%, -100%)",
            }}
            className="anim-fade pointer-events-none fixed z-tooltip w-64 max-w-[80vw] rounded-md border border-border bg-bg-panel px-2.5 py-1.5 text-[11px] leading-snug text-text-muted shadow-elev-2"
          >
            {text}
          </span>,
          document.body
        )}
    </>
  );
}

function Field({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-sm">{label}</span>
        {help && <InfoTip text={help} />}
      </div>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

function Help({ children }: { children: React.ReactNode }) {
  return <div className="mt-1 w-full text-xs text-text-dim">{children}</div>;
}

// Encrypted backup / restore (Plan 12 Phase 4). Export writes a single
// password-protected container carrying profiles, faro.db, subsystem configs,
// and all keychain credentials; restore stages it for the next launch.
function BackupSettings() {
  const [exportPw, setExportPw] = useState("");
  const [exportPw2, setExportPw2] = useState("");
  const [exporting, setExporting] = useState(false);

  const [importPath, setImportPath] = useState<string | null>(null);
  const [importPw, setImportPw] = useState("");
  const [pending, setPending] = useState<BackupSummary | null>(null);
  const [importing, setImporting] = useState(false);

  const btn =
    "rounded-md border border-border px-3 py-1.5 text-sm text-text transition-colors hover:bg-bg-hover disabled:opacity-50";
  const input =
    "w-full rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-sm outline-none focus:border-accent";
  const danger =
    "rounded-md border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-sm text-red-400 transition-colors hover:bg-red-500/20 disabled:opacity-50";

  const doExport = async () => {
    if (exportPw.length < 8) {
      toast.warning("Weak password", "Use at least 8 characters.");
      return;
    }
    if (exportPw !== exportPw2) {
      toast.warning("Passwords don't match");
      return;
    }
    const path = await save({
      title: "Save Faro backup",
      defaultPath: "faro-backup.farobak",
      filters: [{ name: "Faro backup", extensions: ["farobak"] }],
    });
    if (!path) return;
    setExporting(true);
    try {
      const s = await ipc.backupExport(path, exportPw);
      setExportPw("");
      setExportPw2("");
      toast.success(
        "Backup created",
        `${s.profiles} profile${s.profiles === 1 ? "" : "s"}, ${s.credentials} credential${
          s.credentials === 1 ? "" : "s"
        }, and app state — encrypted.`
      );
    } catch (e) {
      toastError(e, "Backup failed");
    } finally {
      setExporting(false);
    }
  };

  const chooseFile = async () => {
    const path = await open({
      title: "Choose a Faro backup",
      multiple: false,
      filters: [{ name: "Faro backup", extensions: ["farobak"] }],
    });
    if (typeof path === "string") {
      setImportPath(path);
      setPending(null);
    }
  };

  // Step 1: decrypt + preview ("what's inside") — also validates the password.
  const doInspect = async () => {
    if (!importPath || !importPw) return;
    setImporting(true);
    try {
      const s = await ipc.backupInspect(importPath, importPw);
      setPending(s);
    } catch (e) {
      toastError(e, "Couldn't open backup");
    } finally {
      setImporting(false);
    }
  };

  // Step 2: apply it (staged for next launch; credentials injected now).
  const doImport = async () => {
    if (!importPath || !importPw) return;
    setImporting(true);
    try {
      await ipc.backupImport(importPath, importPw);
      setPending(null);
      setImportPw("");
      setImportPath(null);
      toast.success(
        "Backup restored",
        "Restart Faro to finish applying it — your connections and secrets are ready."
      );
    } catch (e) {
      toastError(e, "Restore failed");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Export */}
      <div>
        <div className="mb-1 text-sm font-medium">Create an encrypted backup</div>
        <Help>
          一个受密码保护的文件，包含连接配置、已保存的凭据（SSH 密码、云令牌和 AI API 密钥）、应用设置及同步对。采用 Argon2id + AES-256-GCM 加密，没有密码无法使用，请妥善保管。
        </Help>
        <div className="mt-2 flex flex-col gap-2">
          <input
            type="password"
            value={exportPw}
            onChange={(e) => setExportPw(e.target.value)}
            placeholder="Backup password"
            className={input}
            autoComplete="new-password"
          />
          <input
            type="password"
            value={exportPw2}
            onChange={(e) => setExportPw2(e.target.value)}
            placeholder="Confirm password"
            className={input}
            autoComplete="new-password"
          />
          <div>
            <button type="button" className={btn} onClick={doExport} disabled={exporting}>
              {exporting ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" /> Exporting…
                </span>
              ) : (
                "Export backup…"
              )}
            </button>
          </div>
        </div>
      </div>

      <div className="h-px bg-border" />

      {/* Restore */}
      <div>
        <div className="mb-1 flex items-center gap-1.5 text-sm font-medium text-red-400">
          <ShieldAlert size={14} /> Restore from a backup
        </div>
        <Help>
          使用备份中的配置、设置和已保存凭据替换本机数据。重启 Faro 后生效。
        </Help>
        <div className="mt-2 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <button type="button" className={btn} onClick={chooseFile} disabled={importing}>
              Choose backup file…
            </button>
            {importPath && (
              <span className="truncate text-xs text-text-dim" title={importPath}>
                {importPath.split(/[\\/]/).pop()}
              </span>
            )}
          </div>
          {importPath && (
            <input
              type="password"
              value={importPw}
              onChange={(e) => {
                setImportPw(e.target.value);
                setPending(null);
              }}
              placeholder="Backup password"
              className={input}
              autoComplete="off"
            />
          )}
          {importPath && !pending && (
            <div>
              <button
                type="button"
                className={btn}
                onClick={doInspect}
                disabled={importing || !importPw}
              >
                {importing ? "Checking…" : "Preview contents"}
              </button>
            </div>
          )}
          {pending && (
            <div className="rounded-md border border-border bg-bg-subtle p-3 text-sm">
              <div className="mb-1.5 font-medium">This backup contains</div>
              <ul className="mb-2.5 list-inside list-disc text-text-muted">
                <li>
                  {pending.profiles} connection profile
                  {pending.profiles === 1 ? "" : "s"}
                </li>
                <li>
                  {pending.credentials} saved credential
                  {pending.credentials === 1 ? "" : "s"} (keychain)
                </li>
                <li>app settings + state {pending.hasSync ? "+ sync pairs" : ""}</li>
              </ul>
              <button
                type="button"
                className={danger}
                onClick={doImport}
                disabled={importing}
              >
                {importing ? "Restoring…" : "Restore & overwrite current data"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ToggleField({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="text-sm">{label}</span>
        {help && <InfoTip text={help} />}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors",
        checked
          ? "bg-accent border-accent"
          : "bg-bg-subtle border-border hover:border-text-dim"
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-elev-1 transition-transform",
          checked ? "translate-x-4" : "translate-x-0"
        )}
      />
    </button>
  );
}

function ThemeGrid({
  value,
  onChange,
}: {
  value: AppTheme;
  onChange: (v: AppTheme) => void;
}) {
  return (
    <div className="grid w-full grid-cols-3 gap-2">
      {COLOR_THEMES.map((t) => {
        const active = value === t.value;
        return (
          <button
            key={t.value}
            onClick={() => onChange(t.value)}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
              active
                ? "border-accent bg-accent/10"
                : "border-border bg-bg-subtle hover:border-text-dim"
            )}
          >
            <span
              className="h-4 w-4 shrink-0 rounded-full border border-white/10"
              style={{ background: t.swatch }}
            />
            <span
              className={cn(
                "truncate text-xs font-medium",
                active ? "text-text" : "text-text-muted"
              )}
            >
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function AccentGrid({
  value,
  onChange,
}: {
  value: string;
  onChange: (hex: string) => void;
}) {
  const lower = value.toLowerCase();
  const isPreset = ACCENTS.some((a) => a.hex.toLowerCase() === lower);
  const isCustom = value !== "" && !isPreset;
  const chip =
    "flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors";
  return (
    <div className="w-full space-y-2.5">
      <div className="flex items-center gap-2">
        <button
          onClick={() => onChange("")}
          className={cn(
            chip,
            value === ""
              ? "border-accent bg-accent/10 text-text"
              : "border-border text-text-muted hover:border-text-dim hover:text-text"
          )}
        >
          <Ban size={12} /> Theme default
        </button>
        <label
          title="Pick any color"
          className={cn(
            chip,
            "cursor-pointer",
            isCustom
              ? "border-accent bg-accent/10 text-text"
              : "border-border text-text-muted hover:border-text-dim hover:text-text"
          )}
        >
          <span
            className="h-3.5 w-3.5 rounded-full border border-white/20"
            style={{
              background: isCustom
                ? value
                : "conic-gradient(from 0deg, #ef4444, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #ef4444)",
            }}
          />
          Custom
          <input
            type="color"
            value={isCustom ? value : "#8b7ff6"}
            onChange={(e) => onChange(e.target.value)}
            className="sr-only"
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ACCENTS.map((a) => {
          const active = lower === a.hex.toLowerCase();
          return (
            <button
              key={a.hex}
              onClick={() => onChange(a.hex)}
              title={a.name}
              aria-label={a.name}
              aria-pressed={active}
              style={{ background: a.hex }}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-md ring-offset-2 ring-offset-bg-panel transition-all",
                active
                  ? "ring-2 ring-accent"
                  : "ring-1 ring-black/10 hover:ring-2 hover:ring-white/50"
              )}
            >
              {active && (
                <Check size={12} className="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.7)]" />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex rounded-md border border-border bg-bg-subtle p-0.5">
      {options.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-[5px] px-3 py-1 text-xs font-medium transition-colors",
              active
                ? "bg-bg-panel text-text shadow-elev-1"
                : "text-text-muted hover:text-text"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Select<T extends string | number>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <select
      value={value as string | number}
      onChange={(e) => {
        const raw = e.target.value;
        const sample = options[0]?.value;
        const parsed =
          typeof sample === "number" ? (Number(raw) as T) : (raw as T);
        onChange(parsed);
      }}
      className="rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-sm outline-none hover:border-text-dim focus:border-accent"
    >
      {options.map((o) => (
        <option key={String(o.value)} value={o.value as string | number}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function NumberInput({
  min,
  max,
  value,
  onChange,
  suffix,
}: {
  min: number;
  max: number;
  value: number;
  onChange: (n: number) => void;
  suffix?: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) =>
          onChange(
            Math.max(
              min,
              Math.min(max, parseInt(e.target.value) || min)
            )
          )
        }
        className="w-20 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-sm outline-none focus:border-accent"
      />
      {suffix && <span className="text-xs text-text-dim">{suffix}</span>}
    </div>
  );
}
