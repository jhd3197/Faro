// The image viewer (Plan 37 Phase 3): fit or actual size, wheel to zoom, drag
// to pan, copy and download.
//
// The image is shown through an <img> element, including SVG. An SVG loaded
// that way can't run scripts or fetch anything, which inline markup could.

import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, Loader2, Maximize, X, ZoomIn, ZoomOut } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { messageOf, toastError } from "@/lib/errors";
import { imageMime } from "@/lib/editorLang";
import { baseName, fmtSize } from "@/lib/format";
import type { SessionId } from "@/lib/types";
import { useViewer } from "@/stores/viewerStore";
import { toast } from "@/stores/toastStore";
import { save } from "@tauri-apps/plugin-dialog";
import { Btn } from "../settings/kit";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 16;

type Phase =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; url: string; base64: string; bytes: number };

function base64Bytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - pad;
}

export function ImageViewer({ sessionId, path }: { sessionId: SessionId; path: string }) {
  const name = baseName(path);
  const mime = imageMime(name) ?? "image/png";
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  /** null = fit the window; a number is an explicit scale (1 = 100 %). */
  const [zoom, setZoom] = useState<number | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "loading" });
    setNatural(null);
    setZoom(null);
    setOffset({ x: 0, y: 0 });
    void ipc
      .readImageFile(sessionId, path)
      .then((base64) => {
        if (cancelled) return;
        setPhase({
          kind: "ready",
          url: `data:${mime};base64,${base64}`,
          base64,
          bytes: base64Bytes(base64),
        });
      })
      .catch((e) => {
        if (!cancelled) setPhase({ kind: "failed", message: messageOf(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, path, mime]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setStageSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The scale that fits the whole image, never enlarging a small one.
  const fitScale = useMemo(() => {
    if (!natural || !stageSize.w || !stageSize.h) return 1;
    return Math.min(1, (stageSize.w - 32) / natural.w, (stageSize.h - 32) / natural.h);
  }, [natural, stageSize]);
  const scale = zoom ?? fitScale;

  const zoomTo = (next: number) => {
    setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next)));
  };
  const fit = () => {
    setZoom(null);
    setOffset({ x: 0, y: 0 });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (phase.kind !== "ready") return;
    e.preventDefault();
    zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  };

  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setOffset({ x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const copy = async () => {
    if (phase.kind !== "ready") return;
    try {
      // The clipboard takes PNG. Other formats are redrawn as one.
      const img = new Image();
      img.src = phase.url;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth || natural?.w || 1;
      canvas.height = img.naturalHeight || natural?.h || 1;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/png"));
      if (!blob) throw new Error("The image couldn't be prepared for the clipboard.");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast.success("Image copied");
    } catch (e) {
      toastError(e, "Couldn't copy the image");
    }
  };

  const download = async () => {
    if (phase.kind !== "ready") return;
    try {
      const target = await save({ title: "Save image", defaultPath: name });
      if (!target) return;
      await ipc.writeBase64File(target, phase.base64);
      toast.success("Image saved", target);
    } catch (e) {
      toastError(e, "Couldn't save the image");
    }
  };

  return (
    <div data-image-viewer className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm">
            <span className="truncate font-medium" title={path}>
              {name}
            </span>
            <span className="truncate text-xs text-text-dim">{path}</span>
          </div>
        </div>
        <Btn size="sm" variant="ghost" icon={<ZoomOut size={12} />} aria-label="Zoom out" data-image-zoom-out onClick={() => zoomTo(scale / 1.25)} />
        <span data-image-zoom className="w-12 text-center text-xs tabular-nums text-text-muted">
          {Math.round(scale * 100)}%
        </span>
        <Btn size="sm" variant="ghost" icon={<ZoomIn size={12} />} aria-label="Zoom in" data-image-zoom-in onClick={() => zoomTo(scale * 1.25)} />
        <Btn size="sm" variant="ghost" icon={<Maximize size={12} />} data-image-fit onClick={fit}>
          Fit
        </Btn>
        <Btn
          size="sm"
          variant="ghost"
          data-image-actual
          onClick={() => {
            setZoom(1);
            setOffset({ x: 0, y: 0 });
          }}
        >
          100%
        </Btn>
        <Btn size="sm" variant="ghost" icon={<Copy size={12} />} disabled={phase.kind !== "ready"} onClick={() => void copy()}>
          Copy
        </Btn>
        <Btn size="sm" variant="ghost" icon={<Download size={12} />} disabled={phase.kind !== "ready"} onClick={() => void download()}>
          Save as…
        </Btn>
        <button
          type="button"
          aria-label="Close viewer"
          data-image-close
          onClick={() => useViewer.getState().close()}
          className="flex h-7 w-7 items-center justify-center rounded text-text-muted hover:bg-bg-hover hover:text-text"
        >
          <X size={14} />
        </button>
      </div>
      <div
        ref={stage}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={fit}
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-bg active:cursor-grabbing"
        style={{
          // A checkerboard, so transparent areas read as transparent.
          backgroundImage:
            "linear-gradient(45deg, rgb(var(--bg-subtle)) 25%, transparent 25%, transparent 75%, rgb(var(--bg-subtle)) 75%), linear-gradient(45deg, rgb(var(--bg-subtle)) 25%, transparent 25%, transparent 75%, rgb(var(--bg-subtle)) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 8px 8px",
        }}
      >
        {phase.kind === "loading" && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-text-muted">
            <Loader2 size={14} className="animate-spin" /> Loading {name}…
          </div>
        )}
        {phase.kind === "failed" && (
          <div data-image-failed className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-text-muted">
            {phase.message}
          </div>
        )}
        {phase.kind === "ready" && (
          <img
            src={phase.url}
            alt={name}
            draggable={false}
            data-image
            onLoad={(e) => {
              const el = e.currentTarget;
              // An SVG without a size reports 0; give it a workable one.
              setNatural({ w: el.naturalWidth || 512, h: el.naturalHeight || 512 });
            }}
            className="absolute left-1/2 top-1/2 max-w-none select-none"
            style={{
              width: natural ? natural.w * scale : undefined,
              height: natural ? natural.h * scale : undefined,
              transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
              imageRendering: scale >= 4 ? "pixelated" : "auto",
              visibility: natural ? "visible" : "hidden",
            }}
          />
        )}
      </div>
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-border px-3 text-xs text-text-dim">
        {natural && (
          <span data-image-size>
            {natural.w} × {natural.h}
          </span>
        )}
        {phase.kind === "ready" && <span>{fmtSize(phase.bytes)}</span>}
        <span className="flex-1" />
        <span>Scroll to zoom · drag to move · double-click to fit</span>
      </div>
    </div>
  );
}
