import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { X, Check, RotateCcw, Search } from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { ACCENTS } from "@/lib/accent";
import type { UiLanguage } from "@/lib/i18n";
import {
  useSettings,
  setSetting,
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
import type { BackupSummary, CacheId, CacheUsage, LocalShell } from "@/lib/types";
import { localShells } from "@/lib/localTerminal";
import { fmtSize } from "@/lib/format";
import { useBindings } from "@/stores/bindingsStore";
import { open, save } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/cn";
import { RemoteControlSettings } from "./RemoteControlSettings";
import { SyncSettings } from "./SyncSettings";
import { RulesSettings } from "./RulesSettings";
import { CliUpdaterSettings } from "./CliUpdaterSettings";
import { CloudflareSettings } from "./CloudflareSettings";
import { CliHub } from "./CliHub";
import { KeyboardSettings } from "./KeyboardSettings";
import { Dropdown } from "./ui/Dropdown";
import { AboutSettings } from "./AboutSettings";
import { PasswordManagerSettings } from "./PasswordManagerSettings";
import { useLayout } from "@/stores/layoutStore";
import { useSession } from "@/stores/sessionStore";
import {
  SETTINGS_FOCUS,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from "@/lib/settingsNav";
import {
  Btn,
  CheckRow,
  Group,
  Highlight,
  InfoTip,
  List,
  ListRow,
  Row,
  Segmented,
  SettingsSearchScope,
  TextInput,
  inputClass,
} from "./settings/kit";

interface Props {
  onClose: () => void;
}

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
    "terminalLocalShell",
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

const SECTIONS = SETTINGS_SECTIONS;

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
          if (focusable) focusable.focus();
          else nav?.focus({ focusVisible: false } as FocusOptions);
          return true;
        }
      }
      nav?.focus({ focusVisible: false } as FocusOptions);
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

  // --- Search: filters every section at once; the nav keeps only sections
  // with a hit (read back from the rendered rows).
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const searching = q.length > 0;
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hits, setHits] = useState<Set<SettingsSectionId>>(new Set());

  useLayoutEffect(() => {
    const root = contentRef.current;
    if (!searching || !root) {
      setHits(new Set());
      return;
    }
    const read = () => {
      const next = new Set<SettingsSectionId>();
      root.querySelectorAll<HTMLElement>("[data-search-section]").forEach((el) => {
        if (el.hasAttribute("data-section-match") || el.querySelector("[data-row-match]")) {
          next.add(el.dataset.searchSection as SettingsSectionId);
        }
      });
      setHits((prev) =>
        prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next
      );
    };
    read();
    // Sections that load their status show rows a moment later.
    const observer = new MutationObserver(read);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [searching, q]);

  // Esc in a non-empty search clears it instead of closing Settings. The
  // dialog listens natively, so stop it before it bubbles there.
  useEffect(() => {
    const el = searchRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && el.value) {
        e.stopPropagation();
        e.preventDefault();
        setQuery("");
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  }, []);

  const pickSection = (id: SettingsSectionId) => {
    if (searching) {
      contentRef.current
        ?.querySelector(`[data-search-section="${id}"]`)
        ?.scrollIntoView({ block: "start" });
      return;
    }
    setActive(id);
    contentRef.current?.scrollTo({ top: 0 });
  };

  // Ctrl/⌘+F or "/" jumps to search.
  const onPanelKeyDown = (e: React.KeyboardEvent) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") || (e.key === "/" && !typing)) {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    }
  };

  // Up/Down/Home/End walk the section list.
  const onNavKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("[data-settings-section]")];
    if (!buttons.length) return;
    e.preventDefault();
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "Home" ? 0
      : e.key === "End" ? buttons.length - 1
      : e.key === "ArrowDown" ? Math.min(buttons.length - 1, i + 1)
      : Math.max(0, i - 1);
    buttons[next].focus();
    buttons[next].click();
  };

  const renderSection = (id: SettingsSectionId) => {
    switch (id) {
      case "appearance":
        return (
          <>
            <Row label="Mode" focus={SETTINGS_FOCUS.themeMode} keywords="light dark system" help="System follows your OS as it changes. Light and Dark each keep their own theme.">
              <Segmented<ThemeMode>
                label="Mode"
                value={s.themeMode}
                onChange={s.setThemeMode}
                options={[
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                  { value: "system", label: "System" },
                ]}
              />
            </Row>
            {s.themeMode !== "dark" && (
              <Row label="Light theme" keywords="theme" help={s.themeMode === "system" ? "Used while your OS is in light mode." : undefined}>
                <PreviewCards<AppTheme>
                  label="Light theme"
                  items={LIGHT_THEMES}
                  value={s.lightTheme}
                  onChange={s.setLightTheme}
                  preview={(v) => <ThemePreview theme={v} />}
                />
              </Row>
            )}
            {s.themeMode !== "light" && (
              <Row label="Dark theme" keywords="theme" help={s.themeMode === "system" ? "Used while your OS is in dark mode." : undefined}>
                <PreviewCards<AppTheme>
                  label="Dark theme"
                  items={DARK_THEMES}
                  value={s.darkTheme}
                  onChange={s.setDarkTheme}
                  preview={(v) => <ThemePreview theme={v} />}
                />
              </Row>
            )}
            <Row label="Accent color" keywords="highlight color" help="Buttons, links, focus rings and selection. Layers on top of the theme.">
              <AccentGrid value={s.accentColor} onChange={s.setAccentColor} />
            </Row>
            <Row label="UI zoom" keywords="scale size" help={<>Scales text, icons and layout. Also <kbd className="font-mono">Ctrl</kbd> + <kbd className="font-mono">=</kbd> / <kbd className="font-mono">−</kbd> / <kbd className="font-mono">0</kbd>.</>}>
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
                <ResetButton data-zoom-reset label="Reset zoom to 100%" onClick={() => s.setUiZoom(100)} />
              )}
            </Row>
            <Row label="Window frame" keywords="title bar controls" help="Where the window buttons sit. Looks only.">
              <Segmented<FrameStyle>
                label="Window frame"
                value={s.frameStyle}
                onChange={s.setFrameStyle}
                options={[
                  { value: "windows", label: "Windows" },
                  { value: "macos", label: "macOS" },
                  { value: "linux", label: "Linux" },
                ]}
              />
            </Row>
            <Row label="Language" keywords="locale translation" help="System follows your OS language.">
              <Segmented<UiLanguage>
                label="Language"
                value={s.uiLanguage}
                onChange={s.setUiLanguage}
                options={[
                  { value: "system", label: "System" },
                  { value: "en", label: "English" },
                  { value: "zh-CN", label: "中文" },
                ]}
              />
            </Row>
          </>
        );

      case "transfers":
        return (
          <>
            <Group title="Conflicts">
              <Row
                label="If the file exists"
                keywords="overwrite skip rename destination"
                help={
                  <>
                    Used after “apply to all”, or for every transfer when the prompt is off.{" "}
                    {s.overwritePolicy === "overwrite" && "Overwrite replaces the file in place."}
                    {s.overwritePolicy === "skip" && "Skip leaves the file alone."}
                    {s.overwritePolicy === "rename" && "Rename adds _1, _2, … until a name is free."}
                  </>
                }
              >
                <Segmented<OverwritePolicy>
                  label="If the file exists"
                  value={s.overwritePolicy}
                  onChange={s.setOverwritePolicy}
                  options={[
                    { value: "overwrite", label: "Overwrite" },
                    { value: "skip", label: "Skip" },
                    { value: "rename", label: "Rename" },
                  ]}
                />
              </Row>
              <CheckRow
                label="Ask before overwriting"
                help="Prompt with overwrite / keep both / skip. Off applies the choice above silently."
                checked={s.promptOnOverwrite}
                onChange={s.setPromptOnOverwrite}
              />
            </Group>
            <Group title="Speed">
              <Row
                label="Concurrent transfers"
                focus={SETTINGS_FOCUS.transferConcurrency}
                keywords="parallel queue"
                help="How many run at once. The rest wait in line."
              >
                <NumberInput
                  label="Concurrent transfers"
                  min={1}
                  max={32}
                  value={s.transferConcurrency}
                  onChange={s.setTransferConcurrency}
                />
              </Row>
              <Row
                label="Connections per file"
                keywords="segments split parallel"
                help="Large downloads and object-store uploads split across connections. Auto adds more while it helps."
              >
                <Segmented<"auto" | "manual">
                  label="Connections per file"
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
              </Row>
              <BandwidthLimit kbps={s.transferThrottleKbps} onChange={s.setTransferThrottleKbps} />
            </Group>
            <Group title="Integrity">
              <CheckRow
                label="Verify with a checksum"
                keywords="hash sha256 etag"
                help="Compares a checksum with the server when it can provide one. Slower. A mismatch fails the transfer."
                checked={s.transferVerify}
                onChange={s.setTransferVerify}
              />
              <CheckRow
                label="Delta sync"
                keywords="changed blocks rsync"
                help="Sends only the changed blocks of a file. Faro Agent connections, files of 8 MB or more."
                checked={s.deltaSync}
                onChange={s.setDeltaSync}
              />
            </Group>
            <Group title="Behavior">
              <CheckRow
                label="Open the transfer panel automatically"
                help="Slides the bottom panel up when a transfer starts."
                checked={s.autoOpenTransferPanel}
                onChange={s.setAutoOpenTransferPanel}
              />
              <Row label="Download folder" keywords="downloads location path" help="Blank uses your system Downloads folder.">
                <DebouncedText
                  data-settings-focus={SETTINGS_FOCUS.downloadFolder}
                  value={s.defaultDownloadFolder}
                  onCommit={s.setDefaultDownloadFolder}
                  placeholder="System Downloads"
                  aria-label="Download folder"
                  mono
                />
                <Btn
                  onClick={async () => {
                    const picked = await open({ directory: true, title: "Choose a download folder" });
                    if (typeof picked === "string") s.setDefaultDownloadFolder(picked);
                  }}
                >
                  Browse…
                </Btn>
                {s.defaultDownloadFolder && (
                  <ResetButton label="Reset to system Downloads" onClick={() => s.setDefaultDownloadFolder("")} />
                )}
              </Row>
            </Group>
          </>
        );

      case "panes":
        return (
          <>
            <Row label="View" keywords="details list grid density compact" help="Also on the file toolbar.">
              <Segmented<PaneViewMode>
                label="View"
                value={s.paneViewMode}
                onChange={s.setPaneViewMode}
                options={[
                  { value: "details", label: "Details" },
                  { value: "list", label: "List" },
                  { value: "grid", label: "Grid" },
                ]}
              />
              <Segmented<PaneDensity>
                label="Density"
                value={s.paneDensity}
                onChange={s.setPaneDensity}
                options={[
                  { value: "comfortable", label: "Comfortable" },
                  { value: "compact", label: "Compact" },
                ]}
              />
            </Row>
            <Row label="Layout" keywords="browser single split dual" help="Single is one server pane with an Upload button. Split shows local and remote side by side.">
              <Segmented<BrowserLayout>
                label="Browser layout"
                value={s.browserLayout}
                onChange={s.setBrowserLayout}
                options={[
                  { value: "single", label: "Single" },
                  { value: "dual", label: "Split" },
                ]}
              />
            </Row>
            <Row label="Default sort" keywords="order name size modified">
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
                label="Sort direction"
                value={s.sortDirection}
                onChange={s.setSortDirection}
                options={[
                  { value: "asc", label: "Asc" },
                  { value: "desc", label: "Desc" },
                ]}
              />
            </Row>
            <Row label="Default editor" keywords="edit in place code vscode" help="Command for edit-in-place, e.g. code. Blank opens the OS default app.">
              <DebouncedText
                value={s.defaultEditor}
                onCommit={s.setDefaultEditor}
                placeholder="OS default app"
                aria-label="Default editor"
                mono
              />
              <Btn onClick={() => s.setDefaultEditor("code")} title="Use the `code` command">
                VS Code
              </Btn>
              {s.defaultEditor && <ResetButton label="Reset to OS default" onClick={() => s.setDefaultEditor("")} />}
            </Row>
            <CheckRow
              label="Show hidden files"
              keywords="dotfiles"
              help="Names that start with a dot."
              checked={s.showHiddenFiles}
              onChange={s.setShowHiddenFiles}
            />
            <CheckRow
              label="Remote image previews"
              keywords="thumbnails"
              help="Thumbnails for images on SFTP, S3, FTP and the rest, fetched only for rows you scroll to. Local images always preview. Per connection from the file toolbar."
              checked={s.remoteImagePreviews === "on"}
              onChange={(v) => s.setRemoteImagePreviews(v ? "on" : "off")}
            />
          </>
        );

      case "terminal":
        return (
          <>
            <Row label="Font" keywords="family size">
              <Select<string>
                searchable
                label="Terminal font"
                value={s.terminalFontFamily}
                onChange={s.setTerminalFontFamily}
                options={[
                  { value: '"JetBrains Mono", "Fira Code", "Cascadia Code", Consolas, monospace', label: "JetBrains Mono" },
                  { value: '"Fira Code", Consolas, monospace', label: "Fira Code" },
                  { value: '"Cascadia Code", Consolas, monospace', label: "Cascadia Code" },
                  { value: "Menlo, Consolas, monospace", label: "Menlo / Consolas" },
                  { value: "monospace", label: "System default" },
                ]}
              />
              <NumberInput label="Font size" min={8} max={32} value={s.terminalFontSize} onChange={s.setTerminalFontSize} suffix="px" />
            </Row>
            <Row label="Theme" keywords="colors" help="Applies live to open terminals.">
              <PreviewCards<TerminalTheme>
                label="Terminal theme"
                items={TERMINAL_THEME_OPTIONS}
                value={s.terminalTheme}
                onChange={s.setTerminalTheme}
                preview={(v) => <TerminalPreview theme={v} />}
              />
            </Row>
            <Row label="Scrollback" keywords="history lines buffer" note="Applies to new terminals.">
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
            </Row>
            <LocalShellRow />
            <CheckRow
              label="Copy on select"
              keywords="clipboard"
              help="Selecting text copies it. Paste with Ctrl+V or a right-click."
              checked={s.terminalCopyOnSelect}
              onChange={s.setTerminalCopyOnSelect}
            />
            <CheckRow
              label="Inline suggestions"
              keywords="autocomplete history ghost"
              help="Shows the last matching command from this server's history as ghost text. Press → to accept. Kept locally per profile."
              checked={s.terminalSuggestions}
              onChange={s.setTerminalSuggestions}
            />
          </>
        );

      case "connections":
        return (
          <>
            <Row label="Default port" keywords="ssh sftp 22 new profiles" help="Used for new connection profiles.">
              <NumberInput label="Default port" min={1} max={65535} value={s.defaultPort} onChange={s.setDefaultPort} />
            </Row>
            <CheckRow
              label="Save passwords in the OS keychain"
              keywords="credential manager passphrase secrets"
              help="Keeps passwords and key passphrases in Windows Credential Manager or macOS Keychain instead of profiles.json. Changing this moves them right away."
              checked={s.storePasswordsInKeychain}
              onChange={(v) =>
                s.setStorePasswordsInKeychain(v).catch((e) => toastError(e, "Couldn't change where passwords are stored"))
              }
            />
            <CheckRow
              label="Restore last session"
              keywords="reconnect startup"
              help="Reconnects the server you were on when you quit."
              checked={s.restoreLastSession}
              onChange={s.setRestoreLastSession}
            />
          </>
        );

      case "passwordManagers":
        return <PasswordManagerSettings />;

      case "remoteControl":
        return <RemoteControlSettings />;

      case "cli":
        return <CliUpdaterSettings />;

      case "cloudflare":
        return <CloudflareSettings />;

      case "clis":
        return <CliHub embedded />;

      case "sync":
        return <SyncSettings />;

      case "rules":
        return <RulesSettings />;

      case "bridge":
        return (
          <Group
            title="When an agent asks"
            help="Applies to every agent-enabled session. Same setting as the Agent Bridge panel."
          >
            <Row
              label="Approval"
              keywords="allow all no prompts approve everything ask"
              help="Ask: each request waits for you. Allow all: agents run commands, reads and transfers without asking."
            >
              <Segmented<"ask" | "all">
                label="Approval"
                value={policy.allowAll ? "all" : "ask"}
                onChange={(v) => setPolicy({ ...policy, allowAll: v === "all" })}
                options={[
                  { value: "ask", label: "Ask" },
                  { value: "all", label: "Allow all" },
                ]}
              />
            </Row>
            <div data-settings-dependent={policy.allowAll ? "off" : "on"} aria-disabled={policy.allowAll}>
              <CheckRow
                group="Don't ask for"
                label="Reads"
                keywords="auto-approve read-only list search"
                help="Listing, reading and searching. Downloads and uploads still ask."
                checked={policy.allowAll || policy.autoRead}
                disabled={policy.allowAll}
                disabledReason="Allow all already approves these."
                onChange={(v) => setPolicy({ ...policy, autoRead: v })}
              />
              <CheckRow
                label="Safe commands"
                keywords="auto-approve shell ls cat grep"
                help="Read-only commands like ls, cat, df and grep. Best effort."
                checked={policy.allowAll || policy.autoSafeExec}
                disabled={policy.allowAll}
                disabledReason="Allow all already approves these."
                onChange={(v) => setPolicy({ ...policy, autoSafeExec: v })}
              />
            </div>
          </Group>
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

  const activeSection = SECTIONS.find((sec) => sec.id === active)!;

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onPanelKeyDown}
        data-settings-dialog
        className="anim-modal flex h-[min(46rem,90vh)] w-[min(66rem,94vw)] flex-col overflow-hidden rounded-md border border-border bg-bg-panel shadow-elev-3"
      >
        {/* Top bar: title, search across everything, Done. */}
        <div className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-3">
          <div id={titleId} className="w-[10.25rem] shrink-0 pl-1 text-sm font-semibold">
            Settings
          </div>
          <div className="relative min-w-0 max-w-xl flex-1">
            <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-text-dim" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search settings…"
              aria-label="Search settings"
              data-settings-search
              spellCheck={false}
              className={cn(inputClass, "w-full pl-8 pr-14")}
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  searchRef.current?.focus();
                }}
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-text-dim hover:text-text"
              >
                <X size={12} />
              </button>
            ) : (
              <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1 font-mono text-xs leading-4 text-text-dim">
                Ctrl F
              </kbd>
            )}
          </div>
          <div className="flex-1" />
          <Btn variant="primary" onClick={onClose}>
            Done
          </Btn>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* Section list: text only, grouped, rows touch. */}
          <nav
            aria-label="Settings sections"
            onKeyDown={onNavKeyDown}
            className="flex w-44 shrink-0 flex-col overflow-y-auto border-r border-border py-2"
          >
            {SETTINGS_GROUPS.map((g) => {
              const items = SECTIONS.filter((sec) => sec.group === g.id && (!searching || hits.has(sec.id)));
              if (!items.length) return null;
              return (
                <div key={g.id} className="mb-2">
                  <div className="px-4 pb-1 pt-1.5 text-xs text-text-dim">{g.label}</div>
                  {items.map((sec) => {
                    const on = !searching && active === sec.id;
                    const isChanged = changed.has(sec.id);
                    return (
                      <button
                        key={sec.id}
                        type="button"
                        data-settings-section={sec.id}
                        onClick={() => pickSection(sec.id)}
                        aria-current={on ? "page" : undefined}
                        title={SECTION_HELP[sec.id]}
                        className={cn(
                          "mx-2 flex h-7 w-[calc(100%-1rem)] items-center gap-2 rounded-[3px] px-2 text-left text-sm transition-colors",
                          on ? "bg-bg-hover text-text" : "text-text-muted hover:bg-bg-hover/50 hover:text-text"
                        )}
                      >
                        <span className="truncate">{sec.label}</span>
                        {isChanged && (
                          <span
                            data-settings-changed
                            title="Changed from the default"
                            className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-text-dim"
                          >
                            <span className="sr-only">(changed)</span>
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {searching && hits.size === 0 && (
              <div className="px-4 py-1 text-xs text-text-dim">No matches</div>
            )}
          </nav>

          {/* Content. */}
          <div ref={contentRef} className="min-w-0 flex-1 overflow-y-auto">
            {searching ? (
              <div data-search-results className="max-w-[48rem] space-y-6 px-7 py-5">
                {SECTIONS.map((sec) => {
                  const matched = sectionMatches(sec, q);
                  return (
                    <section
                      key={sec.id}
                      data-search-section={sec.id}
                      data-section-match={matched || undefined}
                    >
                      <h2 className="mb-2 text-xs font-semibold text-text-dim">
                        <Highlight text={sec.label} />
                      </h2>
                      <SettingsSearchScope query={q} sectionMatched={matched}>
                        <div data-search-body className="space-y-3">
                          {renderSection(sec.id)}
                        </div>
                      </SettingsSearchScope>
                    </section>
                  );
                })}
                {hits.size === 0 && (
                  <p className="pt-2 text-sm text-text-muted">No settings match “{query.trim()}”.</p>
                )}
              </div>
            ) : (
              <div className="max-w-[48rem] px-7 pb-8 pt-4">
                {/* The nav already names the page; the heading is for screen readers. */}
                <h2 className="sr-only" data-settings-heading={active}>
                  {activeSection.label}
                </h2>
                <div className="space-y-3">{renderSection(active)}</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Section-level explanations, behind the (i) next to the page title. */
const SECTION_HELP: Partial<Record<SettingsSectionId, string>> = {
  appearance: "How Faro looks. Changes apply right away.",
  transfers: "Defaults for uploads and downloads. The transfer panel can change some of these on the fly.",
  panes: "Defaults for the file browser. Most are also on the file toolbar.",
  connections: "Defaults for new connection profiles and how their secrets are kept.",
  passwordManagers: "Fill connection passwords and keys from 1Password or Bitwarden instead of saving them in Faro.",
  cloudflare: "Reach servers behind Cloudflare Access. Faro runs cloudflared for you.",
  clis: "The command-line tools your connections tunnel, sign in and import through: who is signed in, and which connections use each.",
  remoteControl: "Let another Faro on your network browse, transfer and (if you allow it) run commands on this computer.",
  bridge: "What connected AI agents may do without asking.",
  sync: "Folders kept in step with a remote folder while Faro runs, and connections mounted as folders.",
  rules: "Rename, sort and view rules for Copy to…, mounts and folders. Every change is previewed first.",
  cli: "faro-cli drives Faro from a terminal or script.",
  backup: "One password-protected file with your profiles, saved secrets, settings and sync pairs.",
  storage: "Space Faro uses for things it can rebuild. Clearing never touches your files or settings.",
};

function sectionMatches(sec: { label: string; keywords: string }, q: string): boolean {
  return sec.label.toLowerCase().includes(q) || sec.keywords.toLowerCase().includes(q);
}

/** A small icon button that puts a setting back to its default. */
function ResetButton({ label, onClick, ...rest }: { label: string; onClick: () => void } & Record<`data-${string}`, boolean | string | undefined>) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      {...rest}
      className="flex h-7 w-7 items-center justify-center rounded text-text-dim hover:bg-bg-hover hover:text-text"
    >
      <RotateCcw size={13} />
    </button>
  );
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
    <>
      <Group title="Export" help="Profiles, their saved secrets (SSH passwords, cloud tokens, the AI API key), app settings and sync pairs in one encrypted file. Useless without the password, so keep it somewhere safe.">
        <Row label="Password" keywords="backup export encrypt">
          <TextInput
            type="password"
            value={exportPw}
            onChange={(e) => setExportPw(e.target.value)}
            placeholder="At least 8 characters"
            aria-label="Backup password"
            className="w-56"
            autoComplete="new-password"
          />
        </Row>
        <Row label="Confirm password">
          <TextInput
            type="password"
            value={exportPw2}
            onChange={(e) => setExportPw2(e.target.value)}
            placeholder="Again"
            aria-label="Confirm password"
            className="w-56"
            autoComplete="new-password"
          />
        </Row>
        <Row label="" keywords="export backup">
          <Btn onClick={doExport} busy={exporting} disabled={!exportPw || !exportPw2}>
            {exporting ? "Exporting…" : "Export backup…"}
          </Btn>
        </Row>
      </Group>

      <Group title="Restore" help="Replaces this computer's profiles, settings and saved secrets with the backup's. Finishes when you restart Faro.">
        <Row label="Backup file" keywords="restore import">
          <Btn onClick={chooseFile} disabled={importing}>
            Choose file…
          </Btn>
          {importPath && (
            <span className="min-w-0 truncate font-mono text-xs text-text-muted" title={importPath}>
              {importPath.split(/[\\/]/).pop()}
            </span>
          )}
        </Row>
        {importPath && (
          <Row label="Password">
            <TextInput
              type="password"
              value={importPw}
              onChange={(e) => {
                setImportPw(e.target.value);
                setPending(null);
              }}
              placeholder="Backup password"
              aria-label="Backup password"
              className="w-56"
              autoComplete="off"
            />
            {!pending && (
              <Btn onClick={doInspect} busy={importing} disabled={!importPw}>
                {importing ? "Checking…" : "Preview"}
              </Btn>
            )}
          </Row>
        )}
        {pending && (
          <Row label="Contains">
            <div className="flex w-full flex-col gap-2">
              <List>
                <ListRow title="Connection profiles" status={<span className="text-xs tabular-nums text-text-muted">{pending.profiles}</span>} />
                <ListRow title="Saved credentials" status={<span className="text-xs tabular-nums text-text-muted">{pending.credentials}</span>} />
                <ListRow title={pending.hasSync ? "App settings and sync pairs" : "App settings"} />
              </List>
              <div>
                <Btn variant="danger" onClick={doImport} busy={importing}>
                  {importing ? "Restoring…" : "Restore and replace"}
                </Btn>
              </div>
            </div>
          </Row>
        )}
      </Group>
    </>
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
    <div role="radiogroup" data-theme-cards aria-label={label} className="grid w-full max-w-[34rem] grid-cols-4 gap-2">
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
              "flex flex-col gap-1 rounded border p-1 text-left transition-colors",
              active
                ? "border-text-muted"
                : "border-border hover:border-text-dim"
            )}
          >
            {preview(t.value)}
            <span
              className={cn(
                "flex items-center gap-1 truncate px-0.5 text-xs",
                active ? "text-text" : "text-text-muted"
              )}
            >
              {active && <Check size={11} className="shrink-0 text-text" />}
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
      className="pointer-events-none flex h-11 overflow-hidden rounded-sm border border-border bg-bg"
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
      className="pointer-events-none h-11 overflow-hidden rounded-sm border border-border px-1.5 py-1 font-mono text-[9px] leading-[12px]"
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
    <div className="flex flex-wrap items-center gap-1.5">
      {ACCENTS.map((a) => {
        const active = lower === a.hex.toLowerCase();
        return (
          <button
            key={a.hex}
            type="button"
            onClick={() => onChange(a.hex)}
            title={a.name}
            aria-label={a.name}
            aria-pressed={active}
            style={{ background: a.hex }}
            className={cn(
              "flex h-5 w-5 items-center justify-center rounded-sm ring-offset-2 ring-offset-bg-panel transition-shadow",
              active ? "ring-2 ring-text" : "ring-1 ring-black/15 hover:ring-text-dim"
            )}
          >
            {active && <Check size={11} strokeWidth={3} className="text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.7)]" />}
          </button>
        );
      })}
      <span className="mx-1 h-4 w-px bg-border" />
      <label
        title="Pick any color"
        className={cn(
          "flex h-7 cursor-pointer items-center gap-1.5 rounded border px-2 text-xs transition-colors",
          isCustom ? "border-text-dim text-text" : "border-border text-text-muted hover:text-text"
        )}
      >
        <span className="h-3 w-3 rounded-sm border border-border" style={{ background: isCustom ? value : "rgb(var(--bg-subtle))" }} />
        {isCustom ? <span className="font-mono">{value}</span> : "Custom"}
        <input type="color" value={isCustom ? value : "#8b7ff6"} onChange={(e) => onChange(e.target.value)} className="sr-only" />
      </label>
      <button
        type="button"
        onClick={() => onChange("")}
        aria-pressed={value === ""}
        className={cn(
          "flex h-7 items-center rounded border px-2 text-xs transition-colors",
          value === "" ? "border-text-dim text-text" : "border-border text-text-muted hover:text-text"
        )}
      >
        Theme default
      </button>
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
      className="h-7 w-52 py-0"
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
            "h-7 w-20 rounded border bg-bg-subtle px-2.5 text-right text-sm tabular-nums outline-none disabled:cursor-not-allowed disabled:opacity-60",
            error ? "border-danger focus:border-danger" : "border-border focus:border-text-dim"
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
  mono,
  ...rest
}: {
  value: string;
  onCommit: (v: string) => void;
  delay?: number;
  placeholder?: string;
  "aria-label"?: string;
  "data-settings-focus"?: string;
  /** Paths and commands. */
  mono?: boolean;
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
      title={draft || undefined}
      className={cn(inputClass, "w-72 max-w-full", mono && "font-mono text-xs")}
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
    <>
      <CheckRow
        label="Limit bandwidth"
        keywords="throttle cap speed"
        help="One cap shared by all transfers. Also on the transfer panel."
        checked={on}
        onChange={(v) => onChange(v ? last : 0)}
      />
      <div data-settings-dependent={on ? "on" : "off"} aria-disabled={!on}>
        <Row label="Limit" indent disabled={!on} keywords="bandwidth kib">
          <NumberInput
            label="Bandwidth limit"
            min={1}
            max={1024 * 1024}
            value={on ? kbps : last}
            onChange={onChange}
            suffix="KiB/s"
            disabled={!on}
          />
        </Row>
      </div>
    </>
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
    <List data-storage-list="">
      {CACHE_ORDER.map((id) => {
        const u = usage[id];
        const empty = !u || (u.bytes === 0 && u.items === 0);
        return (
          <ListRow
            key={id}
            data-cache-card={id}
            title={
              <span className="flex items-center gap-1.5">
                <Highlight text={CACHE_INFO[id].title} />
                <InfoTip text={CACHE_INFO[id].note} />
              </span>
            }
            status={
              <span data-cache-size className="text-xs tabular-nums text-text-muted">
                {!loaded
                  ? "…"
                  : !u
                    ? "Unavailable"
                    : empty
                      ? "Empty"
                      : `${fmtSize(u.bytes)} · ${plural(u.items, id === "thumbnails" ? "file" : id === "transferResume" ? "transfer" : "folder")}`}
              </span>
            }
            actions={
              <Btn size="sm" onClick={() => void clear(id)} disabled={empty || busy !== null} busy={busy === id}>
                {busy === id ? "Clearing…" : "Clear"}
              </Btn>
            }
          />
        );
      })}
    </List>
  );
}

/// Which shell a new local terminal tab starts (Plan 36 Phase 1).
function LocalShellRow() {
  const value = useSettings((s) => s.terminalLocalShell);
  const [shells, setShells] = useState<LocalShell[]>([]);
  useEffect(() => {
    let alive = true;
    void localShells().then((list) => {
      if (alive) setShells(list);
    });
    return () => {
      alive = false;
    };
  }, []);
  return (
    <Row
      label="Local shell"
      keywords="powershell bash zsh cmd wsl git default this computer"
      help="The shell a new local terminal tab starts. Right-click the + in the terminal to pick another one for a single tab."
    >
      <Select<string>
        label="Local shell"
        value={shells.some((s) => s.id === value) ? value : ""}
        onChange={(v) => setSetting("terminalLocalShell", v)}
        options={[
          { value: "", label: shells[0] ? `Default (${shells[0].name})` : "Default" },
          ...shells.map((s) => ({ value: s.id, label: s.name })),
        ]}
      />
    </Row>
  );
}
