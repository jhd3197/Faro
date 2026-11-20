// The Settings kit. Every section composes these instead of writing its own
// classes, so the dialog reads as one surface. Rules: docs/plans/settings-ui-rules.md.
//
// Layout: a fixed label column and a control column, so every control on a
// page starts at the same x. Explanations sit behind an (i) next to the label,
// never as a visible subtitle. Visible notes are for consequences only.
import {
  createContext,
  forwardRef,
  useContext,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Check, Info, Loader2, Minus } from "lucide-react";
import { cn } from "@/lib/cn";

// ---------------------------------------------------------------------------
// Search

interface SearchState {
  /** Lower-cased query; "" when not searching. */
  query: string;
  /** The whole section matched (its name or keywords), so every row shows. */
  sectionMatched: boolean;
}

const SearchCtx = createContext<SearchState>({ query: "", sectionMatched: false });

export function SettingsSearchScope({
  query,
  sectionMatched,
  children,
}: SearchState & { children: ReactNode }) {
  return <SearchCtx.Provider value={{ query, sectionMatched }}>{children}</SearchCtx.Provider>;
}

export function useSettingsSearch() {
  return useContext(SearchCtx);
}

/** Does this row show under the current search? */
function useRowMatch(...texts: (string | undefined)[]): { show: boolean; hit: boolean } {
  const { query, sectionMatched } = useContext(SearchCtx);
  if (!query) return { show: true, hit: false };
  const hit = texts.some((t) => t && t.toLowerCase().includes(query));
  return { show: hit || sectionMatched, hit };
}

/** The label with the search hit marked. */
export function Highlight({ text }: { text: string }) {
  const { query } = useContext(SearchCtx);
  if (!query) return <>{text}</>;
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-accent/25 text-inherit">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

// ---------------------------------------------------------------------------
// Help

/** An (i) that shows its text on hover or focus. Portaled so the scroll area
 *  never clips it. This is where explanations live. */
export function InfoTip({ text, label = "More info" }: { text: ReactNode; label?: string }) {
  const [coords, setCoords] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const ref = useRef<HTMLButtonElement>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const below = r.top < 120;
    setCoords({ left: r.left + r.width / 2, top: below ? r.bottom + 6 : r.top - 6, below });
  };
  const hide = () => setCoords(null);
  return (
    <>
      <button
        ref={ref}
        type="button"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        aria-label={label}
        data-infotip
        className="inline-flex shrink-0 rounded-sm text-text-dim transition-colors hover:text-text"
      >
        <Info size={12} strokeWidth={2} />
      </button>
      {coords &&
        createPortal(
          <span
            role="tooltip"
            style={{
              left: coords.left,
              top: coords.top,
              transform: coords.below ? "translate(-50%, 0)" : "translate(-50%, -100%)",
            }}
            className="anim-fade pointer-events-none fixed z-tooltip w-64 max-w-[80vw] rounded border border-border bg-bg-panel px-2.5 py-1.5 text-xs leading-snug text-text-muted shadow-elev-2"
          >
            {text}
          </span>,
          document.body
        )}
    </>
  );
}

/** A visible one-liner under a control. Consequences only ("Applies at next
 *  launch."); explanations go in the (i). */
export function Note({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "warning" | "danger" }) {
  return (
    <div
      className={cn(
        "w-full text-xs leading-snug",
        tone === "dim" && "text-text-dim",
        tone === "warning" && "text-warning",
        tone === "danger" && "text-danger"
      )}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rows

const ROW_GRID = "grid grid-cols-[12.5rem_minmax(0,1fr)] items-start gap-x-5";

/**
 * A labelled setting: label (+ its (i)) on the left, controls on the right,
 * an optional consequence note under the controls.
 */
export function Row({
  label,
  help,
  note,
  focus,
  keywords,
  disabled,
  indent,
  children,
}: {
  label: string;
  help?: ReactNode;
  note?: ReactNode;
  /** `data-settings-focus` id so a deep link can land here. */
  focus?: string;
  /** Extra words search should find this row by. */
  keywords?: string;
  disabled?: boolean;
  /** A child of the row above (shown only while its parent applies). */
  indent?: boolean;
  children: ReactNode;
}) {
  const m = useRowMatch(label, keywords, typeof help === "string" ? help : undefined);
  if (!m.show) return null;
  return (
    <div
      data-row
      data-row-match={m.hit || undefined}
      data-settings-focus={focus}
      className={cn(ROW_GRID, "py-1")}
    >
      <div
        className={cn(
          "flex min-h-8 items-center gap-1.5 text-sm",
          indent && "pl-5",
          disabled ? "text-text-dim" : "text-text-muted"
        )}
      >
        <span className="min-w-0 truncate" title={label}>
          <Highlight text={label} />
        </span>
        {help && <InfoTip text={help} />}
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-h-8 flex-wrap items-center gap-2">{children}</div>
        {note && <Note>{note}</Note>}
      </div>
    </div>
  );
}

/** An on/off preference: a checkbox sitting in the control column, its label
 *  to the right (the Photoshop preferences stack). */
export function CheckRow({
  label,
  help,
  note,
  checked,
  onChange,
  disabled,
  disabledReason,
  focus,
  keywords,
  indent,
}: {
  label: string;
  help?: ReactNode;
  note?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  disabledReason?: string;
  focus?: string;
  keywords?: string;
  indent?: boolean;
}) {
  const m = useRowMatch(label, keywords, typeof help === "string" ? help : undefined);
  if (!m.show) return null;
  return (
    <div
      data-row
      data-row-match={m.hit || undefined}
      data-settings-focus={focus}
      className={cn(ROW_GRID, "py-0.5")}
    >
      <div />
      <div className={cn("flex min-w-0 flex-col gap-0.5", indent && "pl-5")}>
        <div className="flex min-h-7 items-center gap-1.5" title={disabled ? disabledReason : undefined}>
          <Checkbox checked={checked} onChange={onChange} disabled={disabled} label={label}>
            <Highlight text={label} />
          </Checkbox>
          {help && <InfoTip text={help} />}
        </div>
        {note && <div className="pl-[22px]"><Note>{note}</Note></div>}
      </div>
    </div>
  );
}

/** A master switch for something that runs (Remote control, a service). Sits
 *  at the top of its page, label in full strength. */
export function SwitchRow({
  label,
  help,
  status,
  checked,
  onChange,
  disabled,
  busy,
  focus,
  keywords,
}: {
  label: string;
  help?: ReactNode;
  /** A short live status under the label ("Listening on 8722"). */
  status?: ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  busy?: boolean;
  focus?: string;
  keywords?: string;
}) {
  const m = useRowMatch(label, keywords, typeof help === "string" ? help : undefined);
  if (!m.show) return null;
  return (
    <div
      data-row
      data-row-match={m.hit || undefined}
      data-settings-focus={focus}
      className="flex items-center gap-3 rounded border border-border bg-bg-subtle/40 px-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-sm font-medium text-text">
          <Highlight text={label} />
          {help && <InfoTip text={help} />}
        </div>
        {status && <div className="mt-0.5 text-xs text-text-dim">{status}</div>}
      </div>
      {busy && <Loader2 size={13} className="animate-spin text-text-dim" />}
      <Switch checked={checked} onChange={onChange} disabled={disabled || busy} label={label} />
    </div>
  );
}

/** Related settings in one bordered box. Hidden when search leaves it empty. */
export function Group({
  title,
  help,
  actions,
  children,
  className,
}: {
  title?: string;
  help?: ReactNode;
  /** Right side of the title line (a small button). */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-settings-group
      className={cn("rounded border border-border px-3.5 pb-2.5 pt-2", className)}
    >
      {title && (
        <div className="mb-1 flex min-h-7 items-center gap-1.5">
          <h3 className="text-xs font-semibold text-text">{title}</h3>
          {help && <InfoTip text={help} />}
          {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/** A plain heading with a hairline, for a page with several parts. */
export function SubHeading({ title, help, actions }: { title: string; help?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex min-h-7 items-center gap-1.5 border-b border-border pb-1">
      <h3 className="text-xs font-semibold text-text">{title}</h3>
      {help && <InfoTip text={help} />}
      {actions && <div className="ml-auto flex items-center gap-1.5">{actions}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controls

export function Checkbox({
  checked,
  onChange,
  disabled,
  label,
  indeterminate,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** Accessible name (defaults to the visible children). */
  label?: string;
  indeterminate?: boolean;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group/cb flex min-w-0 items-center gap-2 rounded-sm text-left text-sm text-text disabled:cursor-not-allowed disabled:text-text-dim"
    >
      <span
        className={cn(
          "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[3px] border-[1.5px] transition-colors",
          checked || indeterminate
            ? "border-accent bg-accent text-white"
            : "border-text-dim bg-bg-subtle group-hover/cb:border-text-muted",
          "group-disabled/cb:opacity-50"
        )}
      >
        {indeterminate ? (
          <Minus size={10} strokeWidth={3.5} />
        ) : checked ? (
          <Check size={10} strokeWidth={3.5} />
        ) : null}
      </span>
      {children && <span className="min-w-0 truncate">{children}</span>}
    </button>
  );
}

export function Switch({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        // Slim 22×12 track, 8px knob: reads as a control, not a pill button.
        "relative h-3 w-[22px] shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-accent" : "bg-text-dim/40 hover:bg-text-dim/60"
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 h-2 w-2 rounded-full bg-white transition-transform",
          checked ? "translate-x-2.5" : "translate-x-0"
        )}
      />
    </button>
  );
}

/** Two to four mutually exclusive choices. More than that: a dropdown. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  label?: string;
  disabled?: boolean;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex h-7 overflow-hidden rounded border border-border", disabled && "opacity-50")}
    >
      {options.map((o, i) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              "px-3 text-xs font-medium transition-colors",
              i > 0 && "border-l border-border",
              active ? "bg-bg-hover text-text" : "text-text-muted hover:bg-bg-hover/60 hover:text-text"
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

type BtnVariant = "default" | "primary" | "danger" | "ghost";

const BTN: Record<BtnVariant, string> = {
  default: "border border-border bg-bg-panel text-text hover:bg-bg-hover",
  primary: "btn-accent border border-transparent font-medium text-white",
  danger: "border border-danger/50 text-danger hover:bg-danger/10",
  ghost: "border border-transparent text-text-muted hover:bg-bg-hover hover:text-text",
};

/** The one button. 28px tall; `sm` (24px) for actions inside a list row. */
export const Btn = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: BtnVariant;
    size?: "md" | "sm";
    busy?: boolean;
    icon?: ReactNode;
  }
>(function Btn({ variant = "default", size = "md", busy, icon, className, children, disabled, ...rest }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled || busy}
      {...rest}
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "md" ? "h-7 px-3 text-sm" : "h-6 px-2 text-xs",
        BTN[variant],
        className
      )}
    >
      {busy ? <Loader2 size={size === "md" ? 13 : 12} className="animate-spin" /> : icon}
      {children}
    </button>
  );
});

/** Class for a text input that matches every other control. */
export const inputClass =
  "h-7 min-w-0 rounded border border-border bg-bg-subtle px-2.5 text-sm text-text outline-none placeholder:text-text-dim focus:border-text-dim disabled:cursor-not-allowed disabled:opacity-60";

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput({ className, ...rest }, ref) {
    return <input ref={ref} {...rest} className={cn(inputClass, className)} />;
  }
);

// ---------------------------------------------------------------------------
// Status & lists

export type Tone = "ok" | "warn" | "bad" | "off" | "busy";

const DOT: Record<Tone, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-danger",
  off: "bg-text-dim/60",
  busy: "bg-text-dim/60",
};

/** A 6px dot and a word. No glow, no pulse. */
export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <span data-status={tone} className="inline-flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
      {tone === "busy" ? (
        <Loader2 size={11} className="shrink-0 animate-spin text-text-dim" />
      ) : (
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOT[tone])} />
      )}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** One bordered box of rows split by hairlines: paired devices, sign-ins,
 *  sync pairs, tools. */
export function List({ children, className, ...rest }: { children: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <div {...rest} className={cn("divide-y divide-border overflow-hidden rounded border border-border", className)}>
      {children}
    </div>
  );
}

/** A list row: title, a dim detail line, status and actions on the right. */
export function ListRow({
  icon,
  title,
  detail,
  status,
  actions,
  children,
  className,
  ...rest
}: {
  icon?: ReactNode;
  title: ReactNode;
  detail?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  /** Anything shown under the row (an inline form, an error). */
  children?: ReactNode;
  className?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  return (
    <div {...rest} className={cn("px-3 py-2", className)}>
      <div className="flex min-h-7 items-center gap-3">
        {icon && <span className="flex shrink-0 text-text-dim">{icon}</span>}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm text-text">{title}</div>
          {detail && <div className="truncate text-xs text-text-dim">{detail}</div>}
        </div>
        {status && <div className="shrink-0">{status}</div>}
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}

/** A list or page with nothing in it yet: one line and at most one action. */
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center gap-3 rounded border border-dashed border-border px-3 py-2 text-sm text-text-dim">
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

/** Folded-away settings most people never touch. */
export function Advanced({ title = "Advanced", children, open }: { title?: string; children: ReactNode; open?: boolean }) {
  const { query } = useContext(SearchCtx);
  return (
    <details open={open || !!query} className="group/adv">
      <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 text-xs font-medium text-text-muted hover:text-text [&::-webkit-details-marker]:hidden">
        <span className="inline-block transition-transform group-open/adv:rotate-90">›</span>
        {title}
      </summary>
      <div className="mt-1 space-y-1">{children}</div>
    </details>
  );
}
