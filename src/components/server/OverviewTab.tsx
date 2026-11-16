import { HardDrive, Loader2 } from "lucide-react";
import { SAMPLE_CAPACITY, useServerView } from "@/stores/serverViewStore";
import { useDiskScan } from "@/stores/diskScanStore";
import { Sparkline } from "@/components/ui/Sparkline";
import { fmtRate, fmtSize } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { SysSample } from "@/lib/types";
import { Notice, TD, TH, usePoll } from "./shared";

const ACCENT = "rgb(var(--accent))";
const INFO = "rgb(var(--info))";

/** "3d 4h", "5h 12m", "9m". */
function fmtUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Round a rate up to 1, 2 or 5 × a power of ten so the scale label is tidy. */
function niceCeil(v: number): number {
  if (v <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

function pct(v: number | null | undefined): string {
  return v == null ? "–" : `${v.toFixed(1)}%`;
}

/** Text colour for a load figure: quiet until it needs attention. */
function loadTone(v: number | null | undefined): string {
  if (v == null) return "text-text";
  if (v >= 95) return "text-danger";
  if (v >= 80) return "text-warning";
  return "text-text";
}

function Panel({
  title,
  value,
  valueClass,
  detail,
  children,
}: {
  title: string;
  value: React.ReactNode;
  valueClass?: string;
  detail: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[10px] font-medium uppercase tracking-wider text-text-dim">{title}</h3>
        <div className={cn("font-mono text-lg font-semibold tabular-nums leading-none", valueClass)}>
          {value}
        </div>
      </div>
      <div className="mt-1 truncate text-right font-mono text-[11px] tabular-nums text-text-muted">
        {detail}
      </div>
      <div className="mt-2 h-32 border-b border-border-subtle">{children}</div>
    </section>
  );
}

export function OverviewTab() {
  const samples = useServerView((s) => s.samples);
  const sampler = useServerView((s) => s.sampler);
  const samplerError = useServerView((s) => s.samplerError);
  const resume = useServerView((s) => s.resume);
  const disks = useServerView((s) => s.disks);
  const refreshDisks = useServerView((s) => s.refreshDisks);
  const sessionId = useServerView((s) => s.sessionId);
  const close = useServerView((s) => s.close);

  usePoll(() => void refreshDisks(), 30_000, sampler === "running");

  const last: SysSample | undefined = samples[samples.length - 1];
  // The charts start as a two-minute window and widen to the full history, so
  // the first samples are readable instead of a sliver at the right edge.
  const slots = Math.min(SAMPLE_CAPACITY, Math.max(60, samples.length));
  const windowLabel = `over the last ${Math.max(1, Math.round((slots * 2) / 60))} minutes`;
  const netPeak = Math.max(
    10 * 1024,
    ...samples.map((s) => Math.max(s.rxBps ?? 0, s.txBps ?? 0))
  );
  const netMax = niceCeil(netPeak);
  const memPct = last && last.memTotal > 0 ? (last.memUsed / last.memTotal) * 100 : null;

  const openDiskUsage = (mount: string) => {
    if (!sessionId) return;
    close();
    void useDiskScan.getState().openFor(sessionId, mount);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      {sampler === "ended" && (
        <Notice
          tone="error"
          action={
            <button
              onClick={() => void resume()}
              className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] text-text hover:bg-bg-hover"
            >
              Resume
            </button>
          }
        >
          Live metrics stopped{samplerError ? `: ${samplerError}` : "."}
        </Notice>
      )}
      {!last && sampler !== "ended" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-bg-subtle px-3 py-1.5 text-xs text-text-muted">
          <Loader2 size={13} className="animate-spin text-accent" />
          Waiting for the first sample…
        </div>
      )}

      <div className="grid shrink-0 grid-cols-1 divide-y divide-border border-b border-border lg:grid-cols-3 lg:divide-x lg:divide-y-0">
        <Panel
          title="CPU"
          value={pct(last?.cpuPct)}
          valueClass={loadTone(last?.cpuPct)}
          detail={
            last
              ? `load ${last.load.map((l) => l.toFixed(2)).join(" ")} · iowait ${pct(last.iowaitPct)}`
              : " "
          }
        >
          <Sparkline
            className="h-full w-full"
            label={`CPU usage ${windowLabel}`}
            capacity={slots}
            max={100}
            series={[{ values: samples.map((s) => s.cpuPct), color: ACCENT, fill: true }]}
          />
        </Panel>

        <Panel
          title="Memory"
          value={last ? fmtSize(last.memUsed) : "–"}
          valueClass={loadTone(memPct)}
          detail={
            last
              ? `${pct(memPct)} of ${fmtSize(last.memTotal)}` +
                (last.swapTotal > 0
                  ? ` · swap ${fmtSize(last.swapUsed)} / ${fmtSize(last.swapTotal)}`
                  : " · no swap")
              : " "
          }
        >
          <Sparkline
            className="h-full w-full"
            label={`Memory in use ${windowLabel}`}
            capacity={slots}
            max={last?.memTotal || 1}
            series={[{ values: samples.map((s) => s.memUsed), color: ACCENT, fill: true }]}
          />
        </Panel>

        <Panel
          title="Network"
          value={
            <span className="flex items-baseline gap-3 text-sm">
              <span style={{ color: ACCENT }}>↓ {last?.rxBps != null ? fmtRate(last.rxBps) : "–"}</span>
              <span style={{ color: INFO }}>↑ {last?.txBps != null ? fmtRate(last.txBps) : "–"}</span>
            </span>
          }
          detail={`scale 0 – ${fmtRate(netMax)}`}
        >
          <Sparkline
            className="h-full w-full"
            label={`Network receive and transmit rate ${windowLabel}`}
            capacity={slots}
            max={netMax}
            series={[
              { values: samples.map((s) => s.rxBps), color: ACCENT, fill: true },
              { values: samples.map((s) => s.txBps), color: INFO },
            ]}
          />
        </Panel>
      </div>

      {last && (
        <div className="flex shrink-0 flex-wrap items-end gap-x-6 gap-y-2 border-b border-border px-4 py-2.5 text-[11px] text-text-muted">
          <div>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-dim">
              Cores ({last.cores.length || "–"})
            </div>
            <div className="flex flex-wrap items-end gap-[3px]" role="list">
              {last.cores.map((c, i) => (
                <div
                  key={i}
                  role="listitem"
                  title={`cpu${i}: ${c.toFixed(0)}%`}
                  aria-label={`cpu${i} ${c.toFixed(0)} percent`}
                  className="relative h-7 w-2 overflow-hidden rounded-[2px] bg-bg-subtle"
                >
                  <div
                    className={cn(
                      "absolute inset-x-0 bottom-0",
                      c >= 95 ? "bg-danger" : c >= 80 ? "bg-warning" : "bg-text-muted"
                    )}
                    style={{ height: `${Math.max(c, 2)}%` }}
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="font-mono tabular-nums">up {fmtUptime(last.uptimeSecs)}</div>
          <div className="flex min-w-0 flex-wrap gap-x-4 gap-y-0.5 font-mono tabular-nums">
            {last.ifaces.map((n) => (
              <span key={n.name} className="whitespace-nowrap">
                <span className="text-text">{n.name}</span> ↓ {fmtRate(n.rxBps)} ↑ {fmtRate(n.txBps)}
              </span>
            ))}
          </div>
        </div>
      )}

      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className={TH}>Mount</th>
            <th className={TH}>Filesystem</th>
            <th className={cn(TH, "text-right")}>Used</th>
            <th className={cn(TH, "text-right")}>Size</th>
            <th className={cn(TH, "w-[30%]")}>Fill</th>
            <th className={TH}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {disks.map((d) => {
            const fill = d.total > 0 ? (d.used / d.total) * 100 : 0;
            return (
              <tr key={d.mount} className="hover:bg-bg-hover/50">
                <td className={cn(TD, "font-mono")}>{d.mount}</td>
                <td className={cn(TD, "font-mono text-text-muted")}>{d.filesystem}</td>
                <td className={cn(TD, "text-right font-mono tabular-nums")}>{fmtSize(d.used)}</td>
                <td className={cn(TD, "text-right font-mono tabular-nums text-text-muted")}>
                  {fmtSize(d.total)}
                </td>
                <td className={TD}>
                  <div className="flex items-center gap-2">
                    <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg-subtle">
                      <div
                        className={cn(
                          "h-full",
                          fill >= 90 ? "bg-danger" : fill >= 75 ? "bg-warning" : "bg-text-muted"
                        )}
                        style={{ width: `${fill}%` }}
                      />
                    </div>
                    <span className="w-10 text-right font-mono tabular-nums text-text-muted">
                      {fill.toFixed(0)}%
                    </span>
                  </div>
                </td>
                <td className={cn(TD, "text-right")}>
                  <button
                    onClick={() => openDiskUsage(d.mount)}
                    className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text"
                    title={`See what is using space under ${d.mount}`}
                  >
                    <HardDrive size={11} /> Disk Usage
                  </button>
                </td>
              </tr>
            );
          })}
          {disks.length === 0 && (
            <tr>
              <td colSpan={6} className="px-3 py-4 text-center text-[11px] text-text-dim">
                {last ? "No filesystems reported." : " "}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
