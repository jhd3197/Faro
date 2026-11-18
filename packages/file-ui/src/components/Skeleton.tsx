import { cn } from "../lib/cn";
import { useDeferredLoading, LOADING_DELAY_MS } from "../hooks/useDeferredLoading";

// A single shimmering placeholder block. The host app supplies the
// `faro-shimmer` keyframe (see README) so it tints with the active theme.
export function Skeleton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      className={cn("faro-shimmer rounded bg-bg-hover", className)}
      style={style}
    />
  );
}

const WIDTHS = ["55%", "70%", "42%", "63%", "48%", "75%", "58%", "38%", "66%", "50%"];

// Placeholder list shaped like FilePane rows, shown while a directory loads so
// a latent listing never leaves the pane blank. It waits LOADING_DELAY_MS
// first, so a listing that arrives quickly never flashes placeholders.
export function FileListSkeleton({ rows = 12, delay = LOADING_DELAY_MS }: { rows?: number; delay?: number }) {
  const show = useDeferredLoading(true, delay);
  if (!show) return <div data-file-skeleton="pending" aria-busy="true" />;
  return (
    <div data-file-skeleton="shown" aria-busy="true" className="px-3 py-1 anim-fade">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 py-[5px]">
          <Skeleton className="h-3.5 w-3.5" />
          <Skeleton
            className="h-3"
            style={{ width: WIDTHS[i % WIDTHS.length] }}
          />
          <div className="flex-1" />
          <Skeleton className="h-3 w-12" />
        </div>
      ))}
    </div>
  );
}
