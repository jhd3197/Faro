/** A missing engine row is pending, never implicitly successful. */
export function uploadOutcome(report: {
  validation?: string; bytes?: number; preparing: boolean; files: number; directories: number;
  verifiedDirectories: number; errors: string[]; skipped: number; canceled: boolean;
}, rows: Array<{ status: string; transferred?: number } | undefined>) {
  const done = rows.filter((t) => t?.status === "done").length;
  const failed = rows.filter((t) => t?.status === "error").length;
  const skipped = report.skipped + rows.filter((t) => t?.status === "skipped").length;
  const canceled = report.canceled || rows.some((t) => t?.status === "canceled");
  const pending = report.preparing || report.validation === "checking" || rows.some((t) => !t || ["queued", "transferring", "paused"].includes(t.status));
  const complete = !pending && !canceled && !skipped && !failed && !report.errors.length &&
    (report.bytes === undefined || rows.reduce((total, row) => total + (row?.transferred ?? 0), 0) === report.bytes) &&
    (report.validation === undefined || report.validation === "done") && done === report.files && report.verifiedDirectories === report.directories;
  const status = pending ? "Upload in progress" : complete ? "Upload complete" : canceled ? "Upload canceled" : done ? "Upload partially complete" : "Upload failed";
  return { done, failed, skipped, canceled, pending, complete, status };
}
