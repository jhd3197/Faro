import { useEffect, useRef, useState } from "react";
import { FilePane } from "@faro/file-ui";
import { SyncDialog } from "./SyncDialog";
import { NoConnections } from "./NoConnections";
import { useConnections } from "@/stores/connectionsStore";
import { useCopyJobs } from "@/stores/copyStore";
import { useMounts } from "@/stores/mountStore";
import { useIndex } from "@/stores/indexStore";
import { useTransfers, toTransferItem } from "@/stores/transfersStore";
import { useLayout } from "@/stores/layoutStore";
import { useSession } from "@/stores/sessionStore";
import { usePanelSizes } from "@/stores/panelSizesStore";
import { COLLAPSE_AT, EXPAND_AT, PANEL_TRANSITION_MS, STRIP_SIZE, startResizeDrag } from "@/hooks/useResizable";
import { CollapsedStrip } from "./ResizablePanel";
import { LOCAL_SESSION } from "@/lib/types";
import type { DirEntry } from "@/lib/types";
import { ArrowRightLeft } from "lucide-react";
import { useSiteBrowser } from "@/hooks/useSiteBrowser";
import { useRememberedLocalPath } from "@/hooks/useRememberedLocalPath";
import { useSyncedPanes } from "@/hooks/useSyncedPanes";

type Side = "local" | "remote";

function currentCollapsedSide(): Side | null {
  const p = usePanelSizes.getState().panels;
  return p["dual.local"]?.collapsed ? "local" : p["dual.remote"]?.collapsed ? "remote" : null;
}

export function DualPaneBrowser() {
  const containerRef = useRef<HTMLDivElement>(null);
  // The split is part of the restored session (persisted, clamped 0.2–0.8).
  const splitRatio = useSession((s) => s.snapshot.splitRatio);
  const resize = (ratio: number) => useSession.getState().setSplitRatio(ratio);
  // Either side can be dragged shut into a labelled strip; the ratio is kept
  // so it reopens where it was.
  const localCollapsed = usePanelSizes((s) => !!s.panels["dual.local"]?.collapsed);
  const remoteCollapsed = usePanelSizes((s) => !!s.panels["dual.remote"]?.collapsed);
  const panelsReady = usePanelSizes((s) => s.ready);
  const collapsed: Side | null = localCollapsed ? "local" : remoteCollapsed ? "remote" : null;
  const setCollapsed = (side: Side | null) => {
    const p = usePanelSizes.getState();
    p.setCollapsed("dual.local", side === "local");
    p.setCollapsed("dual.remote", side === "remote");
  };
  const [dragging, setDragging] = useState(false);

  // Drag the divider (or a collapsed strip). Positions are px from the
  // container's left edge; within COLLAPSE_AT of an edge that side folds into
  // a strip, and it takes EXPAND_AT to pull it back out.
  const beginDrag = (e: React.PointerEvent<Element>, onClick?: () => void) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 1) return;
    const width = bounds.width - 1;
    const shown = collapsed === "local" ? STRIP_SIZE
      : collapsed === "remote" ? width - STRIP_SIZE
      : splitRatio * width;
    const offset = e.clientX - bounds.left - shown;
    let side = collapsed;
    if (e.currentTarget.getAttribute("role") === "separator") (e.currentTarget as HTMLElement).focus();
    startResizeDrag(e, {
      axis: "x",
      onStart: () => setDragging(true),
      onMove: (_delta, ev) => {
        const x = ev.clientX - bounds.left - offset;
        const fromRight = width - x;
        if (side === "local") { if (x >= EXPAND_AT) side = null; }
        else if (side === "remote") { if (fromRight >= EXPAND_AT) side = null; }
        else if (x < COLLAPSE_AT) side = "local";
        else if (fromRight < COLLAPSE_AT) side = "remote";
        if (side !== currentCollapsedSide()) setCollapsed(side);
        if (!side) resize(x / width);
      },
      onEnd: (moved) => {
        setDragging(false);
        if (!moved) onClick?.();
      },
    });
  };
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

  // A collapsed side is a fixed strip and the other takes the rest. Flex
  // changes animate (collapse, expand, keyboard steps) except mid-drag.
  const paneStyle = (side: Side): React.CSSProperties => ({
    flex: collapsed === side ? `0 0 ${STRIP_SIZE}px`
      : collapsed ? "1 1 0%"
      : `${side === "local" ? splitRatio : 1 - splitRatio} 1 0%`,
    transition: dragging ? undefined : `flex ${PANEL_TRANSITION_MS}ms ease`,
  });

  // Wait for the saved collapsed state so a folded pane doesn't flash open.
  if (!panelsReady) return null;

  return (
    <div ref={containerRef} className="relative flex h-full min-w-0 flex-1">
      <div className="flex min-w-0 overflow-hidden" style={paneStyle("local")}>
        {collapsed === "local" && (
          <CollapsedStrip label="Local" axis="x" onExpand={() => setCollapsed(null)} onPointerDown={(e) => beginDrag(e, () => setCollapsed(null))} />
        )}
        <div className={collapsed === "local" ? "hidden" : "flex min-w-0 flex-1"}>
        <FilePane
          paneId="local"
          title="Local"
          sessionId={LOCAL_SESSION}
          path={localPath}
          onPathChange={sync.onLocalNavigate}
          onTransfer={uploadAll}
          onDrop={downloadAll}
          transferLabel="Upload"
          onCopyTo={(entries) => useCopyJobs.getState().openCopyTo(LOCAL_SESSION, entries)}
          toolbarActions={sync.toolbar}
        />
        </div>
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
          onPointerDown={beginDrag}
          onDoubleClick={() => { setCollapsed(null); resize(0.5); }}
          onKeyDown={(e) => {
            const ratio = e.key === "ArrowLeft" ? splitRatio - 0.05
              : e.key === "ArrowRight" ? splitRatio + 0.05
              : e.key === "Home" ? 0.2
              : e.key === "End" ? 0.8
              : e.key === "Enter" ? 0.5 : null;
            if (ratio === null) return;
            e.preventDefault();
            setCollapsed(null);
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
      <div className="flex min-w-0 overflow-hidden" style={paneStyle("remote")}>
        {collapsed === "remote" && (
          <CollapsedStrip label="Remote" axis="x" onExpand={() => setCollapsed(null)} onPointerDown={(e) => beginDrag(e, () => setCollapsed(null))} />
        )}
        <div className={collapsed === "remote" ? "hidden" : "flex min-w-0 flex-1"}>
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
          onCopyTo={activeSessionId ? (entries) => useCopyJobs.getState().openCopyTo(activeSessionId, entries) : undefined}
          onIndexFolder={activeSessionId ? (p) => void useIndex.getState().indexFolder(activeSessionId, p) : undefined}
          onEditTags={activeSessionId ? (entries) => { const pid = useConnections.getState().sessions.find((x) => x.sessionId === activeSessionId)?.profileId; if (pid) useIndex.getState().openTags({ connectionId: pid, paths: entries.map((e) => e.path) }); } : undefined}
          onMountFolder={activeSessionId && useMounts.getState().supported ? (p) => { const pid = useConnections.getState().sessions.find((x) => x.sessionId === activeSessionId)?.profileId; if (pid) useMounts.getState().open({ profileId: pid, remoteRoot: p }); } : undefined}
          toolbarActions={activeSessionId ? siteBrowser.toolbar : undefined}
        />}
        </div>
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
