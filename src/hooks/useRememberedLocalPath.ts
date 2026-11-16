import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ipc } from "@/lib/ipc";
import { LOCAL_SESSION, type ConnectionProfile } from "@/lib/types";
import { browserLocationKey, useSites } from "@/stores/sitesStore";
import {
  LAST_LOCAL_PATH_KEY, createLocalPathMemory, initialLocalPath, injectedLastLocalPath,
  osRoot, parseStoredLocalPath, peekSessionLocalPath, rememberSessionLocalPath,
} from "@/lib/localFolder";

/** Each site (and the server view) owns its last local folder. Profile defaults
 * seed new pairs only. The global folder remains the fallback for local view
 * and for installations upgrading from before per-site navigation existed. */
export function useRememberedLocalPath(
  profile: ConnectionProfile | null,
  activeSessionId: string | null
): readonly [string, (path: string) => void] {
  const [fallback, setFallback] = useState(() => initialLocalPath());
  const [legacyReady, setLegacyReady] = useState(false);
  const navEpoch = useRef(0);
  const loaded = useSites(s => s.loaded);
  const selectionVersion = useSites(s => s.selectionVersion);
  const siteId = useSites(s => profile ? s.activeByProfile[profile.id] : undefined);
  const key = profile ? browserLocationKey(profile.id, siteId) : null;
  const saved = useSites(s => key ? s.localPaths[key] : undefined);
  const path = saved ?? profile?.defaultLocalPath ?? fallback;
  const current = useRef({ key, activeSessionId, path });
  current.current = { key, activeSessionId, path };
  const memory = useRef(createLocalPathMemory(next =>
    ipc.settingsSet(LAST_LOCAL_PATH_KEY, JSON.stringify(next)).catch(() => {}), 300));

  useEffect(() => { void useSites.getState().load().catch(() => {}); }, []);
  useEffect(() => {
    let cancelled = false;
    const epoch = navEpoch.current;
    void (async () => {
      let remembered = peekSessionLocalPath() ?? injectedLastLocalPath();
      if (!remembered) {
        const stored = await ipc.settingsGetAll().catch(() => ({}) as Record<string, string>);
        remembered = parseStoredLocalPath(stored[LAST_LOCAL_PATH_KEY]);
      }
      if (!cancelled && epoch === navEpoch.current) {
        if (remembered) setFallback(remembered);
        setLegacyReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const profileId = profile?.id;
  const setLocalPath = useCallback((next: string) => {
    const sites = useSites.getState();
    if (sites.selectionVersion !== selectionVersion || (profileId && sites.activeByProfile[profileId] !== siteId)) return;
    navEpoch.current++;
    setLegacyReady(true);
    rememberSessionLocalPath(next);
    memory.current.update(next);
    if (profileId) useSites.getState().navigateLocal(profileId, siteId, next);
    else setFallback(next);
  }, [profileId, siteId, selectionVersion]);

  // Validate only on restoration, not on every user navigation. A late probe
  // cannot move a different site, nor overwrite navigation made while it ran.
  useEffect(() => {
    if (!loaded || !legacyReady) return;
    let cancelled = false;
    const epoch = navEpoch.current;
    const candidate = current.current.path;
    void (async () => {
      let next = candidate;
      try { await ipc.listDirectory(LOCAL_SESSION, candidate); }
      catch { next = osRoot(); }
      const sites = useSites.getState();
      if (cancelled || epoch !== navEpoch.current || current.current.key !== key ||
        current.current.activeSessionId !== activeSessionId || current.current.path !== candidate ||
        sites.selectionVersion !== selectionVersion || (profileId && sites.activeByProfile[profileId] !== siteId)) return;
      if (profileId) {
        // Don't continue mirroring an unrelated fallback after a missing root.
        if (next !== candidate) useSites.getState().setBrowseSync(profileId, siteId, { enabled: false, base: null });
        useSites.getState().navigateLocal(profileId, siteId, next);
      } else setFallback(next);
      rememberSessionLocalPath(next);
      memory.current.update(next);
    })();
    return () => { cancelled = true; };
  }, [key, activeSessionId, loaded, legacyReady, selectionVersion]);

  useEffect(() => {
    const flush = async () => {
      await memory.current.flush();
      await useSites.getState().flushNavigation();
    };
    const unload = () => { void flush(); };
    window.addEventListener("beforeunload", unload);
    const win = getCurrentWindow() as {
      onCloseRequested?: (handler: () => Promise<void>) => Promise<() => void>;
    };
    let unlisten = () => {};
    let cancelled = false;
    if (win.onCloseRequested) {
      win.onCloseRequested(flush).then(fn => {
        if (cancelled) fn(); else unlisten = fn;
      }).catch(() => {});
    }
    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", unload);
      unlisten();
      void flush();
    };
  }, []);
  return [path, setLocalPath] as const;
}
