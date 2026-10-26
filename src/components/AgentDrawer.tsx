import { Ban, Check, Power, Radio, X } from "lucide-react";
import { useBridge } from "@/stores/bridgeStore";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import {
  ACCESS_COLUMNS,
  accessCaps,
  effectiveAccess,
} from "@/lib/agentAccess";
import { cn } from "@/lib/cn";
import type { BridgeActivity, BridgeApproval } from "@/lib/types";
import { AccessSeg } from "./ui/AccessSeg";
import { approvalCopy, summaryStats } from "./AgentBridge";

/// Clock time for activity rows — the drawer is a live log, so "14:02:19"
/// reads better than "3m ago" when lining up with a terminal.
export function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

/// One pending agent request, inline (drawer + access page). Deny is first and
/// visually quiet; the card itself is danger-toned for commands and writes so
/// the risk reads before the buttons do.
export function ApprovalCard({
  approval,
  index,
  total,
  onApprove,
  onDeny,
}: {
  approval: BridgeApproval;
  index: number;
  total: number;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const copy = approvalCopy(approval.kind);
  const stats = summaryStats(approval.kind, approval.command);
  const risky = approval.kind !== "read" && approval.kind !== "search";
  return (
    <div
      role="group"
      aria-label={`${copy.title} on ${approval.sessionName}`}
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border p-3",
        risky ? "border-danger/35 bg-danger/[0.06]" : "border-warning/35 bg-warning/[0.06]"
      )}
    >
      <div className="flex items-center gap-2 text-[12px]">
        <span className={cn("font-semibold", risky ? "text-danger" : "text-warning")}>
          {copy.title}
        </span>
        <span className="flex-1" />
        {total > 1 && (
          <span className="text-text-dim">
            {index + 1} of {total}
          </span>
        )}
      </div>
      <div className="text-[12px] text-text-muted">
        On <span className="font-semibold text-text">{approval.sessionName}</span>
      </div>
      <pre className="selectable max-h-32 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg px-2.5 py-2 font-mono text-[12px] text-text [overflow-wrap:anywhere]">
        {approval.command}
      </pre>
      {stats.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {stats.map((s) => (
            <span
              key={s.label}
              className={cn(
                "rounded border px-1.5 py-0.5 text-[11px]",
                s.danger
                  ? "border-danger/40 text-danger"
                  : "border-border text-text-muted"
              )}
            >
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="text-[11px] text-text-dim">{copy.foot}</div>
      <div className="flex items-center gap-2">
        <button
          onClick={onDeny}
          className="flex h-7 items-center gap-1 rounded-md border border-border bg-bg-subtle px-2.5 text-[12px] text-text hover:bg-bg-hover"
        >
          <Ban size={12} /> Deny
        </button>
        <span className="flex-1" />
        <button
          onClick={onApprove}
          className="btn-accent flex h-7 items-center gap-1 rounded-md px-3 text-[12px] font-medium text-white"
        >
          <Check size={13} /> Approve
        </button>
      </div>
    </div>
  );
}

/// Compact activity line: time · server · what happened.
export function ActivityLine({
  a,
  serverName,
}: {
  a: BridgeActivity;
  serverName: string;
}) {
  const bad = a.kind === "denied" || a.kind === "error" || !a.ok;
  return (
    <div className="flex items-baseline gap-2 py-1 text-[11.5px] leading-snug">
      <span className="w-14 shrink-0 font-mono text-text-dim">{clockTime(a.at)}</span>
      <span className="w-20 shrink-0 truncate text-text-muted" title={serverName}>
        {serverName || "—"}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate font-mono",
          bad ? "text-danger" : "text-text-muted"
        )}
        title={`${a.kind} ${a.detail}`}
      >
        <span className="text-text-dim">{a.kind === "denied" ? "denied" : a.kind}</span>{" "}
        {a.detail}
      </span>
    </div>
  );
}

/// Right-hand agent panel beside the file browser: what's waiting, what the
/// agent may do on the server you're looking at, and what it just did. The
/// full fleet view is the Agent Bridge page ("All servers").
export function AgentDrawer() {
  const status = useBridge((s) => s.status);
  const approvals = useBridge((s) => s.approvals);
  const activity = useBridge((s) => s.activity);
  const respond = useBridge((s) => s.respond);
  const setEnabled = useBridge((s) => s.setEnabled);
  const setProfileAccess = useBridge((s) => s.setProfileAccess);
  const openDialog = useLayout((s) => s.openDialog);
  const setAgentDrawerOpen = useLayout((s) => s.setAgentDrawerOpen);
  const browseLocal = useLayout((s) => s.browseLocal);
  const profiles = useConnections((s) => s.profiles);
  const sessions = useConnections((s) => s.sessions);
  const activeProfileId = useConnections((s) => s.activeProfileId);

  const profile = browseLocal
    ? undefined
    : profiles.find((p) => p.id === activeProfileId);
  const access = profile ? effectiveAccess(status, profile.id) : null;
  const caps = profile ? accessCaps(profile.protocol) : null;
  const granted = profile ? status.enabledProfiles.includes(profile.id) : false;

  const nameOfSession = (sid: string) => {
    const pid = sessions.find((s) => s.sessionId === sid)?.profileId;
    return profiles.find((p) => p.id === pid)?.name ?? "";
  };

  return (
    <aside
      aria-label="Agent"
      className="flex h-full w-[340px] shrink-0 flex-col border-l border-border bg-bg-panel"
    >
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Radio size={13} className={status.running ? "text-accent" : "text-text-dim"} />
        <span className="text-[12.5px] font-semibold">Agent</span>
        <span className="truncate text-[11.5px] text-text-dim">
          {status.running ? "bridge running" : "bridge off"}
        </span>
        <span className="flex-1" />
        <button
          onClick={() => openDialog("agentBridge")}
          className="rounded px-1.5 py-0.5 text-[11.5px] text-accent hover:bg-bg-hover"
        >
          All servers
        </button>
        <button
          onClick={() => setAgentDrawerOpen(false)}
          aria-label="Close agent panel"
          className="rounded p-1 text-text-dim hover:bg-bg-hover hover:text-text"
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {!status.enabled ? (
          <div className="m-3 flex flex-col gap-2 rounded-lg border border-border p-3 text-[12px] text-text-muted">
            <span>
              The Agent Bridge is off: no local endpoint, no token, nothing
              exposed.
            </span>
            <button
              onClick={() => void setEnabled(true)}
              className="flex h-7 w-fit items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2.5 text-text hover:bg-bg-hover"
            >
              <Power size={12} /> Turn on
            </button>
          </div>
        ) : (
          approvals.length > 0 && (
            <div className="flex flex-col gap-2 p-3">
              {approvals.map((a, i) => (
                <ApprovalCard
                  key={a.requestId}
                  approval={a}
                  index={i}
                  total={approvals.length}
                  onApprove={() => void respond(a.requestId, "approve")}
                  onDeny={() => void respond(a.requestId, "deny")}
                />
              ))}
            </div>
          )
        )}

        <section className="border-b border-border px-3 pb-3 pt-2">
          <h2 className="mb-2 text-[12.5px] font-semibold">
            {profile ? (
              <>
                Access on <span className="text-text">{profile.name}</span>
              </>
            ) : (
              "Access"
            )}
          </h2>
          {!profile || !access || !caps ? (
            <p className="text-[12px] text-text-dim">
              Open a server to set what the agent may do on it.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {ACCESS_COLUMNS.map((c) => {
                const applies = c.key === "exec" ? caps.exec : c.key === "sudo" ? caps.sudo : true;
                return (
                  <div key={c.key} className="flex items-center text-[12.5px]" title={c.help}>
                    <span className="flex-1 text-text-muted">{c.label}</span>
                    {applies ? (
                      <AccessSeg
                        value={access[c.key]}
                        risky={c.risky}
                        label={`${c.label} on ${profile.name}`}
                        onChange={(v) =>
                          void setProfileAccess(profile.id, { ...access, [c.key]: v })
                        }
                      />
                    ) : (
                      <span className="w-[7.5rem] text-center text-[11px] text-text-dim">
                        not available
                      </span>
                    )}
                  </div>
                );
              })}
              {!granted && (
                <p className="text-[11.5px] text-text-dim">
                  No access yet. Pick Ask or Auto above to let the agent in.
                </p>
              )}
            </div>
          )}
        </section>

        <section className="flex min-h-0 flex-1 flex-col px-3 pt-2">
          <div className="mb-1 flex items-center">
            <h2 className="text-[12.5px] font-semibold">Activity</h2>
            <span className="flex-1" />
            <span className="text-[11px] text-text-dim">all servers</span>
          </div>
          {activity.length === 0 ? (
            <p className="text-[12px] text-text-dim">
              Nothing yet. Approved commands, reads, transfers and denials show up
              here.
            </p>
          ) : (
            <div className="pb-3">
              {activity.slice(0, 60).map((a) => (
                <ActivityLine key={a.id} a={a} serverName={nameOfSession(a.sessionId)} />
              ))}
            </div>
          )}
        </section>
      </div>
    </aside>
  );
}
