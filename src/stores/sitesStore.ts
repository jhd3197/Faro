import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import { toast } from "./toastStore";

export interface SiteShortcut {
  id: string;
  profileId: string;
  name: string;
  path: string;
}

const STORAGE_KEY = "siteShortcuts";
const NAVIGATION_KEY = "siteNavigation.v1";
let loading: Promise<void> | undefined;
let writes: Promise<unknown> = Promise.resolve();
let navigationWrites: Promise<void> = Promise.resolve();
let lastSaved: string | undefined;
let saveFailed = false;

export interface BrowseSyncPair {
  enabled: boolean;
  base: { local: string; remote: string } | null;
}

/** Profiles without a shortcut have their own pair, never another site's. */
export function browserLocationKey(profileId: string, siteId?: string): string {
  return JSON.stringify([profileId, siteId ?? null]);
}

interface NavigationState {
  activeByProfile: Record<string, string | undefined>;
  sitePaths: Record<string, string>;
  serverPaths: Record<string, string>;
  localPaths: Record<string, string>;
  syncPairs: Record<string, BrowseSyncPair>;
}

function emptyNavigation(): NavigationState {
  return { activeByProfile: {}, sitePaths: {}, serverPaths: {}, localPaths: {}, syncPairs: {} };
}

function decodeNavigation(raw?: string): NavigationState {
  if (!raw) return emptyNavigation();
  const value = JSON.parse(raw);
  const out = emptyNavigation();
  if (!value || typeof value !== "object") throw new Error("Saved site folders could not be read.");
  for (const field of ["activeByProfile", "sitePaths", "serverPaths", "localPaths"] as const) {
    const map = value[field] ?? {};
    if (!map || typeof map !== "object" || Array.isArray(map) || Object.values(map).some(v => typeof v !== "string")) {
      throw new Error("Saved site folders could not be read.");
    }
    out[field] = { ...map };
  }
  for (const [key, pair] of Object.entries(value.syncPairs ?? {})) {
    const p = pair as BrowseSyncPair;
    if (!p || typeof p.enabled !== "boolean" || (p.base !== null &&
      (!p.base || typeof p.base.local !== "string" || typeof p.base.remote !== "string"))) {
      throw new Error("Saved synchronized browsing pairs could not be read.");
    }
    out.syncPairs[key] = { enabled: p.enabled && !!p.base, base: p.base };
  }
  return out;
}

function navigationSnapshot(s: NavigationState): NavigationState {
  return { activeByProfile: s.activeByProfile, sitePaths: s.sitePaths, serverPaths: s.serverPaths,
    localPaths: s.localPaths, syncPairs: s.syncPairs };
}

/** Serialize snapshots; never let a late write resurrect an older pair. Failed
 * saves stay retryable, and window-close flush waits for every queued update. */
function persistNavigation(): Promise<void> {
  navigationWrites = navigationWrites.then(async () => {
    await useSites.getState().load();
    const value = JSON.stringify(navigationSnapshot(useSites.getState()));
    if (value === lastSaved) return;
    try {
      await ipc.settingsSet(NAVIGATION_KEY, value);
      lastSaved = value;
      saveFailed = false;
    } catch (e) {
      if (!saveFailed) toast.error("Couldn't save site folders", String(e));
      saveFailed = true;
    }
  }).catch(e => {
    if (!saveFailed) toast.error("Couldn't save site folders", String(e));
    saveFailed = true;
  });
  return navigationWrites;
}

interface SitesState extends NavigationState {
  sites: SiteShortcut[];
  loaded: boolean;
  selectionVersion: number;
  load: () => Promise<void>;
  save: (site: SiteShortcut) => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeForProfile: (profileId: string) => Promise<void>;
  select: (profileId: string, siteId?: string) => void;
  navigate: (profileId: string, path: string) => void;
  navigateAt: (profileId: string, siteId: string | undefined, path: string) => void;
  navigateLocal: (profileId: string, siteId: string | undefined, path: string) => void;
  setBrowseSync: (profileId: string, siteId: string | undefined, pair: BrowseSyncPair) => void;
  flushNavigation: () => Promise<void>;
}

function decode(raw?: string): SiteShortcut[] {
  if (!raw) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every(s => s &&
    [s.id, s.profileId, s.name, s.path].every(v => typeof v === "string" && v.trim())
  ) || new Set(value.map(s => s.id)).size !== value.length) {
    throw new Error("Saved site shortcuts could not be read.");
  }
  // Only metadata is stored here. Authentication always belongs to the parent.
  return value.map(({ id, profileId, name, path }) => ({ id, profileId, name, path }));
}

/** Serialize read/modify/write operations; failed saves leave the current list intact. */
function update(change: (sites: SiteShortcut[]) => SiteShortcut[]) {
  const next = writes.catch(() => {}).then(async () => {
    await useSites.getState().load();
    const sites = change(useSites.getState().sites);
    await ipc.settingsSet(STORAGE_KEY, JSON.stringify(sites));
    useSites.setState(s => ({
      sites,
      selectionVersion: s.selectionVersion + 1,
      activeByProfile: Object.fromEntries(Object.entries(s.activeByProfile)
        .filter(([, id]) => sites.some(site => site.id === id))),
      sitePaths: Object.fromEntries(Object.entries(s.sitePaths)
        .filter(([id]) => sites.some(site => site.id === id))),
      localPaths: prunePairs(s.localPaths, sites),
      syncPairs: prunePairs(s.syncPairs, sites),
    }));
    await persistNavigation();
  });
  writes = next;
  return next;
}

function prunePairs<T>(pairs: Record<string, T>, sites: SiteShortcut[], removedProfile?: string) {
  return Object.fromEntries(Object.entries(pairs).filter(([key]) => {
    try {
      const [profileId, siteId] = JSON.parse(key);
      return profileId !== removedProfile && (siteId === null || sites.some(s => s.id === siteId && s.profileId === profileId));
    } catch { return false; }
  }));
}

function pruneNavigation(state: NavigationState, sites: SiteShortcut[]): NavigationState {
  return { ...state,
    activeByProfile: Object.fromEntries(Object.entries(state.activeByProfile)
      .filter(([profileId, id]) => id === undefined || sites.some(site => site.id === id && site.profileId === profileId))),
    sitePaths: Object.fromEntries(Object.entries(state.sitePaths).filter(([id]) => sites.some(site => site.id === id))),
    localPaths: prunePairs(state.localPaths, sites),
    syncPairs: prunePairs(state.syncPairs, sites),
  };
}

export const useSites = create<SitesState>((set, get) => ({
  sites: [],
  loaded: false,
  selectionVersion: 0,
  ...emptyNavigation(),
  load: () => {
    if (get().loaded) return Promise.resolve();
    loading ??= ipc.settingsGetAll().then(values => {
      const sites = decode(values[STORAGE_KEY]);
      const saved = decodeNavigation(values[NAVIGATION_KEY]);
      // A click/navigation during hydration wins over the saved snapshot.
      // Metadata and navigation are separate settings rows. A crash or failed
      // snapshot after deletion must not resurrect a now-deleted selection.
      set(s => ({ sites, loaded: true, ...pruneNavigation({
        activeByProfile: { ...saved.activeByProfile, ...s.activeByProfile },
        sitePaths: { ...saved.sitePaths, ...s.sitePaths },
        serverPaths: { ...saved.serverPaths, ...s.serverPaths },
        localPaths: { ...saved.localPaths, ...s.localPaths },
        syncPairs: { ...saved.syncPairs, ...s.syncPairs },
      }, sites) }));
    }).finally(() => { loading = undefined; });
    return loading;
  },
  save: site => update(sites => {
    const name = site.name.trim();
    if (!name || !site.path.trim()) throw new Error("Enter a site name and folder.");
    if (sites.some(s => s.id !== site.id && s.profileId === site.profileId && s.path === site.path)) {
      throw new Error("This folder is already saved as a site on this server.");
    }
    const saved = { id: site.id, profileId: site.profileId, name, path: site.path };
    return sites.some(s => s.id === site.id)
      ? sites.map(s => s.id === site.id ? saved : s)
      : [...sites, saved];
  }),
  remove: id => update(sites => sites.filter(s => s.id !== id)),
  removeForProfile: async profileId => {
    await update(sites => sites.filter(s => s.profileId !== profileId));
    set(s => ({
      activeByProfile: Object.fromEntries(Object.entries(s.activeByProfile).filter(([id]) => id !== profileId)),
      serverPaths: Object.fromEntries(Object.entries(s.serverPaths).filter(([id]) => id !== profileId)),
      localPaths: prunePairs(s.localPaths, s.sites, profileId),
      syncPairs: prunePairs(s.syncPairs, s.sites, profileId),
    }));
    await persistNavigation();
  },
  select: (profileId, siteId) => {
    set(s => ({ activeByProfile: { ...s.activeByProfile, [profileId]: siteId }, selectionVersion: s.selectionVersion + 1 }));
    void persistNavigation();
  },
  navigate: (profileId, path) => get().navigateAt(profileId, get().activeByProfile[profileId], path),
  navigateAt: (profileId, siteId, path) => {
    if (get().loaded && siteId && !get().sites.some(s => s.id === siteId && s.profileId === profileId)) return;
    set(s => ({
      ...(!s.loaded ? { activeByProfile: { ...s.activeByProfile, [profileId]: siteId } } : {}),
      ...(siteId ? { sitePaths: { ...s.sitePaths, [siteId]: path } }
        : { serverPaths: { ...s.serverPaths, [profileId]: path } }),
    }));
    void persistNavigation();
  },
  navigateLocal: (profileId, siteId, path) => {
    if (get().loaded && siteId && !get().sites.some(s => s.id === siteId && s.profileId === profileId)) return;
    set(s => ({
      ...(!s.loaded ? { activeByProfile: { ...s.activeByProfile, [profileId]: siteId } } : {}),
      localPaths: { ...s.localPaths, [browserLocationKey(profileId, siteId)]: path },
    }));
    void persistNavigation();
  },
  setBrowseSync: (profileId, siteId, pair) => {
    set(s => ({ syncPairs: { ...s.syncPairs, [browserLocationKey(profileId, siteId)]: pair } }));
    void persistNavigation();
  },
  flushNavigation: persistNavigation,
}));
