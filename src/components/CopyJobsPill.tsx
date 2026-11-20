import { useRef, useState } from "react";
import { Copy, FileText, X } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { fmtSize } from "@/lib/format";
import { cn } from "@/lib/cn";
import { useCopyJobs } from "@/stores/copyStore";
import { Popover } from "@/components/ui/Popover";

/// Status-bar pill for Copy to… runs: hidden until there is one, then a count
/// and a popover with progress, Cancel and the CSV report.
export function CopyJobsPill() {
  const jobs = useCopyJobs((s) => s.jobs);
  const cancel = useCopyJobs((s) => s.cancel);
  const clearFinished = useCopyJobs((s) => s.clearFinished);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  if (jobs.length === 0) return null;
  const running = jobs.filter((j) => j.state === "running").length;

  return (
    <div className="relative flex items-center" ref={wrap}>
      <button
        data-copy-jobs-pill=""
        onClick={() => setOpen((v) => !v)}
        title={running ? `Copying — ${running} running` : "Copy to… runs"}
        aria-label="Copy to… runs"
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 transition-colors",
          open ? "bg-accent-soft text-accent" : "text-text-muted hover:bg-bg-hover hover:text-text"
        )}
      >
        <Copy size={11} className={cn(running > 0 && "animate-pulse text-warning")} />
        <span className="max-[960px]:hidden">{running ? `Copying ${running}` : "Copies"}</span>
      </button>
      {open && (
        <Popover open anchorRef={wrap} onClose={() => setOpen(false)} placement="top-end" layer="dropdown" className="w-96">
          <div className="flex items-center justify-between border-b border-border bg-bg-subtle px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">Copy to…</span>
            {jobs.some((j) => j.state !== "running") && (
              <button onClick={() => void clearFinished()} className="text-[10px] text-text-dim hover:text-text">
                Clear finished
              </button>
            )}
          </div>
          <div className="max-h-72 overflow-y-auto">
            {[...jobs].reverse().map((j) => (
              <div key={j.id} className="border-b border-border px-3 py-2 text-[11px] last:border-b-0" data-copy-job={j.state}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-text">
                    {j.sourceLabel} → {j.destLabel}
                  </span>
                  {j.state === "running" ? (
                    <button
                      onClick={() => void cancel(j.id)}
                      title="Cancel"
                      aria-label="Cancel copy"
                      className="text-text-dim hover:text-text"
                    >
                      <X size={11} />
                    </button>
                  ) : (
                    <span className={cn(j.state === "failed" ? "text-danger" : "text-text-muted")}>
                      {j.state === "done" ? "Done" : j.state === "failed" ? "Errors" : "Canceled"}
                    </span>
                  )}
                </div>
                <div className="mt-1 h-1 overflow-hidden rounded bg-bg-hover">
                  <div
                    className={cn("h-full", j.failed ? "bg-danger" : "bg-accent")}
                    style={{ width: `${j.total ? Math.round(((j.done + j.failed) / j.total) * 100) : 100}%` }}
                  />
                </div>
                <div className="mt-1 flex items-center gap-2 text-text-dim">
                  <span>
                    {j.done}/{j.total} · {fmtSize(j.bytesDone)} of {fmtSize(j.bytesTotal)}
                    {j.skipped > 0 && ` · ${j.skipped} already there`}
                    {j.failed > 0 && ` · ${j.failed} failed`}
                  </span>
                  {j.report && (
                    <button
                      onClick={() => void ipc.revealLocalPath(j.report!)}
                      className="ml-auto flex items-center gap-1 hover:text-text"
                      title={j.report}
                    >
                      <FileText size={10} /> Report
                    </button>
                  )}
                </div>
                {j.current && j.state === "running" && (
                  <div className="mt-0.5 truncate font-mono text-[10px] text-text-dim" title={j.current}>
                    {j.current}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Popover>
      )}
    </div>
  );
}
