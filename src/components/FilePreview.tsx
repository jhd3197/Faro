import { useEffect, useState } from "react";
import { Download, FileText, Pencil, X } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useEditor } from "@/stores/editorStore";
import { fmtMtime, fmtSize, formatMode } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { DirEntry, SessionId } from "@/lib/types";

/** How much of a file the preview pulls — enough for a config or the first
 *  screens of a log, never a whole multi-GB file over the wire. */
const PREVIEW_BYTES = 64 * 1024;
const MAX_LINES = 400;

type State =
  | { kind: "loading" }
  | { kind: "text"; lines: string[]; truncated: boolean }
  | { kind: "binary" }
  | { kind: "error"; message: string };

/** Log-ish tone per line so failures stand out in a scrolled preview. */
function lineTone(line: string): string | undefined {
  if (/\b(error|fail(ed|ure)?|fatal|panic|denied|refused|exception)\b|\b5\d\d\b/i.test(line))
    return "text-danger";
  if (/\bwarn(ing)?\b/i.test(line)) return "text-warning";
  return undefined;
}

function decode(b64: string): { text: string | null } {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // A NUL in the first 8 KiB means binary — don't render mojibake.
  if (bytes.subarray(0, 8192).includes(0)) return { text: null };
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(bytes) };
}

/// Right-hand text preview for the selected file in the single-pane browser:
/// the first 64 KiB (any backend, via a bounded read), line-numbered, with
/// error/warning lines toned. Binary files say so instead of rendering bytes.
export function FilePreview({
  sessionId,
  entry,
  onDownload,
  onClose,
}: {
  sessionId: SessionId;
  entry: DirEntry;
  onDownload?: () => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const startEditing = useEditor((s) => s.startEditing);

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    ipc
      .readFileHead(sessionId, entry.path, PREVIEW_BYTES)
      .then((b64) => {
        if (cancelled) return;
        const { text } = decode(b64);
        if (text === null) return setState({ kind: "binary" });
        const all = text.split(/\r?\n/);
        setState({
          kind: "text",
          lines: all.slice(0, MAX_LINES),
          truncated: all.length > MAX_LINES || entry.size > PREVIEW_BYTES,
        });
      })
      .catch((e) => {
        if (!cancelled)
          setState({ kind: "error", message: typeof e === "string" ? e : String(e?.message ?? e) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, entry.path, entry.size]);

  return (
    <aside
      aria-label="File preview"
      className="flex h-full w-[26rem] max-w-[45%] shrink-0 flex-col border-l border-border bg-bg-panel"
    >
      <div className="flex flex-col gap-2 border-b border-border px-4 pb-3 pt-3">
        <div className="flex items-center gap-2">
          <FileText size={14} className="shrink-0 text-text-dim" />
          <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-medium" title={entry.path}>
            {entry.name}
          </span>
          <span className="shrink-0 text-[11.5px] text-text-dim">{fmtSize(entry.size)}</span>
          <button
            onClick={onClose}
            aria-label="Hide preview"
            className="rounded p-1 text-text-dim hover:bg-bg-hover hover:text-text"
          >
            <X size={13} />
          </button>
        </div>
        <div className="text-[11.5px] text-text-dim">
          Modified {fmtMtime(entry.modified)}
          {entry.mode !== undefined && (
            <>
              {" · "}
              <span className="font-mono">{formatMode(entry.mode)}</span>
            </>
          )}
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => void startEditing(sessionId, entry.path)}
            className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2.5 text-[12px] hover:bg-bg-hover"
          >
            <Pencil size={12} /> Open in editor
          </button>
          {onDownload && (
            <button
              onClick={onDownload}
              className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2.5 text-[12px] hover:bg-bg-hover"
            >
              <Download size={12} /> Download
            </button>
          )}
        </div>
      </div>
      <div className="selectable min-h-0 flex-1 overflow-auto bg-bg px-2 py-2">
        {state.kind === "loading" && (
          <div className="px-2 text-[12px] text-text-dim">Loading preview…</div>
        )}
        {state.kind === "binary" && (
          <div className="px-2 text-[12px] text-text-dim">
            Binary file — no text preview.
          </div>
        )}
        {state.kind === "error" && (
          <div className="px-2 text-[12px] text-text-dim">
            No preview: {state.message}
          </div>
        )}
        {state.kind === "text" && (
          <>
            <div className="font-mono text-[11.5px] leading-[1.7]">
              {state.lines.map((l, i) => (
                <div key={i} className="flex gap-3 whitespace-pre">
                  <span className="w-8 shrink-0 select-none text-right text-text-dim/70">
                    {i + 1}
                  </span>
                  <span className={cn("text-text-muted", lineTone(l))}>{l || " "}</span>
                </div>
              ))}
            </div>
            {state.truncated && (
              <div className="px-2 pt-2 text-[11px] text-text-dim">
                Showing the start of the file. Open it in your editor for the rest.
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
