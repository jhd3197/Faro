import { useRef, type CSSProperties, type ReactNode, type RefObject } from "react";
import { cn } from "@/lib/cn";
import {
  PANEL_TRANSITION_MS,
  STRIP_SIZE,
  useResizable,
  type Axis,
} from "@/hooks/useResizable";

/**
 * The thin labelled strip a collapsed pane turns into. Click, Enter or Space
 * opens it at its remembered size; dragging it resizes like the splitter.
 */
export function CollapsedStrip({
  label,
  axis,
  onExpand,
  onPointerDown,
  className,
}: {
  label: string;
  /** The axis the pane resizes along: "x" strips are vertical. */
  axis: Axis;
  onExpand: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  className?: string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={false}
      aria-label={`Expand ${label}`}
      title={`Expand ${label}`}
      data-collapsed-strip={label}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onExpand();
        }
      }}
      className={cn(
        "flex shrink-0 select-none justify-center bg-bg-subtle text-[11px] font-medium text-text-muted hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent",
        // Label near the top: the middle of a split is where its own controls sit.
        axis === "x" ? "h-full cursor-col-resize items-start pt-3" : "w-full cursor-row-resize items-center",
        className
      )}
      style={axis === "x" ? { width: STRIP_SIZE } : { height: STRIP_SIZE }}
    >
      <span className={cn("whitespace-nowrap", axis === "x" && "[writing-mode:vertical-rl] rotate-180")}>
        {label}
      </span>
    </div>
  );
}

/**
 * A panel docked on the right (axis "x") or bottom (axis "y") of
 * `containerRef`, with a drag handle on its leading edge. Size and collapsed
 * state persist under `id`; nothing renders until the saved size is known.
 */
export function ResizablePanel({
  id,
  label,
  axis,
  defaultSize,
  min,
  max,
  maxFraction = 0.7,
  collapsible = true,
  containerRef,
  hidden = false,
  keepMounted = false,
  fit = "fixed",
  className,
  children,
}: {
  id: string;
  /** Short name on the collapsed strip and the handle ("Preview"). */
  label: string;
  axis: Axis;
  defaultSize: number;
  min: number;
  max?: number;
  maxFraction?: number;
  collapsible?: boolean;
  containerRef: RefObject<HTMLElement | null>;
  /** Render at zero size without unmounting (a dock toggled closed). */
  hidden?: boolean;
  /** Keep children mounted while collapsed (live terminals). */
  keepMounted?: boolean;
  /** "max": size caps the content instead of fixing it (content-sized lists). */
  fit?: "fixed" | "max";
  className?: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const r = useResizable({
    id, axis, defaultSize, min, max, maxFraction, collapsible, containerRef,
    panelRef,
  });
  if (!r.ready) return null;

  const dim = axis === "x" ? "width" : "height";
  const style: CSSProperties = hidden
    ? { [dim]: 0, overflow: "hidden" }
    : r.collapsed
      ? { [dim]: STRIP_SIZE }
      : fit === "max"
        ? { [axis === "x" ? "maxWidth" : "maxHeight"]: r.size }
        : { [dim]: r.size };
  if (!r.dragging) {
    style.transition = `${dim} ${PANEL_TRANSITION_MS}ms ease, max-${dim} ${PANEL_TRANSITION_MS}ms ease`;
  }

  return (
    <div
      ref={panelRef}
      data-panel={id}
      data-collapsed={r.collapsed || undefined}
      className={cn(
        "relative flex",
        // Side panels hold their width; bottom docks give way before the
        // work area above them is squeezed past its minimum.
        axis === "x" ? "h-full shrink-0 flex-row" : "w-full min-h-0 flex-col",
        !hidden && (axis === "x" ? "border-l border-border" : "border-t border-border"),
        className
      )}
      style={style}
    >
      {!hidden && !r.collapsed && (
        <div
          {...r.handleProps}
          aria-label={`Resize ${label}`}
          title="Drag to resize; double-click to reset"
          className={cn(
            "absolute z-20 touch-none select-none hover:bg-accent/30 focus-visible:bg-accent/30 focus-visible:outline-none",
            axis === "x"
              ? "inset-y-0 -left-[5px] w-[9px] cursor-col-resize"
              : "inset-x-0 -top-[5px] h-[9px] cursor-row-resize",
            r.dragging && "bg-accent/30"
          )}
        />
      )}
      {r.collapsed && !hidden && (
        <CollapsedStrip label={label} axis={axis} onExpand={r.expand} onPointerDown={r.stripPointerDown} />
      )}
      {(!r.collapsed || keepMounted) && (
        <div className={cn("min-h-0 min-w-0 flex-1 overflow-hidden", r.collapsed && "hidden", axis === "x" ? "flex flex-col" : "flex flex-col")}>
          {children}
        </div>
      )}
    </div>
  );
}
