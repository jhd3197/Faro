import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";

export type RailDropTarget =
  | { kind: "row"; id: string; after: boolean }
  | { kind: "group"; name: string }
  | { kind: "sectionEnd"; group: string | undefined }
  | { kind: "top" };

interface Gesture {
  id: string;
  pointerId: number;
  element: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  started: boolean;
  userSelect: string;
}

/** Internal sorting must not depend on HTML5 DnD: Tauri's native Windows
 * file-drop handler intercepts those events. Keep native OS file drops enabled. */
export function useRailDrag(onDrop: (id: string, target: RailDropTarget) => void, disabled: boolean) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const drop = useRef(onDrop);
  drop.current = onDrop;
  const suppressClick = useRef(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<RailDropTarget | null>(null);

  useEffect(() => {
    let frame = 0;
    const targetAt = (g: Gesture): RailDropTarget | null => {
      const root = scrollRef.current;
      let hit = document.elementFromPoint(g.x, g.y);
      if (!root || !hit || !root.contains(hit)) return null;
      const selector = "[data-rail-profile-id], [data-rail-group], [data-rail-drop]";
      const server = hit.closest<HTMLElement>("[data-rail-server]");
      if (server && !hit.closest("[data-rail-profile-id]")) {
        // Site children travel with their server; dropping on that block goes
        // after the parent rather than creating a dead area in the rail.
        const id = server.dataset.railServer!;
        return id === g.id ? null : { kind: "row", id, after: true };
      }
      const connections = hit.closest("[data-rail-connections]");
      if (connections && !hit.closest(selector)) {
        // Accept the spaces between rows as well as the rows themselves.
        // Otherwise the insertion line is an unexpectedly undroppable gap.
        let distance = Infinity;
        for (const candidate of connections.querySelectorAll<HTMLElement>(selector)) {
          const r = candidate.getBoundingClientRect();
          const next = Math.max(r.top - g.y, g.y - r.bottom, 0);
          if (next < distance) { distance = next; hit = candidate; }
        }
      }
      const row = hit.closest<HTMLElement>("[data-rail-profile-id]");
      if (row) {
        const id = row.dataset.railProfileId!;
        if (id === g.id) return null;
        const r = row.getBoundingClientRect();
        return { kind: "row", id, after: g.y > r.top + r.height / 2 };
      }
      const group = hit.closest<HTMLElement>("[data-rail-group]");
      if (group) return { kind: "group", name: group.dataset.railGroup! };
      const strip = hit.closest<HTMLElement>("[data-rail-drop]");
      if (strip) return strip.dataset.railDrop === "top"
        ? { kind: "top" }
        : { kind: "sectionEnd", group: strip.dataset.railGroupName };
      return null;
    };
    const showTarget = (g: Gesture) => {
      const target = targetAt(g);
      setDropTarget(current => JSON.stringify(current) === JSON.stringify(target) ? current : target);
    };
    const scroll = () => {
      const g = gesture.current;
      const root = scrollRef.current;
      if (!g?.started || !root) return;
      const r = root.getBoundingClientRect();
      if (g.x >= r.left && g.x <= r.right && g.y >= r.top && g.y <= r.bottom) {
        const speed = g.y < r.top + 32 ? -Math.ceil((r.top + 32 - g.y) / 2)
          : g.y > r.bottom - 32 ? Math.ceil((g.y - r.bottom + 32) / 2) : 0;
        if (speed) root.scrollTop += speed;
      }
      showTarget(g);
      frame = requestAnimationFrame(scroll);
    };
    const finish = (commit: boolean) => {
      const g = gesture.current;
      if (!g) return;
      const target = g.started && commit ? targetAt(g) : null;
      gesture.current = null;
      cancelAnimationFrame(frame);
      if (g.element.hasPointerCapture(g.pointerId)) g.element.releasePointerCapture(g.pointerId);
      if (g.started) {
        document.body.style.userSelect = g.userSelect;
        suppressClick.current = true;
      }
      setDragId(null);
      setDropTarget(null);
      if (target) drop.current(g.id, target);
    };
    const move = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      g.x = e.clientX;
      g.y = e.clientY;
      if (!g.started && Math.hypot(g.x - g.startX, g.y - g.startY) >= 6) {
        g.started = true;
        g.element.setPointerCapture(g.pointerId);
        document.body.style.userSelect = "none";
        setDragId(g.id);
        frame = requestAnimationFrame(scroll);
      }
      if (g.started) { e.preventDefault(); showTarget(g); }
    };
    const up = (e: PointerEvent) => {
      const g = gesture.current;
      if (!g || e.pointerId !== g.pointerId) return;
      g.x = e.clientX;
      g.y = e.clientY;
      finish(true);
    };
    const cancel = () => finish(false);
    const pointerCancel = (e: PointerEvent) => {
      if (e.pointerId === gesture.current?.pointerId) cancel();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape" && gesture.current) { e.preventDefault(); cancel(); }
    };
    const down = () => { suppressClick.current = false; };
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", pointerCancel);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", key, true);
    return () => {
      cancel();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", pointerCancel);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", key, true);
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>, id: string) => {
    if (disabled || e.button !== 0 || !e.isPrimary || gesture.current) return;
    gesture.current = {
      id, pointerId: e.pointerId, element: e.currentTarget,
      startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY,
      started: false, userSelect: document.body.style.userSelect,
    };
  };
  const onClickCapture = (e: ReactMouseEvent) => {
    if (suppressClick.current) { suppressClick.current = false; e.preventDefault(); e.stopPropagation(); }
  };
  return { scrollRef, dragId, dropTarget, onPointerDown, onClickCapture };
}
