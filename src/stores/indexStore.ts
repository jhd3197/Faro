import { create } from "zustand";
import { ipc, onIndexProgress } from "@/lib/ipc";
import { toast } from "./toastStore";
import type { IndexRootView, SessionId } from "@/lib/types";

/** A Tags… request from the file pane: files on one connection. */
export interface TagsRequest {
  connectionId: string;
  paths: string[];
}

interface IndexState {
  open: boolean;
  /** Pre-filter the search to one connection / folder when opened from it. */
  scope: { connectionId: string; under?: string } | null;
  roots: IndexRootView[];
  tagsRequest: TagsRequest | null;
  init: () => Promise<() => void>;
  refreshRoots: () => Promise<void>;
  openSearch: (scope?: { connectionId: string; under?: string } | null) => void;
  closeSearch: () => void;
  indexFolder: (sessionId: SessionId, path: string) => Promise<void>;
  openTags: (req: TagsRequest) => void;
  closeTags: () => void;
}

/** The file index (Plan 34): indexed folders, their progress, the search
 *  overlay and the Tags dialog. */
export const useIndex = create<IndexState>((set, get) => ({
  open: false,
  scope: null,
  roots: [],
  tagsRequest: null,

  init: async () => {
    await get().refreshRoots();
    return onIndexProgress((ev) => {
      set((s) => {
        const roots = s.roots.some((r) => r.connectionId === ev.connectionId && r.root === ev.root)
          ? s.roots.map((r) =>
              r.connectionId === ev.connectionId && r.root === ev.root
                ? { ...r, running: ev.running, done: ev.done, total: ev.total }
                : r
            )
          : [...s.roots, { connectionId: ev.connectionId, root: ev.root, files: 0, running: ev.running, done: ev.done, total: ev.total }];
        return { roots };
      });
      if (!ev.running) {
        if (ev.error) toast.error("Indexing stopped", `${ev.root}: ${ev.error}`);
        void get().refreshRoots();
      }
    });
  },
  refreshRoots: async () => {
    try {
      set({ roots: await ipc.indexRoots() });
    } catch {
      // mock / older backend
    }
  },
  openSearch: (scope = null) => set({ open: true, scope }),
  closeSearch: () => set({ open: false }),
  indexFolder: async (sessionId, path) => {
    await ipc.indexStart(sessionId, path);
    toast.info("Indexing started", `${path} — searchable as files are read.`);
    await get().refreshRoots();
  },
  openTags: (tagsRequest) => set({ tagsRequest }),
  closeTags: () => set({ tagsRequest: null }),
}));
