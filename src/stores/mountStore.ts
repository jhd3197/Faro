import { create } from "zustand";
import { ipc, onVirtualFsChanged } from "@/lib/ipc";
import { toast } from "./toastStore";
import type { Mount, MountView } from "@/lib/types";

/** What the Mount dialog was opened for: a new mount of a connection, or an
 *  existing one to edit. */
export type MountRequest = { profileId: string; remoteRoot?: string } | { edit: MountView };

interface MountState {
  supported: boolean;
  mounts: MountView[];
  request: MountRequest | null;
  init: () => Promise<() => void>;
  refresh: () => Promise<void>;
  open: (req: MountRequest) => void;
  close: () => void;
  save: (m: Mount) => Promise<void>;
  remove: (id: string) => Promise<void>;
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  freeUpSpace: (id: string) => Promise<void>;
}

/** Connections shown as on-demand Windows folders (Plan 34 Phase 2). */
export const useMounts = create<MountState>((set, get) => ({
  supported: false,
  mounts: [],
  request: null,

  init: async () => {
    try {
      const supported = await ipc.virtualFsSupported();
      set({ supported });
      if (supported) set({ mounts: await ipc.mounts() });
    } catch {
      // mock / older backend
    }
    return onVirtualFsChanged(() => void get().refresh());
  },
  refresh: async () => {
    try {
      set({ mounts: await ipc.mounts() });
    } catch {
      // keep the last list
    }
  },
  open: (request) => set({ request }),
  close: () => set({ request: null }),
  save: async (m) => set({ mounts: await ipc.mountSave(m) }),
  remove: async (id) => set({ mounts: await ipc.mountRemove(id) }),
  setEnabled: async (id, enabled) => set({ mounts: await ipc.mountSetEnabled(id, enabled) }),
  freeUpSpace: async (id) => {
    const n = await ipc.virtualFsFreeUpSpace(id);
    toast.success("Space freed", `${n} file${n === 1 ? "" : "s"} now download again when opened.`);
  },
}));
