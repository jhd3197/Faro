import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";

interface Gesture {
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  /** Strip position when the drag began, for Esc. */
  from: number;
  started: boolean;
  userSelect: string;
}

const CHIP = "[data-term-tab-id]";

/** Live drag-reorder for a horizontal tab strip. Tabs move as the pointer
 *  crosses a neighbour's midpoint (so swapping a wide and a narrow tab can't
 *  flip back and forth), the strip scrolls near its edges, and Esc puts the
 *  tab back. Pointer events rather than HTML5 drag and drop, which the native
 *  Windows file-drop handler intercepts. */
export function useTabDrag(onMove: (id: string, index: number) => void, disabled = false) {
  const stripRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const move = useRef(onMove);
  move.current = onMove;
  const suppressClick = useRef(false);
  const [dragId, setDragId] = useState<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const chips = () =>
      [...(stripRef.current?.querySelectorAll<HTMLElement>(CHIP) ?? [])];
    const reorder = (g: Gesture) => {
      const list = chips();
      const from = list.findIndex((c) => c.dataset.termTabId === g.id);
      if (from < 0) return;
      let to = from;
      list.forEach((c, i) => {
        const r = c.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        if (i > from && g.x > mid) to = Math.max(to, i);
        if (i < from && g.x < mid) to = Math.min(to, i);
      });
      if (to !== from) move.current(g.id, to);
    };
    const tick = () => {
      const g = gesture.current;
      const strip = stripRef.current;
      if (!g?.started || !strip) return;
      const r = strip.getBoundingClientRect();
      const edge = 28;
      const speed =
        g.x < r.left + edge ? -Math.ceil((r.left + edge - g.x) / 3)
        : g.x > r.right - edge ? Math.ceil((g.x - r.right + edge) / 3) : 0;
      if (speed) strip.scrollLeft += speed;
      reorder(g);
      frame = requestAnimationFrame(tick);
    };
    const finish = (commit: boolean) => {
      const g = gesture.current;
      if (!g) return;
      gesture.current = null;
      cancelAnimationFrame(frame);
      if (g.started) {
        document.body.style.userSelect = g.userSelect;
        suppressClick.current = true;
        if (!commit) move.current(g.id, g.from);
      }
      setDragId(null);
    };
    const onPointerMove = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      g.x = e.clientX;
      if (!g.started && Math.hypot(e.clientX - g.startX, e.clientY - g.startY) >= 6) {
        g.started = true;
        document.body.style.userSelect = "none";
        setDragId(g.id);
        frame = requestAnimationFrame(tick);
      }
      if (g.started) e.preventDefault();
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === gesture.current?.pointerId) finish(true);
    };
    const cancel = () => finish(false);
    const pointerCancel = (e: PointerEvent) => {
      if (e.pointerId === gesture.current?.pointerId) cancel();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && gesture.current?.started) {
        e.preventDefault();
        e.stopPropagation();
        cancel();
      }
    };
    const down = () => {
      suppressClick.current = false;
    };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", onPointerMove, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    return () => {
      cancel();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (disabled || e.button !== 0 || !e.isPrimary || gesture.current) return;
    const list = [...(stripRef.current?.querySelectorAll<HTMLElement>(CHIP) ?? [])];
    gesture.current = {
      id,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      x: e.clientX,
      from: Math.max(0, list.findIndex((c) => c.dataset.termTabId === id)),
      started: false,
      userSelect: document.body.style.userSelect,
    };
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    }
  };
  return { stripRef, dragId, onPointerDown, onClickCapture };
}
