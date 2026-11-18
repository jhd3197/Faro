import { create } from "zustand";
import { getVersion } from "@tauri-apps/api/app";
import { ipc } from "@/lib/ipc";
import { releaseChanges } from "@/lib/releaseNotes";
import type { ConnectionProfile, ImporterKind, ProfilePreview } from "@/lib/types";
import { useLayout } from "./layoutStore";
import { SESSION_SNAPSHOT_KEY, startupSettled } from "./sessionStore";

export interface ReleaseNotes { version: string; notes: string | null }
/** Connections another client on this machine already has, not yet in Faro. */
export interface FoundSource { kind: Exclude<ImporterKind, "faro">; label: string; path: string | null; count: number }

const SEEN_KEY = "discoverySeenVersion";
export const NOTES_KEY = "discoveryReleaseNotes";
let initialization: Promise<void> | undefined;
let scanning: Promise<FoundSource[]> | undefined;
let settingsCache: Record<string, string> = {};

function semver(v: string | null | undefined): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v ?? "");
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function cachedNotes(version: string): ReleaseNotes | null {
  try {
    const saved = JSON.parse(settingsCache[`${NOTES_KEY}:${version}`] ?? "null");
    if (saved?.version === version && typeof saved.notes === "string") return saved;
  } catch { /* An incomplete cache entry; fetch on demand instead. */ }
  return null;
}

/** What startup shows: the welcome (a genuinely new install), What's New (a
 *  minor/major update), the quiet "Updated" pill (a patch, or an upgrade
 *  from a build that kept no record), or nothing. */
export type DiscoveryPlan = "welcome" | "whatsNew" | "notice" | "quiet" | "none";

export function planDiscovery({ seen, version, profileCount, priorLaunch }: {
  /** The version last acknowledged, or null when none was ever recorded. */
  seen: string | null;
  version: string;
  /** Saved connections; null when they couldn't be read. */
  profileCount: number | null;
  /** Any trace of an earlier launch (session snapshot, tips record…). */
  priorLaunch: boolean;
}): DiscoveryPlan {
  if (seen === version) return "none";
  if (!seen) {
    if (profileCount === null) return "quiet";
    return profileCount === 0 && !priorLaunch ? "welcome" : "notice";
  }
  const before = semver(seen), now = semver(version);
  if (!before || !now || before.join(".") === now.join(".")
    || before[0] > now[0] || (before[0] === now[0] && (before[1] > now[1] || (before[1] === now[1] && before[2] > now[2])))) {
    // A downgrade or an unreadable record: nothing new to announce.
    return "quiet";
  }
  return before[0] !== now[0] || before[1] !== now[1] ? "whatsNew" : "notice";
}

/** Rows only an earlier launch writes: a saved session or the tips record. */
const LAUNCH_TRACES = [SESSION_SNAPSHOT_KEY, "discoveryTipsSeen"];
function priorLaunch(settings: Record<string, string>): boolean {
  return LAUNCH_TRACES.some(k => settings[k] !== undefined);
}

const key = (host: string, port: number, user: string) => `${host.toLowerCase()}\0${port}\0${user}`;

export const useDiscovery = create<{
  version: string | null;
  /** The version the user last acknowledged, while an update notice is pending. */
  since: string | null;
  /** Show the status-bar "Updated" pill. */
  updateNotice: boolean;
  releases: ReleaseNotes[] | null;
  loadingReleases: boolean;
  found: FoundSource[] | null;
  init: () => Promise<void>;
  loadReleases: () => Promise<void>;
  scanImports: (force?: boolean) => Promise<FoundSource[]>;
  acknowledge: () => void;
}>((set, get) => ({
  version: null,
  since: null,
  updateNotice: false,
  releases: null,
  loadingReleases: false,
  found: null,
  init: () => initialization ??= (async () => {
    try {
      const [version, settings] = await Promise.all([getVersion(), ipc.settingsGetAll()]);
      settingsCache = settings;
      set({ version });
      const seen = settings[SEEN_KEY];
      if (seen === version) return;
      // Builds before the walkthrough never recorded a version, so a missing
      // key alone doesn't mean a new user: saved connections or any trace of
      // an earlier launch say otherwise. Unreadable profiles count as "not new".
      const profileCount = seen ? 0 : await ipc.listProfiles().then(p => p.length, () => null);
      const plan = planDiscovery({ seen: seen ?? null, version, profileCount, priorLaunch: priorLaunch(settings) });
      if (plan === "welcome") {
        // Record the version first: a welcome that fails to render, or a
        // window closed over it, must never bring it back next launch. It
        // also keeps a brand-new user from getting What's New for this build.
        get().acknowledge();
        // Never replace a deep-link or a dialog the user has already opened.
        if (!useLayout.getState().dialog) useLayout.getState().openDialog("welcome");
        return;
      }
      if (plan === "quiet") { get().acknowledge(); return; }
      set({ since: seen ?? null, updateNotice: true });
      if (plan !== "whatsNew") return;
      // Patch releases ship several times a week: they get the quiet pill. A
      // minor or major release with a real summary opens the notes once —
      // after the startup restore and auto-connects settle, so a reconnecting
      // server doesn't pull focus from (or land on top of) the notes.
      await get().loadReleases();
      if (!get().releases?.some(r => releaseChanges(r.notes))) return;
      await startupSettled();
      if (get().updateNotice && !useLayout.getState().dialog) {
        useLayout.getState().openDialog("whatsNew");
      }
    } catch { /* Help remains available when startup settings cannot be read. */ }
  })(),
  loadReleases: async () => {
    const { version, since } = get();
    if (!version || get().loadingReleases) return;
    set({ loadingReleases: true });
    try {
      const list = await ipc.appReleaseNotesSince(since, version);
      for (const r of list) {
        if (!r.notes) continue;
        const value = JSON.stringify({ version: r.version, notes: r.notes });
        settingsCache[`${NOTES_KEY}:${r.version}`] = value;
        void ipc.settingsSet(`${NOTES_KEY}:${r.version}`, value).catch(() => {});
      }
      set({ releases: list.length ? list : [cachedNotes(version) ?? { version, notes: null }] });
    } catch {
      // Offline: the updater saved the installed version's notes before install.
      set({ releases: [cachedNotes(version) ?? { version, notes: null }] });
    } finally {
      set({ loadingReleases: false });
    }
  },
  scanImports: (force = false) => {
    if (scanning && !force) return scanning;
    scanning = (async () => {
      const [paths, profiles] = await Promise.all([
        ipc.importerDefaultPaths().catch(() => null),
        ipc.listProfiles().catch(() => [] as ConnectionProfile[]),
      ]);
      const saved = new Set(profiles.map(p => key(p.host, p.port, p.username)));
      const fresh = (list: ProfilePreview[]) => list.filter(p => !saved.has(key(p.host, p.port, p.username))).length;
      const read = async (kind: FoundSource["kind"], label: string, path: string | null, load: () => Promise<ProfilePreview[]>) => {
        try { return { kind, label, path, count: fresh(await load()) }; } catch { return { kind, label, path, count: 0 }; }
      };
      const found = await Promise.all([
        paths?.opensshExists ? read("openssh", "OpenSSH config", paths.openssh, () => ipc.importOpenssh()) : null,
        paths?.filezillaExists ? read("filezilla", "FileZilla", paths.filezilla, () => ipc.importFilezilla()) : null,
        paths?.putty ? read("putty", "PuTTY", null, () => ipc.importPutty()) : null,
      ]);
      const result = found.filter((f): f is FoundSource => !!f && f.count > 0);
      set({ found: result });
      return result;
    })();
    return scanning;
  },
  acknowledge: () => {
    const version = get().version;
    set({ updateNotice: false });
    if (version) void ipc.settingsSet(SEEN_KEY, version).catch(() => {});
  },
}));
