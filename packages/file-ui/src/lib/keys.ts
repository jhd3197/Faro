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
  | "focusFilter"
  | "copy"
  | "cut"
  | "paste";

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
  copy: "mod+c",
  cut: "mod+x",
  paste: "mod+v",
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
  // Shift turns the bracket keys into braces; keep the key's own name so
  // "mod+shift+[" means the key a user sees on the keycap.
  else if (code === "BracketLeft" && k === "{") k = "[";
  else if (code === "BracketRight" && k === "}") k = "]";
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

/** True while an input method (Chinese, Japanese, Korean…) is composing: the
 *  Enter that picks a candidate must not also submit. keyCode 229 covers the
 *  WebKit builds that report the confirming keydown after compositionend. */
export function isComposing(e: { nativeEvent?: KeyboardEvent; isComposing?: boolean; keyCode?: number }): boolean {
  const n = e.nativeEvent ?? e;
  return !!n.isComposing || n.keyCode === 229;
}

type EnterEvent = {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  target: EventTarget | null;
  defaultPrevented?: boolean;
  nativeEvent?: KeyboardEvent;
  isComposing?: boolean;
  keyCode?: number;
};

/** Whether this Enter should confirm a dialog. Only a bare Enter counts (a
 *  modifier means the user wants something else); a focused button, link,
 *  select or textarea keeps Enter for itself; a disabled confirm stays
 *  disabled; and an input method picking a candidate never confirms. */
export function shouldConfirmOnEnter(e: EnterEvent, opts: { disabled?: boolean } = {}): boolean {
  if (e.key !== "Enter" || opts.disabled || e.defaultPrevented) return false;
  if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return false;
  if (isComposing(e)) return false;
  const t = e.target as HTMLElement | null;
  if (t && typeof t.closest === "function") {
    if (t.closest("button, a[href], select, textarea, [role='button'], [role='menuitem'], [role='option'], [role='combobox'], [contenteditable='true']")) {
      return false;
    }
  }
  return true;
}
