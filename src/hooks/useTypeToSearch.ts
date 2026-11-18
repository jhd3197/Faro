import { useEffect, useRef, type RefObject } from "react";
import { isEditableTarget } from "@/lib/keybindings";

/**
 * Type-to-search for a list or menu that has a search box: while `enabled`, a
 * printable key pressed anywhere outside a text field focuses `input` and
 * types that character into it (via `onType`), so you can start filtering
 * without clicking the box first. Modified keys and IME composition are left
 * alone, as are keys something else already handled.
 */
export function useTypeToSearch(
  input: RefObject<HTMLInputElement | null>,
  onType: (char: string) => void,
  enabled = true
) {
  const onTypeRef = useRef(onType);
  onTypeRef.current = onType;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key.length !== 1 || e.key === " ") return;
      const el = input.current;
      if (!el || isEditableTarget(e.target)) return;
      e.preventDefault();
      el.focus();
      onTypeRef.current(e.key);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, input]);
}
