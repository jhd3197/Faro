import { useEffect, useMemo, useRef, useState } from "react";
import {
  X,
  Trash2,
  TerminalSquare,
  FileText,
  Download,
  Upload,
  Search,
  Ban,
  CircleAlert,
  Check,
  Loader2,
  Radio,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
  Filter,
  FileDown,
} from "lucide-react";
import { useBridge } from "@/stores/bridgeStore";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { ipc } from "@/lib/ipc";
import { toast } from "@/stores/toastStore";
import { cn } from "@/lib/cn";
import { relTime } from "@/lib/format";
import type { AgentConsoleEntry } from "@/lib/types";

// Build a plain-text transcript of the console for export — readable and
// paste-friendly for a bug report or feature request.
function buildExportText(
  entries: AgentConsoleEntry[],
  meta: Map<string, { name: string; color?: string }>
): string {
  const out: string[] = [
    "Faro Agent Console export",
    `Generated: ${new Date().toISOString()}`,
    `Entries: ${entries.length}`,
    "",
  ];
  for (const e of entries) {
    const who = meta.get(e.sessionId)?.name || e.sessionName || e.sessionId;
    const stat =
      e.status === "running"
        ? "running"
        : e.kind === "denied"
          ? "denied"
          : e.kind === "error" || e.ok === false
            ? "FAILED"
            : "ok";
    out.push(
      `[${new Date(e.at).toISOString()}] ${e.kind.toUpperCase()} · ${who} · ${stat}`
    );
    out.push(`  ${e.command}`);
    const body = e.output.replace(/\s+$/, "");
    if (body.length > 0) {
      out.push("  ----- output -----");
      for (const line of body.split("\n")) out.push(`  ${line}`);
      out.push("  ------------------");
    }
    out.push("");
  }
  return out.join("\n");
}

// A live, read-only view of everything the agent does through the bridge,
// docked at the bottom of the window so it stays visible while you work. Exec
// output streams in real time; every other op shows as a feed line. Entries
// collapse so a chatty agent doesn't bury the feed, and a per-session filter
// isolates one server when several are bridged at once.
export function AgentConsoleDock() {
  const entries = useBridge((s) => s.console);
  const clear = useBridge((s) => s.clearConsole);
  const setConsoleOpen = useLayout((s) => s.setConsoleOpen);
  const sessions = useConnections((s) => s.sessions);
  const profiles = useConnections((s) => s.profiles);

  const [filter, setFilter] = useState<string | "all">("all");
  // Per-entry open overrides; running entries default open, done default closed.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Label + tag color for a session id, resolved through the connection list.
  const sessionMeta = useMemo(() => {
    const map = new Map<string, { name: string; color?: string }>();
    for (const s of sessions) {
      const p = profiles.find((x) => x.id === s.profileId);
      if (p) map.set(s.sessionId, { name: p.name, color: p.color });
    }
    return map;
  }, [sessions, profiles]);

  // Sessions that actually appear in the feed, for the filter menu.
  const feedSessions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of entries) {
      if (!seen.has(e.sessionId)) {
        seen.set(
          e.sessionId,
          sessionMeta.get(e.sessionId)?.name || e.sessionName || e.sessionId
        );
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [entries, sessionMeta]);

  const shown = filter === "all" ? entries : entries.filter((e) => e.sessionId === filter);
  const running = entries.filter((e) => e.status === "running").length;

  // Keep the view pinned to the latest line unless the user scrolled up.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  const collapseAll = () => {
    const next: Record<string, boolean> = {};
    for (const e of entries) next[e.id] = false;
    setOverrides(next);
  };

  // Export what's currently shown (so the session filter doubles as a scope
  // selector) to a timestamped text file in the user's Downloads folder.
  const exportLogs = async () => {
    if (shown.length === 0) return;
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const name = `faro-agent-console-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(
      d.getDate()
    )}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.txt`;
    try {
      const path = await ipc.exportAgentLog(
        buildExportText(shown, sessionMeta),
        name
      );
      toast.success("Console exported", path);
    } catch (e) {
      toast.error("Couldn't export console", String(e));
    }
  };

  // Clear the active filter if its session disappears from the feed.
  useEffect(() => {
    if (filter !== "all" && !feedSessions.some((s) => s.id === filter)) {
      setFilter("all");
    }
  }, [filter, feedSessions]);

  return (
    <div className="flex h-full flex-col bg-bg-panel">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <Radio size={12} className="text-text-dim" />
        <span className="text-[12px] font-semibold text-text">Agent console</span>
        {entries.length > 0 && (
          <span className="text-xs tabular-nums text-text-dim">
            {running > 0 ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 size={11} className="animate-spin" /> {running} running
              </span>
            ) : (
              `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`
            )}
          </span>
        )}
        <div className="flex-1" />
        {feedSessions.length > 1 && (
          <SessionFilter
            value={filter}
            sessions={feedSessions}
            meta={sessionMeta}
            onChange={setFilter}
          />
        )}
        <ToolButton onClick={collapseAll} disabled={shown.length === 0} title="Collapse all output">
          <ChevronsDownUp size={12} />
        </ToolButton>
        <ToolButton
          onClick={exportLogs}
          disabled={shown.length === 0}
          title="Export console to a file (Downloads)"
        >
          <FileDown size={12} />
        </ToolButton>
        <ToolButton onClick={clear} disabled={entries.length === 0} title="Clear console">
          <Trash2 size={12} />
        </ToolButton>
        <ToolButton onClick={() => setConsoleOpen(false)} title="Close console">
          <X size={14} />
        </ToolButton>
      </div>

      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-w-0 flex-1 divide-y divide-border-subtle overflow-y-auto"
      >
        {shown.length === 0 ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-text-dim">
            {entries.length === 0
              ? "Agent commands and transfers show up here as they run."
              : "No activity for this server."}
          </div>
        ) : (
          shown.map((e) => (
            <ConsoleEntry
              key={e.id}
              entry={e}
              tag={feedSessions.length > 1 ? sessionMeta.get(e.sessionId) : undefined}
              open={overrides[e.id] ?? e.status === "running"}
              onToggle={() =>
                setOverrides((o) => ({
                  ...o,
                  [e.id]: !(o[e.id] ?? e.status === "running"),
                }))
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

function SessionFilter({
  value,
  sessions,
  meta,
  onChange,
}: {
  value: string | "all";
  sessions: { id: string; name: string }[];
  meta: Map<string, { name: string; color?: string }>;
  onChange: (v: string | "all") => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  const label = value === "all" ? "All servers" : meta.get(value)?.name || value;

  return (
    <div className="relative" ref={wrapRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-6 items-center gap-1 rounded border border-border px-2 text-xs text-text-muted hover:bg-bg-hover hover:text-text",
          open && "bg-bg-hover text-text"
        )}
      >
        <Filter size={11} />
        <span className="max-w-[9rem] truncate">{label}</span>
        <ChevronDown size={11} className="text-text-dim" />
      </button>
      {open && (
        <div className="anim-modal absolute right-0 top-7 z-menu w-52 overflow-hidden rounded border border-border bg-bg-panel shadow-elev-3">
          <FilterRow active={value === "all"} onClick={() => { onChange("all"); setOpen(false); }}>
            All servers
          </FilterRow>
          {sessions.map((s) => (
            <FilterRow
              key={s.id}
              active={value === s.id}
              color={meta.get(s.id)?.color}
              onClick={() => { onChange(s.id); setOpen(false); }}
            >
              {s.name}
            </FilterRow>
          ))}
        </div>
      )}
    </div>
  );
}

function FilterRow({
  active,
  color,
  onClick,
  children,
}: {
  active: boolean;
  color?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-bg-hover",
        active ? "text-text" : "text-text-muted"
      )}
    >
      {color !== undefined ? (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: color || "rgb(var(--accent))" }}
        />
      ) : (
        <span className="h-2 w-2 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {active && <Check size={12} className="shrink-0 text-text" />}
    </button>
  );
}

function ToolButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex h-6 w-6 items-center justify-center rounded text-text-dim hover:bg-bg-hover hover:text-text disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function KindIcon({ entry }: { entry: AgentConsoleEntry }) {
  const cls = "shrink-0";
  if (entry.status === "running") return <Loader2 size={12} className={cn(cls, "animate-spin text-text-muted")} />;
  if (entry.kind === "denied") return <Ban size={12} className={cn(cls, "text-warning")} />;
  if (entry.kind === "error" || entry.ok === false) return <CircleAlert size={12} className={cn(cls, "text-danger")} />;
  const muted = cn(cls, "text-text-dim");
  switch (entry.kind) {
    case "exec":
      return <TerminalSquare size={12} className={muted} />;
    case "read":
      return <FileText size={12} className={muted} />;
    case "search":
      return <Search size={12} className={muted} />;
    case "download":
      return <Download size={12} className={muted} />;
    case "upload":
      return <Upload size={12} className={muted} />;
    default:
      return <Check size={12} className={muted} />;
  }
}

function ConsoleEntry({
  entry,
  tag,
  open,
  onToggle,
}: {
  entry: AgentConsoleEntry;
  tag?: { name: string; color?: string };
  open: boolean;
  onToggle: () => void;
}) {
  const denied = entry.kind === "denied";
  const failed = !denied && (entry.kind === "error" || entry.ok === false);
  const hasOutput = entry.output.length > 0;
  const lineCount = hasOutput ? entry.output.split("\n").length : 0;

  return (
    <div data-console-entry={entry.kind} className={cn(open && hasOutput && "bg-bg-subtle/40")}>
      <button
        onClick={hasOutput ? onToggle : undefined}
        aria-expanded={hasOutput ? open : undefined}
        className={cn(
          "flex h-7 w-full items-center gap-2 px-3 text-left",
          hasOutput ? "hover:bg-bg-hover/60" : "cursor-default"
        )}
      >
        <span className="flex w-3 shrink-0 justify-center text-text-dim">
          {hasOutput && (open ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
        </span>
        <KindIcon entry={entry} />
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-mono text-[12px]",
            failed ? "text-danger" : denied ? "text-text-muted line-through decoration-text-dim" : "text-text"
          )}
          title={entry.command}
        >
          {entry.command}
        </span>
        {denied && <span className="shrink-0 text-xs text-warning">Denied</span>}
        {hasOutput && !open && (
          <span className="shrink-0 text-xs tabular-nums text-text-dim max-sm:hidden">
            {lineCount} {lineCount === 1 ? "line" : "lines"}
          </span>
        )}
        {tag && (
          <span className="flex shrink-0 items-center gap-1.5 text-xs text-text-dim max-sm:hidden">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: tag.color || "rgb(var(--text-dim))" }} />
            <span className="max-w-[8rem] truncate">{tag.name}</span>
          </span>
        )}
        <span className="w-8 shrink-0 text-right text-xs tabular-nums text-text-dim" title={new Date(entry.at).toLocaleString()}>
          {relTime(entry.at)}
        </span>
      </button>
      {hasOutput && open && (
        <pre className="selectable mb-2 ml-[2.75rem] mr-3 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-border-subtle bg-bg px-2.5 py-2 font-mono text-[11.5px] leading-relaxed text-text-muted [overflow-wrap:anywhere]">
          {entry.output}
        </pre>
      )}
    </div>
  );
}
