import { create } from "zustand";
import {
  ipc,
  inspectUploadPaths,
  verifyUploadDirectories,
  onTransferEvent,
  onTransferProgressBatch,
  onTransferQueue,
} from "@/lib/ipc";
import { useSettings } from "./settingsStore";
import { toast } from "./toastStore";
import { useConflicts, type ConflictDecision } from "./conflictStore";
import { baseName } from "@/lib/format";
import {
  LOCAL_SESSION,
  type SessionId,
  type Transfer,
  type OverwritePolicy,
} from "@/lib/types";

/** A file/folder queued for transfer. Lighter than DirEntry so native-picker
 *  paths (which have no metadata) can be enqueued too. */
export interface TransferItem {
  path: string;
  kind: "file" | "directory";
  size?: number;
  modified?: number;
}

/** Map a DirEntry (kind may be symlink/other) to a TransferItem (file/dir). */
export function toTransferItem(e: {
  path: string;
  kind: string;
  size?: number;
  modified?: number | null;
  linkDir?: boolean;
}): TransferItem {
  return {
    path: e.path,
    // A link to a folder copies the folder's contents.
    kind: e.kind === "directory" || (e.kind === "symlink" && e.linkDir) ? "directory" : "file",
    size: e.size,
    modified: e.modified ?? undefined,
  };
}

export interface UploadReport {
  id: string;
  sessionId: string;
  retryItems: TransferItem[];
  publication?: { stagedPath: string; finalPath: string };
  directoryPaths: string[];
  validation: "waiting" | "checking" | "done" | "error";
  destination: string;
  files: number;
  directories: number;
  verifiedDirectories: number;
  bytes: number;
  transferIds: string[];
  errors: string[];
  skipped: number;
  canceled: boolean;
  preparing: boolean;
}

interface TransfersState {
  uploadReports: UploadReport[];
  uploadReportsOpen: boolean;
  setUploadReportsOpen: (open: boolean) => void;
  validateUploads: () => Promise<void>;
  byId: Record<string, Transfer>;
  panelOpen: boolean;
  /** Waiting (queued) transfer ids in FIFO order — position = index + 1. */
  queue: string[];
  pausedAll: boolean;
  concurrency: number;
  throttleKbps: number;

  togglePanel: () => void;
  setPanelOpen: (open: boolean) => void;

  initListeners: () => Promise<() => void>;
  loadInitial: () => Promise<void>;

  // Low-level starts. `policy` overrides the default overwrite policy for this
  // one transfer (used after the user answers the conflict prompt).
  download: (
    sessionId: SessionId,
    remotePath: string,
    localDir: string,
    policy?: OverwritePolicy
  ) => Promise<string>;
  upload: (
    sessionId: SessionId,
    localPath: string,
    remoteDir: string,
    policy?: OverwritePolicy
  ) => Promise<string>;
  downloadDir: (
    sessionId: SessionId,
    remoteDir: string,
    localDir: string,
    policy?: OverwritePolicy
  ) => Promise<string[]>;
  uploadDir: (
    sessionId: SessionId,
    localDir: string,
    remoteDir: string,
    policy?: OverwritePolicy
  ) => Promise<string[]>;
  // Batch entry points: detect name collisions against the destination and
  // prompt (FileZilla-style) before starting each transfer.
  enqueueDownloads: (
    sessionId: SessionId,
    items: TransferItem[],
    localDir: string
  ) => Promise<void>;
  enqueueUploads: (
    sessionId: SessionId,
    items: TransferItem[],
    remoteDir: string,
    staged?: boolean
  ) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  pause: (id: string) => Promise<void>;
  resume: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  move: (id: string, dir: "up" | "down") => Promise<void>;
  pauseAll: () => Promise<void>;
  resumeAll: () => Promise<void>;
  setConcurrency: (n: number) => Promise<void>;
  setThrottle: (kbps: number) => Promise<void>;
  clearFinished: () => void;
}

/** Map a conflict action to the backend overwrite policy. "skip"/"cancel" are
 *  handled by the caller (they don't start a transfer), so this only covers the
 *  two that do. */
function actionToPolicy(action: ConflictDecision["action"]): OverwritePolicy {
  return action === "rename" ? "rename" : "overwrite";
}

/** Shared conflict loop. Lists the destination once, then for each item either
 *  starts it (no collision, or user chose overwrite/rename) or skips it. A
 *  remembered "apply to all" decision short-circuits later prompts; "cancel"
 *  stops the batch. */
async function runBatch(
  destSessionId: SessionId,
  destDir: string,
  side: "local" | "remote",
  items: TransferItem[],
  start: (item: TransferItem, policy: OverwritePolicy) => Promise<unknown>
): Promise<{ errors: string[]; skipped: number; canceled: boolean }> {
  const outcome = { errors: [] as string[], skipped: 0, canceled: false };
  const launch = async (item: TransferItem, policy: OverwritePolicy) => {
    try { await start(item, policy); }
    catch (error) {
      const message = `${item.path}: ${String(error)}`;
      outcome.errors.push(message);
      toast.error("Transfer could not start", message);
    }
  };
  const settings = useSettings.getState();
  const defaultPolicy = settings.overwritePolicy;

  // "Don't ask" mode (the user ticked "remember" before, or turned prompts off
  // in Settings): apply the saved default silently — the original behaviour.
  if (!settings.promptOnOverwrite) {
    for (const item of items) await launch(item, defaultPolicy);
    return outcome;
  }

  // Snapshot the destination's names so we can spot collisions. If it can't be
  // listed (e.g. doesn't exist yet), assume no conflicts.
  const existing = new Map<string, { size: number; modified?: number }>();
  try {
    const list = await ipc.listDirectory(destSessionId, destDir);
    for (const e of list) {
      existing.set(e.name, { size: e.size, modified: e.modified ?? undefined });
    }
  } catch {
    // destination unreadable / missing → treat as no conflicts
  }

  let remembered: ConflictDecision | null = null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const name = baseName(item.path);
    const hit = existing.get(name);
    let policy = defaultPolicy;

    if (hit) {
      const decision: ConflictDecision =
        remembered ??
        (await useConflicts.getState().ask({
          name,
          destDir,
          side,
          kind: item.kind,
          remaining: items.length - i - 1,
          existingSize: item.kind === "file" ? hit.size : undefined,
          existingModified: hit.modified ?? undefined,
          sourceSize: item.kind === "file" ? item.size : undefined,
          sourceModified: item.modified,
        }));

      if (decision.applyToAll) remembered = decision;
      if (decision.remember && decision.action !== "cancel") {
        // Persist as the default AND stop asking from now on.
        settings.setOverwritePolicy(
          decision.action === "skip" ? "skip" : actionToPolicy(decision.action)
        );
        settings.setPromptOnOverwrite(false);
      }
      if (decision.action === "cancel") { outcome.canceled = true; break; }
      if (decision.action === "skip") { outcome.skipped++; continue; }
      policy = actionToPolicy(decision.action);
    }

    await launch(item, policy);
  }
  return outcome;
}

function indexBy(transfers: Transfer[]): Record<string, Transfer> {
  return transfers.reduce<Record<string, Transfer>>((acc, t) => {
    acc[t.id] = t;
    return acc;
  }, {});
}

export const useTransfers = create<TransfersState>((set, get) => ({
  uploadReports: [],
  uploadReportsOpen: true,
  setUploadReportsOpen: (open) => set({ uploadReportsOpen: open }),
  validateUploads: async () => {
    for (const report of get().uploadReports) {
      if (report.preparing || report.validation !== "waiting" || report.errors.length || report.canceled || report.skipped) continue;
      const rows = report.transferIds.map((id) => get().byId[id]);
      if (rows.length !== report.files || rows.some((t) => t?.status !== "done")) continue;
      const update = (patch: Partial<UploadReport>) => set((s) => ({ uploadReports:
        s.uploadReports.map((r) => r.id === report.id ? { ...r, ...patch } : r) }));
      update({ validation: "checking" });
      try {
        if (rows.reduce((total, row) => total + (row?.transferred ?? 0), 0) !== report.bytes) {
          throw new Error("Transferred bytes differ from the original upload inventory");
        }
        await verifyUploadDirectories(report.sessionId, report.directoryPaths);
        let destination = report.destination;
        if (report.publication) {
          const { stagedPath, finalPath } = report.publication;
          const parent = finalPath.slice(0, finalPath.lastIndexOf("/")) || "/";
          const name = finalPath.slice(finalPath.lastIndexOf("/") + 1);
          const existing = await ipc.listDirectory(report.sessionId, parent);
          if (existing.some((entry) => entry.name === name)) throw new Error(`Publication destination already exists: ${finalPath}`);
          await ipc.renamePath(report.sessionId, stagedPath, finalPath);
          destination = finalPath;
        }
        update({ validation: "done", verifiedDirectories: report.directories, destination });
      } catch (error) {
        update({ validation: "error", errors: [...report.errors, String(error)], verifiedDirectories: 0 });
        toast.error("Upload verification failed", String(error));
      }
    }
  },
  byId: {},
  panelOpen: false,
  queue: [],
  pausedAll: false,
  concurrency: 3,
  throttleKbps: 0,

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen, uploadReportsOpen: !s.panelOpen })),
  setPanelOpen: (open) => set({ panelOpen: open, uploadReportsOpen: open }),

  initListeners: async () => {
    const unlistenEvents = await onTransferEvent((kind, t) => {
      // "updated" is treated exactly like progress: replace the byId entry.
      // It never toasts (it also carries the mid-auto-retry "retrying in Ns"
      // state, which is not a terminal outcome).
      set((s) => ({ byId: { ...s.byId, [t.id]: t } }));
      if (kind === "added" && !get().panelOpen) {
        if (useSettings.getState().autoOpenTransferPanel) {
          set({ panelOpen: true });
        }
      }
      void get().validateUploads();
      // Surface terminal outcomes as toasts so background transfers aren't silent.
      if (kind === "done") {
        const verb = t.kind === "upload" ? "Uploaded" : "Downloaded";
        if (t.status === "skipped") {
          toast.info("Transfer skipped", baseName(t.source));
        } else {
          toast.success("File transfer complete", `${verb} ${baseName(t.source)}`);
        }
      } else if (kind === "error") {
        toast.error("Transfer failed", t.error || baseName(t.source));
      }
    });
    // One set() per 250 ms batch, however many transfers are running.
    const unlistenBatch = await onTransferProgressBatch((ts) => {
      set((s) => {
        const byId = { ...s.byId };
        for (const t of ts) byId[t.id] = t;
        return { byId };
      });
    });
    const unlistenQueue = await onTransferQueue((q) => {
      set({
        queue: q.waiting,
        pausedAll: q.pausedAll,
        concurrency: q.concurrency,
        throttleKbps: q.throttleKbps,
      });
    });
    return () => {
      unlistenEvents();
      unlistenBatch();
      unlistenQueue();
    };
  },

  loadInitial: async () => {
    const [list, q] = await Promise.all([
      ipc.listTransfers(),
      ipc.transferQueueState(),
    ]);
    set({
      byId: indexBy(list),
      queue: q.waiting,
      pausedAll: q.pausedAll,
      concurrency: q.concurrency,
      throttleKbps: q.throttleKbps,
    });
  },

  download: async (sessionId, remotePath, localDir, policy) => {
    const p = policy ?? useSettings.getState().overwritePolicy;
    return ipc.startDownload(sessionId, remotePath, localDir, p);
  },

  upload: async (sessionId, localPath, remoteDir, policy) => {
    const p = policy ?? useSettings.getState().overwritePolicy;
    return ipc.startUpload(sessionId, localPath, remoteDir, p);
  },

  downloadDir: async (sessionId, remoteDir, localDir, policy) => {
    const p = policy ?? useSettings.getState().overwritePolicy;
    return ipc.startDirectoryDownload(sessionId, remoteDir, localDir, p);
  },

  uploadDir: async (sessionId, localDir, remoteDir, policy) => {
    const p = policy ?? useSettings.getState().overwritePolicy;
    return ipc.startDirectoryUpload(sessionId, localDir, remoteDir, p);
  },

  enqueueDownloads: async (sessionId, items, localDir) => {
    await runBatch(LOCAL_SESSION, localDir, "local", items, (item, policy) =>
      item.kind === "directory"
        ? get().downloadDir(sessionId, item.path, localDir, policy)
        : get().download(sessionId, item.path, localDir, policy)
    );
  },

  enqueueUploads: async (sessionId, items, remoteDir, staged = false) => {
    const report: UploadReport = {
      id: crypto.randomUUID(), sessionId, retryItems: [], directoryPaths: [], validation: "waiting",
      destination: remoteDir, files: 0, directories: 0,
      verifiedDirectories: 0, bytes: 0, transferIds: [], errors: [], skipped: 0,
      canceled: false, preparing: true,
    };
    const publish = () => set((s) => ({ uploadReports:
      [...s.uploadReports.filter((r) => r.id !== report.id), { ...report,
        transferIds: [...report.transferIds], errors: [...report.errors] }] }));
    publish();
    set({ panelOpen: true, uploadReportsOpen: true });
    try {
      const inventory = await inspectUploadPaths(items.map((item) => item.path));
      if (staged) {
        const caps = await ipc.capabilities(sessionId);
        if (!caps.hasDirectories || !caps.canRename) throw new Error("This server cannot publish a staged directory");
        const parent = remoteDir.replace(/\/$/, "");
        const stagedPath = `${parent}/.faro-staging-${report.id}`;
        const finalPath = `${parent}/release-${report.id}`;
        await ipc.createDirectory(sessionId, stagedPath);
        report.publication = { stagedPath, finalPath };
        remoteDir = stagedPath;
        report.destination = `${stagedPath} → ${finalPath}`;
      }
      report.files = inventory.reduce((n, i) => n + i.files, 0);
      report.directories = inventory.reduce((n, i) => n + i.directories, 0);
      report.directoryPaths = inventory.flatMap((i) => i.directoryPaths.map((relative) =>
        `${remoteDir.replace(/\/$/, "")}/${relative}`));
      report.bytes = inventory.reduce((n, i) => n + i.size, 0);
      publish();
      const result = await runBatch(sessionId, remoteDir, "remote", inventory, async (item, policy) => {
        try {
          const fingerprint = inventory.find((entry) => entry.path === item.path)!.fingerprint;
          if (item.kind === "directory") {
            const ids = await ipc.startDirectoryUpload(sessionId, item.path, remoteDir, policy, fingerprint);
            report.transferIds.push(...ids);
            // Final directory counts are validated after every file is done.
          } else {
            report.transferIds.push(await ipc.startUpload(sessionId, item.path, remoteDir, policy, fingerprint));
          }
          publish();
        } catch (error) {
          report.retryItems.push(item);
          throw error;
        }
      });
      report.errors.push(...result.errors);
      report.skipped = result.skipped;
      report.canceled = result.canceled;
    } catch (error) {
      if (!report.transferIds.length) report.retryItems = items;
      report.errors.push(String(error));
      toast.error("Upload incomplete", String(error));
    } finally {
      report.preparing = false;
      publish();
      void get().validateUploads();
    }
  },

  cancel: async (id) => {
    await ipc.cancelTransfer(id);
  },

  pause: async (id) => {
    await ipc.transferPause(id);
  },

  resume: async (id) => {
    try {
      await ipc.transferResume(id);
    } catch (e) {
      // A row restored from the last session needs its connection open.
      toast.error("Can't resume yet", String(e));
    }
  },

  retry: async (id) => {
    await ipc.transferRetry(id);
  },

  move: async (id, dir) => {
    await ipc.transferMove(id, dir);
  },

  pauseAll: async () => {
    await ipc.transferPauseAll();
  },

  resumeAll: async () => {
    await ipc.transferResumeAll();
  },

  setConcurrency: async (n) => {
    await ipc.transferSetConcurrency(n);
  },

  setThrottle: async (kbps) => {
    await ipc.transferSetThrottle(kbps);
  },

  clearFinished: () => {
    const s = get();
    const next: Record<string, Transfer> = {};
    const cleared: string[] = [];
    for (const t of Object.values(s.byId)) {
      // Paused rows are still in flight — keep them like active ones.
      if (
        t.status === "transferring" ||
        t.status === "queued" ||
        t.status === "paused" || t.status === "error" ||
        s.uploadReports.some((r) => r.transferIds.includes(t.id))
      ) {
        next[t.id] = t;
      } else {
        cleared.push(t.id);
      }
    }
    set({ byId: next });
    // Free them in the backend too, so a reload doesn't bring them back.
    if (cleared.length) void ipc.transferForgetFinished(cleared).catch(() => {});
  },
}));
