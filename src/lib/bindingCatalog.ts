// Remappable keys that aren't palette commands: keys that act on whatever has
// focus in a list (a server bubble, a group header, a site, a terminal tab),
// plus a few window-level keys owned by a component. Like the file-browser
// catalogue, each has a stable override id so Settings › Keyboard can list and
// remap it, and menus can show the live binding as their hint.

export const FOCUS_GROUP = "Lists and tabs";

export interface ScopedKeySpec {
  /** faro.db override id. */
  id: string;
  title: string;
  defaultCombo: string;
  /** Conflict scope. "focus" keys only fire on the focused row, so they only
   *  clash with each other; "cmd" keys are window-wide like commands. */
  scope: "focus" | "cmd";
}

export const SCOPED_KEYS: ScopedKeySpec[] = [
  { id: "focus.rename", title: "Rename the focused item", defaultCombo: "f2", scope: "focus" },
  { id: "rail.connect", title: "Connect the focused server", defaultCombo: "enter", scope: "focus" },
  { id: "rail.delete", title: "Delete the focused server", defaultCombo: "delete", scope: "focus" },
  { id: "rail.duplicate", title: "Duplicate the focused server", defaultCombo: "mod+d", scope: "focus" },
  { id: "rail.search", title: "Search servers", defaultCombo: "/", scope: "cmd" },
];

/** Default combos of registry commands that other surfaces show as hints
 *  (the rail menu shows the terminal and reconnect keys). The registry reads
 *  its combos from here too, so a hint can't drift from the real default. */
export const COMMAND_COMBOS = {
  "toggle-terminal": "mod+`",
  reconnect: "mod+shift+r",
  "toggle-rail": "mod+\\",
} as const;

const DEFAULTS: Record<string, string> = {
  ...COMMAND_COMBOS,
  ...Object.fromEntries(SCOPED_KEYS.map((k) => [k.id, k.defaultCombo])),
};

/** The built-in combo for a catalogue or command id, if it has one here. */
export function defaultComboFor(id: string): string | undefined {
  return DEFAULTS[id];
}
