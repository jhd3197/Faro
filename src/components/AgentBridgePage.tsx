import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  Radio,
  Search,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useBridge } from "@/stores/bridgeStore";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import {
  ACCESS_COLUMNS,
  ALL_OFF,
  accessCaps,
  effectiveAccess,
  type AccessColumn,
} from "@/lib/agentAccess";
import { cn } from "@/lib/cn";
import { toast } from "@/stores/toastStore";
import { PROTOCOL_LABEL } from "@/lib/types";
import type { AccessLevel, ConnectionProfile, ProfileAccess } from "@/lib/types";
import { AccessSeg } from "./ui/AccessSeg";
import { AgentBridgeSetup, mcpAddCmd } from "./AgentBridge";
import { ActivityLine, ApprovalCard, clockTime } from "./AgentDrawer";
import { profileAddress } from "./ServerRail";

const UNGROUPED = "Ungrouped";

type Filter = { kind: "all" } | { kind: "group"; name: string } | { kind: "granted" };

/// The Agent Bridge as a page over the work area: every saved server in one
/// access matrix (Off / Ask / Auto per capability), grouped like the rail,
/// with bulk edits, plus what's waiting and what just happened. The endpoint,
/// agent hookup, defaults, saved commands and history are on the Setup tab.
export function AgentBridgePage({ onClose }: { onClose: () => void }) {
  const status = useBridge((s) => s.status);
  const approvals = useBridge((s) => s.approvals);
  const activity = useBridge((s) => s.activity);
  const respond = useBridge((s) => s.respond);
  const setEnabled = useBridge((s) => s.setEnabled);
  const setProfileAccess = useBridge((s) => s.setProfileAccess);
  const refresh = useBridge((s) => s.refresh);
  const setConsoleOpen = useLayout((s) => s.setConsoleOpen);
  const profiles = useConnections((s) => s.profiles);
  const sessions = useConnections((s) => s.sessions);

  const [tab, setTab] = useState<"access" | "setup">("access");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Escape closes the page like the modal it replaces. No focus trap: the page
  // is part of the window (the rail stays usable), not a dialog over it. A
  // modal opened on top handles its own Escape first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Same order as the rail: manual sortOrder, then name.
  const ordered = useMemo(
    () =>
      [...profiles].sort((a, b) => {
        const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
        const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
        return sa !== sb ? sa - sb : a.name.localeCompare(b.name);
      }),
    [profiles]
  );
  const groupNames = useMemo(() => {
    const names: string[] = [];
    for (const p of ordered) {
      const g = p.group || UNGROUPED;
      if (!names.includes(g)) names.push(g);
    }
    return names;
  }, [ordered]);

  const granted = (p: ConnectionProfile) => status.enabledProfiles.includes(p.id);
  const q = query.trim().toLowerCase();
  const visible = ordered.filter((p) => {
    if (filter.kind === "group" && (p.group || UNGROUPED) !== filter.name) return false;
    if (filter.kind === "granted" && !granted(p)) return false;
    if (!q) return true;
    return [p.name, p.host, p.username, p.bucket, p.group, PROTOCOL_LABEL[p.protocol]]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });
  const byGroup = groupNames
    .map((g) => [g, visible.filter((p) => (p.group || UNGROUPED) === g)] as const)
    .filter(([, items]) => items.length > 0);

  // Latest agent call per server (activity is keyed by session id).
  const lastCall = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of activity) {
      const pid = sessions.find((s) => s.sessionId === a.sessionId)?.profileId;
      if (pid && !m.has(pid)) m.set(pid, a.at);
    }
    return m;
  }, [activity, sessions]);
  const nameOfSession = (sid: string) => {
    const pid = sessions.find((s) => s.sessionId === sid)?.profileId;
    return profiles.find((p) => p.id === pid)?.name ?? "";
  };

  /** Set one cell; capabilities a protocol doesn't have stay off. */
  const setCell = (p: ConnectionProfile, col: AccessColumn, v: AccessLevel) => {
    const caps = accessCaps(p.protocol);
    const cur = effectiveAccess(status, p.id);
    const next: ProfileAccess = { ...cur, [col]: v };
    if (!caps.exec) next.exec = "off";
    if (!caps.sudo) next.sudo = "off";
    void setProfileAccess(p.id, next);
  };
  const setBulk = (col: AccessColumn, v: AccessLevel) => {
    const targets = profiles.filter((p) => selected.has(p.id));
    for (const p of targets) {
      const caps = accessCaps(p.protocol);
      if ((col === "exec" && !caps.exec) || (col === "sudo" && !caps.sudo)) continue;
      setCell(p, col, v);
    }
    toast.info(
      `Updated ${targets.length} server${targets.length === 1 ? "" : "s"}`,
      `${ACCESS_COLUMNS.find((c) => c.key === col)?.label}: ${v}`
    );
  };
  const revokeSelected = () => {
    for (const id of selected) void setProfileAccess(id, ALL_OFF);
    setSelected(new Set());
  };
  const toggleSel = (ids: string[], on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      for (const id of ids) on ? n.add(id) : n.delete(id);
      return n;
    });

  const grantedCount = ordered.filter(granted).length;
  const copyMcp = async () => {
    if (!status.url || !status.token) return;
    await navigator.clipboard.writeText(mcpAddCmd(status.url, status.token));
    toast.success("MCP command copied", "Paste it in a terminal to add Faro to Claude Code.");
  };

  return (
    <div
      ref={rootRef}
      role="region"
      aria-label="Agent Bridge"
      className="absolute inset-0 z-[5] flex bg-bg"
    >
      <div className="flex min-w-0 flex-1 flex-col px-5 pt-4">
        {/* Header */}
        <div className="flex items-start gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight">
              <Radio size={16} className={status.running ? "text-accent" : "text-text-dim"} />
              Agent Bridge
            </h1>
            <p className="mt-0.5 truncate text-[12px] text-text-muted">
              {status.running && status.url ? (
                <>
                  Listening on{" "}
                  <span className="font-mono text-text">{status.url.replace("http://", "")}</span>{" "}
                  · token required · {grantedCount} of {ordered.length} servers have access
                </>
              ) : status.enabled ? (
                "Starting…"
              ) : (
                "Off — no endpoint, no token, nothing exposed."
              )}
            </p>
          </div>
          <span className="flex-1" />
          <button
            onClick={() => void copyMcp()}
            disabled={!status.running}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2.5 text-[12px] hover:bg-bg-hover disabled:opacity-40"
          >
            <Copy size={12} /> Copy MCP command
          </button>
          <button
            onClick={() => setConsoleOpen(true)}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2.5 text-[12px] hover:bg-bg-hover"
          >
            <TerminalIcon size={12} /> Live console
          </button>
          <label className="flex h-7 items-center gap-2 border-l border-border pl-3 text-[12px] text-text-muted">
            Bridge
            <button
              role="switch"
              aria-checked={status.enabled}
              aria-label="Agent Bridge on"
              onClick={() => void setEnabled(!status.enabled)}
              className={cn(
                "relative h-5 w-9 rounded-full transition-colors",
                status.enabled ? "bg-accent" : "bg-bg-hover"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full transition-[left]",
                  status.enabled ? "left-[18px] bg-bg" : "left-0.5 bg-text-dim"
                )}
              />
            </button>
          </label>
          <button
            onClick={onClose}
            aria-label="Close Agent Bridge"
            className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-text-muted hover:bg-bg-hover hover:text-text"
          >
            <X size={13} /> Close
          </button>
        </div>

        {/* Tabs */}
        <div role="tablist" className="mt-3 flex gap-4 border-b border-border text-[12.5px]">
          {(
            [
              ["access", "Access"],
              ["setup", "Setup & commands"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              role="tab"
              aria-selected={tab === k}
              onClick={() => setTab(k)}
              className={cn(
                "-mb-px border-b-2 pb-2 transition-colors",
                tab === k
                  ? "border-accent text-text"
                  : "border-transparent text-text-muted hover:text-text"
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "setup" ? (
          <div className="min-h-0 flex-1 overflow-y-auto py-4 pr-1">
            <AgentBridgeSetup onClose={onClose} />
          </div>
        ) : (
          <>
            {/* Filters */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <label className="flex h-7 w-60 items-center gap-2 rounded-md border border-border bg-bg-panel px-2 text-text-dim focus-within:border-accent/60">
                <Search size={13} className="shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Filter by name, host or group"
                  aria-label="Filter servers"
                  className="min-w-0 flex-1 bg-transparent text-[12px] text-text outline-none placeholder:text-text-dim"
                />
              </label>
              <FilterChip on={filter.kind === "all"} onClick={() => setFilter({ kind: "all" })} label="All" count={ordered.length} />
              {groupNames.map((g) => (
                <FilterChip
                  key={g}
                  on={filter.kind === "group" && filter.name === g}
                  onClick={() => setFilter({ kind: "group", name: g })}
                  label={g}
                  count={ordered.filter((p) => (p.group || UNGROUPED) === g).length}
                />
              ))}
              <FilterChip
                on={filter.kind === "granted"}
                onClick={() => setFilter({ kind: "granted" })}
                label="Has access"
                count={grantedCount}
              />
            </div>

            {/* Bulk bar */}
            {selected.size > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-accent/30 bg-accent/[0.07] px-3 py-2 text-[12px]">
                <span className="font-semibold">{selected.size} selected</span>
                <span className="text-text-muted">Set for all:</span>
                {ACCESS_COLUMNS.map((c) => (
                  <span key={c.key} className="flex items-center gap-1.5">
                    <span className="text-text-muted">{c.label}</span>
                    <AccessSeg
                      value={null}
                      risky={c.risky}
                      label={`${c.label} for ${selected.size} selected servers`}
                      onChange={(v) => setBulk(c.key, v)}
                    />
                  </span>
                ))}
                <span className="flex-1" />
                <button
                  onClick={revokeSelected}
                  className="h-7 rounded-md border border-danger/40 px-2.5 text-danger hover:bg-danger/10"
                >
                  Revoke all access
                </button>
                <button
                  onClick={() => setSelected(new Set())}
                  className="h-7 rounded-md border border-border px-2.5 hover:bg-bg-hover"
                >
                  Clear
                </button>
              </div>
            )}

            {/* Matrix */}
            <div className="mt-3 flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-bg-panel">
              <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-3 text-[10.5px] uppercase tracking-[0.07em] text-text-dim">
                <span className="w-4" />
                <span className="min-w-0 flex-1">Server</span>
                <span className="w-16">Type</span>
                {ACCESS_COLUMNS.map((c) => (
                  <span key={c.key} className="w-[7.5rem] truncate whitespace-nowrap" title={`${c.label} — ${c.help}`}>
                    {c.short}
                  </span>
                ))}
                <span className="w-[4.5rem] whitespace-nowrap text-right">Last call</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {byGroup.length === 0 && (
                  <div className="px-4 py-8 text-center text-[12px] text-text-dim">
                    {profiles.length === 0
                      ? "No saved servers yet."
                      : "No servers match this filter."}
                  </div>
                )}
                {byGroup.map(([g, items]) => {
                  const closed = closedGroups.has(g);
                  const ids = items.map((p) => p.id);
                  const allSel = ids.every((id) => selected.has(id));
                  const someSel = !allSel && ids.some((id) => selected.has(id));
                  const nGranted = items.filter(granted).length;
                  return (
                    <div key={g}>
                      <div className="flex h-9 items-center gap-3 border-b border-border-subtle bg-bg-subtle/50 px-3 text-[12px]">
                        <input
                          type="checkbox"
                          aria-label={`Select all in ${g}`}
                          checked={allSel}
                          ref={(el) => {
                            if (el) el.indeterminate = someSel;
                          }}
                          onChange={(e) => toggleSel(ids, e.target.checked)}
                          className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
                        />
                        <button
                          onClick={() =>
                            setClosedGroups((s) => {
                              const n = new Set(s);
                              n.has(g) ? n.delete(g) : n.add(g);
                              return n;
                            })
                          }
                          aria-expanded={!closed}
                          className="flex items-center gap-1.5 hover:text-text"
                        >
                          {closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                          <span className="font-semibold">{g}</span>
                          <span className="text-text-dim">{items.length}</span>
                        </button>
                        <span className="text-[11.5px] text-text-dim">
                          {nGranted === 0
                            ? "no access"
                            : nGranted === items.length
                              ? "all have access"
                              : `${nGranted} with access`}
                        </span>
                      </div>
                      {!closed &&
                        items.map((p) => (
                          <MatrixRow
                            key={p.id}
                            profile={p}
                            access={effectiveAccess(status, p.id)}
                            selected={selected.has(p.id)}
                            connected={sessions.some((s) => s.profileId === p.id)}
                            lastCall={lastCall.get(p.id)}
                            onSelect={(on) => toggleSel([p.id], on)}
                            onSet={(col, v) => setCell(p, col, v)}
                          />
                        ))}
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="flex h-9 shrink-0 flex-wrap items-center gap-x-4 text-[11.5px] text-text-dim">
              <span><b className="font-medium text-text">Off</b> agent can't touch it</span>
              <span><b className="font-medium text-warning">Ask</b> you approve each request</span>
              <span><b className="font-medium text-success">Auto</b> runs without asking</span>
              <span><b className="font-medium text-danger">Auto</b> on commands or sudo shows red</span>
            </div>
          </>
        )}
      </div>

      {/* Waiting + recent */}
      <aside
        aria-label="Agent requests"
        className="flex w-[340px] shrink-0 flex-col border-l border-border bg-bg-panel"
      >
        <div className="flex items-baseline gap-2 px-4 pb-2 pt-4">
          <h2 className="text-[13px] font-semibold">Waiting on you</h2>
          {approvals.length > 0 && (
            <span className="text-[12px] font-semibold text-danger">{approvals.length}</span>
          )}
        </div>
        <div className="flex flex-col gap-2 px-3">
          {approvals.length === 0 ? (
            <p className="px-1 text-[12px] text-text-dim">
              Nothing pending. Requests on servers set to Ask show up here.
            </p>
          ) : (
            approvals.map((a, i) => (
              <ApprovalCard
                key={a.requestId}
                approval={a}
                index={i}
                total={approvals.length}
                onApprove={() => void respond(a.requestId, "approve")}
                onDeny={() => void respond(a.requestId, "deny")}
              />
            ))
          )}
        </div>
        <div className="flex items-center px-4 pb-1 pt-5">
          <h2 className="text-[13px] font-semibold">Recent</h2>
          <span className="flex-1" />
          <button
            onClick={() => setConsoleOpen(true)}
            className="text-[12px] text-accent hover:underline"
          >
            Open console
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-3">
          {activity.length === 0 ? (
            <p className="text-[12px] text-text-dim">No agent activity yet.</p>
          ) : (
            activity
              .slice(0, 80)
              .map((a) => (
                <ActivityLine key={a.id} a={a} serverName={nameOfSession(a.sessionId)} />
              ))
          )}
        </div>
      </aside>
    </div>
  );
}

function FilterChip({
  on,
  onClick,
  label,
  count,
}: {
  on: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors",
        on
          ? "border-text bg-text text-bg"
          : "border-border text-text-muted hover:border-text-dim hover:text-text"
      )}
    >
      {label}
      <span className={on ? "opacity-70" : "text-text-dim"}>{count}</span>
    </button>
  );
}

function MatrixRow({
  profile: p,
  access,
  selected,
  connected,
  lastCall,
  onSelect,
  onSet,
}: {
  profile: ConnectionProfile;
  access: ProfileAccess;
  selected: boolean;
  connected: boolean;
  lastCall: number | undefined;
  onSelect: (on: boolean) => void;
  onSet: (col: AccessColumn, v: AccessLevel) => void;
}) {
  const caps = accessCaps(p.protocol);
  return (
    <div
      className={cn(
        "flex h-10 items-center gap-3 border-b border-border-subtle px-3 hover:bg-bg-hover/40",
        selected && "bg-accent/[0.06]"
      )}
    >
      <input
        type="checkbox"
        aria-label={`Select ${p.name}`}
        checked={selected}
        onChange={(e) => onSelect(e.target.checked)}
        className="h-3.5 w-3.5 accent-[rgb(var(--accent))]"
      />
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          className="h-2 w-2 shrink-0 rounded-[2px]"
          style={{ background: p.color || "rgb(var(--accent))" }}
        />
        <span className={cn("truncate text-[13px] font-medium", !connected && "text-text-muted")}>
          {p.name}
        </span>
        <span className="truncate font-mono text-[11.5px] text-text-dim">{profileAddress(p)}</span>
      </div>
      <span className="w-16 truncate font-mono text-[11px] text-text-muted">
        {PROTOCOL_LABEL[p.protocol]}
      </span>
      {ACCESS_COLUMNS.map((c) => {
        const applies = c.key === "exec" ? caps.exec : c.key === "sudo" ? caps.sudo : true;
        return applies ? (
          <AccessSeg
            key={c.key}
            value={access[c.key]}
            risky={c.risky}
            label={`${c.label} on ${p.name}`}
            onChange={(v) => onSet(c.key, v)}
          />
        ) : (
          <span key={c.key} className="w-[7.5rem] text-center text-[11px] text-text-dim">
            not available
          </span>
        );
      })}
      <span className="w-[4.5rem] text-right font-mono text-[11px] text-text-dim">
        {lastCall ? clockTime(lastCall).slice(0, 5) : "—"}
      </span>
    </div>
  );
}
