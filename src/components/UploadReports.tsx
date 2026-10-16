import { uploadOutcome } from "@/lib/uploadOutcome";
import { useTransfers } from "@/stores/transfersStore";
import { X } from "lucide-react";

/** Derived from engine terminal states, never from the progress animation. */
export function UploadReports() {
  const reports = useTransfers((s) => s.uploadReports);
  const open = useTransfers((s) => s.uploadReportsOpen);
  const setOpen = useTransfers((s) => s.setUploadReportsOpen);
  const byId = useTransfers((s) => s.byId);
  const retry = useTransfers((s) => s.retry);
  const enqueueUploads = useTransfers((s) => s.enqueueUploads);
  if (!open || !reports.length) return null;
  return <section aria-label="Upload results" className="flex max-h-40 shrink-0 flex-col border-t border-border bg-bg-panel text-xs">
    <div className="flex shrink-0 items-center justify-between border-b border-border bg-bg-subtle px-3 py-1.5">
      <span className="font-semibold text-text-muted">Upload results</span>
      <button type="button" aria-label="Hide upload results" title="Hide upload results — reopen from Transfers"
        onClick={() => setOpen(false)} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text">
        <X size={14} />
      </button>
    </div>
    <div className="min-h-0 overflow-y-auto px-3 py-2" aria-live="polite">
    {reports.map((report) => {
      const rows = report.transferIds.map((id) => byId[id]);
      const { done, skipped, complete, status } = uploadOutcome(report, rows);
      const failed = rows.filter((t) => t?.status === "error");
      return <div key={report.id} className="mb-2">
        <strong>{status} → {report.destination}</strong>
        {report.publication && <div>Staged release: published only after validation. This does not switch the live website or guarantee atomic publication.</div>}
        <div>Files: {done}/{report.files} · Directories verified: {report.verifiedDirectories}/{report.directories} · Bytes sent: {rows.reduce((n, t) => n + (t?.transferred ?? 0), 0)} / {report.bytes}</div>
        <div>Failures: {failed.length + report.errors.length} · Skipped selections/files: {skipped}</div>
        <div>Verification: {complete ? "remote sizes checked; no binary integrity guarantee" : "incomplete"}</div>
        {[...report.errors, ...failed.map((t) => `${t!.source}: ${t!.error}`)].map((error, i) => <div key={i} className="text-red-400">{error}</div>)}
        {report.retryItems.length > 0 && !report.preparing && <button className="mr-3 underline" onClick={() => {
          void enqueueUploads(report.sessionId, report.retryItems,
            report.publication?.stagedPath ?? report.destination);
        }}>Retry items that could not start</button>}
        {failed.length > 0 && <button className="underline" onClick={() => {
          for (const t of failed) void retry(t!.id);
        }}>Retry failed files</button>}
      </div>;
    })}
    </div>
  </section>;
}
