import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { formatCombo, keyCombo } from "@/lib/shortcuts";
import { useBindings } from "@/stores/bindingsStore";

export interface MenuItem {
  label: string;
  /** Not needed for an item that only opens `submenu`. */
  onClick?: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  separatorAfter?: boolean;
  /** Opens to the side on hover, click or →. */
  submenu?: MenuItem[];
  /** Its keyboard shortcut as a canonical combo ("f2", "mod+d"), live from the
   *  user's bindings. Shown on the right, and pressing it while the menu is
   *  open runs this item and closes the menu. */
  combo?: string;
  /** A display-only hint, for a key the menu shouldn't run itself. */
  hint?: string;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const WIDTH = 220;

// Keys the menu itself uses (activate, move, close) keep their meaning.
const MENU_KEYS = new Set([
  "enter", "space", "escape", "tab", "shift+tab",
  "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end",
]);

const MODIFIER_ONLY = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph"]);

function flatItems(items: MenuItem[]): MenuItem[] {
  return items.flatMap((it) => (it.submenu ? flatItems(it.submenu) : [it]));
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onAnyClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    // Esc closes only the menu, the innermost layer, never a dialog or a
    // search box underneath it. Capture phase so it gets there first.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("mousedown", onAnyClick);
    window.addEventListener("keydown", onKey, true);
    // Move focus into the menu so it's keyboard-operable straight away.
    const raf = requestAnimationFrame(() =>
      ref.current
        ?.querySelector<HTMLButtonElement>("button:not([disabled])")
        ?.focus()
    );
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousedown", onAnyClick);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  // A shortcut pressed while the menu is open does what it says and closes the
  // menu. One the menu doesn't hold (a global command) closes the menu and
  // carries on to the app.
  const shortcutsOn = useBindings((s) => s.enabled);
  const onRootKeyDown = (e: React.KeyboardEvent) => {
    if (!shortcutsOn || MODIFIER_ONLY.has(e.key)) return;
    const combo = keyCombo(e.nativeEvent);
    if (MENU_KEYS.has(combo)) return;
    const hit = flatItems(items).find((it) => it.combo === combo && !it.disabled && it.onClick);
    if (hit) {
      e.preventDefault();
      e.stopPropagation();
      hit.onClick!();
      onClose();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) onClose();
  };

  // Clamp to viewport.
  const rows = items.length;
  const maxX = window.innerWidth - WIDTH;
  const maxY = window.innerHeight - rows * 30 - 16;
  const left = Math.min(x, maxX);
  const top = Math.max(8, Math.min(y, maxY));
  const flip = left + WIDTH * 2 > window.innerWidth;

  return (
    <div ref={ref} style={{ left, top }} className="fixed z-menu" onKeyDownCapture={onRootKeyDown}>
      <MenuList items={items} onClose={onClose} flip={flip} />
    </div>
  );
}

function MenuList({
  items,
  onClose,
  flip,
  sub,
}: {
  items: MenuItem[];
  onClose: () => void;
  flip: boolean;
  sub?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const shortcutsOn = useBindings((s) => s.enabled);
  const hintOf = (item: MenuItem) =>
    shortcutsOn ? (item.combo ? formatCombo(item.combo) : item.hint) : undefined;
  // The shortcut column exists only when some item in this list has one.
  const hasHints = items.some((it) => hintOf(it));
  const own = () =>
    Array.from(
      listRef.current?.querySelectorAll<HTMLButtonElement>(":scope > div > button:not([disabled])") ?? []
    );

  const focusChild = (i: number) =>
    requestAnimationFrame(() =>
      listRef.current
        ?.querySelector<HTMLButtonElement>(`[data-sub="${i}"] button:not([disabled])`)
        ?.focus()
    );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const btns = own();
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (idx < 0) return; // a key inside a submenu; it handles its own
    if (e.key === "ArrowLeft" && sub) return; // the parent closes us
    // Shortcut chords travel on to the app (the menu has already closed).
    if (MODIFIER_ONLY.has(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) return;
    e.stopPropagation();
    if (e.key === "ArrowRight") {
      const i = Number(btns[idx].dataset.index);
      if (items[i]?.submenu) {
        e.preventDefault();
        setOpen(i);
        focusChild(i);
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    if (btns.length === 0) return;
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? btns.length - 1
          : e.key === "ArrowDown"
            ? (idx + 1) % btns.length
            : (idx - 1 + btns.length) % btns.length;
    btns[next]?.focus();
  };

  return (
    <div
      ref={listRef}
      role="menu"
      aria-label={sub ? undefined : "Context menu"}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" && open !== null) {
          e.preventDefault();
          e.stopPropagation();
          const i = open;
          setOpen(null);
          own().find((b) => b.dataset.index === String(i))?.focus();
          return;
        }
        onKeyDown(e);
      }}
      className="anim-modal min-w-[220px] rounded-lg border border-border bg-bg-panel py-1 shadow-elev-3"
    >
      {items.map((item, i) => (
        <div
          key={i}
          className="relative"
          data-sub={item.submenu ? i : undefined}
          onMouseEnter={() => setOpen(item.submenu ? i : null)}
          onMouseLeave={() => item.submenu && setOpen((cur) => (cur === i ? null : cur))}
        >
          <button
            role="menuitem"
            aria-haspopup={item.submenu ? "menu" : undefined}
            aria-expanded={item.submenu ? open === i : undefined}
            aria-keyshortcuts={item.combo && shortcutsOn ? item.combo : undefined}
            data-index={i}
            disabled={item.disabled}
            onClick={() => {
              if (item.submenu) {
                setOpen(open === i ? null : i);
                return;
              }
              item.onClick?.();
              onClose();
            }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-hover disabled:opacity-40 disabled:hover:bg-transparent",
              item.submenu && open === i && "bg-bg-hover",
              item.destructive && "text-danger hover:bg-danger-soft"
            )}
          >
            {item.icon && (
              <span className="flex h-3.5 w-3.5 items-center justify-center text-text-muted">
                {item.icon}
              </span>
            )}
            <span className="flex-1">{item.label}</span>
            {hasHints && (
              <span data-menu-hint className="min-w-[3.5rem] pl-4 text-right text-[11px] text-text-dim">
                {hintOf(item)}
              </span>
            )}
            {item.submenu && <ChevronRight size={13} className="text-text-dim" />}
          </button>
          {item.submenu && open === i && (
            <div className={cn("absolute -top-1 z-menu", flip ? "right-full pr-1" : "left-full pl-1")}>
              <MenuList items={item.submenu} onClose={onClose} flip={flip} sub />
            </div>
          )}
          {item.separatorAfter && <div className="my-1 border-t border-border" />}
        </div>
      ))}
    </div>
  );
}
