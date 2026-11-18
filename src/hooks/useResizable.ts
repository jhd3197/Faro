import { useCallback, useEffect, useState, type RefObject } from "react";
import { usePanelSizes } from "@/stores/panelSizesStore";

/** Moves shorter than this don't count as a drag (a click stays a click). */
export const DRAG_DEAD_ZONE = 3;
/** Dragging a pane to within this many px of its edge collapses it… */
export const COLLAPSE_AT = 80;
/** …and it takes this much to pull it back open (hysteresis). */
export const EXPAND_AT = 100;
/** Thickness of a collapsed pane's labelled strip. */
export const STRIP_SIZE = 24;
/** Collapse/expand animation; off while dragging so the pane tracks the pointer. */
export const PANEL_TRANSITION_MS = 160;

export type Axis = "x" | "y";

interface DragHandlers {
  axis: Axis;
  /** Called once the pointer has moved past the dead zone. */
  onStart?: () => void;
  /** Pointer delta from the press point along the axis, plus the raw event. */
  onMove: (delta: number, e: PointerEvent) => void;
  /** `moved` is false when the press never left the dead zone (a click). */
  onEnd?: (moved: boolean) => void;
}

/**
 * Start a resize drag from a pointerdown. Listens on the document so the drag
 * survives the pointer leaving the handle (or the window edge), ignores moves
 * inside a 3px dead zone, and pins the resize cursor + no text selection while
 * it runs.
 */
export function startResizeDrag(e: React.PointerEvent, h: DragHandlers): void {
  if (e.button !== 0 || !e.isPrimary) return;
  e.preventDefault();
  const start = h.axis === "x" ? e.clientX : e.clientY;
  let moved = false;
  const body = document.body.style;
  const prevCursor = body.cursor;
  const prevSelect = body.userSelect;

  const move = (ev: PointerEvent) => {
    const delta = (h.axis === "x" ? ev.clientX : ev.clientY) - start;
    if (!moved) {
      if (Math.abs(delta) < DRAG_DEAD_ZONE) return;
      moved = true;
      body.cursor = h.axis === "x" ? "col-resize" : "row-resize";
      body.userSelect = "none";
      h.onStart?.();
    }
    h.onMove(delta, ev);
  };
  const end = () => {
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", end);
    document.removeEventListener("pointercancel", end);
    window.removeEventListener("blur", end);
    body.cursor = prevCursor;
    body.userSelect = prevSelect;
    h.onEnd?.(moved);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
  window.addEventListener("blur", end);
}

/**
 * Size of an element along an axis, tracked with a ResizeObserver. The first
 * zero measurement (layout not done yet, or a hidden parent) is ignored so a
 * stored size is never clamped down to nothing.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>, axis: Axis): number | null {
  const [size, setSize] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const v = axis === "x" ? entry.contentRect.width : entry.contentRect.height;
      if (v > 0) setSize(Math.round(v));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, axis]);
  return size;
}

export interface ResizableOptions {
  /** Persistence key in the panel-sizes store. */
  id: string;
  axis: Axis;
  defaultSize: number;
  min: number;
  max?: number;
  /** Cap as a share of the container, re-applied when the container shrinks. */
  maxFraction?: number;
  collapsible?: boolean;
  /** The element the panel shares space with (for the fraction cap). */
  containerRef: RefObject<HTMLElement | null>;
  /** The panel element; its rendered size is the drag's starting point. */
  panelRef?: RefObject<HTMLElement | null>;
}

/**
 * State for a panel docked on the right (axis x) or bottom (axis y) of its
 * container, with the handle on its leading edge: dragging toward the
 * container grows it. Sizes persist; the visible size is clamped to the
 * container without overwriting what's stored, so a window that shrinks and
 * grows back gets the old size again.
 */
export function useResizable(o: ResizableOptions) {
  const stored = usePanelSizes((s) => s.panels[o.id]);
  const ready = usePanelSizes((s) => s.ready);
  const containerSize = useElementSize(o.containerRef, o.axis);
  const [live, setLive] = useState<{ size: number; collapsed: boolean } | null>(null);

  const max = Math.max(
    o.min,
    Math.min(
      o.max ?? Infinity,
      containerSize != null && o.maxFraction ? containerSize * o.maxFraction : Infinity
    )
  );
  const clamp = useCallback((v: number) => Math.round(Math.min(max, Math.max(o.min, v))), [max, o.min]);
  const remembered = clamp(stored?.size ?? o.defaultSize);
  const size = live ? live.size : remembered;
  const collapsed = !!o.collapsible && (live ? live.collapsed : !!stored?.collapsed);

  const commit = (next: { size: number; collapsed: boolean }) =>
    usePanelSizes.getState().setPanel(o.id, { size: next.size, collapsed: next.collapsed });

  const beginDrag = (e: React.PointerEvent, onClick?: () => void) => {
    const startCollapsed = collapsed;
    // Start from what's on screen: a dock squeezed by its neighbours (or one
    // capped by its content) is smaller than its stored size.
    const el = o.panelRef?.current;
    const rendered = el ? (o.axis === "x" ? el.offsetWidth : el.offsetHeight) : size;
    const base = startCollapsed ? STRIP_SIZE : rendered;
    let isCollapsed = startCollapsed;
    // The latest drag state, read on release (state may not have rendered yet).
    let last: { size: number; collapsed: boolean } | null = null;
    startResizeDrag(e, {
      axis: o.axis,
      onStart: () => setLive({ size: remembered, collapsed: startCollapsed }),
      onMove: (delta) => {
        const raw = base - delta;
        if (o.collapsible) {
          if (!isCollapsed && raw < COLLAPSE_AT) isCollapsed = true;
          else if (isCollapsed && raw >= EXPAND_AT) isCollapsed = false;
        }
        last = { size: isCollapsed ? remembered : clamp(raw), collapsed: isCollapsed };
        setLive(last);
      },
      onEnd: (moved) => {
        setLive(null);
        if (moved && last) commit(last);
        else if (!moved) onClick?.();
      },
    });
  };

  const expand = () => commit({ size: remembered, collapsed: false });
  const collapse = () => commit({ size: remembered, collapsed: true });
  const reset = () => usePanelSizes.getState().resetPanel(o.id);
  const step = 16;
  const grow = o.axis === "x" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];

  const handleProps = {
    role: "separator" as const,
    "aria-orientation": (o.axis === "x" ? "vertical" : "horizontal") as "vertical" | "horizontal",
    "aria-valuemin": o.min,
    "aria-valuemax": Math.round(max),
    "aria-valuenow": collapsed ? 0 : size,
    tabIndex: 0,
    onPointerDown: (e: React.PointerEvent) => beginDrag(e),
    onDoubleClick: reset,
    onKeyDown: (e: React.KeyboardEvent) => {
      let next: number | null = null;
      if (e.key === grow[0]) next = size + step;
      else if (e.key === grow[1]) next = size - step;
      else if (e.key === "Home") next = o.min;
      else if (e.key === "End") next = max;
      else if (e.key === "Enter") { e.preventDefault(); reset(); return; }
      if (next === null) return;
      e.preventDefault();
      commit({ size: clamp(next), collapsed: false });
    },
  };

  return {
    ready,
    size,
    max,
    collapsed,
    dragging: !!live,
    handleProps,
    /** Pointer handler for the collapsed strip: drag resizes, click expands. */
    stripPointerDown: (e: React.PointerEvent) => beginDrag(e, expand),
    expand,
    collapse,
    reset,
  };
}
