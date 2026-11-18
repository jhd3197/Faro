import { useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Loader2, X } from "lucide-react";
import { shouldConfirmOnEnter } from "@faro/file-ui";
import { useDialog } from "@/hooks/useDialog";
import { cn } from "@/lib/cn";

/** How a dialog closed, so callers can tell a cancel from a confirm. */
export type DialogCloseReason = "confirm" | "cancel" | "escape" | "backdrop" | "close-button";

const SIZES = {
  sm: "w-[26rem]",
  md: "w-[34rem]",
  lg: "w-[44rem]",
} as const;

interface Props {
  title: ReactNode;
  /** Small icon before the title. */
  icon?: ReactNode;
  size?: keyof typeof SIZES;
  children?: ReactNode;
  onClose: (reason: DialogCloseReason) => void;
  /** Leave out for a dialog with no confirm button. Return false (or a
   *  promise of false) to stay open, e.g. after a validation error. */
  onConfirm?: () => void | boolean | Promise<void | boolean>;
  confirmLabel?: ReactNode;
  cancelLabel?: ReactNode;
  confirmDisabled?: boolean;
  /** Red confirm, for deletes and other things that can't be undone. */
  danger?: boolean;
  /** Left side of the footer (a checkbox, a count, a help link). */
  footerLeft?: ReactNode;
  /** Replace the default Cancel / Confirm buttons. */
  footer?: ReactNode;
  /** Close when the backdrop is clicked. Default on. */
  closeOnBackdrop?: boolean;
  /** Show the × in the header. Default on. */
  closeButton?: boolean;
  initialFocus?: RefObject<HTMLElement | null>;
  bodyClassName?: string;
  className?: string;
  "data-testid"?: string;
}

// The standard modal: focus trap, Esc and focus return come from useDialog.
// A bare Enter confirms, except on a focused button or textarea, while the
// confirm is disabled or busy, or while an input method is composing.
export function Dialog({
  title,
  icon,
  size = "sm",
  children,
  onClose,
  onConfirm,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  confirmDisabled,
  danger,
  footerLeft,
  footer,
  closeOnBackdrop = true,
  closeButton = true,
  initialFocus,
  bodyClassName,
  className,
  ...rest
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  // Start in the body's first field, else on Cancel: never on the header ×.
  const autoFocus = useMemo<RefObject<HTMLElement | null>>(
    () => ({
      get current() {
        return (
          bodyRef.current?.querySelector<HTMLElement>(
            "input:not([disabled]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex='-1'])"
          ) ??
          cancelRef.current ??
          null
        );
      },
    }),
    []
  );
  useDialog(panelRef, { onClose: () => onClose("escape"), initialFocus: initialFocus ?? autoFocus });

  const disabled = !onConfirm || !!confirmDisabled || busy;
  const confirm = async () => {
    if (disabled) return;
    const r = onConfirm!();
    let keepOpen = r === false;
    if (r instanceof Promise) {
      setBusy(true);
      try {
        keepOpen = (await r) === false;
      } catch {
        keepOpen = true;
      } finally {
        setBusy(false);
      }
    }
    if (!keepOpen) onClose("confirm");
  };

  // Header and footer buttons keep focus where it is on press, so an input
  // underneath doesn't blur (and validate, or commit) before the click lands.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose("backdrop");
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={rest["data-testid"]}
        onKeyDown={(e) => {
          if (!onConfirm || !shouldConfirmOnEnter(e, { disabled })) return;
          e.preventDefault();
          void confirm();
        }}
        className={cn(
          "anim-modal flex max-h-[85vh] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3",
          SIZES[size],
          className
        )}
      >
        <div className="flex items-center gap-2 px-5 pb-2 pt-4">
          {icon && <span className="flex shrink-0 text-accent">{icon}</span>}
          <div id={titleId} className="min-w-0 flex-1 text-sm font-semibold">
            {title}
          </div>
          {closeButton && (
            <button
              type="button"
              aria-label="Close"
              onMouseDown={keepFocus}
              onClick={() => onClose("close-button")}
              className="-mr-1.5 rounded-md p-1 text-text-dim hover:bg-bg-hover hover:text-text"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div ref={bodyRef} className={cn("min-h-0 flex-1 overflow-y-auto px-5 pb-4 text-sm text-text-muted", bodyClassName)}>
          {children}
        </div>
        {footer !== undefined ? (
          footer
        ) : (
          <div className="flex items-center gap-2 border-t border-border px-5 py-3">
            <div className="flex min-w-0 flex-1 items-center text-[11.5px] text-text-dim">{footerLeft}</div>
            <button
              ref={cancelRef}
              type="button"
              onClick={() => onClose("cancel")}
              className="rounded-md border border-border px-3.5 py-1.5 text-sm hover:bg-bg-hover"
            >
              {cancelLabel}
            </button>
            {onConfirm && (
              <button
                type="button"
                data-dialog-confirm=""
                disabled={disabled}
                onMouseDown={keepFocus}
                onClick={() => void confirm()}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-40",
                  danger ? "bg-danger hover:opacity-90" : "btn-accent"
                )}
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                {confirmLabel}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
