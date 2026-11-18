import { useId, useRef, useState, type ReactNode } from "react";
import { Info, X } from "lucide-react";
import { Popover } from "./Popover";

/** Clickable, keyboard-accessible help that escapes the editor's scroll area.
 *  It follows its button while the editor scrolls, and hides while the
 *  button is scrolled out of sight. */
export function ConnectionHelp({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  return <>
    <button ref={trigger} type="button" aria-label={label} title={label} aria-expanded={open}
      aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}
      className="inline-flex rounded p-0.5 text-text-dim hover:bg-bg-hover hover:text-text focus-visible:outline focus-visible:outline-accent">
      <Info size={13} />
    </button>
    <Popover open={open} anchorRef={trigger} onClose={(reason) => close(reason === "escape")}
      id={id} role="region" aria-label={label} maxHeight={224}
      className="w-80 max-w-[calc(100vw-16px)] rounded-lg p-3 text-xs leading-relaxed text-text-muted">
      <div className="mb-2 flex items-center justify-between gap-2 font-medium text-text">{label}
        <button type="button" aria-label="Close help" onMouseDown={(e) => e.preventDefault()} onClick={() => close(true)} className="rounded p-1 hover:bg-bg-hover"><X size={12} /></button>
      </div>{children}
    </Popover>
  </>;
}
