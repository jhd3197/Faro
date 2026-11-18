// The file clipboard shared by every pane in the window: Copy or Cut puts the
// selection here, Paste in any pane reads it. Kept in memory only, and
// separate from the system clipboard (which "Copy path" uses).

import { useSyncExternalStore } from "react";
import type { DirEntry, SessionId } from "../types";

export interface FileClipboard {
  mode: "copy" | "cut";
  sessionId: SessionId;
  /** The pane the items were taken from. */
  paneId: string;
  entries: DirEntry[];
}

let current: FileClipboard | null = null;
const listeners = new Set<() => void>();

export function getFileClipboard(): FileClipboard | null {
  return current;
}

export function setFileClipboard(next: FileClipboard | null): void {
  current = next && next.entries.length ? next : null;
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The clipboard, re-rendering when it changes (cut rows are dimmed). */
export function useFileClipboard(): FileClipboard | null {
  return useSyncExternalStore(subscribe, getFileClipboard, getFileClipboard);
}
