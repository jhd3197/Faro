import { useEffect, useState } from "react";
import { fmtEta } from "@/lib/format";
import { cn } from "@/lib/cn";

// One shared 1 s ticker for every running timer on screen, so twenty transfer
// rows re-render together instead of drifting on twenty intervals.
const listeners = new Set<() => void>();
let ticker: number | undefined;

function subscribe(fn: () => void) {
  listeners.add(fn);
  if (ticker === undefined) {
    ticker = window.setInterval(() => listeners.forEach((l) => l()), 1000);
  }
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0 && ticker !== undefined) {
      window.clearInterval(ticker);
      ticker = undefined;
    }
  };
}

/** Milliseconds since `since` (epoch ms), refreshed every second. Reads the
 *  stored start time, so leaving the view and coming back doesn't reset it. */
export function useElapsed(since: number | undefined, running = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running || since === undefined) return;
    setNow(Date.now());
    return subscribe(() => setNow(Date.now()));
  }, [running, since]);
  return since === undefined ? 0 : Math.max(0, now - since);
}

/** A running "1m 05s" counter with fixed-width digits so it doesn't jitter. */
export function Elapsed({
  since,
  running = true,
  className,
  title = "Elapsed",
}: {
  since: number;
  running?: boolean;
  className?: string;
  title?: string;
}) {
  const ms = useElapsed(since, running);
  return (
    <span data-elapsed className={cn("tabular-nums", className)} title={title}>
      {fmtEta(Math.floor(ms / 1000))}
    </span>
  );
}
