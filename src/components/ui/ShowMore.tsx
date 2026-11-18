import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn";

/** Whether content of `scrollHeight` px needs more than `lines` lines. */
export function overflowsLines(scrollHeight: number, lineHeight: number, lines: number): boolean {
  return scrollHeight > lineHeight * lines + 1;
}

function lineHeightOf(el: HTMLElement): number {
  const s = getComputedStyle(el);
  const lh = parseFloat(s.lineHeight);
  return Number.isFinite(lh) ? lh : parseFloat(s.fontSize) * 1.2;
}

// Long text clamped to a few lines, with "Show more" only when it really is
// longer than that: measured from the rendered line height, re-checked when
// the box resizes. Short text renders plainly, with no toggle.
export function ShowMore({
  children,
  lines = 3,
  className,
  buttonClassName,
}: {
  children: ReactNode;
  lines?: number;
  className?: string;
  buttonClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(overflowsLines(el.scrollHeight, lineHeightOf(el), lines));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [lines, children]);

  const clamp = overflows && !expanded;
  return (
    <div className="min-w-0">
      <div
        ref={ref}
        data-show-more={clamp ? "clamped" : expanded ? "expanded" : "plain"}
        style={
          clamp
            ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: lines, overflow: "hidden" }
            : undefined
        }
        className={cn("whitespace-pre-wrap [overflow-wrap:anywhere]", className)}
      >
        {children}
      </div>
      {overflows && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className={cn("mt-0.5 text-[11px] font-medium text-accent hover:underline", buttonClassName)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
