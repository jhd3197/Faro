import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

export type SelectAllState = "none" | "some" | "all";

/** How many of the rows on screen are ticked. */
export function selectAllState<K>(visible: readonly K[], selected: ReadonlySet<K>): SelectAllState {
  const n = visible.filter((k) => selected.has(k)).length;
  return n === 0 ? "none" : n === visible.length ? "all" : "some";
}

/** Tick every row on screen, or untick them all if they already are. Rows
 *  hidden by a filter keep whatever state they had. */
export function toggleVisible<K>(visible: readonly K[], selected: ReadonlySet<K>): Set<K> {
  const next = new Set(selected);
  if (selectAllState(visible, selected) === "all") visible.forEach((k) => next.delete(k));
  else visible.forEach((k) => next.add(k));
  return next;
}

// The header checkbox for a checkbox list. It acts on `visible` (the rows the
// filter shows), and reads as mixed when only some of them are ticked.
export function SelectAll<K>({
  visible,
  selected,
  onChange,
  label = "Select all",
  disabled,
  className,
}: {
  visible: readonly K[];
  selected: ReadonlySet<K>;
  onChange: (next: Set<K>) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const state = selectAllState(visible, selected);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "some";
  }, [state]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      aria-checked={state === "some" ? "mixed" : state === "all"}
      data-select-all={state}
      checked={state === "all" && visible.length > 0}
      disabled={disabled || visible.length === 0}
      onChange={() => onChange(toggleVisible(visible, selected))}
      className={cn("accent-accent", className)}
    />
  );
}
