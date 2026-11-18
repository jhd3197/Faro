// Canonical keyboard-combo representation shared by the shortcut hook, the
// command registry, the title-bar menus and the cheat-sheet. "mod" = Ctrl on
// Windows/Linux and Cmd on macOS so one registry is cross-platform.
//
// The event → combo and combo → label functions live in the file-browser
// package (the panes need them without depending on the app); these are the
// same functions, so a combo is spelled and shown one way everywhere.
import {
  comboFromEvent,
  formatCombo as formatComboFor,
  isMacPlatform,
} from "@faro/file-ui";

export const isMac = isMacPlatform();

export const MOD_LABEL = isMac ? "⌘" : "Ctrl";

/** Build the canonical combo for a keydown event, e.g. "mod+shift+t". */
export function keyCombo(e: KeyboardEvent): string {
  return comboFromEvent(e);
}

/** OS-native label: "Ctrl+Shift+T" on Windows/Linux, "⇧⌘T" on macOS. */
export function formatCombo(combo: string): string {
  return formatComboFor(combo, isMac);
}
