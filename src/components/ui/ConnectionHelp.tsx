import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Info, X } from "lucide-react";

/** Clickable, keyboard-accessible help that escapes the editor's scroll area. */
export function ConnectionHelp({ label, children }: { label: string; children: ReactNode }) {
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!position) return;
    const close = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setPosition(null);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); setPosition(null); trigger.current?.focus(); }
    };
    const reposition = () => setPosition(null);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", reposition);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", reposition);
    };
  }, [position]);
  return <>
    <button ref={trigger} type="button" aria-label={label} title={label} aria-expanded={!!position}
      aria-controls={position ? id : undefined} onClick={() => {
        const rect = trigger.current!.getBoundingClientRect();
        setPosition(position ? null : { left: Math.max(8, Math.min(rect.left, window.innerWidth - 336)), top: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 240)) });
      }} className="inline-flex rounded p-0.5 text-text-dim hover:bg-bg-hover hover:text-text focus-visible:outline focus-visible:outline-accent">
      <Info size={13} />
    </button>
    {position && createPortal(<div ref={panel} id={id} role="region" aria-label={label}
      style={position} className="fixed z-palette max-h-56 w-80 max-w-[calc(100vw-16px)] overflow-auto rounded-lg border border-border bg-bg-panel p-3 text-xs leading-relaxed text-text-muted shadow-elev-3">
      <div className="mb-2 flex items-center justify-between gap-2 font-medium text-text">{label}
        <button type="button" aria-label="Close help" onClick={() => { setPosition(null); trigger.current?.focus(); }} className="rounded p-1 hover:bg-bg-hover"><X size={12} /></button>
      </div>{children}
    </div>, document.body)}
  </>;
}
