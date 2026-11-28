import { create } from "zustand";
import type { SessionId } from "@/lib/types";

// What the built-in viewer is showing (Plan 37 Phase 3): one text file in the
// editor or one image, over the file panes. The editor's text lives in the
// editor itself; this store only says which file is open and lets the editor
// veto a close while it has unsaved changes.

export interface ViewerDoc {
  kind: "text" | "image";
  sessionId: SessionId;
  path: string;
}

interface ViewerState {
  doc: ViewerDoc | null;
  /** Set by the editor: returns false to keep the viewer open (the user
   *  chose not to discard unsaved changes). */
  beforeClose: (() => boolean) | null;
  open: (doc: ViewerDoc) => void;
  /** Close, unless the editor objects. `force` skips the question. */
  close: (force?: boolean) => boolean;
  setBeforeClose: (fn: (() => boolean) | null) => void;
}

export const useViewer = create<ViewerState>((set, get) => ({
  doc: null,
  beforeClose: null,
  open: (doc) => {
    // Opening another file is a close of the current one first.
    if (get().doc && !get().close()) return;
    set({ doc, beforeClose: null });
  },
  close: (force) => {
    const guard = get().beforeClose;
    if (!force && guard && !guard()) return false;
    set({ doc: null, beforeClose: null });
    return true;
  },
  setBeforeClose: (fn) => set({ beforeClose: fn }),
}));
