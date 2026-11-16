import { useEffect, useRef, useState } from "react";
import { FilePane } from "@faro/file-ui";
import { SyncDialog } from "./SyncDialog";
import { NoConnections } from "./NoConnections";
import { useConnections } from "@/stores/connectionsStore";
import { useTransfers, toTransferItem } from "@/stores/transfersStore";
import { useLayout } from "@/stores/layoutStore";
import { LOCAL_SESSION } from "@/lib/types";
import type { DirEntry } from "@/lib/types";
import { ArrowRightLeft } from "lucide-react";
import { useSiteBrowser } from "@/hooks/useSiteBrowser";
import { useRememberedLocalPath } from "@/hooks/useRememberedLocalPath";
import { useSyncedPanes } from "@/hooks/useSyncedPanes";

export function DualPaneBrowser() {
  const containerRef = useRef<HTMLDivElement>(null);
  const dragOffset = useRef<number | null>(null);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const resize = (ratio: number) => setSplitRatio(Math.min(0.8, Math.max(0.2, ratio)));
  const activeSessionId = useConnections((s) => s.activeSessionId);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const profiles = useConnections((s) => s.profiles);
  const profile = profiles.find((p) => p.id === activeProfileId) || null;
  const enqueueUploads = useTransfers((s) => s.enqueueUploads);
  const enqueueDownloads = useTransfers((s) => s.enqueueDownloads);

  const [localPath, setLocalPath] = useRememberedLocalPath(profile, activeSessionId);
  const siteBrowser = useSiteBrowser(profile);
  const [syncOpen, setSyncOpen] = useState(false);
  const sync = useSyncedPanes({
    profileId: profile?.id,
    siteId: siteBrowser.site?.id,
    sessionId: activeSessionId,
    localPath,
    remotePath: siteBrowser.path,
    setLocalPath,
    setRemotePath: siteBrowser.setPath,
  });

  const remotePath = siteBrowser.path;

  // "Reveal in browser" from the Disk Usage explorer. Local targets go to the
  // local pane; a matching server target updates that session's remote pane.
  // Routed through the sync handlers so an enabled mirror follows along.
  const revealTarget = useLayout((s) => s.revealTarget);
  const clearReveal = useLayout((s) => s.clearReveal);
  useEffect(() => {
    if (!revealTarget) return;
    if (revealTarget.sessionId === LOCAL_SESSION) {
      sync.onLocalNavigate(revealTarget.path);
      clearReveal();
    } else if (revealTarget.sessionId === activeSessionId) {
      sync.onRemoteNavigate(revealTarget.path);
      clearReveal();
    }
  }, [revealTarget, activeSessionId, clearReveal, sync.onLocalNavigate, sync.onRemoteNavigate]);

  const uploadAll = (entries: DirEntry[]) => {
    if (!activeSessionId) return;
    enqueueUploads(activeSessionId, entries.map(toTransferItem), remotePath).catch(
      () => {}
    );
  };

  const downloadAll = (entries: DirEntry[]) => {
    if (!activeSessionId) return;
    enqueueDownloads(activeSessionId, entries.map(toTransferItem), localPath).catch(
      () => {}
    );
  };

  return (
    <div ref={containerRef} className="relative flex h-full min-w-0 flex-1">
      <div className="flex min-w-0 overflow-hidden" style={{ flex: `${splitRatio} 1 0%` }}>
        <FilePane
          paneId="local"
          title="Local"
          sessionId={LOCAL_SESSION}
          path={localPath}
          onPathChange={sync.onLocalNavigate}
          onTransfer={uploadAll}
          onDrop={downloadAll}
          transferLabel="Upload"
          toolbarActions={sync.toolbar}
        />
      </div>
      <div className="relative w-px shrink-0 bg-border">
        <div
          role="separator"
          aria-label="Resize file browser panes"
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={Math.round(splitRatio * 100)}
          tabIndex={0}
          title="Drag to resize panes; double-click to reset"
          className="absolute inset-y-0 -left-1 z-20 w-[9px] touch-none cursor-col-resize select-none hover:bg-accent/30 focus-visible:bg-accent/30 focus-visible:outline-none"
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary) return;
            e.preventDefault();
            const bounds = containerRef.current?.getBoundingClientRect();
            if (!bounds) return;
            dragOffset.current = e.clientX - bounds.left - splitRatio * (bounds.width - 1);
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (dragOffset.current === null || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
            const bounds = containerRef.current?.getBoundingClientRect();
            if (bounds && bounds.width > 1) {
              resize((e.clientX - bounds.left - dragOffset.current) / (bounds.width - 1));
            }
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
            dragOffset.current = null;
          }}
          onPointerCancel={() => { dragOffset.current = null; }}
          onLostPointerCapture={() => { dragOffset.current = null; }}
          onDoubleClick={() => setSplitRatio(0.5)}
          onKeyDown={(e) => {
            const ratio = e.key === "ArrowLeft" ? splitRatio - 0.05
              : e.key === "ArrowRight" ? splitRatio + 0.05
              : e.key === "Home" ? 0.2
              : e.key === "End" ? 0.8
              : e.key === "Enter" ? 0.5 : null;
            if (ratio === null) return;
            e.preventDefault();
            resize(ratio);
          }}
        />
        {activeSessionId && (
          // Centering lives on the wrapper so the button keeps its own
          // transform for the press-scale (button:active scale would otherwise
          // wipe out a -translate centering and make it jump on click).
          <div className="absolute left-1/2 top-1/2 z-raised -translate-x-1/2 -translate-y-1/2">
            <button
              onClick={() => setSyncOpen(true)}
              title="Sync folders"
              aria-label="Sync folders"
              className="flex h-7 w-7 items-center justify-center rounded-full border border-border bg-bg-subtle text-text-muted shadow-elev-1 hover:border-accent hover:bg-accent-soft hover:text-accent hover:shadow-elev-2"
            >
              <ArrowRightLeft size={13} />
            </button>
          </div>
        )}
      </div>
      <div className="flex min-w-0 overflow-hidden" style={{ flex: `${1 - splitRatio} 1 0%` }}>
        {profiles.length === 0 && !activeSessionId ? <NoConnections /> : <FilePane
          paneId="remote"
          key={`${activeSessionId}:${siteBrowser.site?.id ?? "server"}`}
          title={siteBrowser.site?.name ?? (profile ? `Remote — ${profile.name}` : "Remote")}
          sessionId={activeSessionId}
          path={remotePath}
          onPathChange={sync.onRemoteNavigate}
          onTransfer={downloadAll}
          onDrop={uploadAll}
          transferLabel="Download"
          onSaveSite={activeSessionId ? siteBrowser.saveSite : undefined}
          toolbarActions={activeSessionId ? siteBrowser.toolbar : undefined}
        />}
      </div>
      {siteBrowser.dialog}

      {sync.hint && (
        <div
          role="status"
          aria-live="polite"
          data-sync-hint=""
          className="pointer-events-none absolute bottom-3 left-1/2 z-raised max-w-md -translate-x-1/2 rounded-md border border-border bg-bg-panel px-3 py-1.5 text-center text-xs text-text shadow-elev-2"
        >
          <span className="font-medium">{sync.hint.title}.</span> {sync.hint.message}
        </div>
      )}

      {syncOpen && activeSessionId && (
        <SyncDialog
          localPath={localPath}
          remotePath={remotePath}
          onClose={() => setSyncOpen(false)}
        />
      )}
    </div>
  );
}
