// File-browser keyboard actions and their built-in default combos. The package
// stays transport- and app-agnostic: a host can remap these by passing
// `PaneSettings.keyBindings`, but with nothing supplied the pane still works
// with these sensible defaults. Faro threads its effective (user-overridable)
// bindings in from the shared bindings layer (Plan 15).

export type FileBrowserAction =
  | "rename"
  | "open"
  | "delete"
  | "parentDir"
  | "selectAll"
  | "quickInfo"
  | "newFolder"
  | "refresh"
  | "back"
  | "forward"
  | "focusPath"
  | "focusFilter";

/** Canonical default combos, in the same "mod+shift+key" shape the rest of Faro
 *  uses ("mod" = Ctrl on Windows/Linux, Cmd on macOS). */
export const DEFAULT_FILE_BROWSER_KEYBINDINGS: Record<FileBrowserAction, string> = {
  rename: "f2",
  open: "enter",
  delete: "delete",
  parentDir: "backspace",
  selectAll: "mod+a",
  quickInfo: "space",
  newFolder: "mod+shift+n",
  refresh: "f5",
  back: "alt+arrowleft",
  forward: "alt+arrowright",
  focusPath: "mod+l",
  focusFilter: "mod+f",
};

/** Build the canonical combo string for a keydown event. The app's `keyCombo`
 *  is this same function, so the two can never disagree on a spelling.
 *
 *  Letters and digits come from the physical key (`e.code`) whenever `e.key`
 *  isn't the plain character: Option+X on a Mac types "≈" and Shift+1 types
 *  "!", but both should still read as the X / 1 key. */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  let k = (e.key ?? "").toLowerCase();
  const code = e.code ?? "";
  if (/^Key[A-Z]$/.test(code) && !/^[a-z]$/.test(k)) k = code.slice(3).toLowerCase();
  else if (/^Digit[0-9]$/.test(code) && !/^[0-9]$/.test(k)) k = code.slice(5);
  if (k === " ") k = "space";
  if (k === "esc") k = "escape";
  parts.push(k);
  return parts.join("+");
}

const NAMED_KEYS: Record<string, [win: string, mac: string]> = {
  arrowleft: ["←", "←"],
  arrowright: ["→", "→"],
  arrowup: ["↑", "↑"],
  arrowdown: ["↓", "↓"],
  escape: ["Esc", "Esc"],
  enter: ["Enter", "↩"],
  backspace: ["Backspace", "⌫"],
  delete: ["Delete", "⌦"],
  space: ["Space", "Space"],
  tab: ["Tab", "⇥"],
  pageup: ["Page Up", "Page Up"],
  pagedown: ["Page Down", "Page Down"],
  home: ["Home", "Home"],
  end: ["End", "End"],
};

/** Human-readable, OS-native form of a canonical combo.
 *  Windows/Linux: "Ctrl+Shift+W", "Alt+←", "Delete".
 *  macOS: modifiers in the system order ⌃⌥⇧⌘, no separators: "⇧⌘W". */
export function formatCombo(combo: string, mac = isMacPlatform()): string {
  if (!combo) return "";
  const parts = combo.split("+");
  // "mod++" (the plus key) splits into a trailing empty pair.
  let key = parts.pop() ?? "";
  if (key === "" && parts[parts.length - 1] === "") {
    parts.pop();
    key = "+";
  }
  const has = (m: string) => parts.includes(m);
  const named = NAMED_KEYS[key];
  const keyLabel = named
    ? named[mac ? 1 : 0]
    : key.length === 1
      ? key.toUpperCase()
      : /^f\d{1,2}$/.test(key)
        ? key.toUpperCase()
        : key.charAt(0).toUpperCase() + key.slice(1);
  if (mac) {
    return (
      (has("alt") ? "⌥" : "") +
      (has("shift") ? "⇧" : "") +
      (has("mod") ? "⌘" : "") +
      keyLabel
    );
  }
  const mods: string[] = [];
  if (has("mod")) mods.push("Ctrl");
  if (has("alt")) mods.push("Alt");
  if (has("shift")) mods.push("Shift");
  return [...mods, keyLabel].join("+");
}

export function isMacPlatform(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (/mac/i.test(navigator.platform) || /mac/i.test(navigator.userAgent))
  );
}
