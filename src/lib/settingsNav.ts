// Which Settings section a control outside the dialog should open.
// Generic entry points (the gear, Edit → Preferences, "Open Settings") are
// intentionally not listed: they land on Appearance.

export const SETTINGS_SECTIONS = [
  { id: "appearance", label: "Appearance", keywords: "theme mode accent zoom language palette frame" },
  { id: "transfers", label: "Transfers", keywords: "download upload overwrite bandwidth checksum" },
  { id: "panes", label: "File panes", keywords: "hidden files sort view layout preview editor" },
  { id: "terminal", label: "Terminal", keywords: "font scrollback shell suggestions" },
  { id: "keyboard", label: "Keyboard", keywords: "shortcuts keybindings hotkeys remap" },
  { id: "connections", label: "Connections", keywords: "port password keychain" },
  { id: "remoteControl", label: "Remote control", keywords: "remote control agent host pairing faro agent" },
  { id: "sync", label: "Folder Sync", keywords: "folder sync mirror watch pair" },
  { id: "bridge", label: "Agent Bridge", keywords: "agent bridge approval policy" },
  { id: "cli", label: "faro-cli", keywords: "cli command line updater path" },
  { id: "cloudflare", label: "Cloudflare", keywords: "cloudflare cloudflared access tunnel account" },
  { id: "backup", label: "Backup", keywords: "backup restore export" },
  { id: "about", label: "About", keywords: "version notifications about" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** `data-settings-focus` values. The dialog scrolls the node into view and focuses it. */
export const SETTINGS_FOCUS = {
  downloadFolder: "settings-download-folder",
  cloudflareAccount: "settings-cloudflare-account",
  cloudflared: "settings-cloudflared",
  showPairingCode: "settings-show-pairing-code",
  keyboardSearch: "settings-keyboard-search",
} as const;

export interface SettingsTarget {
  section: SettingsSectionId;
  focus?: string;
}

export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "appearance";

const SECTION_IDS = new Set<string>(SETTINGS_SECTIONS.map((s) => s.id));

export function isSettingsSectionId(value: string): value is SettingsSectionId {
  return SECTION_IDS.has(value);
}

/** Command-palette id for "jump straight to this section". */
export function settingsCommandId(section: SettingsSectionId): string {
  return `settings:${section}`;
}

/**
 * Named jumps from the rest of the app. The UI reads this table; tests assert
 * each id still points at the section (and field) the control is about.
 */
export const SETTINGS_ENTRY_POINTS = {
  statusBarSync: { section: "sync" },
  folderSyncError: { section: "sync" },
  inviteCloudflare: { section: "cloudflare", focus: SETTINGS_FOCUS.cloudflareAccount },
  moveToCloudflare: { section: "cloudflare", focus: SETTINGS_FOCUS.cloudflareAccount },
  downloadFolder: { section: "transfers", focus: SETTINGS_FOCUS.downloadFolder },
  cloudflaredUpdate: { section: "cloudflare", focus: SETTINGS_FOCUS.cloudflared },
  profileCloudflareAccount: { section: "cloudflare", focus: SETTINGS_FOCUS.cloudflareAccount },
  aboutCliInstall: { section: "cli" },
  keyboardCustomize: { section: "keyboard", focus: SETTINGS_FOCUS.keyboardSearch },
  pairingRemoteControl: { section: "remoteControl", focus: SETTINGS_FOCUS.showPairingCode },
} as const satisfies Record<string, SettingsTarget>;

export type SettingsEntryPointId = keyof typeof SETTINGS_ENTRY_POINTS;

export function entryPointTarget(id: SettingsEntryPointId): SettingsTarget {
  return SETTINGS_ENTRY_POINTS[id];
}

/** A section id or a target. Unknown sections are dropped so a bad link cannot open Settings on the wrong page. */
export function normalizeSettingsTarget(
  target: SettingsSectionId | string | { section: string; focus?: string } | null | undefined,
): SettingsTarget | null {
  if (target == null) return null;
  if (typeof target === "string") {
    return isSettingsSectionId(target) ? { section: target } : null;
  }
  if (!isSettingsSectionId(target.section)) return null;
  const focus = target.focus?.trim();
  return focus ? { section: target.section, focus } : { section: target.section };
}
