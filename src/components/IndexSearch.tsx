import { createPortal } from "react-dom";
import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, File as FileIcon, Image as ImageIcon, Images, Loader2, MapPin, RefreshCw, Tag, Trash2, X } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { fmtSize } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useConnections } from "@/stores/connectionsStore";
import { useIndex } from "@/stores/indexStore";
import { useRules } from "@/stores/rulesStore";
import { toast } from "@/stores/toastStore";
import { Dropdown } from "@/components/ui/Dropdown";
import type { IndexFacets, IndexQuery, IndexRow } from "@/lib/types";

const KINDS = ["image", "video", "audio", "document", "archive", "other"] as const;

/** Mount point: renders the overlay only while it's open. */
export function IndexSearchHost() {
  const open = useIndex((s) => s.open);
  return open ? <IndexSearch /> : null;
}

function dayMs(iso: string, end: boolean): number | null {
  if (!iso) return null;
  const t = Date.parse(`${iso}T${end ? "23:59:59" : "00:00:00"}Z`);
  return Number.isFinite(t) ? t : null;
}

function fmtTaken(ms?: number | null): string {
  if (!ms) return "";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

/// Search indexed files without downloading them: filter by kind, date taken,
/// camera, tag and location; thumbnails come from the index's cache. Select
/// results to tag them.
function IndexSearch() {
  const close = useIndex((s) => s.closeSearch);
  const scope = useIndex((s) => s.scope);
  const roots = useIndex((s) => s.roots);
  const profiles = useConnections((s) => s.profiles);

  const [connectionId, setConnectionId] = useState<string>(scope?.connectionId ?? "");
  const [text, setText] = useState("");
  const [kinds, setKinds] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [camera, setCamera] = useState("");
  const [tag, setTag] = useState("");
  const [gpsOnly, setGpsOnly] = useState(false);
  const [rows, setRows] = useState<IndexRow[]>([]);
  const [facets, setFacets] = useState<IndexFacets>({ cameras: [], tags: [], files: 0 });
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [revision, setRevision] = useState(0);
  // View rules: a rule set's view folders over the index.
  const ruleSets = useRules((s) => s.sets);
  const [viewSet, setViewSet] = useState("");
  const [views, setViews] = useState<Record<string, IndexRow[]>>({});
  const [activeView, setActiveView] = useState<string | null>(null);
  useEffect(() => {
    setActiveView(null);
    if (!viewSet) {
      setViews({});
      return;
    }
    void ipc
      .rulesViews(viewSet, connectionId || null)
      .then(setViews)
      .catch((e) => toast.error("Couldn't build view folders", String(e)));
  }, [viewSet, connectionId, revision]);

  const query: IndexQuery = useMemo(
    () => ({
      connectionId: connectionId || null,
      under: scope?.connectionId === connectionId ? scope?.under ?? null : null,
      text: text.trim() || null,
      kinds,
      takenFromMs: dayMs(from, false),
      takenToMs: dayMs(to, true),
      camera: camera || null,
      tag: tag || null,
      hasGps: gpsOnly ? true : null,
      limit: 1000,
    }),
    [connectionId, scope, text, kinds, from, to, camera, tag, gpsOnly]
  );

  useEffect(() => {
    let stale = false;
    setLoading(true);
    const t = setTimeout(() => {
      void Promise.all([ipc.indexSearch(query), ipc.indexFacets(connectionId || null)])
        .then(([r, f]) => {
          if (stale) return;
          setRows(r);
          setFacets(f);
          setSelected((sel) => new Set([...sel].filter((k) => r.some((x) => key(x) === k))));
        })
        .catch((e) => !stale && toast.error("Search failed", String(e)))
        .finally(() => !stale && setLoading(false));
    }, 150);
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [query, connectionId, revision]);

  // Re-run when an indexing pass finishes.
  const runningCount = roots.filter((r) => r.running).length;
  const lastRunning = useRef(runningCount);
  useEffect(() => {
    if (runningCount < lastRunning.current) setRevision((v) => v + 1);
    lastRunning.current = runningCount;
  }, [runningCount]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const nameOf = (cid: string) => profiles.find((p) => p.id === cid)?.name ?? "removed connection";
  const key = (r: IndexRow) => `${r.connectionId}\u0001${r.path}`;
  const shown = activeView ? views[activeView] ?? [] : rows;
  const picked = shown.filter((r) => selected.has(key(r)));

  const toggle = (r: IndexRow, additive: boolean) =>
    setSelected((s) => {
      const k = key(r);
      const next = new Set(additive ? s : []);
      if (s.has(k) && (additive || s.size === 1)) next.delete(k);
      else next.add(k);
      return next;
    });

  const tagSelection = () => {
    const byConn = new Map<string, string[]>();
    for (const r of picked) byConn.set(r.connectionId, [...(byConn.get(r.connectionId) ?? []), r.path]);
    if (byConn.size !== 1) {
      toast.info("Pick files from one connection", "Tags are applied per connection.");
      return;
    }
    const [[cid, paths]] = [...byConn];
    useIndex.getState().openTags({ connectionId: cid, paths });
  };

  return createPortal(
    <div className="anim-modal fixed inset-0 z-modal flex flex-col bg-bg" data-testid="index-search">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-panel px-3 py-2">
        <Images size={15} className="shrink-0 text-accent" />
        <span className="shrink-0 text-sm font-semibold">Indexed files</span>
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Name or folder…"
          aria-label="Search indexed files"
          className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[12px]"
        />
        <span className="shrink-0 text-[11px] text-text-dim">
          {loading ? <Loader2 size={12} className="animate-spin" /> : activeView ? `${shown.length} in ${activeView}` : `${rows.length}${rows.length >= 1000 ? "+" : ""} of ${facets.files}`}
        </span>
        <button onClick={close} aria-label="Close" className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text">
          <X size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Filters + indexed folders */}
        <aside className="flex w-60 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-bg-panel p-3 text-[12px]">
          <div className="flex flex-col gap-1">
            <span className="text-text-dim">Connection</span>
            <Dropdown
              aria-label="Connection"
              value={connectionId}
              options={[{ value: "", label: "All connections" }, ...profiles.map((p) => ({ value: p.id, label: p.name }))]}
              onChange={setConnectionId}
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-text-dim">Kind</span>
            <div className="flex flex-wrap gap-1">
              {KINDS.map((k) => (
                <button
                  key={k}
                  aria-pressed={kinds.includes(k)}
                  onClick={() => setKinds((v) => (v.includes(k) ? v.filter((x) => x !== k) : [...v, k]))}
                  className={cn(
                    "rounded border px-1.5 py-0.5 capitalize",
                    kinds.includes(k) ? "border-accent text-text" : "border-border text-text-muted hover:text-text"
                  )}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-text-dim">Taken</span>
            <input type="date" aria-label="Taken from" value={from} onChange={(e) => setFrom(e.target.value)} className="rounded border border-border bg-bg px-1.5 py-0.5" />
            <input type="date" aria-label="Taken to" value={to} onChange={(e) => setTo(e.target.value)} className="rounded border border-border bg-bg px-1.5 py-0.5" />
          </div>
          {facets.cameras.length > 0 && (
            <div className="flex flex-col gap-1">
              <span className="text-text-dim">Camera</span>
              <Dropdown
                aria-label="Camera"
                value={camera}
                options={[{ value: "", label: "Any camera" }, ...facets.cameras.map((c) => ({ value: c, label: c }))]}
                onChange={setCamera}
              />
            </div>
          )}
          <div className="flex flex-col gap-1">
            <span className="text-text-dim">Tag</span>
            <Dropdown
              aria-label="Tag"
              value={tag}
              options={[{ value: "", label: "Any tag" }, ...facets.tags.map((t) => ({ value: t, label: t }))]}
              onChange={setTag}
            />
          </div>
          <label className="flex items-center gap-2 text-text-muted">
            <input type="checkbox" checked={gpsOnly} onChange={(e) => setGpsOnly(e.target.checked)} />
            Has a location
          </label>

          {ruleSets.some((r) => r.rules.some((x) => x.kind === "view")) && (
            <div className="flex flex-col gap-1 border-t border-border pt-2" data-index-views="">
              <span className="text-text-dim">View folders</span>
              <Dropdown
                aria-label="Rule set views"
                value={viewSet}
                options={[
                  { value: "", label: "None" },
                  ...ruleSets.filter((r) => r.rules.some((x) => x.kind === "view")).map((r) => ({ value: r.id, label: r.name })),
                ]}
                onChange={setViewSet}
              />
              {Object.entries(views).map(([name, list]) => (
                <button
                  key={name}
                  data-view={name}
                  onClick={() => setActiveView(activeView === name ? null : name)}
                  className={cn(
                    "flex items-center justify-between rounded px-1.5 py-0.5 text-left",
                    activeView === name ? "bg-bg-hover text-text" : "text-text-muted hover:text-text"
                  )}
                >
                  <span className="truncate">{name}</span>
                  <span className="text-[10px] text-text-dim">{list.length}</span>
                </button>
              ))}
              {viewSet && Object.keys(views).length === 0 && <span className="text-text-dim">No indexed files match its view rules.</span>}
            </div>
          )}

          <div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
            <span className="text-text-dim">Indexed folders</span>
            {roots.length === 0 && (
              <span className="text-text-dim">
                None yet. Right-click a remote folder › Index this folder, or turn on Index files for a mount.
              </span>
            )}
            {roots.map((r) => (
              <div key={`${r.connectionId}:${r.root}`} className="flex items-center gap-1" data-index-root={r.root}>
                <span className="min-w-0 flex-1 truncate" title={`${nameOf(r.connectionId)}:${r.root}`}>
                  <span className="text-text-dim">{nameOf(r.connectionId)}:</span>
                  <span className="font-mono">{r.root}</span>
                </span>
                <span className="shrink-0 text-[10px] text-text-dim">
                  {r.running ? `${r.done}/${r.total}` : `${r.files}`}
                </span>
                <button
                  title="Index again now"
                  aria-label="Index again"
                  disabled={r.running}
                  onClick={() => void ipc.indexRefresh(r.connectionId, r.root).then(() => useIndex.getState().refreshRoots())}
                  className="text-text-dim hover:text-text disabled:opacity-40"
                >
                  <RefreshCw size={11} className={cn(r.running && "animate-spin")} />
                </button>
                <button
                  title="Stop indexing and forget this folder"
                  aria-label="Forget folder"
                  onClick={() =>
                    void ipc
                      .indexForget(r.connectionId, r.root)
                      .then(() => useIndex.getState().refreshRoots())
                      .then(() => setRevision((v) => v + 1))
                  }
                  className="text-text-dim hover:text-danger"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* Results */}
        <main className="flex min-w-0 flex-1 flex-col">
          {picked.length > 0 && (
            <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-subtle px-3 py-1.5 text-[12px]">
              <span>{picked.length} selected</span>
              <button onClick={tagSelection} className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-bg-hover">
                <Tag size={12} /> Tags…
              </button>
              <button
                onClick={() => void navigator.clipboard.writeText(picked.map((r) => r.path).join("\n"))}
                className="flex items-center gap-1 rounded px-2 py-0.5 hover:bg-bg-hover"
              >
                <Copy size={12} /> Copy paths
              </button>
              <button onClick={() => setSelected(new Set())} className="ml-auto text-text-dim hover:text-text">
                Clear
              </button>
            </div>
          )}
          <div className="grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2 overflow-y-auto p-3">
            {shown.map((r) => (
              <ResultCard
                key={key(r)}
                row={r}
                connection={nameOf(r.connectionId)}
                selected={selected.has(key(r))}
                onClick={(e) => toggle(r, e.ctrlKey || e.metaKey || e.shiftKey)}
              />
            ))}
            {!loading && shown.length === 0 && (
              <div className="col-span-full py-12 text-center text-[12px] text-text-dim">
                {facets.files === 0 ? "Nothing indexed yet." : "No indexed files match."}
              </div>
            )}
          </div>
        </main>
      </div>
    </div>,
    document.body
  );
}

function ResultCard({
  row,
  connection,
  selected,
  onClick,
}: {
  row: IndexRow;
  connection: string;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const ref = useRef<HTMLButtonElement>(null);

  // Load the thumbnail once the card scrolls into view.
  useEffect(() => {
    if (row.kind !== "image" || !ref.current) return;
    let done = false;
    const io = new IntersectionObserver((entries) => {
      if (done || !entries.some((e) => e.isIntersecting)) return;
      done = true;
      io.disconnect();
      void ipc
        .indexThumbnail(row.connectionId, row.path)
        .then(setThumb)
        .catch(() => {});
    });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [row.connectionId, row.path, row.kind]);

  const facts = [
    row.width && row.height ? `${row.width}×${row.height}` : null,
    fmtSize(row.size),
    row.camera,
  ].filter(Boolean);

  return (
    <button
      ref={ref}
      onClick={onClick}
      data-index-result={row.path}
      title={`${connection}:${row.path}`}
      className={cn(
        "flex flex-col overflow-hidden rounded border text-left text-[11px]",
        selected ? "border-accent bg-accent-soft" : "border-border hover:bg-bg-hover"
      )}
    >
      <div className="flex h-24 items-center justify-center bg-bg-subtle">
        {thumb ? (
          <img src={`data:image/png;base64,${thumb}`} alt="" className="max-h-24 max-w-full object-contain" />
        ) : row.kind === "image" ? (
          <ImageIcon size={20} className="text-text-dim" />
        ) : (
          <FileIcon size={20} className="text-text-dim" />
        )}
      </div>
      <div className="flex flex-col gap-0.5 p-1.5">
        <span className="truncate text-text">{row.name}</span>
        <span className="truncate text-text-dim">{fmtTaken(row.takenMs) || facts.join(" · ")}</span>
        {row.takenMs && facts.length > 0 && <span className="truncate text-text-dim">{facts.join(" · ")}</span>}
        <span className="flex items-center gap-1 truncate text-text-dim">
          {row.gpsLat != null && <MapPin size={9} />}
          {row.tags.map((t) => (
            <span key={t} className="rounded bg-bg-hover px-1">
              {t}
            </span>
          ))}
        </span>
      </div>
    </button>
  );
}
