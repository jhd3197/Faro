import { useEffect, useState } from "react";
import { Eye, EyeOff, FolderOpen, X } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useLayout } from "@/stores/layoutStore";
import { useServerView } from "@/stores/serverViewStore";
import { LogView } from "@/components/ui/LogView";
import { cn } from "@/lib/cn";
import type { DockerContainer, DockerContainerDetail, Elevate } from "@/lib/types";

export type DrawerMode = "details" | "logs";

/** One container, beside the list: what it is, or what it is printing. */
export function ContainerDrawer({
  sessionId,
  elevate,
  container,
  mode,
  onMode,
  onClose,
}: {
  sessionId: string;
  elevate: Elevate;
  container: DockerContainer;
  mode: DrawerMode;
  onMode: (m: DrawerMode) => void;
  onClose: () => void;
}) {
  return (
    <aside
      aria-label={`Container ${container.name}`}
      className="flex w-[min(42rem,55%)] shrink-0 flex-col border-l border-border bg-bg-panel"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={container.name}>
          {container.name}
        </span>
        <div
          role="tablist"
          aria-label="Container view"
          className="flex h-6 shrink-0 overflow-hidden rounded-md border border-border text-[11px]"
        >
          {(["details", "logs"] as const).map((m, i) => (
            <button
              key={m}
              role="tab"
              aria-selected={mode === m}
              onClick={() => onMode(m)}
              className={cn(
                "px-2.5 capitalize [&:active]:scale-100",
                i > 0 && "border-l border-border",
                mode === m ? "bg-bg-hover font-medium text-text" : "text-text-dim hover:text-text"
              )}
            >
              {m}
            </button>
          ))}
        </div>
        <button
          onClick={onClose}
          title="Close"
          aria-label="Close container panel"
          className="shrink-0 rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text"
        >
          <X size={14} />
        </button>
      </div>

      {mode === "logs" ? (
        <LogView
          className="flex-1"
          sessionId={sessionId}
          streamKey={`docker:${container.id}`}
          // A stream can't type a sudo password; those hosts get a tail.
          follow={
            elevate === "password" ? null : () => ipc.dockerLogsStart(sessionId, container.id, elevate, 200)
          }
          tail={() => ipc.dockerLogsTail(sessionId, container.id, elevate, 500)}
        />
      ) : (
        // Re-read when the container changes state (restart, stop).
        <Details
          key={`${container.id}-${container.state}`}
          sessionId={sessionId}
          elevate={elevate}
          id={container.id}
        />
      )}
    </aside>
  );
}

function Details({ sessionId, elevate, id }: { sessionId: string; elevate: Elevate; id: string }) {
  const [detail, setDetail] = useState<DockerContainerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [revealAll, setRevealAll] = useState(false);
  const requestReveal = useLayout((s) => s.requestReveal);
  const closeView = useServerView((s) => s.close);

  useEffect(() => {
    let alive = true;
    ipc
      .dockerInspect(sessionId, id, elevate)
      .then((d) => alive && setDetail(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [sessionId, id, elevate]);

  if (error) {
    return <div className="px-3 py-3 text-xs text-danger [overflow-wrap:anywhere]">{error}</div>;
  }
  if (!detail) {
    return <div className="px-3 py-3 text-[11px] text-text-dim">Reading container…</div>;
  }

  const toggle = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const reveal = (path: string) => {
    requestReveal(sessionId, path);
    closeView();
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto text-xs">
      <Section title="Container">
        <Row k="Image" v={detail.image} />
        <Row k="Command" v={detail.command} />
        <Row
          k="State"
          v={
            detail.status +
            (detail.health ? ` · ${detail.health}` : "") +
            (detail.status !== "running" ? ` · exit ${detail.exitCode}` : "")
          }
        />
        <Row k="Started" v={detail.startedAt} />
        <Row k="Restarts" v={`${detail.restartCount} · policy ${detail.restartPolicy || "no"}`} />
        <Row k="ID" v={detail.id} />
      </Section>

      <Section title={`Ports (${detail.ports.length})`}>
        {detail.ports.length === 0 && <Empty>None exposed.</Empty>}
        {detail.ports.map((p, i) => (
          <Row key={i} k={p.container} v={p.host || "not published"} dim={!p.host} />
        ))}
      </Section>

      <Section title={`Networks (${detail.networks.length})`}>
        {detail.networks.length === 0 && <Empty>None.</Empty>}
        {detail.networks.map(([name, ip]) => (
          <Row key={name} k={name} v={ip || "–"} />
        ))}
      </Section>

      <Section title={`Mounts (${detail.mounts.length})`}>
        {detail.mounts.length === 0 && <Empty>None.</Empty>}
        {detail.mounts.map((m, i) => (
          <div key={i} className="flex items-start gap-2 px-3 py-1">
            <span className="w-14 shrink-0 text-text-dim">{m.kind}</span>
            <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">
              <span className="text-text">{m.name ?? m.source}</span>
              <span className="text-text-dim"> → </span>
              <span className="text-text-muted">{m.destination}</span>
              {!m.rw && <span className="text-text-dim"> (read-only)</span>}
            </span>
            {m.kind === "bind" && (
              <button
                onClick={() => reveal(m.source)}
                title={`Show ${m.source} in the file browser`}
                className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text"
              >
                <FolderOpen size={11} /> Reveal
              </button>
            )}
          </div>
        ))}
      </Section>

      <Section
        title={`Environment (${detail.env.length})`}
        action={
          detail.env.length > 0 && (
            <button
              onClick={() => setRevealAll((v) => !v)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text"
            >
              {revealAll ? <EyeOff size={11} /> : <Eye size={11} />}
              {revealAll ? "Hide values" : "Show values"}
            </button>
          )
        }
      >
        {detail.env.length === 0 && <Empty>None.</Empty>}
        {detail.env.map(([k, v]) => {
          const shown = revealAll || revealed.has(k);
          return (
            <div key={k} className="flex items-start gap-2 px-3 py-1">
              <span className="min-w-0 flex-1 font-mono [overflow-wrap:anywhere]">
                <span className="text-text">{k}</span>
                <span className="text-text-dim">=</span>
                <span className="text-text-muted">{shown ? v : v ? "••••••••" : ""}</span>
              </span>
              {v && !revealAll && (
                <button
                  onClick={() => toggle(k)}
                  title={shown ? `Hide ${k}` : `Show ${k}`}
                  aria-label={shown ? `Hide ${k}` : `Show ${k}`}
                  className="shrink-0 rounded p-0.5 text-text-dim hover:bg-bg-hover hover:text-text"
                >
                  {shown ? <EyeOff size={11} /> : <Eye size={11} />}
                </button>
              )}
            </div>
          );
        })}
      </Section>

      {detail.labels.length > 0 && (
        <details className="border-b border-border-subtle">
          <summary className="cursor-pointer px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-dim hover:text-text">
            Labels ({detail.labels.length})
          </summary>
          {detail.labels.map(([k, v]) => (
            <Row key={k} k={k} v={v} wideKey />
          ))}
        </details>
      )}
    </div>
  );
}

function Section({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="border-b border-border-subtle pb-1">
      <div className="flex items-center justify-between px-3 pb-0.5 pt-2">
        <h4 className="text-[10px] font-medium uppercase tracking-wider text-text-dim">{title}</h4>
        {action}
      </div>
      {children}
    </section>
  );
}

function Row({ k, v, dim, wideKey }: { k: string; v: string; dim?: boolean; wideKey?: boolean }) {
  return (
    <div className="flex items-start gap-2 px-3 py-1">
      <span className={cn("shrink-0 text-text-dim [overflow-wrap:anywhere]", wideKey ? "w-2/5 font-mono" : "w-20")}>
        {k}
      </span>
      <span
        className={cn(
          "selectable min-w-0 flex-1 font-mono [overflow-wrap:anywhere]",
          dim ? "text-text-dim" : "text-text-muted"
        )}
      >
        {v}
      </span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-3 py-1 text-[11px] text-text-dim">{children}</div>;
}
