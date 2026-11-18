import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { Check, Circle, Loader2, Pencil, RotateCw, Stethoscope, X } from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { ipc } from "@/lib/ipc";
import { messageOf } from "@/lib/errors";
import { cn } from "@/lib/cn";
import { CopyTextButton } from "./ui/CopyText";
import { ConnectionHelp } from "@/components/ui/ConnectionHelp";
import type { ConnectionProfile, DiagnosticReport } from "@/lib/types";
import { AccessGuideLink } from "./CloudflareConnectSheet";
import { ShowMore } from "@/components/ui/ShowMore";

// Right-click › Test connection…: runs the same step-by-step check as the
// editor's Test connection on a saved server, and shows where it stopped.

interface CheckState {
  profile: ConnectionProfile | null;
  onEdit?: () => void;
  open: (profile: ConnectionProfile, onEdit?: () => void) => void;
  close: () => void;
}

export const useConnectionCheck = create<CheckState>((set) => ({
  profile: null,
  open: (profile, onEdit) => set({ profile, onEdit }),
  close: () => set({ profile: null, onEdit: undefined }),
}));

/** The checks after the route, in order, so steps never reached still show. */
const TAIL = ["Destination connection and sign-in", "Starting folder access"];

export function ConnectionCheckDialog() {
  const { profile, onEdit, close } = useConnectionCheck();
  if (!profile) return null;
  return <CheckPanel key={profile.id} profile={profile} onEdit={onEdit} onClose={close} />;
}

function CheckPanel({
  profile,
  onEdit,
  onClose,
}: {
  profile: ConnectionProfile;
  onEdit?: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, { onClose });
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    ipc
      .diagnoseConnection(profile)
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setError(messageOf(e)));
    return () => {
      cancelled = true;
    };
  }, [profile, run]);

  const steps = report?.steps ?? [];
  const notReached = report && !report.ok ? TAIL.filter((l) => !steps.some((s) => s.label === l)) : [];
  const failed = steps.find((s) => !s.ok);
  const where = `${profile.username ? `${profile.username}@` : ""}${profile.host}${profile.port ? `:${profile.port}` : ""}`;

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        data-testid="connection-check"
        className="anim-modal w-[30rem] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        <div className="flex items-center gap-2.5 border-b border-border bg-bg-subtle px-4 py-3">
          <div
            className={cn(
              "flex h-7 w-7 items-center justify-center rounded-md",
              !report && !error
                ? "bg-accent-soft text-accent"
                : report?.ok
                  ? "bg-success/20 text-success"
                  : "bg-danger/20 text-danger"
            )}
          >
            <Stethoscope size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">
              {!report && !error
                ? `Testing ${profile.name}…`
                : report?.ok
                  ? `${profile.name} works`
                  : `${profile.name} didn't connect`}
            </div>
            <div className="truncate font-mono text-[11px] text-text-dim">{where}</div>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text"
            title="Close"
          >
            <X size={13} />
          </button>
        </div>

        <div className="px-4 py-3">
          {error ? (
            <p className="text-[12px] text-text-muted">{error}</p>
          ) : !report ? (
            <div className="flex items-center gap-2 py-2 text-[12px] text-text-muted">
              <Loader2 size={14} className="animate-spin text-accent" />
              Checking the route, the sign-in and the starting folder…
            </div>
          ) : (
            <ol>
              {steps.map((s, i) => (
                <li key={i} className="flex gap-2.5 pb-2.5">
                  <StepMark state={s.ok ? "ok" : "fail"} />
                  <div className="min-w-0 flex-1">
                    <div className={cn("text-[12.5px] font-medium", !s.ok && "text-danger")}>{s.label}</div>
                    {!s.ok && <ShowMore lines={4} className="mt-0.5 text-[11.5px] leading-relaxed text-text-muted">{s.detail}</ShowMore>}
                    {!s.ok && <AccessGuideLink detail={s.detail} />}
                  </div>
                  <span className="shrink-0 font-mono text-[10.5px] text-text-dim">{fmtMs(s.elapsedMs)}</span>
                </li>
              ))}
              {notReached.map((l) => (
                <li key={l} className="flex gap-2.5 pb-2.5">
                  <StepMark state="skip" />
                  <div className="text-[12.5px] text-text-dim">{l}</div>
                  <span className="ml-auto shrink-0 text-[10.5px] text-text-dim">not reached</span>
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-bg-subtle px-4 py-3">
          {report && (
            <span className="flex items-center gap-1">
              <CopyTextButton
                text={[
                  `Faro connection check: ${report.ok ? "passed" : "failed"}`,
                  ...steps.map((s) => `${s.ok ? "✓" : "✗"} ${s.label} (${s.elapsedMs} ms)${s.ok ? "" : ` — ${s.detail}`}`),
                  ...notReached.map((l) => `· ${l} (not reached)`),
                ].join("\n")}
                label
              />
              <ConnectionHelp label="What the report includes">
                Step names, timings and the advice shown here. No addresses, usernames, paths or
                credentials.
              </ConnectionHelp>
            </span>
          )}
          <div className="flex-1" />
          {onEdit && failed && (
            <button
              onClick={() => {
                onClose();
                onEdit();
              }}
              className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-panel px-3 py-1.5 text-xs font-medium hover:bg-bg-hover"
            >
              <Pencil size={12} />
              Edit connection
            </button>
          )}
          <button
            onClick={() => setRun((n) => n + 1)}
            disabled={!report && !error}
            className="inline-flex items-center gap-1 rounded-md border border-border bg-bg-panel px-3 py-1.5 text-xs font-medium hover:bg-bg-hover disabled:opacity-50"
          >
            <RotateCw size={12} />
            Run again
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtMs(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function StepMark({ state }: { state: "ok" | "fail" | "skip" }) {
  const dot = "flex h-4 w-4 items-center justify-center rounded-full";
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
      {state === "ok" ? (
        <span className={cn(dot, "bg-success/20 text-success")}>
          <Check size={10} strokeWidth={3} />
        </span>
      ) : state === "fail" ? (
        <span className={cn(dot, "bg-danger/20 text-danger")}>
          <X size={10} strokeWidth={3} />
        </span>
      ) : (
        <Circle size={15} className="text-text-dim/50" />
      )}
    </span>
  );
}
