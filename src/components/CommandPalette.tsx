import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Plug, Plus, Search } from "lucide-react";
import { isComposing } from "@faro/file-ui";
import { useLayout } from "@/stores/layoutStore";
import { useConnections } from "@/stores/connectionsStore";
import { usePalette } from "@/stores/paletteStore";
import { type Command } from "@/lib/commands";
import { useResolvedCommands } from "@/lib/keybindings";
import { useDialog } from "@/hooks/useDialog";
import { matchCommand } from "@/lib/paletteMatch";
import { searchRank } from "@/lib/serverSearch";
import { formatCombo } from "@/lib/shortcuts";
import { PROTOCOL_LABEL, type ConnectionProfile } from "@/lib/types";
import { cn } from "@/lib/cn";

type Row =
  | { kind: "cmd"; c: Command; ranges: [number, number][]; keywordHits: string[] }
  | { kind: "server"; p: ConnectionProfile }
  | { kind: "searchServers"; q: string }
  | { kind: "newConnection" };

interface Section {
  label?: string;
  rows: Row[];
}

/** How far PageUp / PageDown move the selection. */
const PAGE = 5;

export function CommandPalette() {
  const open = useLayout((s) => s.paletteOpen);
  const setOpen = useLayout((s) => s.setPaletteOpen);
  const commands = useResolvedCommands();
  const profiles = useConnections((s) => s.profiles);
  const sessions = useConnections((s) => s.sessions);
  const recent = usePalette((s) => s.recent);
  const [query, setQuery] = useState("");
  // "servers": the no-results suggestion was taken; the query now searches
  // saved servers the way the rail's search does.
  const [mode, setMode] = useState<"commands" | "servers">("commands");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  // Esc peels one layer: server search back to commands, then the typed
  // query, then the palette itself.
  useDialog(panelRef, {
    onClose: () => {
      if (mode === "servers") {
        setMode("commands");
        setActive(0);
      } else if (query) {
        setQuery("");
        setActive(0);
      } else setOpen(false);
      inputRef.current?.focus();
    },
    enabled: open,
    initialFocus: inputRef,
  });

  useEffect(() => {
    if (open) {
      setQuery("");
      setMode("commands");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const sections = useMemo<Section[]>(() => {
    const live = commands.filter((c) => c.enabled !== false);
    const q = query.trim();

    if (mode === "servers") {
      const hits = searchRank(profiles, q, (p) => [
        { text: p.name, weight: 40 },
        { text: p.group, weight: 25 },
        { text: p.host, weight: 20 },
        { text: p.username, weight: 10 },
        { text: p.bucket, weight: 10 },
        { text: p.account, weight: 10 },
        { text: PROTOCOL_LABEL[p.protocol], weight: 0 },
      ]);
      return [{ label: "Servers", rows: hits.map((p) => ({ kind: "server" as const, p })) }];
    }

    const asRow = (c: Command): Row => ({ kind: "cmd", c, ranges: [], keywordHits: [] });
    if (!q) {
      // Never blank: what you ran last, then your servers, then the rest.
      const byId = new Map(live.map((c) => [c.id, c]));
      const rec = recent.map((id) => byId.get(id)).filter((c): c is Command => !!c);
      const seen = new Set(rec.map((c) => c.id));
      const servers = live.filter((c) => c.id.startsWith("connect:") && !seen.has(c.id));
      servers.forEach((c) => seen.add(c.id));
      const rest = live.filter((c) => !seen.has(c.id));
      return [
        { label: "Recent", rows: rec.map(asRow) },
        { label: "Servers", rows: servers.map(asRow) },
        { label: "All commands", rows: rest.map(asRow) },
      ].filter((s) => s.rows.length > 0);
    }

    const ranked: { row: Row; score: number }[] = [];
    for (const c of live) {
      const m = matchCommand(q, c.title, c.keywords);
      if (m) ranked.push({ row: { kind: "cmd", c, ranges: m.ranges, keywordHits: m.keywordHits }, score: m.score });
    }
    ranked.sort((a, b) => b.score - a.score);
    if (ranked.length) return [{ rows: ranked.map((r) => r.row) }];
    return [
      {
        rows: [profiles.length ? { kind: "searchServers", q } : { kind: "newConnection" }],
      },
    ];
  }, [commands, query, mode, recent, profiles]);

  const rows = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const noCommands = mode === "commands" && rows.length === 1 && rows[0].kind !== "cmd";

  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, rows.length - 1)));
  }, [rows.length]);

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  const close = () => setOpen(false);
  const runRow = (r: Row) => {
    switch (r.kind) {
      case "cmd":
        usePalette.getState().record(r.c.id);
        close();
        setTimeout(() => r.c.run(), 0);
        return;
      case "server":
        close();
        useConnections.getState().connect(r.p.id).catch(() => {});
        return;
      case "searchServers":
        setMode("servers");
        setActive(0);
        inputRef.current?.focus();
        return;
      case "newConnection":
        close();
        setTimeout(() => useLayout.getState().openNewConnection(), 0);
        return;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = rows.length;
    const move = (to: number) => {
      e.preventDefault();
      setActive(n ? to : 0);
    };
    switch (e.key) {
      case "ArrowDown":
        return move((active + 1) % Math.max(n, 1));
      case "ArrowUp":
        return move((active - 1 + n) % Math.max(n, 1));
      case "PageDown":
        return move(Math.min(active + PAGE, n - 1));
      case "PageUp":
        return move(Math.max(active - PAGE, 0));
      case "Home":
        return move(0);
      case "End":
        return move(n - 1);
      case "Enter": {
        if (isComposing(e)) return;
        e.preventDefault();
        const r = rows[active];
        if (r) runRow(r);
        return;
      }
    }
  };

  const escLabel = mode === "servers" ? "back" : query ? "clear" : "close";
  const enterLabel =
    rows[active]?.kind === "searchServers" ? "search" : "run";
  let idx = 0;

  return (
    <div
      className="fixed inset-0 z-palette flex items-start justify-center bg-black/50 pt-[12vh] backdrop-blur-sm"
      onClick={close}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        className="anim-modal flex max-h-[70vh] w-[34rem] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
          <Search size={15} className="shrink-0 text-text-dim" />
          {mode === "servers" && (
            <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">
              Servers
            </span>
          )}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder={mode === "servers" ? "Search servers…" : "Type a command or search…"}
            role="combobox"
            aria-expanded={rows.length > 0}
            aria-controls={listId}
            aria-activedescendant={rows.length ? optionId(active) : undefined}
            aria-label={mode === "servers" ? "Search servers" : "Search commands"}
            className="w-full bg-transparent text-sm outline-none placeholder:text-text-dim"
          />
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={mode === "servers" ? "Servers" : "Commands"}
          className="overflow-y-auto py-1"
        >
          {noCommands && (
            <div data-palette-empty="" className="px-4 pb-1 pt-3 text-xs text-text-dim">
              {`No commands match “${query.trim()}”.`}
            </div>
          )}
          {mode === "servers" && rows.length === 0 && (
            <div data-palette-empty="" className="px-4 py-8 text-center text-xs text-text-dim">
              {query.trim() ? `No servers match “${query.trim()}”.` : "No saved servers yet."}
            </div>
          )}
          {sections.map((s, si) => (
            <div key={s.label ?? si} role="group" aria-label={s.label}>
              {s.label && (
                <div
                  data-palette-section={s.label}
                  className="px-3.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-text-dim"
                >
                  {s.label}
                </div>
              )}
              {s.rows.map((r) => {
                const i = idx++;
                return (
                  <PaletteRow
                    key={rowKey(r)}
                    row={r}
                    i={i}
                    id={optionId(i)}
                    active={i === active}
                    connected={r.kind === "server" && sessions.some((x) => x.profileId === r.p.id)}
                    onHover={() => setActive(i)}
                    onRun={() => runRow(r)}
                  />
                );
              })}
            </div>
          ))}
        </div>
        <div
          data-palette-footer=""
          className="flex items-center gap-3 border-t border-border bg-bg-subtle px-3.5 py-1.5 text-[11px] text-text-dim"
        >
          <Hint keys={["↑", "↓"]} label="navigate" />
          <Hint keys={["PgUp", "PgDn"]} label="jump" />
          <Hint keys={["↵"]} label={enterLabel} />
          <Hint keys={["Esc"]} label={escLabel} />
        </div>
      </div>
    </div>
  );
}

function rowKey(r: Row): string {
  switch (r.kind) {
    case "cmd":
      return r.c.id;
    case "server":
      return `server:${r.p.id}`;
    default:
      return r.kind;
  }
}

function PaletteRow({
  row: r,
  i,
  id,
  active,
  connected,
  onHover,
  onRun,
}: {
  row: Row;
  i: number;
  id: string;
  active: boolean;
  connected: boolean;
  onHover: () => void;
  onRun: () => void;
}) {
  const data =
    r.kind === "cmd"
      ? { "data-command-id": r.c.id }
      : r.kind === "server"
        ? { "data-server-id": r.p.id }
        : { "data-palette-suggest": r.kind };
  const icon =
    r.kind === "cmd" ? r.c.icon : r.kind === "newConnection" ? <Plus size={14} /> : r.kind === "server" ? <Plug size={14} /> : <Search size={14} />;
  return (
    <button
      {...data}
      data-idx={i}
      role="option"
      id={id}
      aria-selected={active}
      tabIndex={-1}
      onMouseMove={onHover}
      onClick={onRun}
      className={cn(
        "flex w-full items-center gap-2.5 px-3.5 py-2 text-left text-sm",
        active ? "bg-accent/15 text-text" : "text-text-muted"
      )}
    >
      <span
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center",
          active ? "text-accent" : "text-text-dim"
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">
        {r.kind === "cmd" && (
          <>
            <Highlight text={r.c.title} ranges={r.ranges} />
            {r.keywordHits.length > 0 && (
              <span data-palette-why="" className="ml-2 text-xs text-text-dim">
                {`matches: ${r.keywordHits.join(", ")}`}
              </span>
            )}
          </>
        )}
        {r.kind === "server" && (
          <>
            {r.p.name}
            <span className="ml-2 text-xs text-text-dim">
              {r.p.username ? `${r.p.username}@` : ""}
              {r.p.host}
            </span>
          </>
        )}
        {r.kind === "searchServers" && `Search servers for “${r.q}”`}
        {r.kind === "newConnection" && <>New connection…</>}
      </span>
      {r.kind === "cmd" && (
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-dim">
          {r.c.group}
        </span>
      )}
      {r.kind === "server" && connected && (
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-text-dim">Open</span>
      )}
      {r.kind === "cmd" && r.c.combo && <Keycap>{formatCombo(r.c.combo)}</Keycap>}
    </button>
  );
}

function Keycap({ children }: { children: ReactNode }) {
  return (
    <kbd className="shrink-0 rounded border border-border bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-dim">
      {children}
    </kbd>
  );
}

function Hint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1">
      {keys.map((k) => (
        <kbd
          key={k}
          className="rounded border border-border bg-bg-panel px-1 font-mono text-[10px] text-text-muted"
        >
          {k}
        </kbd>
      ))}
      <span>{label}</span>
    </span>
  );
}

function Highlight({
  text,
  ranges,
}: {
  text: string;
  ranges: [number, number][];
}) {
  if (!ranges.length) return <>{text}</>;
  const out: ReactNode[] = [];
  let i = 0;
  ranges.forEach(([s, e], k) => {
    if (s > i) out.push(<span key={`n${k}`}>{text.slice(i, s)}</span>);
    out.push(
      <mark key={`h${k}`} className="bg-transparent font-semibold text-accent">
        {text.slice(s, e)}
      </mark>
    );
    i = e;
  });
  if (i < text.length) out.push(<span key="end">{text.slice(i)}</span>);
  return <>{out}</>;
}
