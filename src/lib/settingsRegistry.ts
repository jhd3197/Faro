// A description of every user-facing setting (Plan 37 Phase 1): which section
// it lives in, what it is called and what kind of control it takes. The
// Settings pages still lay their rows out by hand; this table is what lets
// the Changed view and the command palette reach a setting without knowing
// its page.
//
// Adding a persisted setting means adding it here or to INTERNAL_SETTINGS; a
// unit test fails otherwise (scripts/settings-registry.test.mjs).

import type { SettingsSectionId } from "./settingsNav";

export type SettingKind = "toggle" | "choice" | "number" | "text" | "custom";

export interface SettingOption {
  value: string | number | boolean;
  label: string;
}

export interface SettingEntry {
  /** The persisted key in the settings store. */
  key: string;
  section: SettingsSectionId;
  label: string;
  /** Extra words the palette and search find it by. */
  keywords?: string;
  kind: SettingKind;
  /** `choice`: the values it can take. */
  options?: SettingOption[];
  /** `number`: unit shown after the value. */
  unit?: string;
  /** `text`: what an empty value means ("System Downloads"). */
  emptyLabel?: string;
}

/** Persisted keys that are state, not settings: derived values, remembered
 *  UI positions and per-connection maps edited where they apply. */
export const INTERNAL_SETTINGS: readonly string[] = [
  "appTheme",
  "railExpanded",
  "railCollapsedGroups",
  "railSort",
  "terminalPersistOverrides",
];

const onOff = (key: string, section: SettingsSectionId, label: string, keywords?: string): SettingEntry => ({
  key,
  section,
  label,
  keywords,
  kind: "toggle",
});

export const SETTINGS_REGISTRY: readonly SettingEntry[] = [
  // ---- Appearance ----
  {
    key: "themeMode",
    section: "appearance",
    label: "Theme mode",
    keywords: "light dark system appearance",
    kind: "choice",
    options: [
      { value: "light", label: "Light" },
      { value: "dark", label: "Dark" },
      { value: "system", label: "System" },
    ],
  },
  { key: "lightTheme", section: "appearance", label: "Light theme", keywords: "theme colors", kind: "custom" },
  { key: "darkTheme", section: "appearance", label: "Dark theme", keywords: "theme colors", kind: "custom" },
  { key: "accentColor", section: "appearance", label: "Accent color", keywords: "highlight colour", kind: "custom" },
  { key: "uiZoom", section: "appearance", label: "UI zoom", keywords: "scale size", kind: "number", unit: "%" },
  {
    key: "frameStyle",
    section: "appearance",
    label: "Window frame",
    keywords: "title bar controls buttons",
    kind: "choice",
    options: [
      { value: "windows", label: "Windows" },
      { value: "macos", label: "macOS" },
      { value: "linux", label: "Linux" },
    ],
  },
  { key: "uiLanguage", section: "appearance", label: "Language", keywords: "locale translation", kind: "custom" },

  // ---- Transfers ----
  {
    key: "overwritePolicy",
    section: "transfers",
    label: "If the file exists",
    keywords: "overwrite skip rename conflict",
    kind: "choice",
    options: [
      { value: "overwrite", label: "Overwrite" },
      { value: "skip", label: "Skip" },
      { value: "rename", label: "Keep both" },
    ],
  },
  onOff("promptOnOverwrite", "transfers", "Ask before overwriting", "confirm prompt conflict"),
  onOff("autoOpenTransferPanel", "transfers", "Open the transfer panel automatically", "queue show"),
  { key: "transferConcurrency", section: "transfers", label: "Concurrent transfers", keywords: "parallel queue", kind: "number" },
  { key: "transferThrottleKbps", section: "transfers", label: "Bandwidth limit", keywords: "throttle speed cap", kind: "number", unit: " KB/s" },
  onOff("deltaSync", "transfers", "Delta sync", "changed blocks differential"),
  { key: "transferSegments", section: "transfers", label: "Connections per file", keywords: "segments ranges parallel", kind: "custom" },
  onOff("transferVerify", "transfers", "Verify with a checksum", "hash integrity"),
  { key: "defaultDownloadFolder", section: "transfers", label: "Download folder", keywords: "downloads location path", kind: "text", emptyLabel: "System Downloads" },
  {
    key: "transferTarFolders",
    section: "transfers",
    label: "Send folders of small files as one stream",
    keywords: "tar fast folder many small files ssh",
    kind: "choice",
    options: [
      { value: "auto", label: "When it is faster" },
      { value: "off", label: "Never" },
    ],
  },

  // ---- File panes ----
  onOff("showHiddenFiles", "panes", "Show hidden files", "dotfiles"),
  {
    key: "sortField",
    section: "panes",
    label: "Sort by",
    keywords: "order",
    kind: "choice",
    options: [
      { value: "name", label: "Name" },
      { value: "size", label: "Size" },
      { value: "modified", label: "Modified" },
    ],
  },
  {
    key: "sortDirection",
    section: "panes",
    label: "Sort direction",
    keywords: "order ascending descending",
    kind: "choice",
    options: [
      { value: "asc", label: "Ascending" },
      { value: "desc", label: "Descending" },
    ],
  },
  {
    key: "paneViewMode",
    section: "panes",
    label: "View",
    keywords: "details list grid",
    kind: "choice",
    options: [
      { value: "list", label: "List" },
      { value: "details", label: "Details" },
      { value: "grid", label: "Grid" },
    ],
  },
  {
    key: "paneDensity",
    section: "panes",
    label: "Density",
    keywords: "compact comfortable rows",
    kind: "choice",
    options: [
      { value: "comfortable", label: "Comfortable" },
      { value: "compact", label: "Compact" },
    ],
  },
  {
    key: "browserLayout",
    section: "panes",
    label: "Browser layout",
    keywords: "single split dual panes",
    kind: "choice",
    options: [
      { value: "single", label: "Single" },
      { value: "dual", label: "Split" },
    ],
  },
  {
    key: "remoteImagePreviews",
    section: "panes",
    label: "Remote image previews",
    keywords: "thumbnails",
    kind: "choice",
    options: [
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ],
  },
  onOff("filePreview", "panes", "Preview the selected file", "text preview pane"),
  { key: "defaultEditor", section: "panes", label: "External editor command", keywords: "edit in place code vscode", kind: "text", emptyLabel: "OS default" },
  {
    key: "editorOpenWith",
    section: "panes",
    label: "Open files for editing in",
    keywords: "built-in editor external edit",
    kind: "choice",
    options: [
      { value: "builtin", label: "Faro's editor" },
      { value: "external", label: "My editor" },
    ],
  },
  onOff("editorAutoSave", "panes", "Auto-save in the editor", "autosave save automatically"),

  // ---- Terminal ----
  { key: "terminalFontSize", section: "terminal", label: "Terminal font size", keywords: "text size", kind: "number", unit: "px" },
  { key: "terminalFontFamily", section: "terminal", label: "Terminal font", keywords: "family typeface", kind: "custom" },
  { key: "terminalTheme", section: "terminal", label: "Terminal theme", keywords: "colors", kind: "custom" },
  { key: "terminalScrollback", section: "terminal", label: "Scrollback", keywords: "history lines buffer", kind: "number", unit: " lines" },
  onOff("terminalCopyOnSelect", "terminal", "Copy on select", "clipboard"),
  onOff("terminalSuggestions", "terminal", "Inline suggestions", "autocomplete history ghost"),
  {
    key: "terminalCursorStyle",
    section: "terminal",
    label: "Cursor style",
    keywords: "caret",
    kind: "choice",
    options: [
      { value: "block", label: "Block" },
      { value: "bar", label: "Bar" },
      { value: "underline", label: "Underline" },
    ],
  },
  onOff("terminalCursorBlink", "terminal", "Cursor blink", "caret"),
  { key: "terminalLineHeight", section: "terminal", label: "Line height", keywords: "spacing leading", kind: "number" },
  onOff("terminalPasteImages", "terminal", "Paste images as a file path", "screenshot clipboard upload"),
  onOff("terminalPlainPaste", "terminal", "Plain paste", "bracketed paste raw"),
  onOff("terminalOsc52", "terminal", "Let the server set the clipboard", "osc 52 copy remote"),
  onOff("terminalHighlight", "terminal", "Highlight keywords", "color error warning"),
  { key: "terminalHighlightRules", section: "terminal", label: "Highlight rules", keywords: "pattern regex", kind: "custom" },
  {
    key: "terminalPersist",
    section: "terminal",
    label: "Keep server shells running",
    keywords: "persistent sessions tmux survive disconnect",
    kind: "choice",
    options: [
      { value: "off", label: "Off" },
      { value: "on", label: "On" },
    ],
  },
  onOff("terminalRestoreWorkspace", "terminal", "Restore terminal tabs", "workspace layout splits"),
  { key: "terminalLocalShell", section: "terminal", label: "Local shell", keywords: "powershell bash zsh cmd wsl", kind: "custom" },

  // ---- Connections ----
  { key: "defaultPort", section: "connections", label: "Default port", keywords: "ssh sftp 22", kind: "number" },
  onOff("storePasswordsInKeychain", "connections", "Save passwords in the OS keychain", "credential manager secrets"),
  onOff("restoreLastSession", "connections", "Restore last session", "reconnect startup"),

  // ---- Appearance: time ----
  {
    key: "timeFormat",
    section: "appearance",
    label: "Time format",
    keywords: "12 hour 24 hour clock am pm dates",
    kind: "choice",
    options: [
      { value: "auto", label: "Automatic" },
      { value: "12h", label: "12-hour" },
      { value: "24h", label: "24-hour" },
    ],
  },

  // ---- About ----
  { key: "notifications", section: "about", label: "Desktop notifications", keywords: "notify alerts", kind: "custom" },
];

const BY_KEY = new Map(SETTINGS_REGISTRY.map((e) => [e.key, e]));

export function settingEntry(key: string): SettingEntry | undefined {
  return BY_KEY.get(key);
}

/** Does `value` differ from the default? `alsoDefault` lists other values
 *  that count as untouched for a key. */
export function isChangedValue(value: unknown, fallback: unknown, alsoDefault: unknown[] = []): boolean {
  const same = (v: unknown) => JSON.stringify(v) === JSON.stringify(value);
  return !same(fallback) && !alsoDefault.some(same);
}

/** A short, human reading of a setting's value. */
export function settingValueLabel(entry: SettingEntry, value: unknown): string {
  if (entry.kind === "toggle") return value ? "On" : "Off";
  if (entry.kind === "choice") {
    return entry.options?.find((o) => o.value === value)?.label ?? String(value);
  }
  if (entry.kind === "number") return `${value}${entry.unit ?? ""}`;
  if (entry.kind === "text") return value ? String(value) : entry.emptyLabel ?? "Not set";
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "item" : "items"}`;
  if (value && typeof value === "object") return "Custom";
  if (value === "" || value == null) return "Default";
  const text = String(value);
  return text.length > 40 ? `${text.slice(0, 37)}…` : text;
}

/** Search match that forgives one typo. Short queries must match exactly as
 *  a substring; from four characters on, one wrong, missing or extra
 *  character is allowed. Both arguments are compared case-insensitively. */
export function looseMatch(text: string, query: string): boolean {
  const t = text.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (t.includes(q)) return true;
  if (q.length < 4) return false;
  // Slide a window of length |q|-1 … |q|+1 across the text and accept an
  // edit distance of 1.
  for (let len = q.length - 1; len <= q.length + 1; len++) {
    if (len <= 0 || len > t.length) continue;
    for (let i = 0; i + len <= t.length; i++) {
      if (withinOneEdit(t.slice(i, i + len), q)) return true;
    }
  }
  return false;
}

function withinOneEdit(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
