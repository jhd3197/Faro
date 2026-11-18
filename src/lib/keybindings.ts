import { useCallback, useEffect, useMemo, useRef } from "react";
import { useCommands, type Command } from "./commands";
import { useBindings } from "@/stores/bindingsStore";
import { defaultComboFor } from "./bindingCatalog";
import { formatCombo, keyCombo } from "./shortcuts";

// The one resolver every surface reads (Plan 15 Phase 1). Default combos live in
// the command registry; the bindings store holds user overrides. Effective combo
// = override ?? default. Keeping this in a single place is what stops the
// palette, the title-bar menus, the cheat-sheet and the dispatcher from drifting
// apart onto their own private copies of a combo.

/** Resolve one id's effective combo. `""` in the overrides map means the command
 *  is explicitly unbound (no shortcut); an absent id falls back to `def`. */
export function effectiveCombo(
  id: string,
  def: string | undefined,
  overrides: Record<string, string>
): string | undefined {
  if (Object.prototype.hasOwnProperty.call(overrides, id)) {
    return overrides[id] || undefined;
  }
  return def;
}

/** The command registry with each command's `combo` swapped for its effective
 *  binding. Consumers just read `c.combo` and get the resolved value. With
 *  shortcuts switched off every combo is cleared, so hints vanish too. */
export function useResolvedCommands(): Command[] {
  const commands = useCommands();
  const overrides = useBindings((s) => s.overrides);
  const enabled = useBindings((s) => s.enabled);
  return useMemo(
    () =>
      commands.map((c) => {
        const eff = enabled ? effectiveCombo(c.id, c.combo, overrides) : undefined;
        return eff === c.combo ? c : { ...c, combo: eff };
      }),
    [commands, overrides, enabled]
  );
}

/** A function resolving any id (command, rail or focus key) to its live combo
 *  and display hint. `def` overrides the catalogue default. Returns an empty
 *  object when the key is unbound or shortcuts are off, so it spreads straight
 *  into a menu item: `{ label, ...keyOf("focus.rename") }`. */
export function useKeyOf(): (id: string, def?: string) => { combo?: string; hint?: string } {
  const overrides = useBindings((s) => s.overrides);
  const enabled = useBindings((s) => s.enabled);
  return useCallback(
    (id: string, def?: string) => {
      if (!enabled) return {};
      const combo = effectiveCombo(id, def ?? defaultComboFor(id), overrides);
      return combo ? { combo, hint: formatCombo(combo) } : {};
    },
    [overrides, enabled]
  );
}

/** True when the keystroke is being typed into an editable surface. */
export function isEditableTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  if (typeof t.closest === "function" && t.closest(".xterm")) return true;
  return false;
}

/**
 * Bind one remappable key by id. The listener follows the user's override and
 * the master switch, never fires on a key something else already handled
 * (`defaultPrevented`), and never fires a bare key while the user is typing.
 *
 * `scope`: only while focus is inside this element (row-level shortcuts).
 * `enabled`: turn the binding off without unmounting.
 */
export function useKeybinding(
  id: string,
  handler: (e: KeyboardEvent) => void,
  opts: { enabled?: boolean; scope?: React.RefObject<HTMLElement>; def?: string } = {}
) {
  const keyOf = useKeyOf();
  const combo = keyOf(id, opts.def).combo;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const active = opts.enabled !== false && !!combo;
  const scope = opts.scope;

  useEffect(() => {
    if (!active || !combo) return;
    const bare = !/^(mod|alt)\+/.test(combo) && !/^f\d+$/.test(combo);
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || (e.repeat && bare)) return;
      if (keyCombo(e) !== combo) return;
      if (bare && isEditableTarget(e.target)) return;
      if (scope && !scope.current?.contains(document.activeElement)) return;
      e.preventDefault();
      handlerRef.current(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, combo, scope]);
}
