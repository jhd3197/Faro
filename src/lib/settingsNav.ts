// Which Settings section a control outside the dialog should open.
// Generic entry points (the gear, Edit → Preferences, "Open Settings") are
// intentionally not listed: they land on Appearance.

export const SETTINGS_SECTIONS = [
  { id: "appearance", group: "app", label: "Appearance", keywords: "theme mode accent zoom language palette frame" },
  { id: "panes", group: "app", label: "File panes", keywords: "hidden files sort view layout preview editor" },
  { id: "transfers", group: "app", label: "Transfers", keywords: "download upload overwrite bandwidth checksum" },
  { id: "terminal", group: "app", label: "Terminal", keywords: "font scrollback shell suggestions" },
  { id: "keyboard", group: "app", label: "Keyboard", keywords: "shortcuts keybindings hotkeys remap" },
  { id: "connections", group: "connections", label: "Connections", keywords: "port password keychain" },
  { id: "passwordManagers", group: "connections", label: "Password managers", keywords: "1password bitwarden vault op bw ssh agent master password unlock" },
  { id: "cloudflare", group: "connections", label: "Cloudflare", keywords: "cloudflare cloudflared access tunnel account" },
  { id: "remoteControl", group: "connections", label: "Remote control", keywords: "remote control agent host pairing faro agent" },
  { id: "bridge", group: "connections", label: "Agent Bridge", keywords: "agent bridge approval policy" },
  { id: "sync", group: "system", label: "Folder sync", keywords: "folder sync mirror watch pair mount mounts on demand" },
  { id: "rules", group: "system", label: "Rules", keywords: "rules rename sort view template naming organize photos library" },
  { id: "cli", group: "system", label: "CLI", keywords: "faro-cli command line terminal updater path" },
  { id: "backup", group: "system", label: "Backup", keywords: "backup restore export" },
  { id: "storage", group: "system", label: "Storage", keywords: "cache clear thumbnails resume disk space" },
  { id: "about", group: "system", label: "About", keywords: "version notifications about" },
] as const;

/** Nav groups, in order. */
export const SETTINGS_GROUPS = [
  { id: "app", label: "App" },
  { id: "connections", label: "Connections" },
  { id: "system", label: "System" },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

/** `data-settings-focus` values. The dialog scrolls the node into view and focuses it. */
export const SETTINGS_FOCUS = {
  downloadFolder: "settings-download-folder",
  cloudflareAccount: "settings-cloudflare-account",
  cloudflared: "settings-cloudflared",
  showPairingCode: "settings-show-pairing-code",
  keyboardSearch: "settings-keyboard-search",
  themeMode: "settings-theme-mode",
  transferConcurrency: "settings-transfer-concurrency",
  bitwardenPassword: "settings-bitwarden-password",
  opCli: "settings-op-cli",
  bwCli: "settings-bw-cli",
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
  keyboardCustomize: { section: "keyboard", focus: SETTINGS_FOCUS.keyboardSearch },
  pairingRemoteControl: { section: "remoteControl", focus: SETTINGS_FOCUS.showPairingCode },
  themeMenu: { section: "appearance", focus: SETTINGS_FOCUS.themeMode },
  transferPanel: { section: "transfers", focus: SETTINGS_FOCUS.transferConcurrency },
  vaultLocked: { section: "passwordManagers", focus: SETTINGS_FOCUS.bitwardenPassword },
  opCliUpdate: { section: "passwordManagers", focus: SETTINGS_FOCUS.opCli },
  bwCliUpdate: { section: "passwordManagers", focus: SETTINGS_FOCUS.bwCli },
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
