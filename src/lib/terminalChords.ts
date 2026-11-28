// Terminal split/zoom/close chords (Plan 11 Phase 2), in one place so the
// command registry (which binds them, discoverable in the palette + cheat
// sheet) and the terminal itself (which must SWALLOW them so they never reach
// the shell) can't drift apart. As of Plan 15 the chords are remappable: the
// command combos resolve through the shared bindings layer, and the xterm
// swallow-matcher below reads the same effective bindings.
//
// Why `mod+shift+…` and not the plan's bare Cmd+D: "mod" is Ctrl on Windows/
// Linux, and a bare Ctrl+D is EOF in every shell — binding split to it would
// break the terminal. The shift-qualified chords collide with nothing the
// shell needs, and the terminal swallows them anyway (see isTerminalChord).

import { useBindings } from "@/stores/bindingsStore";
import { keyCombo } from "@/lib/shortcuts";

export const TERMINAL_CHORDS = {
  splitRight: "mod+shift+d", // side-by-side (vertical divider)
  splitDown: "mod+shift+e", // stacked (horizontal divider)
  zoom: "mod+shift+enter",
  closePane: "mod+shift+w",
  // Tab strip. mod+shift+t is the theme toggle, so reopen takes mod+alt+t.
  reopenTab: "mod+alt+t",
  prevTab: "mod+shift+[",
  nextTab: "mod+shift+]",
  lastTab: "mod+9",
  clear: "mod+shift+k",
} as const;

/** Command id for "go to terminal tab n" (1–8); tab 9 is `term-tab-last`. */
export const termTabCommandId = (n: number) => `term-tab-${n}`;

// Override ids (they match the command-registry ids) → their default chord.
// Undefined = no default, but a user binding is still kept from the shell.
const CHORD_COMMAND_DEFAULTS: Record<string, string | undefined> = {
  "term-split-right": TERMINAL_CHORDS.splitRight,
  "term-split-down": TERMINAL_CHORDS.splitDown,
  "term-zoom-pane": TERMINAL_CHORDS.zoom,
  "term-close-pane": TERMINAL_CHORDS.closePane,
  "term-reopen-tab": TERMINAL_CHORDS.reopenTab,
  "term-tab-prev": TERMINAL_CHORDS.prevTab,
  "term-tab-next": TERMINAL_CHORDS.nextTab,
  "term-tab-last": TERMINAL_CHORDS.lastTab,
  "term-clear": TERMINAL_CHORDS.clear,
  "term-select-all": undefined,
  "term-copy-output": undefined,
  "term-save-output": undefined,
  "term-broadcast": undefined,
  "term-lock-tab": undefined,
  "term-pin-tab": undefined,
  "term-duplicate-tab": undefined,
  "term-tab-move-left": undefined,
  "term-tab-move-right": undefined,
  ...Object.fromEntries(
    [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [termTabCommandId(n), `mod+${n}`])
  ),
};

/** Raw-event matcher for xterm's `attachCustomKeyEventHandler`: returning false
 *  there makes xterm ignore the key (no bytes to the PTY) and lets it bubble to
 *  the app shortcut handler. Honours user remaps, but only ever swallows a
 *  chord that still holds a modifier — a bare-key remap must keep reaching the
 *  shell rather than silently break typing. */
export function isTerminalChord(ev: KeyboardEvent): boolean {
  if (ev.type !== "keydown") return false;
  if (!(ev.ctrlKey || ev.metaKey)) return false;
  // Shortcuts switched off: every key belongs to the shell.
  if (!useBindings.getState().enabled) return false;
  const combo = keyCombo(ev);
  const overrides = useBindings.getState().overrides;
  for (const [id, def] of Object.entries(CHORD_COMMAND_DEFAULTS)) {
    const eff = Object.prototype.hasOwnProperty.call(overrides, id)
      ? overrides[id] || undefined
      : def;
    if (eff && eff === combo) return true;
  }
  return false;
}
