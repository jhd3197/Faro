import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, Palette, ArrowDownUp, FolderTree, TerminalSquare, Cloud, Plug, Radio, Ban, Check, Info, MonitorSmartphone, FolderSync, ShieldAlert, Loader2, Keyboard, HardDrive, RotateCcw } from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { ACCENTS } from "@/lib/accent";
import type { UiLanguage } from "@/lib/i18n";
import {
  useSettings,
  LIGHT_THEMES,
  DARK_THEMES,
  TERMINAL_THEMES,
  SETTINGS_DEFAULTS,
  UI_ZOOM_STEPS,
  type AppTheme,
  type PersistedSettings,
  type ThemeMode,
  type FrameStyle,
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
import type { BackupSummary, CacheId, CacheUsage } from "@/lib/types";
import { fmtSize } from "@/lib/format";
import { useBindings } from "@/stores/bindingsStore";
import { open, save } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/cn";
import { RemoteControlSettings } from "./RemoteControlSettings";
import { SyncSettings } from "./SyncSettings";
import { CliUpdaterSettings } from "./CliUpdaterSettings";
import { CloudflareSettings } from "./CloudflareSettings";
import { KeyboardSettings } from "./KeyboardSettings";
import { Dropdown } from "./ui/Dropdown";
import { AboutSettings } from "./AboutSettings";
import { useLayout } from "@/stores/layoutStore";
import { useSession } from "@/stores/sessionStore";
import {
  SETTINGS_FOCUS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settingsNav";

interface Props {
  onClose: () => void;
}

const SECTION_ICONS: Record<SettingsSectionId, React.ReactNode> = {
  appearance: <Palette size={14} />,
  transfers: <ArrowDownUp size={14} />,
  panes: <FolderTree size={14} />,
  terminal: <TerminalSquare size={14} />,
  keyboard: <Keyboard size={14} />,
  connections: <Plug size={14} />,
  remoteControl: <MonitorSmartphone size={14} />,
  sync: <FolderSync size={14} />,
  bridge: <Radio size={14} />,
  cli: <TerminalSquare size={14} />,
  cloudflare: <Cloud size={14} />,
  backup: <ShieldAlert size={14} />,
  storage: <HardDrive size={14} />,
  about: <Info size={14} />,
};

// Which saved settings each section shows, for the "changed" dot in the nav.
// Sections that keep their config elsewhere are checked separately below.
const SECTION_SETTING_KEYS: Partial<Record<SettingsSectionId, (keyof PersistedSettings)[]>> = {
  appearance: ["themeMode", "lightTheme", "darkTheme", "accentColor", "uiZoom", "frameStyle", "uiLanguage"],
  transfers: [
    "overwritePolicy",
    "promptOnOverwrite",
    "autoOpenTransferPanel",
    "transferConcurrency",
    "transferThrottleKbps",
    "transferSegments",
    "transferVerify",
    "deltaSync",
    "defaultDownloadFolder",
  ],
  panes: [
    "showHiddenFiles",
    "sortField",
    "sortDirection",
    "paneViewMode",
    "paneDensity",
    "browserLayout",
    "remoteImagePreviews",
    "defaultEditor",
  ],
  terminal: [
    "terminalFontSize",
    "terminalFontFamily",
    "terminalTheme",
    "terminalScrollback",
    "terminalCopyOnSelect",
    "terminalSuggestions",
  ],
  connections: ["defaultPort", "storePasswordsInKeychain", "restoreLastSession"],
  about: ["notifications"],
};

/** Values that count as untouched besides the default: new installs start
 *  in System mode, older ones in Dark. */
const ALSO_DEFAULT: Partial<Record<keyof PersistedSettings, unknown[]>> = {
  themeMode: ["system"],
};

function isChangedSetting(key: keyof PersistedSettings, value: unknown): boolean {
  const same = (v: unknown) => JSON.stringify(v) === JSON.stringify(value);
  return !same(SETTINGS_DEFAULTS[key]) && !(ALSO_DEFAULT[key] ?? []).some(same);
}

/** Sections holding at least one non-default value. */
function useChangedSections(): Set<SettingsSectionId> {
  const s = useSettings();
  const policy = useBridge((b) => b.status.policy);
  const overrides = useBindings((b) => b.overrides);
  const shortcutsOn = useBindings((b) => b.enabled);
  const out = new Set<SettingsSectionId>();
  for (const [sec, keys] of Object.entries(SECTION_SETTING_KEYS) as [SettingsSectionId, (keyof PersistedSettings)[]][]) {
    if (keys.some((k) => isChangedSetting(k, s[k]))) out.add(sec);
  }
  if (policy.allowAll || policy.autoRead || policy.autoSafeExec) out.add("bridge");
  if (Object.keys(overrides).length > 0 || !shortcutsOn) out.add("keyboard");
  return out;
}

const SECTIONS: { id: SettingsSectionId; label: string; icon: React.ReactNode }[] =
  SETTINGS_SECTIONS.map((sec) => ({ ...sec, icon: SECTION_ICONS[sec.id] }));

/** The section shown last time Settings was open (Appearance on first use). */
function lastSection(): SettingsSectionId {
  const saved = useSession.getState().snapshot.settingsSection;
  return SECTIONS.some((sec) => sec.id === saved) ? (saved as SettingsSectionId) : "appearance";
}

export function Settings({ onClose }: Props) {
  const s = useSettings();
  const changed = useChangedSections();

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

  const target = useLayout((s) => s.settingsTarget);
  const [active, setActive] = useState<SettingsSectionId>(
    () => useLayout.getState().settingsTarget?.section ?? lastSection()
  );

  // A jump from another page (or a second jump while Settings is already
  // open) names the section. A generic open leaves the target null, which
  // is the section shown last time. Clicking the nav does not change the
  // target, so it is not pulled back.
  useEffect(() => {
    setActive(target?.section ?? lastSection());
  }, [target]);

  useEffect(() => {
    useSession.getState().setSettingsSection(active);
  }, [active]);

  useEffect(() => {
    const root = panelRef.current;
    if (!root) return;
    let cancelled = false;
    let observer: MutationObserver | null = null;

    const place = () => {
      const nav = root.querySelector<HTMLElement>(
        `[data-settings-section="${active}"]`
      );
      nav?.scrollIntoView({ block: "nearest" });
      // A click in the section list already moved the highlight. Don't pull
      // focus back to a jump that asked for a different section.
      if (!target || target.section !== active) return true;
      if (target.focus) {
        const el = root.querySelector(
          `[data-settings-focus="${CSS.escape(target.focus)}"]`
        );
        if (el instanceof HTMLElement) {
          el.scrollIntoView({ block: "center" });
          const focusable = el.matches("input, select, textarea, button, a[href]")
            ? el
            : el.querySelector<HTMLElement>("input, select, textarea, button, a[href]");
          (focusable ?? nav)?.focus();
          return true;
        }
      }
      nav?.focus();
      // The named control can show up after a status round-trip.
      return !target.focus;
    };

    const watch = () => {
      if (cancelled || place()) return;
      observer = new MutationObserver(() => {
        if (place()) observer?.disconnect();
      });
      observer.observe(root, { childList: true, subtree: true });
    };

    // After the dialog's own initial-focus frame, so a deep link wins.
    const raf = requestAnimationFrame(() => watch());
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      observer?.disconnect();
    };
  }, [target, active]);

  const renderContent = () => {
    switch (active) {
      case "appearance":
        return (
          <>
            <Field
              label="Mode"
              focus={SETTINGS_FOCUS.themeMode}
              help="Light, Dark, or System to follow your OS setting as it changes. Light and Dark each keep their own theme."
            >
              <Segmented<ThemeMode>
                value={s.themeMode}
                onChange={s.setThemeMode}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "System" },
                ]}
              />
            </Field>
            {s.themeMode !== "dark" && (
              <Field
                label="Light theme"
                help={s.themeMode === "system" ? "Used while your OS is in light mode." : undefined}
              >
                <PreviewCards<AppTheme>
                  label="Light theme"
                  items={LIGHT_THEMES}
                  value={s.lightTheme}
                  onChange={s.setLightTheme}
                  preview={(v) => <ThemePreview theme={v} />}
                />
              </Field>
            )}
            {s.themeMode !== "light" && (
              <Field
                label="Dark theme"
                help={s.themeMode === "system" ? "Used while your OS is in dark mode." : undefined}
              >
                <PreviewCards<AppTheme>
                  label="Dark theme"
                  items={DARK_THEMES}
                  value={s.darkTheme}
                  onChange={s.setDarkTheme}
                  preview={(v) => <ThemePreview theme={v} />}
                />
              </Field>
            )}
            <Field
              label="Accent color"
              help="The highlight color for buttons, links, focus rings, the active rail pill and selection. Layers on top of the theme."
            >
              <AccentGrid value={s.accentColor} onChange={s.setAccentColor} />
            </Field>
            <Field
              label="UI zoom"
              help="Scales the whole interface — text, icons and layout. Also View → Zoom in / Zoom out, or Ctrl/⌘ + = / − / 0."
            >
              <Select<number>
                label="UI zoom"
                value={s.uiZoom}
                onChange={s.setUiZoom}
                options={(UI_ZOOM_STEPS.includes(s.uiZoom)
                  ? UI_ZOOM_STEPS
                  : [...UI_ZOOM_STEPS, s.uiZoom].sort((a, b) => a - b)
                ).map((z) => ({
                  value: z,
                  label: z === 100 ? "100% (Default)" : `${z}%`,
                }))}
              />
              {s.uiZoom !== 100 && (
                <button
                  type="button"
                  onClick={() => s.setUiZoom(100)}
                  title="Reset to 100%"
                  aria-label="Reset zoom to 100%"
                  data-zoom-reset
                  className="rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text"
                >
                  <RotateCcw size={13} />
                </button>
              )}
            </Field>
            <Field
              label="Window frame"
              help="Where the window controls sit in Faro's title bar. Looks only — the window behaves the same."
            >
              <Segmented<FrameStyle>
                value={s.frameStyle}
                onChange={s.setFrameStyle}
                options={[
                  { value: "windows", label: "Windows" },
                  { value: "macos", label: "macOS" },
                  { value: "linux", label: "Linux" },
                ]}
              />
            </Field>
            <Field
              label="Language"
              help="System follows your OS language."
            >
              <Segmented<UiLanguage>
                value={s.uiLanguage}
                onChange={s.setUiLanguage}
                options={[
                  { value: "system", label: "System" },
                  { value: "en", label: "English" },
                  { value: "zh-CN", label: "中文" },
                ]}
              />
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
              focus={SETTINGS_FOCUS.transferConcurrency}
              help="How many transfers run at once. Extra transfers wait in a first-in, first-out queue."
            >
              <NumberInput
                label="Concurrent transfers"
                min={1}
                max={32}
                value={s.transferConcurrency}
                onChange={s.setTransferConcurrency}
              />
            </Field>
            <BandwidthLimit
              kbps={s.transferThrottleKbps}
              onChange={s.setTransferThrottleKbps}
            />
            <Field
              label="Connections per file"
              help="Large downloads and object-store uploads are split across parallel connections. Auto starts with one and adds more while it helps; 1 turns splitting off."
            >
              <div className="flex items-center gap-2">
                <Segmented<"auto" | "manual">
                  value={s.transferSegments === "auto" ? "auto" : "manual"}
                  onChange={(v) => s.setTransferSegments(v === "auto" ? "auto" : 4)}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "manual", label: "Fixed" },
                  ]}
                />
                {s.transferSegments !== "auto" && (
                  <NumberInput
                    label="Connections per file"
                    min={1}
                    max={16}
                    value={s.transferSegments}
                    onChange={(n) => s.setTransferSegments(n)}
                  />
                )}
              </div>
            </Field>
            <ToggleField
              label="Verify transfers with a checksum"
              help="After a transfer, compare a checksum with the server where it can provide one (S3-style ETags, sha256sum over SSH). Slower; a mismatch keeps the temporary file and marks the transfer failed."
              checked={s.transferVerify}
              onChange={s.setTransferVerify}
            />
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
                <DebouncedText
                  data-settings-focus={SETTINGS_FOCUS.downloadFolder}
                  value={s.defaultDownloadFolder}
                  onCommit={s.setDefaultDownloadFolder}
                  placeholder="System Downloads"
                  aria-label="Download folder"
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
                label="Sort by"
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
                <DebouncedText
                  value={s.defaultEditor}
                  onCommit={s.setDefaultEditor}
                  placeholder="OS default app"
                  aria-label="Default editor"
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
                label="Font size"
                min={8}
                max={32}
                value={s.terminalFontSize}
                onChange={s.setTerminalFontSize}
                suffix="px"
              />
            </Field>
            <Field label="Font family">
              <Select<string>
                searchable
                label="Terminal font"
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
            <Field label="Theme" help="Applies live to open terminals.">
              <PreviewCards<TerminalTheme>
                label="Terminal theme"
                items={TERMINAL_THEME_OPTIONS}
                value={s.terminalTheme}
                onChange={s.setTerminalTheme}
                preview={(v) => <TerminalPreview theme={v} />}
              />
            </Field>
            <Field label="Scrollback">
              <Select<number>
                label="Scrollback"
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
          <>
            <Field label="Default port for new profiles">
              <NumberInput
                label="Default port"
                min={1}
                max={65535}
                value={s.defaultPort}
                onChange={s.setDefaultPort}
              />
            </Field>
            <ToggleField
              label="Store passwords and key passphrases in the OS keychain"
              help="Keep saved connection passwords and SSH key passphrases in macOS Keychain / Windows Credential Manager instead of plaintext in profiles.json. Turning it on or off moves them straight away."
              checked={s.storePasswordsInKeychain}
              onChange={(v) =>
                s.setStorePasswordsInKeychain(v).catch((e) =>
                  toastError(e, "Couldn't change where passwords are stored"),
                )
              }
            />
            <ToggleField
              label="Restore last session"
              help="When Faro starts, reconnect the server you were using if it was still connected when you quit."
              checked={s.restoreLastSession}
              onChange={s.setRestoreLastSession}
            />
          </>
        );

      case "remoteControl":
        return <RemoteControlSettings />;

      case "cli":
        return <CliUpdaterSettings />;

      case "cloudflare":
        return <CloudflareSettings />;

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
            {/* Only meaningful while prompts are on: Allow all already
                approves everything. */}
            <Dependent enabled={!policy.allowAll} reason="Allow all already approves these.">
              <ToggleField
                label="Auto-approve read-only operations"
                help="List directories, read files and search run without asking. Downloads & uploads write to disk, so they still prompt unless Allow all is on."
                checked={policy.allowAll || policy.autoRead}
                disabled={policy.allowAll}
                onChange={(v) => setPolicy({ ...policy, autoRead: v })}
              />
              <ToggleField
                label="Auto-approve safe shell commands"
                help="Read-only commands (ls, cat, df, grep…) run without asking; anything that could change the server still prompts. Best-effort heuristic."
                checked={policy.allowAll || policy.autoSafeExec}
                disabled={policy.allowAll}
                onChange={(v) => setPolicy({ ...policy, autoSafeExec: v })}
              />
            </Dependent>
            <Help>
              Same setting as the Agent Bridge panel — applies to every
              agent-enabled session and persists across restarts.
            </Help>
          </>
        );

      case "keyboard":
        return <KeyboardSettings />;

      case "backup":
        return <BackupSettings />;

      case "storage":
        return <StorageSettings />;

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
            const isChanged = changed.has(sec.id);
            return (
              <button
                key={sec.id}
                type="button"
                data-settings-section={sec.id}
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
                {isChanged && (
                  <span
                    data-settings-changed
                    title="Changed from the default"
                    className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  >
                    <span className="sr-only">(changed)</span>
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Content pane for the active section. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center border-b border-border px-6 py-3.5">
            <span className="text-sm font-semibold" data-settings-heading={active}>
              {activeLabel}
            </span>
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
              Changes save automatically.
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
  focus,
  children,
}: {
  label: string;
  help?: string;
  /** `data-settings-focus` id so a deep link can land on this field. */
  focus?: string;
  children: React.ReactNode;
}) {
  return (
    <div data-settings-focus={focus}>
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
      toastError(e, "Couldn't create the backup");
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
      toastError(e, "Couldn't restore the backup");
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
          One password-protected file with your connection profiles, their saved
          secrets (SSH passwords, cloud tokens, the AI API key), app settings, and
          sync pairs. Argon2id + AES-256-GCM — useless without the password, so
          store it somewhere safe.
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
          Replaces this machine's profiles, settings, and saved secrets with the
          backup's. Takes effect after you restart Faro.
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
  disabled,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className={cn("text-sm", disabled && "text-text-dim")}>{label}</span>
        {help && <InfoTip text={help} />}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}

/** Settings that only matter while a parent setting is on: indented under it
 *  and inert until then. */
function Dependent({
  enabled,
  reason,
  children,
}: {
  enabled: boolean;
  /** Why the children are off, for screen readers and hover. */
  reason?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-settings-dependent={enabled ? "on" : "off"}
      aria-disabled={!enabled}
      title={!enabled ? reason : undefined}
      className={cn("ml-2 space-y-3 border-l border-border pl-4", !enabled && "opacity-60")}
    >
      {children}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed",
        checked
          ? "bg-accent border-accent"
          : "bg-bg-subtle border-border hover:border-text-dim"
      )}
    >
      <span
        className={cn(
          "absolute left-px top-1/2 h-4 w-4 -translate-y-1/2 rounded-full bg-white shadow-elev-1 transition-transform",
          checked ? "translate-x-4" : "translate-x-0"
        )}
      />
    </button>
  );
}

const CARD_COLUMNS = 4;

/**
 * A radio group of small preview cards (themes, terminal themes). The selected
 * card gets a ring; arrow keys, Home and End move and select, and only the
 * selected card is in the tab order.
 */
function PreviewCards<T extends string>({
  label,
  items,
  value,
  onChange,
  preview,
}: {
  label: string;
  items: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  preview: (v: T) => React.ReactNode;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = items.findIndex((t) => t.value === value);
  if (!items.length) {
    return <div className="text-xs text-text-dim">No themes available.</div>;
  }
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    const n = items.length;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (i + 1) % n;
    else if (e.key === "ArrowLeft") next = (i - 1 + n) % n;
    else if (e.key === "ArrowDown") next = Math.min(n - 1, i + CARD_COLUMNS);
    else if (e.key === "ArrowUp") next = Math.max(0, i - CARD_COLUMNS);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === null) return;
    e.preventDefault();
    onChange(items[next].value);
    refs.current[next]?.focus();
  };
  return (
    <div role="radiogroup" aria-label={label} className="grid w-full grid-cols-4 gap-2">
      {items.map((t, i) => {
        const active = i === selected;
        return (
          <button
            key={t.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active || (selected < 0 && i === 0) ? 0 : -1}
            data-theme-card={t.value}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "flex flex-col gap-1.5 rounded-lg border p-1.5 text-left outline-none transition-colors focus-visible:border-accent",
              active
                ? "border-accent ring-2 ring-accent/40"
                : "border-border hover:border-text-dim"
            )}
          >
            {preview(t.value)}
            <span
              className={cn(
                "flex items-center gap-1 truncate px-0.5 text-[11px] font-medium",
                active ? "text-text" : "text-text-muted"
              )}
            >
              {active && <Check size={11} className="shrink-0 text-accent" />}
              <span className="truncate">{t.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A miniature window painted with the theme's own tokens: the nested
 *  `data-theme` re-scopes every color variable to that theme. */
function ThemePreview({ theme }: { theme: AppTheme }) {
  return (
    <div
      data-theme={theme}
      aria-hidden
      className="pointer-events-none flex h-12 overflow-hidden rounded-md border border-border bg-bg"
    >
      <div className="w-1/4 space-y-1 border-r border-border-subtle bg-bg-subtle p-1">
        <div className="h-1.5 rounded-sm bg-accent" />
        <div className="h-1 rounded-sm bg-text-dim/50" />
        <div className="h-1 rounded-sm bg-text-dim/30" />
      </div>
      <div className="flex-1 space-y-1 bg-bg-panel p-1.5">
        <div className="h-1.5 w-3/4 rounded-sm bg-text/80" />
        <div className="h-1 w-1/2 rounded-sm bg-text-muted/60" />
        <div className="h-1 w-2/3 rounded-sm bg-text-muted/40" />
        <div className="h-1.5 w-5 rounded-sm bg-accent" />
      </div>
    </div>
  );
}

const TERMINAL_THEME_OPTIONS: { value: TerminalTheme; label: string }[] = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "dracula", label: "Dracula" },
  { value: "solarized-dark", label: "Solarized Dark" },
  { value: "gruvbox-dark", label: "Gruvbox Dark" },
  { value: "onedark", label: "One Dark" },
  { value: "rosepine", label: "Rosé Pine" },
  { value: "everforest", label: "Everforest" },
];

/** A prompt line in the terminal theme's own background, text and cursor. */
function TerminalPreview({ theme }: { theme: TerminalTheme }) {
  const c = TERMINAL_THEMES[theme];
  return (
    <div
      aria-hidden
      style={{ background: c.background, color: c.foreground }}
      className="pointer-events-none h-12 overflow-hidden rounded-md border border-border px-1.5 py-1 font-mono text-[9px] leading-[13px]"
    >
      <div className="opacity-70">$ ls</div>
      <div>logs  www</div>
      <div className="flex items-center">
        $&nbsp;<span className="inline-block h-2.5 w-1.5" style={{ background: c.cursor }} />
      </div>
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
  searchable,
  label,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  searchable?: boolean;
  label?: string;
}) {
  return (
    <Dropdown<T>
      value={value}
      onChange={onChange}
      options={options}
      searchable={searchable}
      aria-label={label}
      className="min-w-[11rem]"
    />
  );
}

/** "Default port must be 1–65535". */
function rangeError(label: string, min: number, max: number): string {
  // Ports read as plain numbers; only big limits get thousands separators.
  const n = (v: number) => (v >= 100_000 ? v.toLocaleString("en-US") : String(v));
  return `${label} must be ${n(min)}–${n(max)}`;
}

/**
 * A whole-number setting. A valid value saves shortly after typing stops;
 * an invalid one stays in the box (not clamped under your cursor) and is
 * reported only once you leave the field, naming the field. Leaving
 * Settings with an invalid draft keeps the last valid value.
 */
function NumberInput({
  label,
  min,
  max,
  value,
  onChange,
  suffix,
  disabled,
}: {
  /** Field name used in the error message. */
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (n: number) => void;
  suffix?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));
  const [touched, setTouched] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  const errorId = useId();
  const pending = useRef<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const commitRef = useRef(onChange);
  commitRef.current = onChange;

  // Saved shortly after typing stops (so "40" never applies a passing "4"),
  // and at once on blur or when Settings closes.
  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (pending.current !== null) {
      const n = pending.current;
      pending.current = null;
      commitRef.current(n);
    }
  }, []);
  useEffect(() => flush, [flush]);

  // Follow outside changes (another window, the transfer panel) unless the
  // user is typing here.
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(String(value));
  }, [value]);

  const parse = (raw: string): number | null => {
    if (!/^\d+$/.test(raw.trim())) return null;
    const n = Number(raw);
    return n >= min && n <= max ? n : null;
  };
  const invalid = parse(draft) === null;
  const error = touched && invalid && !disabled ? rangeError(label, min, max) : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <input
          ref={ref}
          type="text"
          inputMode="numeric"
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={disabled}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = parse(e.target.value);
            if (timer.current) clearTimeout(timer.current);
            pending.current = n !== null && n !== value ? n : null;
            if (pending.current !== null) timer.current = setTimeout(flush, 400);
          }}
          onBlur={() => {
            setTouched(true);
            flush();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
          className={cn(
            "w-24 rounded-md border bg-bg-subtle px-2.5 py-1.5 text-sm tabular-nums outline-none disabled:cursor-not-allowed disabled:opacity-60",
            error ? "border-danger focus:border-danger" : "border-border focus:border-accent"
          )}
        />
        {suffix && <span className="text-xs text-text-dim">{suffix}</span>}
      </div>
      {error && (
        <span id={errorId} role="alert" data-settings-error className="text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * A text setting saved shortly after typing stops instead of on every
 * keystroke; leaving the field or closing Settings saves at once.
 */
function DebouncedText({
  value,
  onCommit,
  delay = 400,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
  delay?: number;
  placeholder?: string;
  "aria-label"?: string;
  "data-settings-focus"?: string;
}) {
  const [draft, setDraft] = useState(value);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  const flush = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = undefined;
    if (pending.current !== null) {
      const v = pending.current;
      pending.current = null;
      commitRef.current(v);
    }
  }, []);

  // Outside changes (Browse…, Reset) replace the draft when nothing is pending.
  useEffect(() => {
    if (pending.current === null) setDraft(value);
  }, [value]);

  // Closing Settings or switching section saves what was typed.
  useEffect(() => flush, [flush]);

  return (
    <input
      {...rest}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        pending.current = e.target.value;
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, delay);
      }}
      onBlur={flush}
      className="min-w-0 flex-1 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-sm outline-none focus:border-accent"
    />
  );
}

/** Bandwidth cap as a switch with the limit indented under it. 0 in the store
 *  means unlimited; the last limit is kept for when it's switched back on. */
function BandwidthLimit({ kbps, onChange }: { kbps: number; onChange: (n: number) => void }) {
  const on = kbps > 0;
  const [last, setLast] = useState(on ? kbps : 1024);
  useEffect(() => {
    if (kbps > 0) setLast(kbps);
  }, [kbps]);
  return (
    <div className="space-y-3">
      <ToggleField
        label="Limit bandwidth"
        help="A global cap shared by all active transfers. Off = unlimited. Also adjustable from the transfer panel."
        checked={on}
        onChange={(v) => onChange(v ? last : 0)}
      />
      <Dependent enabled={on} reason="Turn on Limit bandwidth first.">
        <Field label="Limit">
          <NumberInput
            label="Bandwidth limit"
            min={1}
            max={1024 * 1024}
            value={on ? kbps : last}
            onChange={onChange}
            suffix="KiB/s"
            disabled={!on}
          />
        </Field>
      </Dependent>
    </div>
  );
}

const CACHE_INFO: Record<CacheId, { title: string; note: string; cleared: string }> = {
  thumbnails: {
    title: "Image thumbnails",
    note: "Previews of remote images. They're fetched again the next time you view the folder.",
    cleared: "Thumbnails cleared",
  },
  transferResume: {
    title: "Transfer resume data",
    note: "Partial downloads that let paused or failed transfers continue. Clearing cancels those transfers; running ones are left alone.",
    cleared: "Resume data cleared",
  },
  editCopies: {
    title: "Leftover edit copies",
    note: "Local copies from edit-in-place sessions that are no longer open.",
    cleared: "Edit copies cleared",
  },
};

const CACHE_ORDER: CacheId[] = ["thumbnails", "transferResume", "editCopies"];

function plural(n: number, one: string, many = `${one}s`) {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

/** Settings › Storage: one card per clearable cache with its live size. */
function StorageSettings() {
  const [usage, setUsage] = useState<Partial<Record<CacheId, CacheUsage>>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<CacheId | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await ipc.cacheUsage();
      setUsage(Object.fromEntries(rows.map((r) => [r.id, r])));
    } catch (e) {
      toastError(e, "Couldn't read cache sizes");
    } finally {
      setLoaded(true);
    }
  }, []);

  // Sizes stay live while the section is open (thumbnails fill as you browse).
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const clear = async (id: CacheId) => {
    const before = usage[id]?.bytes ?? 0;
    setBusy(id);
    try {
      const after = await ipc.cacheClear(id);
      setUsage((u) => ({ ...u, [id]: after }));
      const freed = Math.max(0, before - after.bytes);
      toast.success(CACHE_INFO[id].cleared, freed > 0 ? `Freed ${fmtSize(freed)}.` : undefined);
    } catch (e) {
      toastError(e, `Couldn't clear ${CACHE_INFO[id].title.toLowerCase()}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2.5">
      <Help>Space Faro uses for things it can rebuild. Clearing never touches your files or settings.</Help>
      {CACHE_ORDER.map((id) => {
        const u = usage[id];
        const empty = !u || (u.bytes === 0 && u.items === 0);
        return (
          <div
            key={id}
            data-cache-card={id}
            className="flex items-center gap-3 rounded-lg border border-border bg-bg-subtle/60 px-3.5 py-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-medium">{CACHE_INFO[id].title}</span>
                <span data-cache-size className="text-xs tabular-nums text-text-muted">
                  {!loaded
                    ? "…"
                    : !u
                      ? "Unavailable"
                      : empty
                        ? "Empty"
                        : `${fmtSize(u.bytes)} · ${plural(u.items, id === "thumbnails" ? "file" : id === "transferResume" ? "transfer" : "folder")}`}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-text-dim">{CACHE_INFO[id].note}</div>
            </div>
            <button
              type="button"
              onClick={() => void clear(id)}
              disabled={empty || busy !== null}
              className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm text-text transition-colors hover:bg-bg-hover disabled:opacity-50"
            >
              {busy === id ? (
                <span className="inline-flex items-center gap-1.5">
                  <Loader2 size={13} className="animate-spin" /> Clearing…
                </span>
              ) : (
                "Clear"
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}
