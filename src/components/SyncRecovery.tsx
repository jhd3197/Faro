import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Undo2 } from "lucide-react";
import { ipc } from "@/lib/ipc";
import type { SessionId, SyncRecoveryEntry } from "@/lib/types";

export function SyncRecovery({ sessionId, root, local, onRestored }: {
  sessionId: SessionId; root: string; local: boolean; onRestored: () => void;
}) {
  const [staging, setStaging] = useState(false);
  const [days, setDays] = useState(30);
  const [confirmCleanup, setConfirmCleanup] = useState(false);
  const [entries, setEntries] = useState<SyncRecoveryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setConfirmCleanup(false);
    setError(null);
    ipc.syncRecoveryList(sessionId, root, local, staging).then(result => {
      if (active) setEntries(result);
    }).catch(e => { if (active) setError(String(e)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [sessionId, root, local, staging, revision]);

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

  const candidates = entries.filter(entry => { const created = Number(entry.batch.split("-")[0]); return created > 0 && created * 1000 < Date.now() - days * 86400000; });
  async function cleanup() {
    setBusy(true); setError(null);
    try { await ipc.syncRecoveryPurge(sessionId, root, local, staging, days, candidates); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); setConfirmCleanup(false); setRevision(r => r + 1); }
  }

  return <div className="mx-4 mb-3 min-h-0 overflow-y-auto rounded-md border border-border bg-bg-subtle text-[11.5px]">
    <div className="flex items-center justify-between border-b border-border px-3 py-2">
      <span className="font-semibold">{local ? "Local" : "Remote"} {staging ? "staging" : "recovery"} files</span>
      <button aria-label="Refresh recovery files" disabled={busy || loading} onClick={() => setRevision(r => r + 1)}
        className="rounded p-1 hover:bg-bg-hover disabled:opacity-40"><RefreshCw size={12} /></button>
    </div>
    <div className="flex flex-wrap items-center gap-2 px-3 pt-2">
      <select aria-label="Sync storage area" disabled={busy} value={staging ? "staging" : "recovery"} onChange={e => setStaging(e.target.value === "staging")} className="rounded border border-border bg-bg-panel px-2 py-1"><option value="recovery">Saved versions</option><option value="staging">Staged files</option></select>
      <select aria-label="Cleanup retention" disabled={busy} value={days} onChange={e => { setDays(Number(e.target.value)); setConfirmCleanup(false); }} className="rounded border border-border bg-bg-panel px-2 py-1">{[7, 30, 90, 365].map(n => <option key={n} value={n}>Keep {n} days</option>)}</select>
      <button disabled={busy || loading || !candidates.length} onClick={() => setConfirmCleanup(true)} className="rounded border border-border px-2 py-1 disabled:opacity-40">Review cleanup ({candidates.length})</button>
    </div>
    {confirmCleanup && <div className="m-3 rounded border border-danger/40 p-2 text-danger">
      <p>Permanently delete the {candidates.length} files shown below that are older than {days} days? Pause sync on all devices first. This cannot be undone.</p>
      <button disabled={busy} onClick={() => void cleanup()} className="mt-2 rounded border border-danger px-2 py-1">Delete {candidates.length} files permanently</button>
      <button disabled={busy} onClick={() => setConfirmCleanup(false)} className="ml-2 px-2 py-1">Cancel</button>
    </div>}
    <p className="break-all px-3 py-2 text-text-muted">
      {root} · Pause continuous sync before restoring. Restore keeps both files if the original name is occupied. Saved versions stay until restored or removed. Staging may contain incomplete transfers and is available for cleanup only.
    </p>
    {error && <p role="alert" className="break-all px-3 py-2 text-danger">{error}</p>}
    {restored && <p role="status" className="break-all px-3 py-2 text-success">Restored to {restored}</p>}
    {loading ? <div className="flex items-center gap-2 p-3"><Loader2 size={12} className="animate-spin" />Loading versions…</div>
      : !error && entries.length === 0 ? <p className="p-3 text-text-dim">No saved versions in this folder.</p>
      : (confirmCleanup ? candidates : entries).map(entry => {
        const saved = Number(entry.batch.split("-")[0]) * 1000;
        return <div key={`${entry.batch}/${entry.relative}`} className="flex items-center gap-2 border-t border-border-subtle px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate font-mono" title={entry.relative}>{entry.relative}</div>
            <div className="text-[10px] text-text-dim">{Number.isFinite(saved) ? new Date(saved).toLocaleString() : entry.batch} · {entry.size.toLocaleString()} bytes</div>
          </div>
          {!staging && <button disabled={busy || confirmCleanup} onClick={() => void restore(entry)} aria-label={`Restore ${entry.relative}`}
            className="flex shrink-0 items-center gap-1 rounded border border-border px-2 py-1 hover:bg-bg-hover disabled:opacity-40">
            <Undo2 size={11} />Restore
          </button>}
        </div>;
      })}
  </div>;
}
