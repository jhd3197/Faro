import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Check, Search } from "lucide-react";
import { cn } from "@/lib/cn";
import { isComposing } from "@faro/file-ui";

export interface MenuOption<T = string> {
  value: T;
  label: string;
  icon?: ReactNode;
  /** Small text on the right (a shortcut, a size, a count). */
  hint?: string;
  /** Extra words the search matches but the row doesn't show. */
  keywords?: string;
  disabled?: boolean;
  /** Options sharing a group are listed under its label, in order. */
  group?: string;
}

interface Props<T> {
  options: MenuOption<T>[];
  /** The current choice: ticked, and focused when the menu opens. */
  value?: T;
  onSelect: (value: T) => void;
  onClose?: () => void;
  /** Show a search box; typing anywhere in the menu goes into it. */
  searchable?: boolean;
  searchPlaceholder?: string;
  emptyText?: string;
  "aria-label"?: string;
  className?: string;
  /** Focus the menu when it mounts. Default on. */
  autoFocus?: boolean;
}

const TYPEAHEAD_MS = 600;

/** Case-insensitive; every space-separated term must match label or keywords. */
export function matchesQuery(o: { label: string; keywords?: string }, query: string): boolean {
  const hay = `${o.label} ${o.keywords ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((t) => hay.includes(t));
}

/** Next enabled index from `from` in direction `dir`, wrapping; -1 if none. */
export function nextEnabled(
  items: { disabled?: boolean }[],
  from: number,
  dir: 1 | -1
): number {
  const n = items.length;
  for (let step = 1; step <= n; step++) {
    const i = (((from + dir * step) % n) + n) % n;
    if (!items[i].disabled) return i;
  }
  return -1;
}

// A keyboard-first list of choices, for selects and pickers: ↑/↓ wrap and skip
// disabled rows, Home/End jump, Enter or Space picks, Esc closes. It opens on
// the current choice (ticked). With `searchable`, typing filters; without it,
// typing jumps to the first row starting with what was typed.
export function Menu<T>({
  options,
  value,
  onSelect,
  onClose,
  searchable = false,
  searchPlaceholder = "Search",
  emptyText = "No matches",
  className,
  autoFocus = true,
  ...aria
}: Props<T>) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const baseId = useId();

  const visible = useMemo(
    () => (searchable && query ? options.filter((o) => matchesQuery(o, query)) : options),
    [options, query, searchable]
  );
  const selectedIndex = visible.findIndex((o) => Object.is(o.value, value) && !o.disabled);
  const initial = () => (selectedIndex >= 0 ? selectedIndex : nextEnabled(visible, -1, 1));
  const [active, setActive] = useState(initial);

  // A new filter result starts on the current choice if it survived, else the top.
  useEffect(() => {
    setActive(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!autoFocus) return;
    const raf = requestAnimationFrame(() => (searchable ? inputRef.current : listRef.current)?.focus());
    return () => cancelAnimationFrame(raf);
  }, [autoFocus, searchable]);

  useEffect(() => {
    if (active < 0) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (i: number) => {
    const o = visible[i];
    if (!o || o.disabled) return;
    onSelect(o.value);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isComposing(e)) return;
    const inSearch = e.target === inputRef.current;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const i = nextEnabled(visible, active < 0 ? (e.key === "ArrowDown" ? -1 : 0) : active, e.key === "ArrowDown" ? 1 : -1);
        if (i >= 0) setActive(i);
        return;
      }
      case "Home":
      case "End": {
        if (e.shiftKey) return;
        e.preventDefault();
        const i =
          e.key === "Home" ? nextEnabled(visible, -1, 1) : nextEnabled(visible, visible.length, -1);
        if (i >= 0) setActive(i);
        return;
      }
      case "Enter":
        e.preventDefault();
        e.stopPropagation();
        pick(active);
        return;
      case " ":
        if (inSearch) return;
        e.preventDefault();
        pick(active);
        return;
      case "Escape":
        if (!onClose) return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
    }
    // Printable keys from the list.
    if (inSearch || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
    if (searchable) {
      // Type-to-search: the keystroke lands in the search box.
      e.preventDefault();
      setQuery((q) => q + e.key);
      inputRef.current?.focus();
      return;
    }
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at > TYPEAHEAD_MS ? e.key.toLowerCase() : t.text + e.key.toLowerCase();
    t.at = now;
    const start = t.text.length === 1 ? active : active - 1;
    for (let step = 1; step <= visible.length; step++) {
      const i = (start + step + visible.length) % visible.length;
      if (!visible[i].disabled && visible[i].label.toLowerCase().startsWith(t.text)) {
        setActive(i);
        break;
      }
    }
  };

  const optionId = (i: number) => `${baseId}-o${i}`;
  let lastGroup: string | undefined;

  return (
    <div className={cn("flex min-w-[10rem] flex-col", className)} onKeyDown={onKeyDown} data-menu="">
      {searchable && (
        <div className="flex items-center gap-1.5 border-b border-border px-2.5 py-1.5">
          <Search size={12} className="shrink-0 text-text-dim" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${baseId}-list`}
            aria-activedescendant={active >= 0 ? optionId(active) : undefined}
            aria-autocomplete="list"
            className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-text-dim focus-visible:!outline-none"
          />
        </div>
      )}
      <div
        ref={listRef}
        id={`${baseId}-list`}
        role="listbox"
        tabIndex={searchable ? -1 : 0}
        aria-label={aria["aria-label"]}
        aria-activedescendant={!searchable && active >= 0 ? optionId(active) : undefined}
        className="min-h-0 flex-1 overflow-y-auto py-1 outline-none focus-visible:!outline-none"
      >
        {visible.length === 0 && (
          <div className="px-3 py-3 text-center text-[11.5px] text-text-dim">{emptyText}</div>
        )}
        {visible.map((o, i) => {
          const header = o.group && o.group !== lastGroup ? o.group : null;
          lastGroup = o.group;
          const selected = Object.is(o.value, value);
          return (
            <div key={`${String(o.value)}-${i}`}>
              {header && (
                <div role="presentation" className="px-3 pb-0.5 pt-2 text-[10px] uppercase tracking-wider text-text-dim">
                  {header}
                </div>
              )}
              <div
                id={optionId(i)}
                role="option"
                data-index={i}
                aria-selected={selected}
                aria-disabled={o.disabled || undefined}
                data-active={i === active ? "" : undefined}
                onMouseMove={() => !o.disabled && i !== active && setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(i)}
                className={cn(
                  "flex cursor-default select-none items-center gap-2 px-2 py-1.5 text-[12.5px]",
                  i === active && "bg-bg-hover",
                  o.disabled && "opacity-40"
                )}
              >
                <span className="flex w-3.5 shrink-0 justify-center text-accent">
                  {selected && <Check size={12} aria-hidden />}
                </span>
                {o.icon && <span className="flex shrink-0 text-text-muted">{o.icon}</span>}
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="shrink-0 pl-3 text-[11px] text-text-dim">{o.hint}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
