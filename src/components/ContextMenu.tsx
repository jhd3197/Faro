import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";

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
  /** Its keyboard shortcut, shown dim on the right (e.g. "F2"). */
  hint?: string;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const WIDTH = 220;

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onAnyClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onAnyClick);
    window.addEventListener("keydown", onKey);
    // Move focus into the menu so it's keyboard-operable straight away.
    const raf = requestAnimationFrame(() =>
      ref.current
        ?.querySelector<HTMLButtonElement>("button:not([disabled])")
        ?.focus()
    );
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousedown", onAnyClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp to viewport.
  const rows = items.length;
  const maxX = window.innerWidth - WIDTH;
  const maxY = window.innerHeight - rows * 30 - 16;
  const left = Math.min(x, maxX);
  const top = Math.max(8, Math.min(y, maxY));
  const flip = left + WIDTH * 2 > window.innerWidth;

  return (
    <div ref={ref} style={{ left, top }} className="fixed z-menu">
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
            {item.hint && <span className="pl-4 text-[11px] text-text-dim">{item.hint}</span>}
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
