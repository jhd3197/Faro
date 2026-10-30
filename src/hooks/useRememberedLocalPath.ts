import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ipc } from "@/lib/ipc";
import { LOCAL_SESSION, type ConnectionProfile } from "@/lib/types";
import {
  LAST_LOCAL_PATH_KEY,
  createLocalPathMemory,
  initialLocalPath,
  injectedLastLocalPath,
  osRoot,
  parseStoredLocalPath,
  peekSessionLocalPath,
  rememberSessionLocalPath,
  resolveLaunchLocalPath,
} from "@/lib/localFolder";

const PERSIST_MS = 300;

/**
 * Local pane path that survives a restart.
 *
 * Precedence: a connection's Default local path, then the remembered folder
 * when it can be listed, then the OS root. An unreadable remembered folder
 * falls back silently — no dialog, no toast. Site shortcuts are not local
 * paths and are left to the remote pane.
 */
export function useRememberedLocalPath(
  profile: ConnectionProfile | null,
  activeSessionId: string | null
): readonly [string, (path: string) => void] {
  const [path, setPath] = useState(() => initialLocalPath());
  const navEpoch = useRef(0);
  const readyToPersist = useRef(false);
  const memory = useRef(createLocalPathMemory((next) => {
    return ipc.settingsSet(LAST_LOCAL_PATH_KEY, JSON.stringify(next)).catch(() => {});
  }, PERSIST_MS));

  const profileRef = useRef(profile);
  profileRef.current = profile;

  const setLocalPath = useCallback((next: string) => {
    navEpoch.current += 1;
    readyToPersist.current = true;
    rememberSessionLocalPath(next);
    setPath(next);
  }, []);

  // Default local path wins whenever that connection is the one in front,
  // including on the launch that also restored a remembered folder.
  useEffect(() => {
    if (profile?.defaultLocalPath) setLocalPath(profile.defaultLocalPath);
  }, [activeSessionId, profile?.id, profile?.defaultLocalPath, setLocalPath]);

  // Once per mount. A later navigation (or a Default local path) bumps
  // navEpoch and this probe will not overwrite it. Re-running on profile
  // changes would pull the pane back to the remembered folder.
  useEffect(() => {
    let cancelled = false;
    const epoch = navEpoch.current;
    (async () => {
      if (profileRef.current?.defaultLocalPath) {
        readyToPersist.current = true;
        return;
      }
      let remembered = peekSessionLocalPath() ?? injectedLastLocalPath();
      if (!remembered) {
        const stored = await ipc.settingsGetAll().catch(() => ({}) as Record<string, string>);
        remembered = parseStoredLocalPath(stored[LAST_LOCAL_PATH_KEY]);
      }
      if (cancelled || navEpoch.current !== epoch || profileRef.current?.defaultLocalPath) {
        readyToPersist.current = true;
        return;
      }
      if (!remembered) {
        readyToPersist.current = true;
        return;
      }
      let accessible = false;
      try {
        await ipc.listDirectory(LOCAL_SESSION, remembered);
        accessible = true;
      } catch {
        accessible = false;
      }
      if (cancelled || navEpoch.current !== epoch || profileRef.current?.defaultLocalPath) return;
      const next = resolveLaunchLocalPath({
        remembered,
        rememberedAccessible: accessible,
        osRoot: osRoot(),
      });
      readyToPersist.current = true;
      rememberSessionLocalPath(next);
      setPath(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!readyToPersist.current) return;
    memory.current.update(path);
  }, [path]);

  useEffect(() => {
    const flush = () => {
      void memory.current.flush();
    };
    window.addEventListener("beforeunload", flush);
    // Wait for the write on a real window close. The mock window has no
    // close listener; beforeunload still covers that build.
    const win = getCurrentWindow() as {
      onCloseRequested?: (handler: () => Promise<void>) => Promise<() => void>;
    };
    let unlisten = () => {};
    let cancelled = false;
    if (win.onCloseRequested) {
      win.onCloseRequested(() => memory.current.flush()).then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      }).catch(() => {});
    }
    return () => {
      cancelled = true;
      window.removeEventListener("beforeunload", flush);
      unlisten();
      flush();
    };
  }, []);

  return [path, setLocalPath] as const;
}
