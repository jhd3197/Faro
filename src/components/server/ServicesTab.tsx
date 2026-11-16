import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Play, RotateCw, ScrollText, Square, X } from "lucide-react";
import { ConfirmModal } from "@faro/file-ui";
import { ipc } from "@/lib/ipc";
import { toast } from "@/stores/toastStore";
import { cn } from "@/lib/cn";
import type { Elevate, ServiceAction, ServiceUnit } from "@/lib/types";
import {
  FilterInput,
  Notice,
  RefreshButton,
  SudoPasswordModal,
  TD,
  TH,
  runInTerminal,
  usePoll,
  useRoot,
} from "./shared";

type StateFilter = "all" | "running" | "failed";

const ACTION_VERB: Record<ServiceAction, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  reload: "Reload",
};

const ACTION_DONE: Record<ServiceAction, string> = {
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
  reload: "Reloaded",
};

function dotClass(u: ServiceUnit): string {
  if (u.active === "failed") return "bg-danger";
  if (u.sub === "running") return "bg-success";
  if (u.active === "active") return "bg-info";
  return "bg-border";
}

export function ServicesTab() {
  const { probe, sessionId, elevate, root, canAsk, allow } = useRoot();
  const [units, setUnits] = useState<ServiceUnit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [stateFilter, setStateFilter] = useState<StateFilter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ unit: string; action: ServiceAction } | null>(null);
  const [askSudo, setAskSudo] = useState<{ unit: string; action: ServiceAction } | null>(null);
  const [logsUnit, setLogsUnit] = useState<string | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!sessionId) return;
      if (!quiet) setLoading(true);
      try {
        setUnits(await ipc.sysmonServices(sessionId));
        setError(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId]
  );

  useEffect(() => {
    void load();
  }, [load]);
  // The unit list needs no root, so it can refresh on its own.
  usePoll(() => void load(true), 10_000, !!sessionId);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (units ?? []).filter((u) => {
      if (stateFilter === "running" && u.sub !== "running") return false;
      if (stateFilter === "failed" && u.active !== "failed") return false;
      return !q || u.unit.toLowerCase().includes(q) || u.description.toLowerCase().includes(q);
    });
  }, [units, filter, stateFilter]);

  const failed = (units ?? []).filter((u) => u.active === "failed").length;
  const sudoPrefix = probe?.root === "root" ? "" : "sudo ";

  const run = async (unit: string, action: ServiceAction, how: Elevate) => {
    if (!sessionId) return;
    setBusy(unit);
    try {
      const res = await ipc.sysmonServiceAction(sessionId, unit, action, how);
      if (res.ok) {
        toast.success(`${ACTION_DONE[action]} ${unit}`);
      } else {
        toast.error(`Could not ${action} ${unit}`, res.output || undefined);
      }
    } catch (e) {
      toast.error(`Could not ${action} ${unit}`, String(e));
    } finally {
      setBusy(null);
      void load(true);
    }
  };

  /** After the user confirmed the action itself: find a way to be root. */
  const proceed = (unit: string, action: ServiceAction) => {
    if (!sessionId) return;
    if (root) {
      void run(unit, action, elevate);
    } else if (canAsk) {
      setAskSudo({ unit, action });
    } else {
      // No root Faro can use (key login and sudo wants a password, or no
      // sudo at all): hand the command to a terminal the user can answer in.
      runInTerminal(sessionId, `${sudoPrefix}systemctl ${action} ${unit}`);
    }
  };

  const viaTerminal = !root && !canAsk;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
          <FilterInput value={filter} onChange={setFilter} placeholder="Filter services" />
          <div
            role="radiogroup"
            aria-label="Service state"
            className="flex h-6 shrink-0 overflow-hidden rounded-md border border-border text-[11px]"
          >
            {(
              [
                ["all", "All"],
                ["running", "Running"],
                ["failed", failed > 0 ? `Failed (${failed})` : "Failed"],
              ] as const
            ).map(([id, label], i) => (
              <button
                key={id}
                role="radio"
                aria-checked={stateFilter === id}
                onClick={() => setStateFilter(id)}
                className={cn(
                  "px-2.5 [&:active]:scale-100",
                  i > 0 && "border-l border-border",
                  stateFilter === id
                    ? "bg-bg-hover font-medium text-text"
                    : "text-text-dim hover:text-text",
                  id === "failed" && failed > 0 && stateFilter !== id && "text-danger"
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="flex-1 text-[11px] tabular-nums text-text-dim">
            {units ? `${shown.length} of ${units.length}` : ""}
          </span>
          <RefreshButton onClick={() => void load()} busy={loading} />
        </div>

        {error && <Notice tone="error">{error}</Notice>}

        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th className={cn(TH, "w-[34%]")}>Unit</th>
                <th className={TH}>State</th>
                <th className={TH}>Description</th>
                <th className={cn(TH, "w-28")}>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((u) => {
                const isActive = u.active === "active" || u.active === "activating";
                const isBusy = busy === u.unit;
                return (
                  <tr
                    key={u.unit}
                    className={cn("hover:bg-bg-hover/50", logsUnit === u.unit && "bg-bg-hover/60")}
                  >
                    <td className={cn(TD, "font-mono")}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass(u))} />
                        <span className="truncate" title={u.unit}>
                          {u.unit}
                        </span>
                      </span>
                    </td>
                    <td
                      className={cn(
                        TD,
                        "whitespace-nowrap font-mono",
                        u.active === "failed" ? "text-danger" : "text-text-muted"
                      )}
                    >
                      {u.active} ({u.sub})
                    </td>
                    <td className={cn(TD, "max-w-0 truncate text-text-muted")} title={u.description}>
                      {u.description}
                    </td>
                    <td className={cn(TD, "whitespace-nowrap text-right")}>
                      {isBusy ? (
                        <Loader2 size={13} className="ml-auto animate-spin text-accent" />
                      ) : (
                        <span className="inline-flex items-center gap-0.5">
                          <RowButton
                            label={`Restart ${u.unit}`}
                            onClick={() => setConfirm({ unit: u.unit, action: "restart" })}
                          >
                            <RotateCw size={13} />
                          </RowButton>
                          {isActive ? (
                            <RowButton
                              label={`Stop ${u.unit}`}
                              onClick={() => setConfirm({ unit: u.unit, action: "stop" })}
                            >
                              <Square size={13} />
                            </RowButton>
                          ) : (
                            <RowButton
                              label={`Start ${u.unit}`}
                              onClick={() => proceed(u.unit, "start")}
                            >
                              <Play size={13} />
                            </RowButton>
                          )}
                          <RowButton
                            label={`Logs for ${u.unit}`}
                            active={logsUnit === u.unit}
                            onClick={() => setLogsUnit(logsUnit === u.unit ? null : u.unit)}
                          >
                            <ScrollText size={13} />
                          </RowButton>
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {units && shown.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-[11px] text-text-dim">
                    No services match.
                  </td>
                </tr>
              )}
              {!units && !error && (
                <tr>
                  <td colSpan={4} className="px-3 py-6 text-center text-[11px] text-text-dim">
                    Loading services…
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {logsUnit && sessionId && (
        <LogsDrawer
          key={logsUnit}
          sessionId={sessionId}
          unit={logsUnit}
          elevate={elevate}
          onClose={() => setLogsUnit(null)}
        />
      )}

      {confirm && (
        <ConfirmModal
          title={`${ACTION_VERB[confirm.action]} ${confirm.unit}?`}
          message={
            `Runs on ${probe?.hostname || "the server"}:\n` +
            `${sudoPrefix}systemctl ${confirm.action} ${confirm.unit}` +
            (viaTerminal
              ? `\n\nsudo needs a password Faro doesn't have, so the command opens in a terminal where you can type it.`
              : "")
          }
          destructive={confirm.action === "stop"}
          confirmLabel={viaTerminal ? "Open in terminal" : ACTION_VERB[confirm.action]}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            proceed(c.unit, c.action);
          }}
        />
      )}
      {askSudo && (
        <SudoPasswordModal
          host={probe?.hostname || "this server"}
          onClose={() => setAskSudo(null)}
          onConfirm={() => {
            allow();
            void run(askSudo.unit, askSudo.action, "password");
          }}
        />
      )}
    </div>
  );
}

function RowButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "rounded p-1 hover:bg-bg-hover hover:text-text",
        active ? "bg-bg-hover text-text" : "text-text-dim"
      )}
    >
      {children}
    </button>
  );
}

function LogsDrawer({
  sessionId,
  unit,
  elevate,
  onClose,
}: {
  sessionId: string;
  unit: string;
  elevate: Elevate;
  onClose: () => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setText(await ipc.sysmonServiceLogs(sessionId, unit, elevate, 200));
    } catch (e) {
      setText(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, unit, elevate]);

  useEffect(() => {
    void load();
  }, [load]);

  // Newest lines are at the bottom; land there.
  useEffect(() => {
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text]);

  return (
    <aside
      aria-label={`Logs for ${unit}`}
      className="flex w-[min(40rem,55%)] shrink-0 flex-col border-l border-border bg-bg-panel"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <ScrollText size={13} className="shrink-0 text-text-dim" />
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={unit}>
          {unit}
        </span>
        <span className="shrink-0 text-[10px] text-text-dim">last 200 lines</span>
        <RefreshButton onClick={() => void load()} busy={loading} />
        <button
          onClick={onClose}
          title="Close logs"
          aria-label="Close logs"
          className="shrink-0 rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text"
        >
          <X size={14} />
        </button>
      </div>
      <pre
        ref={preRef}
        tabIndex={0}
        className="selectable min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-[11px] leading-relaxed text-text-muted [overflow-wrap:anywhere]"
      >
        {text ?? "Loading…"}
      </pre>
    </aside>
  );
}
