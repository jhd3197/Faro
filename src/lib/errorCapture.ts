import { create } from "zustand";
import { useToasts } from "@/stores/toastStore";
import { messageOf } from "@/lib/errors";

// Crashes and stray errors land in the notification centre, so the status
// bar's error pill can count them and "Copy details" can hand them over.

/** Text of an error plus its stack, for "Copy details". */
export function crashDetail(
  error: unknown,
  componentStack?: string | null,
): string {
  const parts = [messageOf(error)];
  if (error instanceof Error && error.stack) parts.push(error.stack);
  if (componentStack) parts.push(`Component stack:${componentStack}`);
  return parts.join("\n\n");
}

let recentCrash: { message: string; at: number } | null = null;

/** Log a region crash. The recover panel is already on screen, so no card. */
export function logCrash(
  region: string,
  error: unknown,
  componentStack?: string | null,
): void {
  recentCrash = { message: messageOf(error), at: Date.now() };
  useToasts.getState().push({
    id: `crash:${region}`,
    variant: "error",
    title: `${region} stopped working`,
    message: messageOf(error),
    detail: crashDetail(error, componentStack),
    show: false,
  });
}

/** Log an uncaught error or unhandled promise rejection. Repeats of the same
 *  message replace one entry instead of filling the log. */
function logUncaught(kind: "error" | "rejection", error: unknown): void {
  const message = messageOf(error) || "Unknown error";
  // React (in development) reports an error to the window before the
  // boundary that catches it logs it: wait a tick, then skip such repeats.
  setTimeout(() => {
    if (
      recentCrash &&
      recentCrash.message === message &&
      Date.now() - recentCrash.at < 2000
    )
      return;
    useToasts.getState().push({
      id: `uncaught:${message.slice(0, 120)}`,
      variant: "error",
      title:
        kind === "error"
          ? "Unexpected error"
          : "Unhandled error in the background",
      message,
      detail: crashDetail(error),
      show: false,
    });
  }, 0);
}

let installed = false;

/** Catch window `error` and `unhandledrejection` into the notification log. */
export function installGlobalErrorCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    // Resource load failures (an <img> 404) carry no error and aren't bugs.
    if (!e.error && !e.message) return;
    logUncaught("error", e.error ?? e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logUncaught("rejection", e.reason);
  });
}

/** Demo/test hook: make a region's boundary throw on its next render, to
 *  show the recover panel. Only the mock build exposes it (window.__demo). */
export const useCrashTest = create<{
  region: string | null;
  crash: (region: string | null) => void;
}>((set) => ({ region: null, crash: (region) => set({ region }) }));
