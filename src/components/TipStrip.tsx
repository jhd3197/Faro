import { useEffect, useRef } from "react";
import { Lightbulb, X } from "lucide-react";
import { useTips, type TipId } from "@/stores/tipsStore";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { formatCombo } from "@/lib/shortcuts";
import { useSettings } from "@/stores/settingsStore";

const key = (combo: string) => <kbd className="rounded border border-border bg-bg-panel px-1 font-mono text-[10px] text-text-muted">{formatCombo(combo)}</kbd>;

const TIPS: Record<TipId, (split: boolean) => React.ReactNode> = {
  "first-connect": (split) => split
    ? <>Drag files between the panes, or select them and use Upload or Download. {key("mod+k")} opens every command.</>
    : <>Drop files from your computer onto the list to upload, or select files and use Download. <b className="font-medium text-text">Split</b> shows local files beside the server. {key("mod+k")} opens every command.</>,
  "first-ssh": () => <>This server has a shell. <b className="font-medium text-text">Terminal</b> opens one beside your files, and <b className="font-medium text-text">Server</b> shows live CPU, services and Docker.</>,
  "first-transfer": () => <><b className="font-medium text-text">Transfers</b> lists every upload and download. Pause, retry or cancel them there.</>,
  "first-site": () => <>Site shortcuts remember their local and remote folders, so the next visit opens both where you left them.</>,
};

/** One tip at a time, in a thin strip right above the status-bar pills it points at. */
export function TipStrip() {
  const { loaded, enabled, seen, triggered, markSeen, setEnabled } = useTips();
  const connected = useConnections((s) => !!s.activeSessionId);
  const ssh = useConnections((s) => !!s.activeSessionId && s.profiles.find((p) => p.id === s.activeProfileId)?.protocol === "sftp");
  const dialogOpen = useLayout((s) => !!s.dialog);
  const split = useSettings((s) => s.browserLayout === "dual");
  useEffect(() => { void useTips.getState().init(); }, []);

  const due: TipId[] = [];
  if (connected) due.push("first-connect");
  if (ssh) due.push("first-ssh");
  due.push(...triggered);
  const tip = due.find((id) => !seen.includes(id));
  const visible = loaded && enabled && !!tip && !dialogOpen;
  // Toasts stack just above the status bar; lift them over the strip so they
  // never cover its buttons.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.documentElement.style;
    if (!visible || !strip.current) { root.removeProperty("--tip-strip-height"); return; }
    const el = strip.current;
    const sync = () => root.setProperty("--tip-strip-height", `${el.offsetHeight}px`);
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(el);
    return () => { observer.disconnect(); root.removeProperty("--tip-strip-height"); };
  }, [visible, tip]);
  if (!visible) return null;

  return (
    <div ref={strip} role="status" data-tip={tip} className="flex shrink-0 items-center gap-2 border-t border-border bg-bg-subtle px-3 py-1.5 text-[11px] text-text-muted">
      <Lightbulb size={12} className="shrink-0 text-accent" aria-hidden="true" />
      {/* Controls follow the text, not the far right, where toasts stack. */}
      <p className="min-w-0">{TIPS[tip](split)}</p>
      <button onClick={() => markSeen(tip)} aria-label="Dismiss tip" className="flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-text hover:bg-bg-hover"><X size={11} /> Got it</button>
      <button onClick={() => setEnabled(false)} className="shrink-0 rounded px-1.5 py-0.5 text-text-dim hover:bg-bg-hover hover:text-text">Turn off tips</button>
    </div>
  );
}
