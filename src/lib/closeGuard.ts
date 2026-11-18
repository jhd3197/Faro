import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * The main window's single close handler. Tauri destroys the window after
 * *each* `onCloseRequested` listener unless that listener prevents it, so
 * several independent listeners can't cooperate on a "wait, are you sure?"
 * gate. Everything that needs the close goes through here instead:
 *
 * - `onBeforeClose(fn)` — work to flush before the window goes (saved paths,
 *   the session snapshot). Runs only when the close actually proceeds.
 * - `setCloseGate(fn)` — one confirm step. It gets the list of things still
 *   running and resolves `true` to quit anyway, `false` to keep the window.
 */

export interface PendingWork {
  kind: "transfer" | "edit";
  label: string;
}

type Flusher = () => void | Promise<void>;
type Gate = (pending: PendingWork[]) => Promise<boolean>;
type PendingSource = () => PendingWork[];

const flushers = new Set<Flusher>();
const sources = new Set<PendingSource>();
let gate: Gate | null = null;
let installed: Promise<() => void> | null = null;

export function onBeforeClose(fn: Flusher): () => void {
  flushers.add(fn);
  return () => { flushers.delete(fn); };
}

export function addPendingSource(fn: PendingSource): () => void {
  sources.add(fn);
  return () => { sources.delete(fn); };
}

export function setCloseGate(fn: Gate | null) {
  gate = fn;
}

export function pendingWork(): PendingWork[] {
  const out: PendingWork[] = [];
  for (const s of sources) {
    try { out.push(...s()); } catch { /* a broken source shouldn't block quit */ }
  }
  return out;
}

/** A stuck write must never keep the window from closing. */
const FLUSH_TIMEOUT_MS = 2000;

export async function flushBeforeClose() {
  const all = Promise.all([...flushers].map(async f => {
    try { await f(); } catch { /* best effort */ }
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([all, new Promise<void>(r => { timer = setTimeout(r, FLUSH_TIMEOUT_MS); })]);
  clearTimeout(timer);
}

/** Decide whether a close may go ahead (shows the gate when work is pending). */
export async function confirmClose(): Promise<boolean> {
  const pending = pendingWork();
  if (pending.length && gate && !(await gate(pending))) return false;
  await flushBeforeClose();
  return true;
}

type ClosableWindow = {
  onCloseRequested?: (
    handler: (event: { preventDefault: () => void }) => Promise<void>,
  ) => Promise<() => void>;
};

/** Install the main window's close handler once (idempotent across StrictMode). */
export function installCloseGuard(): void {
  if (installed) return;
  const win = getCurrentWindow() as unknown as ClosableWindow;
  if (!win.onCloseRequested) return;
  installed = win.onCloseRequested(async event => {
    if (!(await confirmClose())) event.preventDefault();
  });
  installed.catch(() => { installed = null; });
}
