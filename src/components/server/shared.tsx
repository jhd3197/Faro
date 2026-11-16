import { useEffect, useRef } from "react";
import { RefreshCw, Loader2, AlertCircle, KeyRound } from "lucide-react";
import { ConfirmModal } from "@faro/file-ui";
import {
  elevateFor,
  hasRoot,
  useServerView,
} from "@/stores/serverViewStore";
import { useTerminals } from "@/stores/terminalsStore";
import { useLayout } from "@/stores/layoutStore";
import { cn } from "@/lib/cn";

/** How this host gives Faro root, and whether asking for the password helps. */
export function useRoot() {
  const probe = useServerView((s) => s.probe);
  const sessionId = useServerView((s) => s.sessionId);
  const passwordOk = useServerView((s) =>
    s.sessionId ? !!s.passwordSudo[s.sessionId] : false
  );
  const allow = useServerView((s) => s.allowPasswordSudo);
  return {
    probe,
    sessionId,
    /** What to pass to a command right now. */
    elevate: elevateFor(probe, passwordOk),
    /** Commands run as root right now. */
    root: hasRoot(probe, passwordOk),
    /** sudo wants a password, Faro has one, and the user hasn't agreed yet. */
    canAsk: probe?.root === "password" && probe.hasPassword && !passwordOk,
    allow,
  };
}

/** One-time, per-session consent to answer sudo with the login password. */
export function SudoPasswordModal({
  host,
  onConfirm,
  onClose,
}: {
  host: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <ConfirmModal
      title="Use this connection's password for sudo?"
      message={
        `Faro will answer sudo's prompt on ${host} with the password this ` +
        `connection logged in with, until you disconnect.\n` +
        `It is typed at sudo's prompt, never put on a command line.`
      }
      confirmLabel="Use password"
      onClose={onClose}
      onConfirm={() => {
        onClose();
        onConfirm();
      }}
    />
  );
}

/** Open a terminal tab on the session with `command` already typed and run. */
export function runInTerminal(sessionId: string, command: string, title?: string) {
  const terminals = useTerminals.getState();
  const tab = terminals.openTab(sessionId, command);
  if (title) terminals.renameTab(tab.id, title);
  useLayout.getState().setTerminalOpen(true);
}

/** Call `fn` every `ms` while `enabled` and the window is visible. */
export function usePoll(fn: () => void, ms: number, enabled: boolean) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => {
      if (!document.hidden) ref.current();
    }, ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
}

export function RefreshButton({
  onClick,
  busy,
  title = "Refresh",
}: {
  onClick: () => void;
  busy?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={title}
      className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60"
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
      Refresh
    </button>
  );
}

/** A full-width notice above a table: what is missing and how to get it. */
export function Notice({
  tone = "info",
  children,
  action,
}: {
  tone?: "info" | "error";
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex shrink-0 items-start gap-2 border-b border-border px-3 py-1.5 text-xs",
        tone === "error" ? "bg-danger-soft text-text" : "bg-bg-subtle text-text-muted"
      )}
    >
      <AlertCircle
        size={13}
        className={cn("mt-0.5 shrink-0", tone === "error" ? "text-danger" : "text-text-dim")}
      />
      <div className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">{children}</div>
      {action}
    </div>
  );
}

/** "Use sudo password" — shown where root would reveal more. */
export function AskSudoButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-0.5 text-[11px] text-text hover:bg-bg-hover"
    >
      <KeyRound size={11} /> Use sudo password
    </button>
  );
}

export function FilterInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={placeholder}
      spellCheck={false}
      className="h-6 w-56 rounded-md border border-border bg-bg px-2 text-[11px] text-text placeholder:text-text-dim focus:border-accent focus:outline-none"
    />
  );
}

/** Table header / cell classes shared by the Server view tables. */
export const TH =
  "sticky top-0 z-[1] border-b border-border bg-bg-panel px-3 py-1.5 text-left text-[10px] font-medium uppercase tracking-wider text-text-dim";
export const TD = "border-b border-border-subtle px-3 py-1.5 align-middle";
