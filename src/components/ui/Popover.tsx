import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";

export type PopoverPlacement = "bottom-start" | "bottom-end" | "top-start" | "top-end";
export type PopoverCloseReason = "escape" | "outside";

interface Props {
  open: boolean;
  /** The element the popover hangs off. */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: (reason: PopoverCloseReason) => void;
  children: ReactNode;
  placement?: PopoverPlacement;
  /** Same width as the trigger (select-like controls). */
  matchWidth?: boolean;
  /** Hide while the trigger is scrolled out of its scroll area. Default on. */
  hideOnClip?: boolean;
  offset?: number;
  /** Cap on height in px; it also shrinks to the room left on screen. */
  maxHeight?: number;
  /** Stacking layer: `dropdown` for status-bar panels, `palette` (default)
   *  so a select inside a dialog opens above it. */
  layer?: "dropdown" | "palette";
  className?: string;
  style?: CSSProperties;
  /** Forwarded to the panel, for callers that need to measure or test it. */
  popRef?: RefObject<HTMLDivElement>;
  onMouseLeave?: () => void;
  role?: string;
  "aria-label"?: string;
  id?: string;
}

const MARGIN = 8;

/** Every ancestor that clips its overflow: the popover is portaled out of
 *  them, so it has to check by hand whether the trigger is still visible. */
function clippingAncestors(el: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (/(auto|scroll|hidden|clip)/.test(s.overflow + s.overflowX + s.overflowY)) out.push(p);
  }
  return out;
}

/** True when no part of `r` is inside every clipping ancestor. */
export function isClipped(anchor: HTMLElement): boolean {
  const r = anchor.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return true;
  const boxes = clippingAncestors(anchor).map((a) => a.getBoundingClientRect());
  boxes.push(new DOMRect(0, 0, window.innerWidth, window.innerHeight));
  return boxes.some((b) => r.bottom <= b.top || r.top >= b.bottom || r.right <= b.left || r.left >= b.right);
}

// A floating panel tied to a trigger: portaled to <body> so scroll areas and
// the status bar can't clip it, placed against the trigger (flipping when
// there's no room), following it on scroll and resize. Esc closes only this
// popover: a dialog underneath stays open.
export function Popover({
  open,
  anchorRef,
  onClose,
  children,
  placement = "bottom-start",
  matchWidth = false,
  hideOnClip = true,
  offset = 6,
  maxHeight = Infinity,
  layer = "palette",
  className,
  style,
  popRef,
  onMouseLeave,
  role,
  id,
  ...aria
}: Props) {
  const innerRef = useRef<HTMLDivElement>(null);
  const panelRef = popRef ?? innerRef;
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const [clipped, setClipped] = useState(false);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    const panel = panelRef.current;
    const h = panel?.offsetHeight ?? 0;
    const w = matchWidth ? r.width : panel?.offsetWidth ?? 0;
    const wantTop = placement.startsWith("top");
    const below = window.innerHeight - r.bottom - offset - MARGIN;
    const above = r.top - offset - MARGIN;
    const top = wantTop ? above >= h || above > below : below < h && above > below;
    const end = placement.endsWith("end");
    let left = end ? r.right - w : r.left;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - w - MARGIN));
    const next: CSSProperties = { left };
    if (top) next.bottom = window.innerHeight - r.top + offset;
    else next.top = r.bottom + offset;
    next.maxHeight = Math.min(maxHeight, Math.max(120, top ? above : below));
    if (matchWidth) next.width = r.width;
    setPos(next);
    setClipped(hideOnClip && isClipped(anchor));
  }, [anchorRef, panelRef, placement, matchWidth, offset, hideOnClip, maxHeight]);

  // Measure twice: once to render, again with the panel's real size.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    place();
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t) || anchorRef.current?.contains(t)) return;
      onCloseRef.current("outside");
    };
    // Capture phase, so the innermost layer (this popover) takes Esc first.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onCloseRef.current("escape");
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, place, anchorRef, panelRef]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panelRef}
      id={id}
      role={role}
      aria-label={aria["aria-label"]}
      data-popover=""
      data-clipped={clipped ? "" : undefined}
      onMouseLeave={onMouseLeave}
      style={{
        ...(pos ?? { left: -9999, top: -9999 }),
        ...style,
        visibility: pos && !clipped ? undefined : "hidden",
      }}
      className={cn(
        "anim-modal fixed overflow-auto rounded-md border border-border bg-bg-panel shadow-elev-3",
        layer === "dropdown" ? "z-dropdown" : "z-palette",
        className
      )}
    >
      {children}
    </div>,
    document.body
  );
}
