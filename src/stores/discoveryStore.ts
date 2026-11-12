import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { ipc } from "@/lib/ipc";
import { useLayout } from "./layoutStore";

export interface ReleaseNotes { version: string; notes: string | null }
const SEEN_KEY = "discoverySeenVersion";
export const NOTES_KEY = "discoveryReleaseNotes";
let initialization: Promise<void> | undefined;

export const useDiscovery = create<{
  version: string | null;
  installedNotes: ReleaseNotes | null;
  init: () => Promise<void>;
  acknowledge: () => void;
}>((set, get) => ({
  version: null,
  installedNotes: null,
  init: () => initialization ??= (async () => {
    try {
      const [version, settings] = await Promise.all([getVersion(), ipc.settingsGetAll()]);
      let installedNotes: ReleaseNotes | null = null;
      try {
        const saved = JSON.parse(settings[`${NOTES_KEY}:${version}`] ?? settings[NOTES_KEY] ?? "null");
        if (saved?.version === version && typeof saved.notes === "string") installedNotes = saved;
      } catch { /* Older or incomplete cache; release notes can be fetched on demand. */ }
      set({ version, installedNotes });
      const seen = settings[SEEN_KEY];
      // Never replace a deep-link or a dialog the user has already opened.
      if (seen !== version && !useLayout.getState().dialog) {
        useLayout.getState().openDialog(seen ? "whatsNew" : "welcome");
      }
    } catch { /* Help remains available when startup settings cannot be read. */ }
  })(),
  acknowledge: () => {
    const version = get().version;
    if (version) void ipc.settingsSet(SEEN_KEY, version).catch(() => {});
  },
}));
