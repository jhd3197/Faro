import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import type { ListeningPort } from "@/lib/types";
import {
  AskSudoButton,
  FilterInput,
  Notice,
  RefreshButton,
  SudoPasswordModal,
  TD,
  TH,
  useRoot,
} from "./shared";

/** Who can reach a listening address. */
function scope(address: string): { label: string; exposed: boolean } {
  const a = address.split("%")[0];
  if (a === "::1" || a.startsWith("127.")) return { label: "this host only", exposed: false };
  if (a === "0.0.0.0" || a === "*" || a === "::") return { label: "all interfaces", exposed: true };
  return { label: "one address", exposed: true };
}

export function PortsTab() {
  const { probe, sessionId, elevate, root, canAsk, allow } = useRoot();
  const [ports, setPorts] = useState<ListeningPort[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Why the list is the plain user's view when root was asked for. */
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [askSudo, setAskSudo] = useState(false);
  const tool = probe?.ports;

  // Elevated reads are logged by sudo on the server, so this tab loads when
  // opened and on Refresh, not on a timer.
  const load = useCallback(async () => {
    if (!sessionId || !tool) return;
    setLoading(true);
    try {
      const report = await ipc.sysmonPorts(sessionId, tool, elevate);
      setPorts(report.ports);
      setNote(report.note);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, tool, elevate]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return ports ?? [];
    return (ports ?? []).filter(
      (p) =>
        String(p.port).includes(q) ||
        p.process.toLowerCase().includes(q) ||
        p.address.toLowerCase().includes(q) ||
        p.proto.includes(q)
    );
  }, [ports, filter]);

  const unnamed = (ports ?? []).some((p) => !p.process);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <FilterInput value={filter} onChange={setFilter} placeholder="Filter by port, process or address" />
        <span className="flex-1 text-[11px] tabular-nums text-text-dim">
          {ports ? `${shown.length} of ${ports.length} listening sockets` : ""}
        </span>
        <span className="font-mono text-[10px] text-text-dim">{tool}</span>
        <RefreshButton onClick={() => void load()} busy={loading} />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {note && <Notice>{note}</Notice>}
      {!root && unnamed && (
        <Notice action={canAsk ? <AskSudoButton onClick={() => setAskSudo(true)} /> : undefined}>
          Sockets owned by other users show no process name without root.
        </Notice>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className={cn(TH, "w-20 text-right")}>Port</th>
              <th className={cn(TH, "w-16")}>Proto</th>
              <th className={TH}>Address</th>
              <th className={TH}>Reachable from</th>
              <th className={TH}>Process</th>
              <th className={cn(TH, "w-20 text-right")}>PID</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p, i) => {
              const s = scope(p.address);
              return (
                <tr key={`${p.proto}-${p.address}-${p.port}-${i}`} className="hover:bg-bg-hover/50">
                  <td className={cn(TD, "text-right font-mono font-medium tabular-nums")}>{p.port}</td>
                  <td className={cn(TD, "font-mono text-text-muted")}>{p.proto}</td>
                  <td className={cn(TD, "font-mono text-text-muted")}>{p.address}</td>
                  <td className={cn(TD, s.exposed ? "text-text" : "text-text-dim")}>{s.label}</td>
                  <td className={cn(TD, "font-mono")}>
                    {p.process || <span className="text-text-dim">–</span>}
                  </td>
                  <td className={cn(TD, "text-right font-mono tabular-nums text-text-muted")}>
                    {p.pid ?? "–"}
                  </td>
                </tr>
              );
            })}
            {ports && shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-[11px] text-text-dim">
                  {ports.length === 0 ? "Nothing is listening." : "No sockets match."}
                </td>
              </tr>
            )}
            {!ports && !error && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-[11px] text-text-dim">
                  Loading listening sockets…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {askSudo && (
        <SudoPasswordModal
          host={probe?.hostname || "this server"}
          onClose={() => setAskSudo(false)}
          // Agreeing changes `elevate`, which reloads the table as root.
          onConfirm={allow}
        />
      )}
    </div>
  );
}
