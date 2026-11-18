import { useEffect, useRef } from "react";
import { useResolvedCommands, isEditableTarget } from "@/lib/keybindings";
import { useLayout } from "@/stores/layoutStore";
import { useBindings } from "@/stores/bindingsStore";
import { keyCombo } from "@/lib/shortcuts";

// One global keydown listener dispatching the (override-resolved) command
// registry. It fires modifier combos everywhere and bare-key combos only when
// focus isn't in an editable surface (Plan 15 Phase 3). File-browser keys are
// deliberately absent here — <FilePane> owns those locally so they can't collide
// with anything global.
//
// A key that a focused editor, field or list already handled (it called
// preventDefault) is left alone, so one keystroke never does two things. The
// terminal is the exception: xterm marks every key it sends to the shell as
// handled, and app chords it lets through must still reach the registry.
export function useShortcuts() {
  const commands = useResolvedCommands();
  const togglePalette = useLayout((s) => s.togglePalette);
  const enabled = useBindings((s) => s.enabled);

  // Keep the latest commands without re-binding the listener every render.
  const ref = useRef(commands);
  ref.current = commands;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const inTerminal = !!t?.closest?.(".xterm");
      if (e.defaultPrevented && !inTerminal) return;
      let combo = keyCombo(e);
      // Zoom In is bound to "mod+=", but the same physical key reports "+"
      // when shifted (and the numpad's plus always does) — treat them alike,
      // as browsers do.
      if (combo === "mod++" || combo === "mod+shift++") combo = "mod+=";
      const hasMod = e.ctrlKey || e.metaKey;
      // The palette toggle is a fixed binding (not a registry command).
      if (combo === "mod+k") {
        e.preventDefault();
        togglePalette();
        return;
      }
      // Guard the user's typing: bare-key combos don't fire from an input/
      // textarea/terminal. Modifier combos stay global.
      if (!hasMod && isEditableTarget(e.target)) return;
      const cmd = ref.current.find(
        (c) => c.combo === combo && c.enabled !== false
      );
      if (cmd) {
        e.preventDefault();
        cmd.run();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePalette, enabled]);
}
