import { fmtSize } from "@/lib/format";

export function UpdateProgress({ downloaded, total }: { downloaded: number; total: number | null }) {
  const pct = total && total > 0 ? Math.min(100, Math.round(downloaded / total * 100)) : null;
  return (
    <div className="min-w-0 flex-1">
      <div role="progressbar" aria-label="Update download" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={pct ?? undefined} className="h-1.5 overflow-hidden rounded-full bg-border">
        <div className={`h-full origin-left bg-accent motion-safe:transition-transform motion-safe:duration-150 ${pct === null ? "motion-safe:animate-pulse" : ""}`}
          style={{ transform: `scaleX(${pct === null ? 1 : pct / 100})`, opacity: pct === null ? 0.5 : 1 }} />
      </div>
      <div className="mt-1 flex justify-between gap-2 text-xs tabular-nums text-text-muted">
        <span>{fmtSize(downloaded)}{total ? ` of ${fmtSize(total)}` : " downloaded"}</span>
        {pct !== null && <span>{pct}%</span>}
      </div>
    </div>
  );
}
