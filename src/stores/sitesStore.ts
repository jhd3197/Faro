import { create } from "zustand";
import { ipc } from "@/lib/ipc";

export interface SiteShortcut {
  id: string;
  profileId: string;
  name: string;
  path: string;
}

const STORAGE_KEY = "siteShortcuts";
let loading: Promise<void> | undefined;
let writes: Promise<unknown> = Promise.resolve();

interface SitesState {
  sites: SiteShortcut[];
  loaded: boolean;
  activeByProfile: Record<string, string | undefined>;
  sitePaths: Record<string, string>;
  serverPaths: Record<string, string>;
  load: () => Promise<void>;
  save: (site: SiteShortcut) => Promise<void>;
  remove: (id: string) => Promise<void>;
  removeForProfile: (profileId: string) => Promise<void>;
  select: (profileId: string, siteId?: string) => void;
  navigate: (profileId: string, path: string) => void;
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
      activeByProfile: Object.fromEntries(Object.entries(s.activeByProfile)
        .filter(([, id]) => sites.some(site => site.id === id))),
      sitePaths: Object.fromEntries(Object.entries(s.sitePaths)
        .filter(([id]) => sites.some(site => site.id === id))),
    }));
  });
  writes = next;
  return next;
}

export const useSites = create<SitesState>((set, get) => ({
  sites: [],
  loaded: false,
  activeByProfile: {},
  sitePaths: {},
  serverPaths: {},
  load: () => {
    if (get().loaded) return Promise.resolve();
    loading ??= ipc.settingsGetAll().then(values => {
      set({ sites: decode(values[STORAGE_KEY]), loaded: true });
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
  removeForProfile: profileId => update(sites => sites.filter(s => s.profileId !== profileId)),
  select: (profileId, siteId) => set(s => ({ activeByProfile: { ...s.activeByProfile, [profileId]: siteId } })),
  navigate: (profileId, path) => set(s => {
    const siteId = s.activeByProfile[profileId];
    return siteId
      ? { sitePaths: { ...s.sitePaths, [siteId]: path } }
      : { serverPaths: { ...s.serverPaths, [profileId]: path } };
  }),
}));
