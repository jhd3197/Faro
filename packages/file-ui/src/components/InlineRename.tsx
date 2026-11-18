import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

interface Props {
  /** The current name. Saving it unchanged is a quiet no-op. */
  value: string;
  /** Persist the new name. Throw (or reject) to keep the editor open with the
   *  message shown under it. */
  onSubmit: (next: string) => void | Promise<void>;
  /** Leave edit mode without saving. */
  onDone: () => void;
  /** Check a draft before saving; return a message to block it. */
  validate?: (next: string) => string | null;
  /** Select only the part before the extension, the way file managers do. */
  selectStem?: boolean;
  className?: string;
  "aria-label"?: string;
}

/** One inline rename editor for every list in Faro: file rows, server names,
 *  group headers, sites and terminal tabs. The text starts selected; Enter or
 *  leaving the field saves, Esc cancels, an unchanged name does nothing, and a
 *  failure stays inline instead of opening a dialog. */
export function InlineRename({
  value,
  onSubmit,
  onDone,
  validate,
  selectStem,
  className,
  "aria-label": ariaLabel = "New name",
}: Props) {
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // A save in flight or finished must not run again from the blur that
  // follows Enter, and Esc must not be undone by that same blur.
  const settled = useRef(false);

  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    const dot = selectStem ? value.lastIndexOf(".") : -1;
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    settled.current = false;
    return () => { settled.current = true; };
  }, []);

  const save = async () => {
    if (settled.current || busy) return;
    const next = draft.trim();
    if (!next || next === value) {
      settled.current = true;
      onDone();
      return;
    }
    const invalid = validate?.(next) ?? null;
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(next);
      settled.current = true;
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      inputRef.current?.focus();
    }
  };

  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onDone();
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <span
      className={cn("relative inline-flex min-w-0 flex-1 flex-col", className)}
      onClick={stop}
      onDoubleClick={stop}
      onPointerDown={stop}
      onMouseDown={stop}
      onContextMenu={stop}
    >
      <input
        ref={inputRef}
        data-inline-rename
        aria-label={ariaLabel}
        aria-invalid={!!error}
        value={draft}
        readOnly={busy}
        spellCheck={false}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError(null);
        }}
        onKeyDown={(e) => {
          // Nothing typed here may reach list navigation or app shortcuts.
          e.stopPropagation();
          if (e.nativeEvent.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
        onBlur={() => void save()}
        className={cn(
          "w-full min-w-0 rounded border bg-bg px-1 py-0 font-[inherit] text-[inherit] text-text outline-none",
          error ? "border-danger" : "border-accent"
        )}
      />
      {error && (
        <span
          role="alert"
          className="absolute left-0 top-full z-10 mt-0.5 max-w-[20rem] whitespace-normal rounded border border-danger/40 bg-bg-panel px-1.5 py-0.5 text-[11px] leading-snug text-danger shadow-elev-2 [overflow-wrap:anywhere]"
        >
          {error}
        </span>
      )}
    </span>
  );
}
