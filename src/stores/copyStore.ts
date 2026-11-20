import { create } from "zustand";
import { ipc, onCopyToProgress } from "@/lib/ipc";
import { toast } from "./toastStore";
import type { CopyJob, DirEntry, SessionId } from "@/lib/types";

/** What the Copy to… dialog was opened with. */
export interface CopyToRequest {
  sessionId: SessionId;
  entries: DirEntry[];
}

interface CopyStoreState {
  /** Open dialog, if any. */
  request: CopyToRequest | null;
  jobs: CopyJob[];
  openCopyTo: (sessionId: SessionId, entries: DirEntry[]) => void;
  closeCopyTo: () => void;
  init: () => Promise<() => void>;
  cancel: (id: string) => Promise<void>;
  clearFinished: () => Promise<void>;
}

export const useCopyJobs = create<CopyStoreState>((set) => ({
  request: null,
  jobs: [],
  openCopyTo: (sessionId, entries) => set({ request: { sessionId, entries } }),
  closeCopyTo: () => set({ request: null }),

  init: async () => {
    try {
      set({ jobs: await ipc.copyToJobs() });
    } catch {
      // older backend / mock without the command: no jobs to show
    }
    const un = await onCopyToProgress((job) => {
      set((s) => {
        const prev = s.jobs.find((j) => j.id === job.id);
        // Tell the user once, when a run ends.
        if (prev?.state === "running" && job.state !== "running") {
          const what = `${job.done} file${job.done === 1 ? "" : "s"} to ${job.destLabel}`;
          if (job.state === "done") toast.success("Copy finished", `Copied ${what}.`);
          else if (job.state === "failed") toast.error("Copy finished with errors", job.error ?? `${job.failed} failed`);
          else toast.info("Copy canceled", `Copied ${what} before stopping.`);
        }
        const jobs = prev ? s.jobs.map((j) => (j.id === job.id ? job : j)) : [...s.jobs, job];
        return { jobs };
      });
    });
    return un;
  },

  cancel: async (id) => {
    await ipc.copyToCancel(id);
  },

  clearFinished: async () => {
    await ipc.copyToClear();
    set((s) => ({ jobs: s.jobs.filter((j) => j.state === "running") }));
  },
}));
