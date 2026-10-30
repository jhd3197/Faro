import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, Crosshair } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { LOCAL_SESSION } from "@/lib/types";
import { cn } from "@/lib/cn";
import {
  clearMatchingEcho,
  initialSyncState,
  rebaseSync,
  retargetSession,
  runMirror,
  toggleSync,
  type Side,
  type SyncHint,
  type SyncState,
} from "@/lib/syncBrowse";

/**
 * Keep the local and remote panes on the same relative folder.
 *
 * Navigation on either side lists the counterpart and, only when that listing
 * succeeds, moves the other pane. A missing folder, a permission error, or a
 * dropped connection leaves the other pane where it is and shows a status
 * hint — never a dialog, and never a transfer.
 */
export function useSyncedPanes(args: {
  sessionId: string | null;
  localPath: string;
  remotePath: string;
  setLocalPath: (path: string) => void;
  setRemotePath: (path: string) => void;
  defaultLocalPath?: string;
}) {
  const stateRef = useRef<SyncState>(initialSyncState());
  const argsRef = useRef(args);
  argsRef.current = args;
  const [enabled, setEnabled] = useState(false);
  const [hint, setHint] = useState<SyncHint | null>(null);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const sessionSeen = useRef(args.sessionId);

  const showHint = useCallback((next: SyncHint) => {
    setHint(next);
    if (hintTimer.current) clearTimeout(hintTimer.current);
    hintTimer.current = setTimeout(() => setHint(null), 4500);
  }, []);

  useEffect(() => () => {
    if (hintTimer.current) clearTimeout(hintTimer.current);
  }, []);

  // Switching servers re-bases onto the folders open on the new connection
  // (after a Default local path has landed) instead of replaying the previous
  // server's offset. Wait one frame when that default hasn't been applied yet.
  useEffect(() => {
    if (sessionSeen.current === args.sessionId) return;
    const expected = args.defaultLocalPath;
    if (expected && args.localPath !== expected) return;
    sessionSeen.current = args.sessionId;
    stateRef.current = retargetSession(
      stateRef.current,
      args.sessionId,
      args.localPath,
      args.remotePath
    );
  }, [args.sessionId, args.localPath, args.remotePath, args.defaultLocalPath]);

  const follow = useCallback((side: Side, path: string) => {
    const current = argsRef.current;
    const otherPath = side === "local" ? current.remotePath : current.localPath;
    const otherSession = () => {
      const live = argsRef.current;
      return side === "local" ? live.sessionId : LOCAL_SESSION;
    };
    void runMirror({
      getState: () => stateRef.current,
      setState: (next) => {
        stateRef.current = next;
      },
      side,
      path,
      otherPath,
      listDirectory: async (counterpart) => {
        const sessionId = otherSession();
        if (!sessionId) throw new Error("no connection");
        // Existence probe only. The file panes do their own listing after a move.
        await ipc.listDirectory(sessionId, counterpart);
      },
    }).then((result) => {
      if (result.stale) return;
      if (result.hint) showHint(result.hint);
      if (!result.apply) return;
      const applied = result.apply;
      const echo = stateRef.current.echo;
      if (applied.side === "local") argsRef.current.setLocalPath(applied.path);
      else argsRef.current.setRemotePath(applied.path);
      queueMicrotask(() => {
        stateRef.current = clearMatchingEcho(stateRef.current, echo);
      });
    });
  }, [showHint]);

  const onLocalNavigate = useCallback((path: string) => {
    argsRef.current.setLocalPath(path);
    follow("local", path);
  }, [follow]);

  const onRemoteNavigate = useCallback((path: string) => {
    argsRef.current.setRemotePath(path);
    follow("remote", path);
  }, [follow]);

  const toggle = useCallback(() => {
    const current = argsRef.current;
    if (!current.sessionId) return;
    const next = !stateRef.current.enabled;
    stateRef.current = toggleSync(
      stateRef.current,
      next,
      current.localPath,
      current.remotePath,
      current.sessionId
    );
    setEnabled(next);
    setHint(null);
  }, []);

  const rebase = useCallback(() => {
    const current = argsRef.current;
    if (!current.sessionId || !stateRef.current.enabled) return;
    stateRef.current = rebaseSync(
      stateRef.current,
      current.localPath,
      current.remotePath,
      current.sessionId
    );
    showHint({
      title: "Synchronized base updated",
      message: "Both panes now mirror relative folders from the directories that are open.",
    });
  }, [showHint]);

  const toolbar = currentSessionId(args.sessionId) ? (
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
