// The built-in viewer's window (Plan 37 Phase 3): one text file in the editor
// or one image, over the file panes. The editor is a separate chunk loaded the
// first time a text file is opened.

import { Suspense, lazy, useRef } from "react";
import { Loader2 } from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { useViewer } from "@/stores/viewerStore";
import { ImageViewer } from "./ImageViewer";

const TextEditor = lazy(() => import("./TextEditor"));

export function FileViewer() {
  const doc = useViewer((s) => s.doc);
  if (!doc) return null;
  return <ViewerWindow key={`${doc.kind}:${doc.sessionId}:${doc.path}`} />;
}

function ViewerWindow() {
  const doc = useViewer((s) => s.doc);
  const panel = useRef<HTMLDivElement>(null);
  // Escape and a click outside ask to close; the editor may refuse while it
  // has unsaved changes and show its own question.
  useDialog(panel, { onClose: () => void useViewer.getState().close() });
  if (!doc) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={doc.kind === "text" ? "Editor" : "Image viewer"}
        data-file-viewer={doc.kind}
        className="anim-modal flex h-[min(54rem,94vh)] w-[min(84rem,96vw)] flex-col overflow-hidden rounded-md border border-border bg-bg-panel shadow-elev-3"
      >
        {doc.kind === "text" ? (
          <Suspense
            fallback={
              <div className="flex flex-1 items-center justify-center gap-2 text-sm text-text-muted">
                <Loader2 size={14} className="animate-spin" /> Loading the editor…
              </div>
            }
          >
            <TextEditor sessionId={doc.sessionId} path={doc.path} />
          </Suspense>
        ) : (
          <ImageViewer sessionId={doc.sessionId} path={doc.path} />
        )}
      </div>
    </div>
  );
}
