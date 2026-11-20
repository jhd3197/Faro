import { UploadReports } from "./components/UploadReports";
import { DiscoveryDialog } from "./components/DiscoveryDialog";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { TipStrip } from "./components/TipStrip";
import { useDiscovery } from "./stores/discoveryStore";
import { NativeFileDrop } from "./components/NativeFileDrop";
import { useEffect, useRef, useState } from "react";
import { ServerRail } from "./components/ServerRail";
import { DualPaneBrowser } from "./components/DualPaneBrowser";
import { FileBrowser } from "./components/FileBrowser";
import { FileUiBridge } from "./components/FileUiBridge";
import { TerminalDock } from "./components/Terminal";
import { TransferQueue } from "./components/TransferQueue";
import { ResizablePanel } from "./components/ResizablePanel";
import { Settings } from "./components/Settings";
import { HostKeyModal } from "./components/HostKeyModal";
import { AuthPromptModal } from "./components/AuthPromptModal";
import { TitleBar } from "./components/TitleBar";
import { ProfileEditor } from "./components/ProfileEditor";
import { CloudflareConnectSheet, useCfConnect } from "./components/CloudflareConnectSheet";
import { ConnectionCheckDialog } from "./components/ConnectionCheckDialog";
import { GrantDialog } from "./components/GrantDialog";
import { ImportDialog } from "./components/ImportDialog";
import { ExportDialog } from "./components/ExportDialog";
import { InviteDialog } from "./components/InviteDialog";
import { MoveToCloudflareDialog } from "./components/MoveToCloudflareDialog";
import { AboutDialog } from "./components/AboutDialog";
import { useConnections } from "./stores/connectionsStore";
import { useTransfers } from "./stores/transfersStore";
import { useLayout } from "./stores/layoutStore";
import { SETTINGS_ENTRY_POINTS } from "./lib/settingsNav";
import {
  TerminalSquare,
  Activity,
  ArrowDownUp,
  Wifi,
  WifiOff,
  Edit3,
  X,
  Bell,
  CheckCircle2,
  AlertCircle,
  Info,
  AlertTriangle,
  Radio,
  Columns2,
  FolderSync,
  ArrowUpCircle,
} from "lucide-react";
import { useEditor } from "./stores/editorStore";
import { followToastAction, toast, toastDetails, unseenErrors, useToasts, type Toast, type ToastVariant } from "./stores/toastStore";
import { CopyTextButton, notificationText } from "./components/ui/CopyText";
import { useBridge } from "./stores/bridgeStore";
import { useSync } from "./stores/syncStore";
import { useSettings } from "./stores/settingsStore";
import { ipc, onDeepLink } from "./lib/ipc";
import { runDefaultBumps, runSettingsMigration } from "./lib/secretMigration";
import { initNotifications } from "./lib/notifications";
import { openTerminalWindow } from "./lib/popout";
import { cleanRemotePath, matchLinkProfile, sameRemotePath, siteNameFor } from "./lib/deepLinkMatch";
import { showLinkTarget } from "./lib/linkTarget";
import { useSites } from "./stores/sitesStore";
import type { DeepLink, Protocol, ConnectionProfile } from "./lib/types";
import { PROTOCOL_DEFAULT_PORT } from "./lib/types";
import { Toaster } from "./components/ui/Toaster";
import { Popover } from "./components/ui/Popover";
import { OverwriteDialogHost } from "./components/OverwriteModal";
import { CommandPalette } from "./components/CommandPalette";
import { KeyboardShortcutsDialog } from "./components/KeyboardShortcutsDialog";
import { AgentBridgeHost } from "./components/AgentBridge";
import { AgentBridgePage } from "./components/AgentBridgePage";
import { AgentConsoleDock } from "./components/AgentConsole";
import { AgentDrawer } from "./components/AgentDrawer";
import { DiskUsageHost } from "./components/DiskUsage";
import { ServerViewHost } from "./components/ServerView";
import { useServerView } from "./stores/serverViewStore";
import { useDiskScan } from "./stores/diskScanStore";
import { DirectoryDiffHost } from "./components/DirectoryDiff";
import { FindDuplicatesHost } from "./components/FindDuplicates";
import { FleetSearchHost } from "./components/FleetSearch";
import { SkillsHost } from "./components/SkillsPanel";
import { SnippetsHost } from "./components/SnippetsPanel";
import { useShortcuts } from "./hooks/useShortcuts";
import { useResolvedCommands } from "./lib/keybindings";
import { formatCombo } from "./lib/shortcuts";
import { toggleZen } from "./lib/windowMode";
import { relTime } from "./lib/format";
import { cn } from "./lib/cn";
import { QuitGate } from "./components/QuitGate";
import { useSession } from "./stores/sessionStore";

export default function App() {
  const activeSessionId = useConnections((s) => s.activeSessionId);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const profiles = useConnections((s) => s.profiles);
  const activeProfile = profiles.find((p) => p.id === activeProfileId);
  const supportsTerminal = activeProfile?.protocol === "sftp";

  // Containers the docked panels measure against (their size caps).
  const columnRef = useRef<HTMLDivElement>(null);
  const workRowRef = useRef<HTMLDivElement>(null);
  const terminalOpen = useLayout((s) => s.terminalOpen);
  const toggleTerminal = useLayout((s) => s.toggleTerminal);
  const terminalVisible = !!activeSessionId && terminalOpen && supportsTerminal;
  const consoleOpen = useLayout((s) => s.consoleOpen);
  const agentDrawerOpen = useLayout((s) => s.agentDrawerOpen);
  const zen = useLayout((s) => s.zen);
  const browserLayout = useSettings((s) => s.browserLayout);
  const dialog = useLayout((s) => s.dialog);
  const diskUsageOpen = useDiskScan((s) => s.open);
  const serverViewCovering = useServerView((s) => s.open);
  const workAreaCovered = dialog === "agentBridge" || diskUsageOpen || serverViewCovering;
  const closeDialog = useLayout((s) => s.closeDialog);
  const connectionPrefill = useLayout((s) => s.connectionPrefill);
  const exportRequest = useLayout((s) => s.exportRequest);
  const importFile = useLayout((s) => s.importFile);
  const inviteIds = useLayout((s) => s.inviteIds);
  const moveProfileId = useLayout((s) => s.moveProfileId);
  const togglePanel = useTransfers((s) => s.togglePanel);
  const transferPanelOpen = useTransfers((s) => s.panelOpen);
  const activeTransfers = useTransfers((s) =>
    Object.values(s.byId).filter(
      (t) => t.status === "transferring" || t.status === "queued"
    ).length
  );
  const [editsMenuOpen, setEditsMenuOpen] = useState(false);

  useShortcuts();

  useEffect(() => { void useDiscovery.getState().init(); }, []);

  // Pick up where the last run left off (focused server, split, Settings
  // section). Saving the session snapshot starts only after this finishes.
  useEffect(() => { void useSession.getState().restore(); }, []);

  // Boot the Folder Sync store: fetch the current pairs and attach the
  // "foldersync://changed" listener so background syncs keep the UI live.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    useSync
      .getState()
      .init()
      .then((c) => {
        if (cancelled) c();
        else cleanup = c;
      });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  // One-time migration of app settings from localStorage into faro.db (Plan 12),
  // then any defaults that changed since this install first wrote its rows —
  // in that order, so the bumps apply on top of the imported values.
  useEffect(() => {
    void runSettingsMigration().then(runDefaultBumps);
  }, []);

  // Saved passwords/passphrases the keychain refused at launch: those profiles
  // run without their secret until restart, so say which ones.
  useEffect(() => {
    ipc
      .profileKeychainWarnings()
      .then((names) => {
        if (names.length)
          toast.warning(
            "Some saved passwords couldn't be read",
            `Keychain access failed for: ${names.join(", ")}. Restart Faro after fixing keychain access.`,
          );
      })
      .catch(() => {});
  }, []);

  // Desktop notifications (Plan 16 Phase 3): OS toasts for the curated events
  // (transfer batch done/failed, folder-sync error, edit-in-place save failure),
  // gated by the `notifications` setting + window focus.
  useEffect(() => {
    const cleanup = initNotifications();
    return cleanup;
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col">
      {zen ? <ZenExit /> : <TitleBar />}
      <DeepLinkListener />
      {(dialog === "welcome" || dialog === "whatsNew") && (
        <ErrorBoundary region={dialog === "welcome" ? "Welcome" : "What's new"} className="fixed inset-0 z-modal bg-black/60">
          <DiscoveryDialog key={dialog} mode={dialog} />
        </ErrorBoundary>
      )}
      {dialog === "settings" && (
        <ErrorBoundary region="Settings" className="fixed inset-0 z-modal bg-black/60">
          <Settings onClose={closeDialog} />
        </ErrorBoundary>
      )}
      {dialog === "newConnection" && (
        <ProfileEditor
          profile={null}
          prefill={connectionPrefill}
          onClose={closeDialog}
        />
      )}
      {dialog === "import" && <ImportDialog key={importFile ?? ""} onClose={closeDialog} />}
      {dialog === "export" && <ExportDialog request={exportRequest} onClose={closeDialog} />}
      {dialog === "invite" && <InviteDialog ids={inviteIds} onClose={closeDialog} />}
      {dialog === "moveToCloudflare" && moveProfileId && (
        <MoveToCloudflareDialog profileId={moveProfileId} onClose={closeDialog} />
      )}
      {dialog === "grant" && <GrantDialog onClose={closeDialog} />}
      {dialog === "about" && <AboutDialog onClose={closeDialog} />}
      <CloudflareConnectSheet />
      <ConnectionCheckDialog />
      <HostKeyModal />
      <AuthPromptModal />
      <Toaster />
      <QuitGate />
      <AgentBridgeHost />
      <OverwriteDialogHost />
      <DirectoryDiffHost />
      <FindDuplicatesHost />
      <FleetSearchHost />
      <SkillsHost />
      <SnippetsHost />
      <CommandPalette />
      <KeyboardShortcutsDialog />
      <div className="flex flex-1 overflow-hidden">
        {!zen && <ServerRail />}
        <div ref={columnRef} className="flex min-w-0 flex-1 flex-col">
          <div ref={workRowRef} className="relative flex min-h-[160px] flex-1 overflow-hidden">
            {/* The Agent Bridge page covers the work area (panes stay mounted
                underneath so their paths survive opening it). */}
            {dialog === "agentBridge" && <AgentBridgePage onClose={closeDialog} />}
            <DiskUsageHost />
            <ErrorBoundary region="Server view" className="absolute inset-0 z-[6]">
              <ServerViewHost />
            </ErrorBoundary>
            {/* While a full-page view covers the work area, hide the panes:
                their own stacked controls (the split divider at z-raised)
                would otherwise draw and stay hoverable over the page. */}
            <div
              className={cn("min-w-0 flex-1 overflow-hidden", workAreaCovered && "invisible")}
              aria-hidden={workAreaCovered || undefined}
            >
              <ErrorBoundary region="File browser" className="h-full">
                <FileUiBridge>
                  {browserLayout === "dual" ? <DualPaneBrowser /> : <FileBrowser />}
                </FileUiBridge>
              </ErrorBoundary>
            </div>
            {agentDrawerOpen && !zen && (
              <ResizablePanel id="agentDrawer" label="Agent" axis="x" defaultSize={340} min={280} maxFraction={0.5} containerRef={workRowRef}>
                <AgentDrawer />
              </ResizablePanel>
            )}
          </div>
          {consoleOpen && !zen && (
            <ResizablePanel id="console" label="Agent console" axis="y" defaultSize={256} min={120} maxFraction={0.7} containerRef={columnRef}>
              <AgentConsoleDock />
            </ResizablePanel>
          )}
          {/* The terminal dock stays mounted even when hidden so background
              shells survive connection-tab switches and toggling it closed;
              visibility is CSS, not mount/unmount. */}
          <ResizablePanel
            id="terminal"
            label="Terminal"
            axis="y"
            defaultSize={288}
            min={120}
            maxFraction={0.75}
            containerRef={columnRef}
            hidden={!terminalVisible}
            keepMounted
          >
            <ErrorBoundary region="Terminal">
              <TerminalDock
                sessionId={supportsTerminal ? activeSessionId : null}
                visible={terminalVisible}
              />
            </ErrorBoundary>
          </ResizablePanel>
          <NativeFileDrop />
          <UploadReports />
          <TransferQueue containerRef={columnRef} />
          {!zen && <TipStrip />}
          {!zen && <StatusBar
            terminalOpen={terminalOpen && supportsTerminal}
            onToggleTerminal={toggleTerminal}
            terminalAvailable={supportsTerminal}
            transferPanelOpen={transferPanelOpen}
            onToggleTransfers={togglePanel}
            activeTransfers={activeTransfers}
            editsMenuOpen={editsMenuOpen}
            onToggleEditsMenu={() => setEditsMenuOpen((v) => !v)}
            onCloseEditsMenu={() => setEditsMenuOpen(false)}
          />}
        </div>
      </div>
    </div>
  );
}

// Zen mode hides the title bar, so a thin strip along the top edge reveals a
// way back out on hover (the shortcut works too).
function ZenExit() {
  const commands = useResolvedCommands();
  const combo = commands.find((c) => c.id === "toggle-zen")?.combo;
  return (
    <div className="group fixed inset-x-0 top-0 z-50 flex h-3 justify-center hover:h-10">
      <button
        onClick={() => void toggleZen()}
        className="mt-1.5 hidden h-7 items-center gap-2 rounded-md border border-border bg-bg-panel px-3 text-[12px] text-text-muted shadow-elev-2 hover:text-text group-hover:flex"
      >
        Leave Zen mode
        {combo && (
          <kbd className="rounded border border-border px-1 font-mono text-[10px] text-text-dim">
            {formatCombo(combo)}
          </kbd>
        )}
      </button>
    </div>
  );
}

function StatusBar({
  terminalOpen,
  onToggleTerminal,
  terminalAvailable,
  transferPanelOpen,
  onToggleTransfers,
  activeTransfers,
  editsMenuOpen,
  onToggleEditsMenu,
  onCloseEditsMenu,
}: {
  terminalOpen: boolean;
  onToggleTerminal: () => void;
  terminalAvailable: boolean;
  transferPanelOpen: boolean;
  onToggleTransfers: () => void;
  activeTransfers: number;
  editsMenuOpen: boolean;
  onToggleEditsMenu: () => void;
  onCloseEditsMenu: () => void;
}) {
  const activeSessionId = useConnections((s) => s.activeSessionId);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const profiles = useConnections((s) => s.profiles);
  const profile = profiles.find((p) => p.id === activeProfileId);
  const connected = !!activeSessionId && !!profile;
  const edits = useEditor((s) => s.edits);
  const stopEditing = useEditor((s) => s.stopEditing);
  const editList = Object.values(edits);
  const serverViewOpen = useServerView((s) => s.open);
  const openServerView = useServerView((s) => s.openFor);
  const closeServerView = useServerView((s) => s.close);

  const history = useToasts((s) => s.history);
  const unread = useToasts((s) => s.unreadCount);
  const markAllRead = useToasts((s) => s.markAllRead);
  const clearHistory = useToasts((s) => s.clearHistory);
  const errorsSeenAt = useToasts((s) => s.errorsSeenAt);
  const errorCount = unseenErrors(history, errorsSeenAt);
  const [notifOpen, setNotifOpen] = useState(false);
  /** The error pill opens the notification centre showing only errors. */
  const [notifFilter, setNotifFilter] = useState<"all" | "errors">("all");
  const shownHistory = notifFilter === "errors" ? history.filter((n) => n.variant === "error") : history;

  const bridgeRunning = useBridge((s) => s.status.running);
  const waiting = useBridge((s) => s.approvals.length);
  const agentDrawerOpen = useLayout((s) => s.agentDrawerOpen);
  const toggleAgentDrawer = useLayout((s) => s.toggleAgentDrawer);
  const consoleRunning = useBridge((s) =>
    s.console.filter((e) => e.status === "running").length
  );
  const syncPairs = useSync((s) => s.pairs);
  const syncRunning = syncPairs.filter((p) => p.running).length;
  const syncActive = syncPairs.filter((p) => p.state === "syncing").length;
  const openSettings = useLayout((s) => s.openSettings);
  const consoleOpen = useLayout((s) => s.consoleOpen);
  const toggleConsole = useLayout((s) => s.toggleConsole);
  const browserLayout = useSettings((s) => s.browserLayout);
  const setBrowserLayout = useSettings((s) => s.setBrowserLayout);
  const updateNotice = useDiscovery((s) => s.updateNotice);
  const installedVersion = useDiscovery((s) => s.version);
  const discoveryOpen = useLayout((s) => s.dialog === "whatsNew");

  // The status-bar popovers close on Escape or a click outside (Popover),
  // and when the pointer leaves them.
  const editsWrapRef = useRef<HTMLDivElement>(null);
  const notifWrapRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex h-7 min-w-0 shrink-0 items-center gap-2 overflow-hidden border-t border-border bg-bg-panel px-2 text-[11px]">
      {connected ? (
        <div className="flex min-w-0 items-center gap-1.5 pl-1">
          <div className="relative">
            <div
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: profile.color || "rgb(var(--accent))" }}
            />
            <div
              className="absolute inset-0 h-1.5 w-1.5 animate-ping rounded-full opacity-50"
              style={{ background: profile.color || "rgb(var(--accent))" }}
            />
          </div>
          <span className="max-w-[18rem] shrink-0 truncate font-medium" title={profile.name}>
            {profile.name}
          </span>
          <span className="min-w-0 truncate font-mono text-text-dim">
            {profile.username}@{profile.host}:{profile.port}
          </span>
          <span className="shrink-0 rounded-sm bg-bg-subtle px-1 text-[9px] font-medium uppercase tracking-wider text-text-dim">
            {profile.protocol}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-1.5 pl-1 text-text-dim">
          <WifiOff size={11} />
          <span>Not connected</span>
        </div>
      )}
      <div className="flex-1" />
      {updateNotice && !discoveryOpen && (
        // Patch updates land several times a week: a pill, never a dialog.
        <div data-update-notice="" className="flex shrink-0 items-center rounded-md bg-accent-soft text-accent">
          <button
            onClick={() => useLayout.getState().openDialog("whatsNew")}
            className="flex items-center gap-1.5 rounded-md px-2 py-0.5 hover:underline"
          >
            <ArrowUpCircle size={11} />
            {installedVersion ? `Updated to ${installedVersion}` : "Updated"} · What's new
          </button>
          <button
            onClick={() => useDiscovery.getState().acknowledge()}
            aria-label="Dismiss update notice"
            title="Dismiss"
            className="rounded-md px-1 py-0.5 opacity-70 hover:bg-accent/10 hover:opacity-100"
          >
            <X size={10} />
          </button>
        </div>
      )}
      {editList.length > 0 && (
        <div className="relative" ref={editsWrapRef}>
          <PillButton
            active={editsMenuOpen}
            onClick={onToggleEditsMenu}
            icon={<Edit3 size={11} />}
            badge={editList.length}
          >
            Editing
          </PillButton>
          {editsMenuOpen && (
            <StatusPopover
              anchorRef={editsWrapRef}
              onClose={onCloseEditsMenu}
            >
              <div className="border-b border-border bg-bg-subtle px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
                Live edits — saves upload automatically
              </div>
              {editList.map((e) => {
                const since = e.lastSavedAt
                  ? `${Math.max(1, Math.round((Date.now() - e.lastSavedAt) / 1000))}s ago`
                  : "no saves yet";
                return (
                  <div
                    key={e.editId}
                    className="flex items-start gap-2 border-b border-border-subtle px-3 py-2 last:border-0"
                  >
                    <Edit3
                      size={11}
                      className="mt-0.5 shrink-0 text-accent"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-mono text-[11px]">
                        {e.remotePath}
                      </div>
                      {e.lastError ? (
                        <div className="text-[10px] text-danger">
                          {e.lastError}
                        </div>
                      ) : (
                        <div className="text-[10px] text-text-dim">
                          saved {since}
                        </div>
                      )}
                    </div>
                    <button
                      onClick={() => stopEditing(e.editId)}
                      className="rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-danger"
                      title="Stop editing (closes the watcher)"
                    >
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </StatusPopover>
          )}
        </div>
      )}
      <div className="relative flex items-center gap-1" ref={notifWrapRef}>
        {errorCount > 0 && (
          <PillButton
            data-error-pill=""
            danger
            onClick={() => {
              setNotifFilter("errors");
              setNotifOpen(true);
              markAllRead();
            }}
            icon={<AlertCircle size={11} />}
            badge={errorCount}
            title="Show errors"
          >
            {errorCount === 1 ? "Error" : "Errors"}
          </PillButton>
        )}
        <PillButton
          active={notifOpen}
          onClick={() => {
            const next = !notifOpen;
            setNotifOpen(next);
            setNotifFilter("all");
            if (next) markAllRead();
          }}
          icon={<Bell size={11} />}
          badge={unread > 0 ? unread : undefined}
          title="Notifications"
        />
        {notifOpen && (
          <StatusPopover
            anchorRef={notifWrapRef}
            onClose={() => setNotifOpen(false)}
          >
            <div className="flex items-center justify-between border-b border-border bg-bg-subtle px-3 py-1.5">
              <div className="flex items-center gap-1" role="tablist" aria-label="Show">
                {(["all", "errors"] as const).map((f) => (
                  <button
                    key={f}
                    role="tab"
                    aria-selected={notifFilter === f}
                    data-notif-filter={f}
                    onClick={() => setNotifFilter(f)}
                    className={cn(
                      "rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                      notifFilter === f ? "bg-bg-hover text-text" : "text-text-dim hover:text-text"
                    )}
                  >
                    {f === "all" ? "Notifications" : "Errors"}
                  </button>
                ))}
              </div>
              {history.length > 0 && (
                <button
                  onClick={clearHistory}
                  className="text-[10px] text-text-dim hover:text-text"
                >
                  Clear
                </button>
              )}
            </div>
            {shownHistory.length === 0 ? (
              <div className="px-3 py-6 text-center text-[11px] text-text-dim">
                {notifFilter === "errors" ? "No errors" : "No notifications yet"}
              </div>
            ) : (
              <div className="max-h-72 overflow-y-auto">
                {shownHistory.slice(0, 50).map((n) => (
                  <NotificationRow key={n.id} n={n} />
                ))}
              </div>
            )}
          </StatusPopover>
        )}
      </div>
      <PillButton
        onClick={() => openSettings(SETTINGS_ENTRY_POINTS.statusBarSync)}
        data-settings-link="statusBarSync"
        icon={
          <FolderSync
            size={11}
            className={cn(
              syncActive
                ? "animate-pulse text-warning"
                : syncRunning
                  ? "text-success"
                  : undefined
            )}
          />
        }
        badge={syncPairs.length > 0 ? syncPairs.length : undefined}
        title={
          syncPairs.length === 0
            ? "Folder Sync — keep folders mirrored to your servers"
            : `Folder Sync — ${syncRunning} running${
                syncActive ? `, ${syncActive} syncing` : ""
              } of ${syncPairs.length}`
        }
      >
        Sync
      </PillButton>
      <PillButton
        active={agentDrawerOpen}
        onClick={toggleAgentDrawer}
        icon={
          <Radio
            size={11}
            className={bridgeRunning ? "text-accent" : undefined}
          />
        }
        badge={waiting > 0 ? waiting : undefined}
        danger={waiting > 0}
        title={`Agent panel${bridgeRunning ? " (bridge running)" : ""}${
          waiting > 0 ? ` — ${waiting} waiting for you` : ""
        }`}
      >
        {waiting > 0 ? "Agent waiting" : "Agent"}
      </PillButton>
      <PillButton
        active={consoleOpen}
        onClick={toggleConsole}
        icon={<TerminalSquare size={11} />}
        badge={consoleRunning > 0 ? consoleRunning : undefined}
        title="Agent console — live view of what the agent is doing over the bridge"
      >
        Console
      </PillButton>
      <PillButton
        active={browserLayout === "dual"}
        onClick={() =>
          setBrowserLayout(browserLayout === "dual" ? "single" : "dual")
        }
        icon={<Columns2 size={11} />}
        title="Split view — show local files next to the server"
      >
        Split
      </PillButton>
      <PillButton
        active={serverViewOpen}
        onClick={() => {
          if (serverViewOpen) closeServerView();
          else if (activeSessionId) void openServerView(activeSessionId);
        }}
        disabled={!activeSessionId || !terminalAvailable}
        icon={<Activity size={11} />}
        title={
          !terminalAvailable && activeSessionId
            ? "Server view is only available for SSH connections"
            : "Server view — live CPU, memory and network, services, ports, firewall"
        }
      >
        Server
      </PillButton>
      <PillButton
        active={terminalOpen}
        onClick={onToggleTerminal}
        disabled={!activeSessionId || !terminalAvailable}
        icon={<TerminalSquare size={11} />}
        title={
          !terminalAvailable && activeSessionId
            ? "Terminal is only available for SFTP sessions"
            : undefined
        }
      >
        Terminal
      </PillButton>
      <PillButton
        active={transferPanelOpen}
        onClick={onToggleTransfers}
        icon={<ArrowDownUp size={11} />}
        badge={activeTransfers > 0 ? activeTransfers : undefined}
        title="Transfer queue"
      >
        Transfers
      </PillButton>
      {connected && (
        <div className="flex items-center gap-1 pl-2 pr-1 text-success">
          <Wifi size={11} />
        </div>
      )}
    </div>
  );
}

/// Status-bar popover: portaled (the bar clips its overflow), above the
/// pill's wrapper and right-aligned to it.
function StatusPopover({
  anchorRef,
  onClose,
  children,
}: {
  anchorRef: React.RefObject<HTMLDivElement>;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Popover
      open
      anchorRef={anchorRef}
      onClose={onClose}
      onMouseLeave={onClose}
      placement="top-end"
      layer="dropdown"
      className="w-80"
    >
      {children}
    </Popover>
  );
}

function PillButton({
  children,
  onClick,
  icon,
  active,
  disabled,
  badge,
  danger,
  title,
  ...rest
}: {
  children?: React.ReactNode;
  onClick: () => void;
  icon: React.ReactNode;
  active?: boolean;
  disabled?: boolean;
  badge?: number;
  /** Something needs the user (agent approvals): danger-toned label + badge. */
  danger?: boolean;
  title?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      onClick={onClick}
      disabled={disabled}
      title={title ?? (typeof children === "string" ? children : undefined)}
      aria-label={typeof children === "string" ? children : undefined}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
        active
          ? "bg-accent-soft text-accent"
          : "text-text-muted hover:bg-bg-hover hover:text-text",
        danger && "text-danger"
      )}
    >
      {icon}
      {/* A narrow window keeps the icons; the label is in the tooltip. */}
      {children !== undefined && <span className="max-[960px]:hidden">{children}</span>}
      {badge !== undefined && (
        <span
          className={cn(
            "ml-0.5 rounded-full px-1.5 py-0 text-[9px] font-semibold",
            danger ? "bg-danger text-bg" : "bg-accent-strong text-white"
          )}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

/// Listens for faro:// deep links (from a hosting panel like ServerKit) and
/// opens the New Connection editor prefilled. Never auto-connects — the user
/// reviews the target and clicks Connect / Pair, because any web page can fire
/// a protocol handler. `faro://terminal` is the one shortcut: if the named
/// server is ALREADY connected it opens a standalone terminal window for it
/// (no new connection is ever made), otherwise it falls back to the editor.
function DeepLinkListener() {
  const openNewConnection = useLayout((s) => s.openNewConnection);
  const openGrant = useLayout((s) => s.openGrant);
  useEffect(() => {
    const un = onDeepLink((dl) => {
      if (dl.action === "grant") {
        // Access grant: never prefill the editor — open the consent dialog,
        // which fetches the manifest and only acts on Accept.
        if (dl.issuer && dl.token) {
          openGrant({ issuer: dl.issuer, token: dl.token, name: dl.name });
        } else {
          toast.error(
            "Invalid grant link",
            "The link is missing its issuer or token."
          );
        }
        return;
      }
      if (dl.action === "terminal") {
        const { profiles, sessions } = useConnections.getState();
        const norm = (v?: string | null) => (v ?? "").trim().toLowerCase();
        const match = profiles.find(
          (p) =>
            (dl.name && norm(p.name) === norm(dl.name)) ||
            (dl.host && norm(p.host) === norm(dl.host))
        );
        const live = match
          ? sessions.find((s) => s.profileId === match.id)
          : undefined;
        if (match && live && match.protocol === "sftp") {
          void openTerminalWindow({
            sessionId: live.sessionId,
            title: match.name,
          }).catch((e) => toast.error("Terminal window failed", String(e)));
          return;
        }
        if (match && live) {
          toast.warning(
            "No terminal for this server",
            `${match.name} is a ${match.protocol} connection — terminals need SFTP.`
          );
          return;
        }
        // Not connected: a link never auto-connects, so the best we can do is
        // open the prefilled editor with a single explanatory toast.
        openNewConnection(deepLinkToPrefill(dl));
        toast.warning(
          "Server not connected",
          "Connect it first, then the terminal link can open a shell."
        );
        return;
      }
      if (dl.action === "connect" || dl.action === "site") {
        void openConnectLink(dl, openNewConnection);
        return;
      }
      const prefill = deepLinkToPrefill(dl);
      openNewConnection(prefill);
      toast.info("Pair a machine", prefill.name || prefill.host || undefined);
    });
    return () => {
      void un.then((f) => f());
    };
  }, [openNewConnection, openGrant]);
  return null;
}

/// `faro://connect` and `faro://site`: reuse a saved connection that matches
/// the link (host, username, port, protocol, Cloudflare hostname) instead of
/// creating a duplicate. A connected match opens straight away; otherwise a
/// toast offers Connect, because a link never connects on its own. A `site`
/// link saves its folder as a site on the match. Without a match, the editor
/// opens prefilled, in the link's `group`.
async function openConnectLink(
  dl: DeepLink,
  openNewConnection: (prefill?: Partial<ConnectionProfile>) => void
) {
  const { profiles, sessions } = useConnections.getState();
  const match = matchLinkProfile(profiles, dl);
  const path = dl.path?.trim() ? cleanRemotePath(dl.path) : undefined;
  // Through Cloudflare (issue #86) a link goes from click to files in one
  // sheet: one Connect, then cloudflared, the Access sign-in, the first host
  // key. Once connected, this runs again and opens the folder or site.
  const again = () => void openConnectLink(dl, openNewConnection);
  const seed = deepLinkToPrefill(dl);
  if (
    !match &&
    seed.protocol === "sftp" &&
    seed.proxyCommand?.kind === "cloudflare" &&
    seed.auth?.kind === "cloudflarecert" &&
    seed.host?.trim() &&
    seed.username?.trim()
  ) {
    const host = seed.host.trim();
    useCfConnect.getState().start(
      {
        ...seed,
        id: crypto.randomUUID(),
        name: seed.name?.trim() || host,
        protocol: "sftp",
        host,
        port: seed.port ?? 22,
        username: seed.username.trim(),
        auth: { kind: "cloudflarecert" },
      },
      { saved: false, onDone: again }
    );
    return;
  }
  if (match?.proxyCommand?.kind === "cloudflare" && !sessions.some((x) => x.profileId === match.id)) {
    useCfConnect.getState().start(match, { saved: true, onDone: again });
    return;
  }
  if (!match) {
    const prefill = deepLinkToPrefill(dl);
    openNewConnection(prefill);
    toast.info(
      dl.action === "site" ? "Save the server first" : "Open connection",
      dl.action === "site"
        ? "This site's server isn't saved in Faro yet."
        : prefill.name || prefill.host || undefined
    );
    return;
  }

  let siteId: string | undefined;
  let savedSite = false;
  if (path) {
    try {
      await useSites.getState().load();
      const existing = useSites
        .getState()
        .sites.find((s) => s.profileId === match.id && sameRemotePath(s.path, path));
      if (existing) {
        siteId = existing.id;
      } else if (dl.action === "site") {
        const id = crypto.randomUUID();
        await useSites.getState().save({ id, profileId: match.id, name: siteNameFor(dl, path), path });
        siteId = id;
        savedSite = true;
      }
    } catch (e) {
      toast.error("Couldn't save the site", String(e));
    }
  }

  // Reveal the server in the rail if its folder is collapsed.
  const settings = useSettings.getState();
  if (match.group && settings.railCollapsedGroups.includes(match.group)) {
    settings.toggleRailGroup(match.group);
  }

  const target = { profileId: match.id, siteId, path: siteId ? undefined : path };
  const siteName = siteId ? useSites.getState().sites.find((s) => s.id === siteId)?.name : undefined;
  const label = siteName ? `${siteName} on ${match.name}` : match.name;
  if (showLinkTarget(target)) {
    toast.info(savedSite ? "Site saved" : "Opened saved connection", label);
    return;
  }
  useToasts.getState().push({
    variant: "info",
    title: savedSite ? "Site saved" : "Already saved in Faro",
    message: `${label}. Press Connect to open it.`,
    action: { label: "Connect", connect: target },
    duration: 15000,
  });
}

/// Map a parsed deep link to editor seed values. `pair` links become a
/// faro-agent profile; everything else a server profile of the named protocol.
function deepLinkToPrefill(dl: DeepLink): Partial<ConnectionProfile> {
  const known: Protocol[] = ["sftp", "ftp", "ftps", "s3", "azure", "gcs", "webdav", "http", "dropbox", "onedrive", "gdrive", "box", "shopify", "hubspot", "dynamics", "wordpress", "faro-agent"];
  const protocol: Protocol =
    dl.action === "pair"
      ? "faro-agent"
      : known.includes(dl.protocol as Protocol)
      ? (dl.protocol as Protocol)
      : "sftp";
  return {
    protocol,
    name: dl.name ?? undefined,
    host: dl.host ?? undefined,
    port: dl.port ?? PROTOCOL_DEFAULT_PORT[protocol],
    username: dl.username ?? undefined,
    defaultRemotePath: dl.path ?? undefined,
    bucket: dl.bucket ?? undefined,
    region: dl.region ?? undefined,
    // WordPress keeps its site URL in `endpoint`; a link's `host` is the site.
    endpoint:
      dl.endpoint ?? (protocol === "wordpress" ? (dl.host ?? undefined) : undefined),
    account: dl.account ?? undefined,
    group: dl.group?.trim() || undefined,
    ...(protocol === "sftp" ? sshRouteFromLink(dl) : {}),
  };
}

/// A link's Cloudflare Access route and secret-free login (`via`, `access`,
/// `auth`), as editor seed values. A certificate login needs the route.
function sshRouteFromLink(dl: DeepLink): Partial<ConnectionProfile> {
  const cloudflare = dl.via === "cloudflare";
  const seed: Partial<ConnectionProfile> = {};
  if (cloudflare) {
    seed.proxyCommand = { kind: "cloudflare", hostname: dl.access || undefined };
  }
  if (dl.auth === "agent") seed.auth = { kind: "agent" };
  else if (dl.auth === "cloudflarecert" && cloudflare) seed.auth = { kind: "cloudflarecert" };
  return seed;
}

/// One notification-center row. Click to expand the full text (selectable)
/// with a Copy button; collapsed rows still offer Copy on the right.
function NotificationRow({ n }: { n: Toast }) {
  const [open, setOpen] = useState(false);
  const version = useDiscovery((s) => s.version);
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={open}
      onClick={() => setOpen((o) => !o)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setOpen((o) => !o);
        }
      }}
      title={open ? undefined : "Show the full notification"}
      className="flex cursor-pointer items-start gap-2 border-b border-border-subtle px-3 py-2 last:border-0 hover:bg-bg-hover"
    >
      <NotifIcon variant={n.variant} />
      <div className="min-w-0 flex-1">
        <div className={cn("text-[11px] font-medium", open && "select-text")}>{n.title}</div>
        {n.message && (
          <div
            onClick={(e) => open && e.stopPropagation()}
            className={cn(
              "text-[10px] text-text-dim",
              open
                ? "mt-0.5 max-h-48 cursor-text select-text overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere]"
                : "truncate"
            )}
          >
            {n.message}
          </div>
        )}
        {n.action && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              followToastAction(n.action!);
            }}
            className="mt-1 inline-flex items-center gap-1 text-[10px] font-medium text-accent hover:underline"
          >
            {n.action.label}
          </button>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-[9px] text-text-dim">{relTime(n.createdAt)}</span>
        <CopyTextButton
          text={n.variant === "error" ? toastDetails(n, version) : notificationText(n)}
          label={n.variant === "error" && open ? "Copy details" : open}
        />
      </div>
    </div>
  );
}

function NotifIcon({ variant }: { variant: ToastVariant }) {
  const map = {
    info: { Icon: Info, cls: "text-info" },
    success: { Icon: CheckCircle2, cls: "text-success" },
    error: { Icon: AlertCircle, cls: "text-danger" },
    warning: { Icon: AlertTriangle, cls: "text-warning" },
  } as const;
  const { Icon, cls } = map[variant];
  return <Icon size={12} className={cn("mt-0.5 shrink-0", cls)} />;
}
