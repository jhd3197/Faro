import { useId } from "react";

export interface SparkSeries {
  /** Newest value last. `null` leaves a gap. */
  values: (number | null)[];
  /** Any CSS colour, e.g. `rgb(var(--accent))`. */
  color: string;
  /** Shade the area under the line. */
  fill?: boolean;
}

/**
 * A small time-series chart: one or more lines over a fixed number of slots,
 * newest at the right edge, so a short history grows in from the right instead
 * of stretching to fill the width. Plain SVG; it scales to its container.
 *
 * Purely visual: the current value belongs in text next to it, and callers
 * describe the chart through `label`.
 */
export function Sparkline({
  series,
  capacity,
  max,
  min = 0,
  label,
  className,
}: {
  series: SparkSeries[];
  /** Number of slots across the width. */
  capacity: number;
  /** Top of the scale. */
  max: number;
  min?: number;
  /** Accessible description, e.g. "CPU usage, last 10 minutes". */
  label: string;
  className?: string;
}) {
  const gradientId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const W = 300;
  const H = 100;
  const span = max - min || 1;
  const x = (slot: number) => (capacity <= 1 ? W : (slot / (capacity - 1)) * W);
  const y = (v: number) => H - (Math.min(Math.max(v, min), max) - min) / span * H;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={className}
    >
      {[0.25, 0.5, 0.75].map((f) => (
        <line
          key={f}
          x1={0}
          x2={W}
          y1={H * f}
          y2={H * f}
          stroke="rgb(var(--border-subtle))"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {series.map((s, si) => {
        // Right-align: the newest value sits in the last slot.
        const tail = s.values.slice(-capacity);
        const offset = capacity - tail.length;
        // Split into runs of consecutive non-null points.
        const runs: [number, number][][] = [];
        let run: [number, number][] = [];
        tail.forEach((v, i) => {
          if (v == null || !Number.isFinite(v)) {
            if (run.length) runs.push(run);
            run = [];
          } else {
            run.push([x(offset + i), y(v)]);
          }
        });
        if (run.length) runs.push(run);

        return (
          <g key={si}>
            {s.fill && (
              <defs>
                <linearGradient id={`${gradientId}-${si}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor={s.color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={s.color} stopOpacity={0.02} />
                </linearGradient>
              </defs>
            )}
            {runs.map((pts, ri) => {
              const line = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
              const first = pts[0];
              const last = pts[pts.length - 1];
              return (
                <g key={ri}>
                  {s.fill && pts.length > 1 && (
                    <path
                      d={`${line}L${last[0].toFixed(1)},${H}L${first[0].toFixed(1)},${H}Z`}
                      fill={`url(#${gradientId}-${si})`}
                    />
                  )}
                  {pts.length > 1 ? (
                    <path
                      d={line}
                      fill="none"
                      stroke={s.color}
                      strokeWidth={1.5}
                      strokeLinejoin="round"
                      vectorEffect="non-scaling-stroke"
                    />
                  ) : (
                    // A lone point has no line to draw; mark it.
                    <line
                      x1={first[0] - 1}
                      x2={first[0]}
                      y1={first[1]}
                      y2={first[1]}
                      stroke={s.color}
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                </g>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}
