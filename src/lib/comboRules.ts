// What the Settings › Keyboard recorder accepts as a shortcut. Pure (no
// imports) so the rules are unit-tested directly.

/** Keys that are never a binding on their own: they only modify. */
export const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph"]);

/** Lock keys toggle state; recording them would make a binding that "sticks". */
export const LOCK_KEYS = new Set(["CapsLock", "NumLock", "ScrollLock", "FnLock"]);

/** At most this many keys in one shortcut (modifiers included). */
export const MAX_KEYS = 3;

/** Keys that may be bound without a modifier: the function keys, plus the
 *  named keys file panes and the server rail already use bare. */
const BARE_OK = new Set(["enter", "delete", "backspace", "space", "/"]);
export function allowsBare(key: string): boolean {
  return /^f([1-9]|1[0-2])$/.test(key) || BARE_OK.has(key);
}

/** Combos the operating system takes before Faro ever sees them. */
export const RESERVED: Record<"mac" | "other", Record<string, string>> = {
  mac: {
    "mod+h": "hides the app",
    "mod+m": "minimizes the window",
    "mod+q": "quits the app",
    "mod+space": "opens Spotlight",
    "mod+tab": "switches apps",
    "mod+shift+3": "takes a screenshot",
    "mod+shift+4": "takes a screenshot",
    "mod+shift+5": "takes a screenshot",
  },
  other: {
    "alt+f4": "closes the window",
    "alt+tab": "switches windows",
    "alt+shift+tab": "switches windows",
    "mod+alt+delete": "opens the security screen",
    "mod+shift+escape": "opens Task Manager",
    "alt+space": "opens the window menu",
    "alt+escape": "switches windows",
  },
};

export type ComboProblem =
  | { code: "modifiers-only"; message: string }
  | { code: "needs-modifier"; message: string }
  | { code: "too-many-keys"; message: string }
  | { code: "reserved"; message: string };

/** Count the keys in a canonical combo ("mod+shift+k" → 3). */
export function keyCount(combo: string): number {
  return combo.split("+").filter(Boolean).length + (combo.endsWith("++") ? 1 : 0);
}

/**
 * Check a recorded combo. `label` renders a combo for the message (OS-native);
 * `windowsKey` is true when the Windows/Super key was held on Windows/Linux,
 * where it can't be told apart from Ctrl in the canonical form.
 */
export function validateCombo(
  combo: string,
  opts: { mac: boolean; windowsKey?: boolean; label: (c: string) => string }
): ComboProblem | null {
  const parts = combo.split("+");
  const plusKey = combo.endsWith("++");
  const key = plusKey ? "+" : parts[parts.length - 1];
  const mods = parts.slice(0, plusKey ? -2 : -1);
  if (!key) {
    return { code: "modifiers-only", message: `Add a non-modifier key (e.g. ${opts.mac ? "⌘K" : "Ctrl+K"})` };
  }
  if (!opts.mac && opts.windowsKey) {
    return { code: "reserved", message: "Windows-key shortcuts belong to the system (Win+L locks the screen)" };
  }
  if (keyCount(combo) > MAX_KEYS) {
    return { code: "too-many-keys", message: `Use at most ${MAX_KEYS} keys` };
  }
  if (mods.length === 0 && !allowsBare(key)) {
    return { code: "needs-modifier", message: `Add a modifier (e.g. ${opts.label(`mod+${key}`)})` };
  }
  const reserved = RESERVED[opts.mac ? "mac" : "other"][combo];
  if (reserved) {
    return {
      code: "reserved",
      message: `${opts.label(combo)} is reserved by ${opts.mac ? "macOS" : "the system"}: it ${reserved}`,
    };
  }
  return null;
}

/** The combo for the modifiers currently held, with no key yet ("mod+shift+"),
 *  for showing a draft while the user is still pressing keys. */
export function modifierDraft(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  return parts.length ? parts.join("+") + "+" : "";
}
