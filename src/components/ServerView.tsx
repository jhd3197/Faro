import { useEffect } from "react";
import { Activity, Loader2, MonitorOff, X } from "lucide-react";
import { useServerView, type ServerTab } from "@/stores/serverViewStore";
import { useConnections } from "@/stores/connectionsStore";
import { EmptyState } from "@/components/ui/EmptyState";
import { Deferred } from "@faro/file-ui";
import { cn } from "@/lib/cn";
import type { HostProbe } from "@/lib/types";
import { OverviewTab } from "./server/OverviewTab";
import { ServicesTab } from "./server/ServicesTab";
import { PortsTab } from "./server/PortsTab";
import { FirewallTab } from "./server/FirewallTab";
import { DockerTab } from "./docker/DockerTab";

// Server view (Plan 30): what an SSH host is doing right now. An overlay in
// the work area — the same slot as Disk Usage — so the rail and the terminal
// dock stay usable.

/** One tab of the Server view. Later plans add tabs by adding entries here. */
interface TabDef {
  id: ServerTab;
  label: string;
  /** Whether this host can show the tab at all. */
  visible: (probe: HostProbe) => boolean;
  render: () => React.ReactNode;
}

const TABS: TabDef[] = [
  { id: "overview", label: "Overview", visible: (p) => p.proc, render: () => <OverviewTab /> },
  { id: "services", label: "Services", visible: (p) => p.systemd, render: () => <ServicesTab /> },
  { id: "ports", label: "Ports", visible: (p) => !!p.ports, render: () => <PortsTab /> },
  {
    id: "firewall",
    label: "Firewall",
    visible: (p) => p.firewall.length > 0,
    render: () => <FirewallTab />,
  },
  { id: "docker", label: "Docker", visible: (p) => p.docker, render: () => <DockerTab /> },
];

/** Mount point: renders the overlay only while the Server view is open. */
export function ServerViewHost() {
  const open = useServerView((s) => s.open);
  const viewSession = useServerView((s) => s.sessionId);
  const openFor = useServerView((s) => s.openFor);
  const close = useServerView((s) => s.close);
  const activeSessionId = useConnections((s) => s.activeSessionId);
  const activeProfileId = useConnections((s) => s.activeProfileId);
  const profiles = useConnections((s) => s.profiles);

  // The view follows the focused connection: switching to another SSH server
  // shows that server, and switching to anything else closes it.
  useEffect(() => {
    if (!open || activeSessionId === viewSession) return;
    const profile = profiles.find((p) => p.id === activeProfileId);
    if (activeSessionId && profile?.protocol === "sftp") {
      void openFor(activeSessionId, useServerView.getState().tab);
    } else {
      close();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId]);

  if (!open) return null;
  return <ServerView />;
}

function ServerView() {
  const sessionId = useServerView((s) => s.sessionId);
  const tab = useServerView((s) => s.tab);
  const setTab = useServerView((s) => s.setTab);
  const probe = useServerView((s) => s.probe);
  const probing = useServerView((s) => s.probing);
  const probeError = useServerView((s) => s.probeError);
  const openFor = useServerView((s) => s.openFor);
  const close = useServerView((s) => s.close);

  // Esc closes the view (matches every other overlay) unless a dialog or a
  // text field has the key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[role="dialog"]')) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const tabs = probe ? TABS.filter((t) => t.visible(probe)) : [];
  const current = tabs.find((t) => t.id === tab) ?? tabs[0];
  const facts = probe ? [probe.distro || probe.os, probe.kernel].filter(Boolean).join(" · ") : "";

  return (
    <div className="absolute inset-0 z-[6] flex flex-col bg-bg">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-panel px-3 py-2">
        <Activity size={15} className="shrink-0 text-accent" />
        <span className="shrink-0 text-sm font-semibold">Server</span>
        {probe?.hostname && (
          <span className="shrink-0 truncate font-mono text-xs text-text" title={probe.hostname}>
            {probe.hostname}
          </span>
        )}
        <span className="min-w-0 flex-1 truncate text-[11px] text-text-dim" title={facts}>
          {facts}
        </span>

        {tabs.length > 0 && (
          <div
            role="tablist"
            aria-label="Server view"
            className="flex h-6 shrink-0 overflow-hidden rounded-md border border-border text-[11px]"
          >
            {tabs.map((t, i) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={current?.id === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "px-2.5 [&:active]:scale-100",
                  i > 0 && "border-l border-border",
                  current?.id === t.id
                    ? "bg-bg-hover font-medium text-text"
                    : "text-text-dim hover:text-text"
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <button
          onClick={() => close()}
          className="shrink-0 rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-danger"
          title="Close (Esc)"
          aria-label="Close Server view"
        >
          <X size={16} />
        </button>
      </div>

      {probing && (
        <Deferred>
          <div className="flex flex-1 items-center justify-center gap-2 text-xs text-text-muted">
            <Loader2 size={14} className="animate-spin text-accent" />
            Checking what this server offers…
          </div>
        </Deferred>
      )}

      {probeError && (
        <EmptyState
          icon={<MonitorOff size={20} />}
          title="Could not check this server"
          hint={probeError}
          action={
            sessionId && (
              <button
                onClick={() => {
                  close();
                  void openFor(sessionId);
                }}
                className="rounded-md border border-border px-3 py-1 text-xs text-text hover:bg-bg-hover"
              >
                Try again
              </button>
            )
          }
        />
      )}

      {probe && tabs.length === 0 && (
        <EmptyState
          icon={<MonitorOff size={20} />}
          title="Server view needs a Linux host"
          hint={
            probe.os
              ? `This host reports ${probe.os}, which has none of what the view reads.`
              : "This host has none of what the view reads."
          }
        />
      )}

      {/* Keyed by session so a tab's own state never leaks across servers. */}
      {current && (
        <div key={`${sessionId}-${current.id}`} role="tabpanel" className="flex min-h-0 flex-1 flex-col">
          {current.render()}
        </div>
      )}
    </div>
  );
}
