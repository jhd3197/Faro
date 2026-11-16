import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link2, Crosshair } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { LOCAL_SESSION } from "@/lib/types";
import { cn } from "@/lib/cn";
import { useConnections } from "@/stores/connectionsStore";
import { browserLocationKey, useSites } from "@/stores/sitesStore";
import {
  clearMatchingEcho, initialSyncState, rebaseSync, runMirror, toggleSync,
  type Side, type SyncHint,
} from "@/lib/syncBrowse";

/** Navigation only: a persisted base per profile/site, with each asynchronous
 * probe owned by one selection and connection lifetime. Never transfers files. */
export function useSyncedPanes(args: {
  profileId?: string;
  siteId?: string;
  sessionId: string | null;
  localPath: string;
  remotePath: string;
  setLocalPath: (path: string) => void;
  setRemotePath: (path: string) => void;
}) {
  const key = args.profileId ? browserLocationKey(args.profileId, args.siteId) : null;
  const saved = useSites(s => key ? s.syncPairs[key] : undefined);
  const loaded = useSites(s => s.loaded);
  const selectionVersion = useSites(s => s.selectionVersion);
  const connectionProfileId = useConnections(s => s.activeProfileId);
  const [lifetime, setLifetime] = useState(0);
  const runtime = useMemo(() => ({
    active: true,
    state: loaded && saved?.enabled && saved.base && args.sessionId
      ? toggleSync(initialSyncState(), true, saved.base.local, saved.base.remote, args.sessionId)
      : initialSyncState(),
  }), [key, args.sessionId, connectionProfileId, saved, loaded, selectionVersion, lifetime]);
  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const argsRef = useRef(args);
  argsRef.current = args;
  const enabled = !!saved?.enabled;
  const [notice, setNotice] = useState<{ owner: typeof runtime; value: SyncHint } | null>(null);
  const hint = notice?.owner === runtime ? notice.value : null;
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const isCurrent = useCallback(() => {
    const sites = useSites.getState();
    const connections = useConnections.getState();
    return runtime.active && runtimeRef.current === runtime &&
      connections.activeSessionId === args.sessionId && connections.activeProfileId === connectionProfileId &&
      sites.selectionVersion === selectionVersion &&
      (!args.profileId || sites.activeByProfile[args.profileId] === args.siteId) &&
      (!key || sites.syncPairs[key] === saved);
  }, [runtime, args.sessionId, connectionProfileId, args.profileId, args.siteId, selectionVersion, key, saved]);

  useEffect(() => {
    runtime.active = true;
    // Synchronous subscriptions also invalidate A -> B -> A transitions made
    // before React has rendered B. Equality with A again cannot revive a probe.
    const invalidate = () => {
      if (runtime.active && !isCurrent()) {
        runtime.active = false;
        setLifetime(n => n + 1);
      }
    };
    const offSites = useSites.subscribe(invalidate);
    const offConnections = useConnections.subscribe(invalidate);
    return () => { runtime.active = false; offSites(); offConnections(); };
  }, [runtime, isCurrent]);
  useEffect(() => () => { if (hintTimer.current) clearTimeout(hintTimer.current); }, []);

  const showHint = useCallback((next: SyncHint) => {
    setNotice({ owner: runtime, value: next });
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setNotice(null), 4500);
  }, [runtime]);

  const follow = useCallback((side: Side, path: string) => {
    if (!isCurrent()) return;
    const current = argsRef.current;
    void runMirror({
      getState: () => runtime.state,
      setState: next => { runtime.state = next; },
      side, path,
      otherPath: side === "local" ? current.remotePath : current.localPath,
      listDirectory: async counterpart => {
        const sessionId = side === "local" ? current.sessionId : LOCAL_SESSION;
        if (!sessionId) throw new Error("no connection");
        await ipc.listDirectory(sessionId, counterpart);
      },
    }).then(result => {
      if (!isCurrent() || result.stale) return;
      if (result.hint) showHint(result.hint);
      if (!result.apply) return;
      const echo = runtime.state.echo;
      if (result.apply.side === "local") current.setLocalPath(result.apply.path);
      else current.setRemotePath(result.apply.path);
      queueMicrotask(() => { runtime.state = clearMatchingEcho(runtime.state, echo); });
    });
  }, [runtime, isCurrent, showHint]);

  const onLocalNavigate = useCallback((path: string) => {
    if (!isCurrent()) return;
    argsRef.current.setLocalPath(path);
    follow("local", path);
  }, [follow, isCurrent]);
  const onRemoteNavigate = useCallback((path: string) => {
    if (!isCurrent()) return;
    argsRef.current.setRemotePath(path);
    follow("remote", path);
  }, [follow, isCurrent]);

  const save = () => {
    if (!args.profileId) return;
    const { enabled, base } = runtime.state;
    useSites.getState().setBrowseSync(args.profileId, args.siteId, {
      enabled, base: base ? { local: base.local, remote: base.remote } : null,
    });
  };
  const toggle = () => {
    const current = argsRef.current;
    if (!isCurrent() || !current.profileId || !current.sessionId || !loaded) return;
    runtime.state = toggleSync(runtime.state, !runtime.state.enabled, current.localPath, current.remotePath, current.sessionId);
    save();
    setNotice(null);
  };
  const rebase = () => {
    const current = argsRef.current;
    if (!isCurrent() || !current.sessionId || !runtime.state.enabled) return;
    runtime.state = rebaseSync(runtime.state, current.localPath, current.remotePath, current.sessionId);
    save();
  };

  const toolbar = args.profileId && currentSessionId(args.sessionId) ? (
    <>
      <button
        type="button"
        onClick={toggle}
        aria-pressed={enabled}
        aria-label="Synchronized browsing"
        data-sync-browse={enabled ? "on" : "off"}
        title={
          enabled
            ? "Synchronized browsing is on — click to browse each pane independently"
            : "Synchronized browsing — keep both panes on the same relative folder"
        }
        className={cn(
          "flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
          enabled
            ? "bg-accent-soft text-accent"
            : "text-text-muted hover:bg-bg-hover hover:text-text"
        )}
      >
        <Link2 size={12} />
        {enabled ? "Synced" : "Sync browse"}
      </button>
      {enabled && (
        <button
          type="button"
          onClick={rebase}
          aria-label="Re-base synchronized browsing"
          title="Use these folders as the synchronized base"
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"
        >
          <Crosshair size={13} />
        </button>
      )}
    </>
  ) : null;

  return { enabled, hint, toolbar, onLocalNavigate, onRemoteNavigate, toggle, rebase };
}

function currentSessionId(sessionId: string | null): sessionId is string {
  return !!sessionId;
}
