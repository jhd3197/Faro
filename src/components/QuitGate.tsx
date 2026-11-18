import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownUp, FilePen, Power } from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import {
  addPendingSource, installCloseGuard, setCloseGate, type PendingWork,
} from "@/lib/closeGuard";
import { baseName } from "@/lib/format";
import { useTransfers } from "@/stores/transfersStore";
import { useEditor } from "@/stores/editorStore";

/** Rows shown before collapsing the rest into "…N more". */
export const QUIT_LIST_LIMIT = 5;

function runningTransfers(): PendingWork[] {
  return Object.values(useTransfers.getState().byId)
    .filter((t) => t.status === "transferring" || t.status === "queued")
    .map((t) => ({
      kind: "transfer" as const,
      label: `${t.kind === "download" ? "Downloading" : "Uploading"} ${baseName(t.source)}`,
    }));
}

function openEdits(): PendingWork[] {
  return Object.values(useEditor.getState().edits).map((e) => ({
    kind: "edit" as const,
    label: `Editing ${baseName(e.remotePath)}`,
  }));
}

/**
 * Installs the main window's close handler and, when transfers are running or
 * remote edits are open, asks before quitting.
 */
export function QuitGate() {
  const [pending, setPending] = useState<PendingWork[] | null>(null);
  const answer = useRef<((quit: boolean) => void) | null>(null);

  useEffect(() => {
    const offTransfers = addPendingSource(runningTransfers);
    const offEdits = addPendingSource(openEdits);
    setCloseGate((items) => new Promise<boolean>((resolve) => {
      answer.current?.(false);
      answer.current = resolve;
      setPending(items);
    }));
    installCloseGuard();
    return () => {
      offTransfers();
      offEdits();
      setCloseGate(null);
    };
  }, []);

  const decide = (quit: boolean) => {
    const resolve = answer.current;
    answer.current = null;
    setPending(null);
    resolve?.(quit);
  };

  if (!pending) return null;
  return <QuitGateDialog pending={pending} onDecide={decide} />;
}

function QuitGateDialog({
  pending,
  onDecide,
}: {
  pending: PendingWork[];
  onDecide: (quit: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  useDialog(panelRef, { onClose: () => onDecide(false), initialFocus: cancelRef });

  const shown = pending.slice(0, QUIT_LIST_LIMIT);
  const more = pending.length - shown.length;
  const transfers = pending.filter((p) => p.kind === "transfer").length;
  const edits = pending.length - transfers;
  const what = [
    transfers ? `${transfers} transfer${transfers === 1 ? "" : "s"} still running` : "",
    edits ? `${edits} file${edits === 1 ? "" : "s"} open for editing` : "",
  ].filter(Boolean).join(" and ");

  return (
    <div className="fixed inset-0 z-secure flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-quit-gate
        className="anim-modal w-[26rem] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        <div className="flex items-center gap-2.5 border-b border-border bg-bg-subtle px-4 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-danger-soft text-danger">
            <Power size={14} />
          </div>
          <div id={titleId} className="text-[13px] font-semibold">
            Quit Faro?
          </div>
        </div>
        <div className="px-4 py-4">
          <p className="mb-3 text-[12.5px] leading-relaxed text-text-muted">
            {what[0]?.toUpperCase()}{what.slice(1)}. Unfinished transfers can be resumed next time;
            unsaved changes in open files won't be uploaded.
          </p>
          <ul className="space-y-1" data-quit-list>
            {shown.map((p, i) => (
              <li key={i} className="flex min-w-0 items-center gap-2 text-[12.5px]">
                <span className="shrink-0 text-text-dim">
                  {p.kind === "transfer" ? <ArrowDownUp size={12} /> : <FilePen size={12} />}
                </span>
                <span className="truncate" title={p.label}>{p.label}</span>
              </li>
            ))}
            {more > 0 && (
              <li className="pl-5 text-[12px] text-text-dim" data-quit-more>
                …{more} more
              </li>
            )}
          </ul>
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-subtle px-4 py-3">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onDecide(false)}
            className="rounded-md border border-border bg-bg-panel px-3 py-1.5 text-xs font-medium hover:bg-bg-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            data-quit-anyway
            onClick={() => onDecide(true)}
            className="rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            Quit anyway
          </button>
        </div>
      </div>
    </div>
  );
}
