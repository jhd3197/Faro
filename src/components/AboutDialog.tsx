import { useId, useRef } from "react";
import { Github, ExternalLink, X } from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { openExternal } from "@/lib/openExternal";

interface Props {
  onClose: () => void;
}

const VERSION = "1.3.0";
const REPO_URL = "https://github.com/jhd3197/faro";

export function AboutDialog({ onClose }: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, { onClose });
  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="anim-modal w-[26rem] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-2 border-b border-border bg-bg-subtle px-5 py-5">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl text-white shadow-elev-2 btn-accent">
            <svg viewBox="0 0 16 16" width="34" height="34" fill="currentColor">
              <path
                d="M9 5.5 L15 4 L15 8 L9 6.5 Z"
                fill="rgb(252 211 77)"
                opacity="0.9"
              />
              <path d="M5 4.2 L7 2.5 L9 4.2 Z" />
              <rect x="5.4" y="4.2" width="3.2" height="2" rx="0.2" />
              <path d="M5 6.2 L9 6.2 L9.4 13.5 L4.6 13.5 Z" />
              <rect
                x="4.6"
                y="9"
                width="4.8"
                height="0.7"
                fill="rgb(20 22 36)"
              />
            </svg>
          </div>
          <div id={titleId} className="text-base font-semibold">Faro</div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-accent">
            version {VERSION}
          </div>
          <div className="max-w-xs text-center text-[12px] leading-relaxed text-text-muted">
            A modern desktop client for SFTP, FTP, SSH, and S3-compatible
            storage. Servers, storage, and sessions in one workspace.
          </div>
        </div>

        <div className="grid grid-cols-1 gap-1 px-3 py-3 text-[12px]">
          <Row label="Built with" value="Tauri 2 · React · Rust" />
          <Row label="License" value="MIT" />
          <Row label="Bundle ID" value="com.juandenis.faro" mono />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border bg-bg-subtle px-3 py-2">
          <button
            onClick={() => openExternal(REPO_URL)}
            className="flex items-center gap-1.5 rounded-md border border-border bg-bg-panel px-2.5 py-1 text-[11.5px] hover:bg-bg-hover"
          >
            <Github size={11} />
            GitHub
            <ExternalLink size={9} className="text-text-dim" />
          </button>
          <button
            onClick={() => openExternal(`${REPO_URL}/issues`)}
            className="flex items-center gap-1.5 rounded-md border border-border bg-bg-panel px-2.5 py-1 text-[11.5px] hover:bg-bg-hover"
          >
            Issues
            <ExternalLink size={9} className="text-text-dim" />
          </button>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-[11.5px] text-text-muted hover:bg-bg-hover hover:text-text"
          >
            <X size={11} />
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-dim">{label}</span>
      <span className={mono ? "font-mono text-text-muted" : "text-text-muted"}>
        {value}
      </span>
    </div>
  );
}
