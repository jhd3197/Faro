import type { AccessLevel } from "@/lib/types";
import { cn } from "@/lib/cn";

const LEVELS: { value: AccessLevel; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "ask", label: "Ask" },
  { value: "auto", label: "Auto" },
];

/// Off / Ask / Auto segmented control for one agent capability. Auto on a
/// `risky` capability (commands, sudo) is drawn in the danger tone so a
/// permissive cell is never mistaken for a safe one.
export function AccessSeg({
  value,
  onChange,
  label,
  risky = false,
  disabled = false,
  className,
}: {
  /** null = no current value (bulk "set all" controls). */
  value: AccessLevel | null;
  onChange: (v: AccessLevel) => void;
  /** Accessible name, e.g. "Run commands on api-prod". */
  label: string;
  risky?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      className={cn(
        "flex h-6 w-[7.5rem] shrink-0 overflow-hidden rounded-md border border-border",
        disabled && "pointer-events-none opacity-40",
        className
      )}
    >
      {LEVELS.map((l, i) => {
        const on = value === l.value;
        return (
          <button
            key={l.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on || (value === null && i === 0) ? 0 : -1}
            onClick={() => !on && onChange(l.value)}
            onKeyDown={(e) => {
              // Arrow keys move between levels. No wrap-around: one stray ←
              // on Off must not jump straight to Auto.
              const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
              if (!d) return;
              e.preventDefault();
              const next = LEVELS[i + d];
              if (!next) return;
              onChange(next.value);
              const sib = (e.currentTarget.parentElement?.children[
                LEVELS.indexOf(next)
              ] ?? null) as HTMLElement | null;
              sib?.focus();
            }}
            className={cn(
              "flex-1 text-[11px] leading-none transition-colors [&:active]:scale-100",
              i > 0 && "border-l border-border",
              !on && "text-text-dim hover:bg-bg-hover hover:text-text",
              on && l.value === "off" && "bg-bg-hover font-medium text-text",
              on && l.value === "ask" && "bg-warning/15 font-medium text-warning",
              on && l.value === "auto" &&
                (risky
                  ? "bg-danger/15 font-medium text-danger"
                  : "bg-success/15 font-medium text-success")
            )}
          >
            {l.label}
          </button>
        );
      })}
    </div>
  );
}
