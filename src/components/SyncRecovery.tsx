import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Undo2 } from "lucide-react";
import { ipc } from "@/lib/ipc";
import type { SessionId, SyncRecoveryEntry } from "@/lib/types";

export function SyncRecovery({ sessionId, root, local, onRestored }: {
  sessionId: SessionId; root: string; local: boolean; onRestored: () => void;
}) {
  const [entries, setEntries] = useState<SyncRecoveryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    ipc.syncRecoveryList(sessionId, root, local).then(result => {
      if (active) setEntries(result);
    }).catch(e => { if (active) setError(String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, root, local, revision]);

  async function restore(entry: SyncRecoveryEntry) {
    setBusy(true);
    setError(null);
    setRestored(null);
    try {
      const path = await ipc.syncRecoveryRestore(sessionId, root, local, entry);
      setRestored(path);
      onRestored();
      setRevision(r => r + 1);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  return <div className="mx-4 mb-3 min-h-0 overflow-y-auto rounded-md border border-border bg-bg-subtle text-[11.5px]">
    <div className="flex items-center justify-between border-b border-border px-3 py-2">
      <span className="font-semibold">{local ? "Local" : "Remote"} recovery files</span>
      <button aria-label="Refresh recovery files" disabled={busy || loading} onClick={() => setRevision(r => r + 1)}
        className="rounded p-1 hover:bg-bg-hover disabled:opacity-40"><RefreshCw size={12} /></button>
    </div>
    <p className="break-all px-3 py-2 text-text-muted">
      {root} · Pause continuous sync before restoring. Restore keeps both files if the original name is occupied. Versions stay in .faro-sync-recovery until you restore or remove them.
    </p>
    {error && <p role="alert" className="break-all px-3 py-2 text-danger">{error}</p>}
    {restored && <p role="status" className="break-all px-3 py-2 text-success">Restored to {restored}</p>}
    {loading ? <div className="flex items-center gap-2 p-3"><Loader2 size={12} className="animate-spin" />Loading versions…</div>
      : !error && entries.length === 0 ? <p className="p-3 text-text-dim">No saved versions in this folder.</p>
      : entries.map(entry => {
        const saved = Number(entry.batch.split("-")[0]) * 1000;
        return <div key={`${entry.batch}/${entry.relative}`} className="flex items-center gap-2 border-t border-border-subtle px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono" title={entry.relative}>{entry.relative}</div>
            <div className="text-[10px] text-text-dim">{Number.isFinite(saved) ? new Date(saved).toLocaleString() : entry.batch} · {entry.size.toLocaleString()} bytes</div>
          </div>
          <button disabled={busy} onClick={() => void restore(entry)} aria-label={`Restore ${entry.relative}`}
            className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 hover:bg-bg-hover disabled:opacity-40">
            <Undo2 size={11} />Restore
          </button>
        </div>;
      })}
  </div>;
}
