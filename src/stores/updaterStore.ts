import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { ipc } from "@/lib/ipc";
import { toast } from "./toastStore";

// Tauri owns downloading and signature verification in Rust. Keep the verified
// package alive until the user explicitly chooses to install and restart.
let heldUpdate: Update | null = null;
let installed = false;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const RELEASES_URL = "https://github.com/jhd3197/Faro/releases/latest";

export type UpdaterStatus =
  | "idle" | "checking" | "current" | "available" | "manual"
  | "downloading" | "verifying" | "ready" | "installing" | "error";
type Retry = "check" | "download" | "install";

interface UpdaterState {
  status: UpdaterStatus;
  version: string | null;
  currentVersion: string | null;
  notes: string | null;
  releaseUrl: string;
  downloaded: number;
  total: number | null;
  error: string | null;
  errorDetail: string | null;
  retryAction: Retry;
  lastChecked: number | null;
  dismissed: boolean;
  check: (quiet: boolean) => Promise<void>;
  download: () => Promise<void>;
  restart: () => Promise<void>;
  retry: () => Promise<void>;
  dismiss: () => void;
  init: () => Promise<() => void>;
}

function detail(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const e = error as { message?: string; detail?: string };
    return e.detail ?? e.message ?? JSON.stringify(error);
  }
  return String(error);
}

function downloadError(error: unknown): string {
  const raw = detail(error);
  if (/signature|verify|minisign|pubkey/i.test(raw)) {
    return "Faro couldn't verify this update. Nothing was installed. Try downloading it again, or open Downloads.";
  }
  return "The update couldn't finish downloading. Check your connection and try again.";
}

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: "idle", version: null, currentVersion: null, notes: null,
  releaseUrl: RELEASES_URL, downloaded: 0, total: null,
  error: null, errorDetail: null, retryAction: "check", lastChecked: null, dismissed: false,

  check: async (quiet) => {
    // A second check must not discard a verified download or race an install.
    if (["checking", "downloading", "verifying", "ready", "installing"].includes(get().status)
      || (get().status === "error" && get().retryAction === "install")) return;
    const previous = heldUpdate;
    heldUpdate = null;
    installed = false;
    set({ status: "checking", error: null, errorDetail: null, version: null, notes: null,
      downloaded: 0, total: null, releaseUrl: RELEASES_URL, retryAction: "check" });
    await previous?.close().catch(() => {});
    // Timestamp successful checks only. An offline launch must not suppress the
    // next launch's check for six hours.
    const checked = () => {
      const now = Date.now();
      set({ lastChecked: now });
      void ipc.settingsSet("lastUpdateCheck", JSON.stringify(now)).catch(() => {});
    };
    try {
      const update = await check({ timeout: 15_000 });
      heldUpdate = update;
      if (update) {
        set({ status: "available", version: update.version, currentVersion: update.currentVersion,
          notes: update.body ?? null, dismissed: false });
      } else {
        set({ status: "current" });
        if (!quiet) toast.success("Faro is up to date");
      }
      checked();
    } catch (pluginError) {
      // Releases can exist without latest.json. Discover them natively, without
      // weakening the signed installer path or pretending a failed check passed.
      try {
        const release = await ipc.appUpdateRelease();
        set({ status: release.newer ? "manual" : "current", version: release.version,
          currentVersion: release.currentVersion, notes: release.notes, releaseUrl: release.url,
          errorDetail: release.newer ? detail(pluginError) : null, dismissed: false });
        checked();
        if (!release.newer && !quiet) toast.success("Faro is up to date");
      } catch (fallbackError) {
        const message = typeof fallbackError === "object" && fallbackError !== null
          ? (fallbackError as { message?: string }).message : null;
        set({ status: "error", error: message ?? "Couldn't check for updates. Check your connection and try again.",
          errorDetail: `${detail(pluginError)}\n${detail(fallbackError)}` });
        // The About panel owns this error; background checks stay quiet and a
        // manual check doesn't produce a second, duplicate toast.
      }
    }
  },

  download: async () => {
    if (!heldUpdate || !(get().status === "available"
      || (get().status === "error" && get().retryAction === "download"))) return;
    set({ status: "downloading", downloaded: 0, total: null, error: null, errorDetail: null, dismissed: false });
    try {
      let received = 0;
      let lastPaint = 0;
      await heldUpdate.download((event) => {
        if (event.event === "Started") {
          received = 0;
          set({ total: event.data.contentLength || null, downloaded: 0 });
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          const now = Date.now();
          if (now - lastPaint >= 100) {
            lastPaint = now;
            set({ downloaded: received });
          }
        } else {
          // Tauri emits Finished before signature verification, not after it.
          set({ status: "verifying", downloaded: received });
        }
      }, { timeout: 30 * 60 * 1000 });
      set({ status: "ready" });
    } catch (error) {
      set({ status: "error", retryAction: "download", error: downloadError(error), errorDetail: detail(error) });
    }
  },

  restart: async () => {
    if (!heldUpdate || !(get().status === "ready"
      || (get().status === "error" && get().retryAction === "install"))) return;
    set({ status: "installing", error: null, errorDetail: null, dismissed: false });
    try {
      if (!installed) {
        // Windows launches the installer and exits here; macOS/Linux return.
        await heldUpdate.install();
        installed = true;
      }
      await relaunch();
    } catch (error) {
      set({ status: "error", retryAction: "install",
        error: installed ? "The update is installed, but Faro couldn't restart. Try again, or close and reopen Faro."
          : "Faro couldn't install the update. Try again, or open Downloads to install it manually.",
        errorDetail: detail(error) });
    }
  },

  retry: async () => {
    const state = get();
    if (state.retryAction === "download") await state.download();
    else if (state.retryAction === "install") await state.restart();
    else await state.check(false);
  },
  dismiss: () => set({ dismissed: true }),
  init: async () => {
    try {
      const all = await ipc.settingsGetAll();
      let last = 0;
      try { last = Number(JSON.parse(all["lastUpdateCheck"] ?? "0")); } catch { /* Check again. */ }
      if (Number.isFinite(last) && last > 0 && last <= Date.now()) set({ lastChecked: last });
      if (!Number.isFinite(last) || last <= 0 || last > Date.now() || Date.now() - last > CHECK_INTERVAL_MS) {
        await get().check(true);
      }
    } catch { /* Settings unavailable; leave the manual check usable. */ }
    return () => {};
  },
}));
