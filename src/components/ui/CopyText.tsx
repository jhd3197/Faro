import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/cn";

/** The whole notification as plain text: title, then the message. */
export function notificationText(n: { title: string; message?: string }): string {
  return n.message ? `${n.title}\n${n.message}` : n.title;
}

/** Copies `text` to the clipboard and shows "Copied" in place for a moment —
 *  no toast, so copying a notification doesn't create another one. */
export function CopyTextButton({
  text,
  label,
  className,
}: {
  text: string;
  /** Show a text label next to the icon. */
  label?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can be unavailable (focus/permissions); the text stays selectable.
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={copied ? "Copied" : "Copy the full text"}
      aria-label={copied ? "Copied" : "Copy the full text"}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded p-0.5 text-text-dim hover:bg-bg-hover hover:text-text",
        className
      )}
    >
      {copied ? <Check size={12} className="text-success" /> : <Copy size={12} />}
      {label && <span className="text-[10px]">{copied ? "Copied" : "Copy"}</span>}
    </button>
  );
}
