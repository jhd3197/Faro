import { useEffect, useState } from "react";

/** Loading spinners and skeletons wait this long: a load that finishes
 *  sooner never flashes a placeholder. */
export const LOADING_DELAY_MS = 200;
/** "Not found" and error empty states wait a little longer, so a quick
 *  reload that is about to succeed doesn't flash a failure. */
export const NOT_FOUND_DELAY_MS = 300;

/** True only once `active` has stayed true for `delay` ms; false again the
 *  moment it turns false. */
export function useDeferredLoading(active: boolean, delay = LOADING_DELAY_MS): boolean {
  const [elapsed, setElapsed] = useState(false);
  useEffect(() => {
    if (!active) {
      setElapsed(false);
      return;
    }
    const timer = setTimeout(() => setElapsed(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
  return active && elapsed;
}

/** Renders `children` only after it has been mounted for `delay` ms. */
export function Deferred({
  delay = LOADING_DELAY_MS,
  children,
}: {
  delay?: number;
  children: React.ReactNode;
}) {
  return useDeferredLoading(true, delay) ? <>{children}</> : null;
}
