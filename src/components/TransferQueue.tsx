import { useEffect, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  X,
  ChevronDown,
  ChevronUp,
  Trash2,
  ArrowDownUp,
  Pause,
  Play,
  RotateCcw,
} from "lucide-react";
import { useTransfers } from "@/stores/transfersStore";
import type { Transfer } from "@/lib/types";
import { cn } from "@/lib/cn";
import { fmtEta, fmtRate } from "@/lib/format";
import { toastError } from "@/lib/errors";

export function TransferQueue() {
  const {
    byId,
    panelOpen,
    setPanelOpen,
    cancel,
    clearFinished,
    initListeners,
    loadInitial,
    queue,
    pausedAll,
    throttleKbps,
    pauseAll,
    resumeAll,
    setThrottle,
    pause,
    resume,
    retry,
    move,
  } = useTransfers();

  useEffect(() => {
    // Listeners first, so a failed initial load can't leave the queue deaf
    // for the whole session; the cancelled flag drops a listener that
    // resolves after unmount (StrictMode) instead of leaking a duplicate.
    let unsub: (() => void) | undefined;
    let cancelled = false;
    initListeners().then((u) => {
      if (cancelled) u();
      else unsub = u;
    });
    loadInitial().catch((e) => toastError(e, "Load transfers"));
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [initListeners, loadInitial]);

  const transfers = Object.values(byId).sort((a, b) => b.startedAt - a.startedAt);
  if (!panelOpen) return null;

  const active = transfers.filter(
    (t) => t.status === "transferring" || t.status === "paused"
  ).length;
  const queued = queue.length;
  const totalSpeed = transfers.reduce(
    (sum, t) => sum + (t.status === "transferring" ? t.bytesPerSec ?? 0 : 0),
    0
  );

  return (
    <div className="anim-slide-up flex max-h-64 flex-col border-t border-border bg-bg-panel">
      <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-3 py-1.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-text-muted">
          Transfers
        </span>
        {(active > 0 || queued > 0) && (
          <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            {active} active · {queued} queued
          </span>
        )}
        {totalSpeed > 0 && (
          <span className="text-[11px] text-text-muted" title="Combined speed of running transfers">
            {fmtRate(totalSpeed)}
          </span>
        )}
        <div className="flex-1" />
        <ThrottleInput value={throttleKbps} onCommit={setThrottle} />
        <button
          onClick={() => (pausedAll ? resumeAll() : pauseAll())}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"
          title={pausedAll ? "Resume all" : "Pause all"}
        >
          {pausedAll ? <Play size={12} /> : <Pause size={12} />}
        </button>
        <button
          onClick={clearFinished}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"
          title="Clear finished"
        >
          <Trash2 size={12} />
        </button>
        <button
          onClick={() => setPanelOpen(false)}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"
          title="Hide"
        >
          <ChevronDown size={14} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {transfers.length === 0 && (
          <div className="flex flex-col items-center justify-center px-3 py-8 text-center anim-fade">
            <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl bg-bg-subtle text-text-dim">
              <ArrowDownUp size={16} />
            </div>
            <div className="text-xs text-text-dim">
              No transfers yet. Drag files between panes to begin.
            </div>
          </div>
        )}
        {transfers.map((t) => (
          <Row
            key={t.id}
            t={t}
            queue={queue}
            onCancel={() => cancel(t.id)}
            onPause={() => pause(t.id)}
            onResume={() => resume(t.id)}
            onRetry={() => retry(t.id)}
            onMove={(dir) => move(t.id, dir)}
          />
        ))}
      </div>
    </div>
  );
}

/** Global bandwidth cap (KiB/s, 0 = unlimited). Commits on blur or Enter. */
function ThrottleInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (kbps: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // Follow external changes (settings sync / other windows) while not editing.
  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const n = Math.max(0, parseInt(draft) || 0);
    setDraft(String(n));
    if (n !== value) onCommit(n);
  };

  return (
    <span className="flex items-center gap-1" title="Bandwidth limit (KiB/s, 0 = unlimited)">
      <input
        type="number"
        min={0}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-14 rounded border border-border bg-bg-panel px-1.5 py-0.5 text-[11px] text-text outline-none focus:border-accent"
      />
      <span className="text-[10px] text-text-dim">KiB/s</span>
    </span>
  );
}

function Row({
  t,
  queue,
  onCancel,
  onPause,
  onResume,
  onRetry,
  onMove,
}: {
  t: Transfer;
  queue: string[];
  onCancel: () => void;
  onPause: () => void;
  onResume: () => void;
  onRetry: () => void;
  onMove: (dir: "up" | "down") => void;
}) {
  const Icon = t.kind === "download" ? ArrowDownToLine : ArrowUpFromLine;
  const pct = t.size > 0 ? Math.min(100, (t.transferred / t.size) * 100) : 0;
  // Mid-auto-retry: the error text reads "retrying in Ns (attempt N/3)".
  const retrying = t.retryAttempt !== undefined && !!t.error;
  const queuePos = queue.indexOf(t.id);

  const stalled = t.status === "transferring" && !!t.stalled;
  const statusLabel =
    stalled
      ? "not responding"
      : t.status === "transferring"
      ? `${pct.toFixed(0)}%`
      : t.status === "done"
        ? "done"
        : t.status === "error"
          ? "error"
          : t.status === "canceled"
            ? "canceled"
            : t.status === "paused"
              ? "Paused"
              : t.status === "queued" && queuePos >= 0
                ? `#${queuePos + 1} in queue`
                : t.status;

  return (
    <div className="flex items-center gap-3 border-b border-border-subtle px-3 py-2 text-sm">
      <Icon
        size={14}
        className={cn(
          t.kind === "download" ? "text-info" : "text-success"
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs">{t.source}</div>
        <div className="truncate text-[11px] text-text-dim">
          → {t.destination}
        </div>
        {t.delta && <DeltaBadge delta={t.delta} />}
        {t.notice && (
          <div className="mt-0.5 text-[11px] text-warning">{t.notice}</div>
        )}
        {t.restored && (
          <div className="mt-0.5 text-[11px] text-text-dim">
            Unfinished from your last session. Open its connection, then resume.
          </div>
        )}
        {t.status === "transferring" && (
          <div className="mt-1 h-1 w-full overflow-hidden rounded bg-bg-subtle">
            <div
              className="h-full bg-accent transition-[width] duration-150"
              style={{ width: `${pct}%` }}
            />
          </div>
        )}
        {t.error && (
          <div
            className={cn(
              "mt-1 text-[11px]",
              retrying ? "text-warning" : "text-danger"
            )}
          >
            {t.error}
          </div>
        )}
      </div>
      <div className="w-24 shrink-0 text-right text-[11px] text-text-muted">
        <div>{fmtSize(t.transferred)}</div>
        {t.status === "transferring" && !stalled && t.bytesPerSec !== undefined && (
          <div
            className="text-text-dim"
            title={
              t.segments && t.segments > 1
                ? `${t.segments} parallel connections`
                : undefined
            }
          >
            {fmtRate(t.bytesPerSec)}
            {t.etaSecs !== undefined && ` · ${fmtEta(t.etaSecs)}`}
          </div>
        )}
        <div className={stalled ? "text-warning" : "text-text-dim"}>{statusLabel}</div>
      </div>
      {t.status === "queued" && queuePos >= 0 && (
        <>
          <button
            onClick={() => onMove("up")}
            disabled={queuePos === 0}
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
            title="Move up"
          >
            <ChevronUp size={12} />
          </button>
          <button
            onClick={() => onMove("down")}
            disabled={queuePos === queue.length - 1}
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-30 disabled:hover:bg-transparent"
            title="Move down"
          >
            <ChevronDown size={12} />
          </button>
        </>
      )}
      {(t.status === "transferring" || t.status === "queued") && (
        <button
          onClick={onPause}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"
          title="Pause"
        >
          <Pause size={12} />
        </button>
      )}
      {t.status === "paused" && (
        <button
          onClick={onResume}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"
          title="Resume"
        >
          <Play size={12} />
        </button>
      )}
      {(t.status === "error" || t.status === "canceled") && (
        <button
          onClick={onRetry}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"
          title="Retry"
        >
          <RotateCcw size={12} />
        </button>
      )}
      {(t.status === "transferring" ||
        t.status === "queued" ||
        t.status === "paused") && (
        <button
          onClick={onCancel}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"
          title="Cancel"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

/** Compact delta-sync indicator (Plan 23 Phase 4): how much actually crossed
 *  the wire vs. how much was reused from the basis. Shown for in-flight and
 *  done transfers alike (the stats are set before finalize). */
function DeltaBadge({ delta }: { delta: { sent: number; reused: number } }) {
  const total = delta.sent + delta.reused;
  const savedPct = total > 0 ? (delta.reused / total) * 100 : 0;
  return (
    <div className="mt-0.5">
      <span
        className="rounded bg-success/15 px-1.5 py-0.5 text-[10px] font-medium text-success"
        title={`Delta sync: ${fmtSize(delta.reused)} reused from the previous version`}
      >
        Δ {fmtSize(delta.sent)} of {fmtSize(total)} sent · {savedPct.toFixed(1)}% saved
      </span>
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
