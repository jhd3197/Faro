import { useEffect, useState } from "react";
import { onNativeFileDrop } from "@/lib/ipc";
import { useTransfers } from "@/stores/transfersStore";
import { toast } from "@/stores/toastStore";
import { useLayout } from "@/stores/layoutStore";

/** Native paths are authoritative; HTML DataTransfer is only used by the
 * existing internal pane drag. This listener never consumes HTML drops. */
export function NativeFileDrop() {
  const [destination, setDestination] = useState<string | null>(null);
  useEffect(() => {
    if (import.meta.env.VITE_MOCK) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let highlighted: Element[] = [];
    const reset = () => {
      highlighted.forEach((e) => e.removeAttribute("data-native-hover"));
      highlighted = [];
      setDestination(null);
    };
    // Only `enter` and `drop` carry the paths; `over` is position only.
    let dragged: string[] = [];
    onNativeFileDrop((event) => {
      reset();
      if (event.type === "leave") return;
      if (event.type === "enter" || event.type === "drop") dragged = event.paths;
      // Native coordinates are physical; DOM hit testing uses CSS pixels.
      const element = document.elementFromPoint(
        event.position.x / window.devicePixelRatio,
        event.position.y / window.devicePixelRatio);
      const pane = element?.closest<HTMLElement>('[data-file-pane="remote"]');
      const session = pane?.dataset.fileSession;
      // A `.faro` connections file dropped anywhere but a remote pane (where
      // it uploads like any file) opens in Import.
      const faroFile = dragged.length === 1 && /\.faro$/i.test(dragged[0]) ? dragged[0] : null;
      if (faroFile && (!pane || !session)) {
        if (event.type === "drop") useLayout.getState().openImport(faroFile);
        else setDestination("Drop to import these connections");
        return;
      }
      if (!pane || !session) {
        if (event.type !== "drop") setDestination("Drop unavailable — choose a connected remote pane");
        return;
      }
      const folder = element?.closest<HTMLElement>("[data-upload-directory]");
      const target = folder?.dataset.uploadDirectory ?? pane.dataset.filePath;
      if (!target) return;
      if (event.type !== "drop") {
        highlighted = folder ? [pane, folder] : [pane];
        highlighted.forEach((e) => e.setAttribute("data-native-hover", "true"));
        setDestination(`Upload to ${target}`);
        return;
      }
      if (event.paths.length === 0) return;
      // Capture session and destination now, before the user navigates elsewhere.
      toast.info("Preparing upload", `${event.paths.length} selected item(s) → ${target}`);
      useTransfers.getState().enqueueUploads(session,
        event.paths.map((path) => ({ path, kind: "file" })), target)
        .catch((error) => toast.error("Upload incomplete", String(error)));
    }).then((stop) => { if (disposed) stop(); else unlisten = stop; })
      .catch((error) => toast.error("Native file drop unavailable", String(error)));
    return () => { disposed = true; unlisten?.(); reset(); };
  }, []);
  return destination ? <div role="status" className="pointer-events-none fixed bottom-12 left-1/2 z-50 -translate-x-1/2 rounded border border-accent bg-bg-panel px-4 py-2 text-sm text-text shadow-lg">{destination}</div> : null;
}
