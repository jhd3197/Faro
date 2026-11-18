import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";
import { comboFromEvent } from "../lib/keys";

export interface MenuItem {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  disabled?: boolean;
  destructive?: boolean;
  separatorAfter?: boolean;
  /** Its shortcut as a canonical combo ("f2", "mod+shift+n"). Pressing it
   *  while the menu is open runs the item and closes the menu. */
  combo?: string;
  /** The shortcut as shown, right-aligned (e.g. "F2"). */
  hint?: string;
  /**
   * Nested items. When present, this row is a submenu parent: clicking/hovering
   * it reveals `children` in a flyout and its own `onClick` is ignored.
   */
  children?: MenuItem[];
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const MENU_KEYS = new Set([
  "enter", "space", "escape", "tab", "shift+tab",
  "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end",
]);

const MODIFIER_ONLY = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph"]);

export function ContextMenu({ x, y, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [openSub, setOpenSub] = useState<number | null>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const focusSub = useRef(false);
  const [position, setPosition] = useState({ left: x, top: y });
  const [subPosition, setSubPosition] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (box) setPosition({ left: Math.max(8, Math.min(x, window.innerWidth - box.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - box.height - 8)) });
  }, [x, y, items]);

  useLayoutEffect(() => {
    if (openSub == null) return;
    const parent = ref.current?.querySelector<HTMLButtonElement>(`[data-menu-index="${openSub}"]`);
    const box = parent?.getBoundingClientRect();
    const sub = subRef.current?.getBoundingClientRect();
    if (box && sub) setSubPosition({
      left: Math.max(8, box.right + sub.width + 8 <= window.innerWidth ? box.right : box.left - sub.width),
      top: Math.max(8, Math.min(box.top, window.innerHeight - sub.height - 8)),
    });
    if (focusSub.current) {
      subRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
      focusSub.current = false;
    }
  }, [openSub, position]);

  useEffect(() => {
    const onAnyClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onAnyClick);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onClose);
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
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // A shortcut pressed while the menu is open runs that item and closes the
  // menu, the same as clicking it.
  const runByCombo = (e: React.KeyboardEvent): boolean => {
    const combo = comboFromEvent(e.nativeEvent);
    // Keys the menu itself uses (activate, move, close) keep their meaning.
    if (MENU_KEYS.has(combo)) return false;
    const all = items.flatMap((it) => (it.children?.length ? it.children : [it]));
    const hit = all.find((it) => it.combo === combo && !it.disabled);
    if (!hit) return false;
    e.preventDefault();
    hit.onClick();
    onClose();
    return true;
  };
  const hasHints = items.some((it) => it.hint);
  const subHasHints = (it: MenuItem) => !!it.children?.some((c) => c.hint);

  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (runByCombo(e)) {
      e.stopPropagation();
      return;
    }
    // Any other chord closes the menu and carries on to the app (a modifier
    // on its own is just the start of one).
    if (MODIFIER_ONLY.has(e.key)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || /^F\d+$/.test(e.key)) {
      onClose();
      return;
    }
    e.stopPropagation();
    const button = (e.target as HTMLElement).closest<HTMLButtonElement>("button");
    const currentMenu = button?.closest('[role="menu"]');
    if (e.key === "Tab") { onClose(); return; }
    if (e.key === "Escape" || e.key === "ArrowLeft") {
      e.preventDefault();
      if (openSub != null) {
        ref.current?.querySelector<HTMLButtonElement>(`[data-menu-index="${openSub}"]`)?.focus();
        setOpenSub(null);
      } else if (e.key === "Escape") onClose();
      return;
    }
    if (e.key === "ArrowRight" && button?.dataset.menuIndex != null) {
      const index = Number(button.dataset.menuIndex);
      if (items[index]?.children?.length && !items[index].disabled) {
        e.preventDefault();
        if (openSub === index) subRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
        else { focusSub.current = true; setOpenSub(index); }
      }
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const btns = Array.from(
      currentMenu?.querySelectorAll<HTMLButtonElement>(
        "button:not([disabled])"
      ) ?? []
    ).filter((el) => el.closest('[role="menu"]') === currentMenu);
    if (btns.length === 0) return;
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
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
      ref={ref}
      role="menu"
      aria-label="Context menu"
      onKeyDown={onMenuKeyDown}
      style={{ ...position, maxHeight: "calc(100vh - 16px)", maxWidth: "calc(100vw - 16px)" }}
      onScroll={() => setOpenSub(null)}
      className="fixed z-menu min-w-[220px] overflow-y-auto rounded-lg border border-border bg-bg-panel py-1 shadow-elev-3"
    >
      {items.map((item, i) => {
        const hasChildren = !!item.children?.length;
        return (
          <div
            key={i}
            className="relative"
            onMouseEnter={() => setOpenSub(hasChildren && !item.disabled ? i : null)}
          >
            <button
              role="menuitem"
              data-menu-index={i}
              aria-haspopup={hasChildren || undefined}
              aria-expanded={hasChildren ? openSub === i : undefined}
              disabled={item.disabled}
              onClick={() => {
                if (hasChildren) {
                  if (openSub === i) subRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
                  else { focusSub.current = true; setOpenSub(i); }
                  return;
                }
                item.onClick();
                onClose();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-hover disabled:opacity-40 disabled:hover:bg-transparent",
                item.destructive && "text-danger hover:bg-danger-soft"
              )}
            >
                <span className="flex h-3.5 w-3.5 items-center justify-center text-text-muted">
                  {item.icon}
                </span>
              <span className="flex-1">{item.label}</span>
              {hasHints && (
                <span className="min-w-[3.5rem] pl-4 text-right text-[11px] text-text-dim">
                  {item.hint}
                </span>
              )}
              {hasChildren && (
                <ChevronRight size={12} className="text-text-dim" />
              )}
            </button>
            {hasChildren && openSub === i && (
              <div
                role="menu"
                ref={subRef}
                aria-label={item.label}
                style={{ ...subPosition, maxHeight: "calc(100vh - 16px)", maxWidth: "calc(100vw - 16px)" }}
                onScroll={(e) => e.stopPropagation()}
                className="fixed z-menu min-w-[180px] overflow-y-auto rounded-lg border border-border bg-bg-panel py-1 shadow-elev-3"
              >
                {item.children!.map((child, j) => (
                  <button
                    key={j}
                    role="menuitem"
                    disabled={child.disabled}
                    onClick={() => {
                      child.onClick();
                      onClose();
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-hover disabled:opacity-40 disabled:hover:bg-transparent",
                      child.destructive && "text-danger hover:bg-danger-soft"
                    )}
                  >
                      <span aria-hidden="true" className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-text-muted">
                        {child.icon}
                      </span>
                    <span className="flex-1">{child.label}</span>
                    {subHasHints(item) && (
                      <span className="min-w-[3.5rem] pl-4 text-right text-[11px] text-text-dim">
                        {child.hint}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
            {item.separatorAfter && (
              <div className="my-1 border-t border-border" />
            )}
          </div>
        );
      })}
    </div>
  );
}
