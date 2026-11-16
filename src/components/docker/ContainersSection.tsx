import { Fragment, useState } from "react";
import {
  Info,
  Loader2,
  MoreHorizontal,
  Pause,
  Play,
  RotateCw,
  ScrollText,
  Skull,
  Square,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { ConfirmModal, ContextMenu, type MenuItem } from "@faro/file-ui";
import { ipc } from "@/lib/ipc";
import { STATS_CAPACITY, useDocker } from "@/stores/dockerStore";
import { toast } from "@/stores/toastStore";
import { Sparkline } from "@/components/ui/Sparkline";
import { fmtSize } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { DockerContainer, DockerContainerAction, Elevate } from "@/lib/types";
import { TD, TH, runInTerminal, usePoll } from "../server/shared";
import { ContainerDrawer, type DrawerMode } from "./ContainerDrawer";

export interface SectionProps {
  sessionId: string;
  elevate: Elevate;
  /** `sudo ` when docker runs through sudo, for the commands shown to the user. */
  sudoPrefix: string;
}

const DONE: Record<DockerContainerAction, string> = {
  start: "Started",
  stop: "Stopped",
  restart: "Restarted",
  pause: "Paused",
  unpause: "Resumed",
  kill: "Killed",
  remove: "Removed",
};

function dotClass(state: string): string {
  if (state === "running") return "bg-success";
  if (state === "paused") return "bg-warning";
  if (state === "restarting") return "bg-info";
  if (state === "dead") return "bg-danger";
  return "bg-border";
}

/** A name safe to type into the user's shell (Docker's own character set). */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** A login shell in the container: bash when it has one, else sh. */
export function shellCommand(sudoPrefix: string, target: string): string {
  return `${sudoPrefix}docker exec -it ${target} sh -c 'command -v bash >/dev/null && exec bash || exec sh'`;
}

export function ContainersSection({ sessionId, elevate, sudoPrefix }: SectionProps) {
  const containers = useDocker((s) => s.containers);
  const stats = useDocker((s) => s.stats);
  const cpuHistory = useDocker((s) => s.cpuHistory);
  const refresh = useDocker((s) => s.refreshContainers);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ c: DockerContainer; action: "kill" | "remove" } | null>(
    null
  );
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [open, setOpen] = useState<{ id: string; mode: DrawerMode } | null>(null);

  // A direct `docker` call is cheap and unlogged, so the list keeps itself
  // current. Through sudo every read lands in the server's auth log: no timer.
  usePoll(() => void refresh(elevate, { quiet: true }), 5000, elevate === "none");

  const run = async (c: DockerContainer, action: DockerContainerAction) => {
    setBusy(c.id);
    try {
      const res = await ipc.dockerContainerAction(sessionId, c.id, action, elevate);
      if (res.ok) toast.success(`${DONE[action]} ${c.name}`);
      else toast.error(`Could not ${action} ${c.name}`, res.output || undefined);
      if (res.ok && action === "remove" && open?.id === c.id) setOpen(null);
    } catch (e) {
      toast.error(`Could not ${action} ${c.name}`, String(e));
    } finally {
      setBusy(null);
      void refresh(elevate, { quiet: true });
    }
  };

  const openShell = (c: DockerContainer) => {
    const target = SAFE_NAME.test(c.name) ? c.name : c.id;
    runInTerminal(sessionId, shellCommand(sudoPrefix, target), c.name);
  };

  const more = (c: DockerContainer, x: number, y: number) => {
    const running = c.state === "running";
    const items: MenuItem[] = [
      { label: "Details", icon: <Info size={12} />, onClick: () => setOpen({ id: c.id, mode: "details" }) },
      c.state === "paused"
        ? { label: "Resume", icon: <Play size={12} />, onClick: () => void run(c, "unpause") }
        : { label: "Pause", icon: <Pause size={12} />, disabled: !running, onClick: () => void run(c, "pause") },
      {
        label: "Kill…",
        icon: <Skull size={12} />,
        disabled: !running && c.state !== "paused",
        destructive: true,
        onClick: () => setConfirm({ c, action: "kill" }),
        separatorAfter: true,
      },
      {
        label: "Remove…",
        icon: <Trash2 size={12} />,
        destructive: true,
        onClick: () => setConfirm({ c, action: "remove" }),
      },
    ];
    setMenu({ x, y, items });
  };

  const hasProjects = (containers ?? []).some((c) => c.project);
  const selected = open ? (containers ?? []).find((c) => c.id === open.id) : undefined;

  return (
    <div className="flex min-h-0 flex-1">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className={cn(TH, "w-[24%]")}>Name</th>
              <th className={TH}>Image</th>
              <th className={TH}>Status</th>
              {/* The drawer shows ports in full; the column would only be a sliver. */}
              {!open && <th className={TH}>Ports</th>}
              <th className={cn(TH, "w-32")}>CPU</th>
              <th className={cn(TH, "w-24 text-right")}>Memory</th>
              <th className={cn(TH, "w-40")}>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(containers ?? []).map((c, i, all) => {
              const st = stats[c.name];
              const hist = cpuHistory[c.name] ?? [];
              const running = c.state === "running";
              const active = running || c.state === "paused" || c.state === "restarting";
              const newGroup = hasProjects && (i === 0 || all[i - 1].project !== c.project);
              return (
                <Fragment key={c.id}>
                  {newGroup && (
                    <tr>
                      <td
                        colSpan={7}
                        className="border-b border-border-subtle bg-bg-subtle px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-text-dim"
                      >
                        {c.project ? `Compose · ${c.project}` : "Not in a Compose project"}
                      </td>
                    </tr>
                  )}
                  <tr
                    onClick={() => setOpen({ id: c.id, mode: open?.id === c.id ? open.mode : "details" })}
                    className={cn(
                      "cursor-pointer hover:bg-bg-hover/50",
                      open?.id === c.id && "bg-bg-hover/60"
                    )}
                  >
                    <td className={cn(TD, "font-mono")}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotClass(c.state))}
                          title={c.state}
                        />
                        <span className="truncate" title={c.name}>
                          {c.name}
                        </span>
                      </span>
                    </td>
                    <td className={cn(TD, "max-w-0 truncate font-mono text-text-muted")} title={c.image}>
                      {c.image}
                    </td>
                    <td
                      className={cn(
                        TD,
                        "whitespace-nowrap",
                        c.state === "dead" || /unhealthy/.test(c.status) ? "text-danger" : "text-text-muted"
                      )}
                    >
                      {c.status}
                    </td>
                    {!open && (
                      <td className={cn(TD, "max-w-0 truncate font-mono text-text-muted")} title={c.ports}>
                        {c.ports || <span className="text-text-dim">–</span>}
                      </td>
                    )}
                    <td className={TD}>
                      {running && st ? (
                        <span className="flex items-center gap-2">
                          <Sparkline
                            className="h-4 w-14 shrink-0"
                            label={`CPU history for ${c.name}`}
                            capacity={Math.min(STATS_CAPACITY, Math.max(12, hist.length))}
                            max={Math.max(100, ...hist)}
                            series={[{ values: hist, color: "rgb(var(--accent))" }]}
                          />
                          <span className="font-mono tabular-nums">{st.cpuPct.toFixed(1)}%</span>
                        </span>
                      ) : (
                        <span className="text-text-dim">–</span>
                      )}
                    </td>
                    <td
                      className={cn(TD, "text-right font-mono tabular-nums")}
                      title={st && st.memLimit ? `of ${fmtSize(st.memLimit)}` : undefined}
                    >
                      {running && st ? fmtSize(st.memUsed) : <span className="text-text-dim">–</span>}
                    </td>
                    <td className={cn(TD, "whitespace-nowrap text-right")} onClick={(e) => e.stopPropagation()}>
                      {busy === c.id ? (
                        <Loader2 size={13} className="ml-auto animate-spin text-accent" />
                      ) : (
                        <span className="inline-flex items-center gap-0.5">
                          {active ? (
                            <RowButton label={`Stop ${c.name}`} onClick={() => void run(c, "stop")}>
                              <Square size={13} />
                            </RowButton>
                          ) : (
                            <RowButton label={`Start ${c.name}`} onClick={() => void run(c, "start")}>
                              <Play size={13} />
                            </RowButton>
                          )}
                          <RowButton label={`Restart ${c.name}`} onClick={() => void run(c, "restart")}>
                            <RotateCw size={13} />
                          </RowButton>
                          <RowButton
                            label={`Logs for ${c.name}`}
                            active={open?.id === c.id && open.mode === "logs"}
                            onClick={() => setOpen({ id: c.id, mode: "logs" })}
                          >
                            <ScrollText size={13} />
                          </RowButton>
                          <RowButton label={`Shell in ${c.name}`} disabled={!running} onClick={() => openShell(c)}>
                            <TerminalSquare size={13} />
                          </RowButton>
                          <RowButton
                            label={`More actions for ${c.name}`}
                            onClick={(e) => {
                              const r = e.currentTarget.getBoundingClientRect();
                              more(c, r.left, r.bottom + 2);
                            }}
                          >
                            <MoreHorizontal size={13} />
                          </RowButton>
                        </span>
                      )}
                    </td>
                  </tr>
                </Fragment>
              );
            })}
            {containers && containers.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-[11px] text-text-dim">
                  No containers on this host.
                </td>
              </tr>
            )}
            {!containers && (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-[11px] text-text-dim">
                  Loading containers…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {open && selected && (
        <ContainerDrawer
          sessionId={sessionId}
          elevate={elevate}
          container={selected}
          mode={open.mode}
          onMode={(mode) => setOpen({ id: open.id, mode })}
          onClose={() => setOpen(null)}
        />
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {confirm && (
        <ConfirmModal
          title={`${confirm.action === "kill" ? "Kill" : "Remove"} ${confirm.c.name}?`}
          message={
            (confirm.action === "kill"
              ? "The container is stopped at once (SIGKILL), with no chance to shut down cleanly."
              : confirm.c.state === "running" || confirm.c.state === "paused"
                ? "The container is running: it is killed and then removed. Its writable layer is lost; named volumes stay."
                : "The container is removed. Its writable layer is lost; named volumes stay.") +
            `\n\nRuns:\n${sudoPrefix}docker ${confirm.action === "kill" ? "kill" : "rm -f"} ${confirm.c.name}`
          }
          destructive
          confirmLabel={confirm.action === "kill" ? "Kill" : "Remove"}
          onClose={() => setConfirm(null)}
          onConfirm={() => {
            const { c, action } = confirm;
            setConfirm(null);
            void run(c, action);
          }}
        />
      )}
    </div>
  );
}

export function RowButton({
  label,
  onClick,
  active,
  disabled,
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "rounded p-1 hover:bg-bg-hover hover:text-text disabled:pointer-events-none disabled:opacity-30",
        active ? "bg-bg-hover text-text" : "text-text-dim"
      )}
    >
      {children}
    </button>
  );
}
