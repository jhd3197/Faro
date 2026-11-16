import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/Badge";
import type { FirewallReport, FirewallTool } from "@/lib/types";
import {
  AskSudoButton,
  Notice,
  RefreshButton,
  SudoPasswordModal,
  TD,
  TH,
  runInTerminal,
  useRoot,
} from "./shared";

const TOOL_LABEL: Record<FirewallTool, string> = {
  ufw: "ufw",
  firewalld: "firewalld",
  nft: "nftables",
  iptables: "iptables",
};

/** The command a tool's view comes from, for the "open in terminal" escape. */
const TOOL_COMMAND: Record<FirewallTool, string> = {
  ufw: "ufw status verbose",
  firewalld: "firewall-cmd --list-all",
  nft: "nft list ruleset",
  iptables: "iptables -S",
};

/** Read-only: this tab shows the firewall, it never changes it. */
export function FirewallTab() {
  const { probe, sessionId, elevate, root, canAsk, allow } = useRoot();
  const tools = probe?.firewall ?? [];
  const [tool, setTool] = useState<FirewallTool | null>(tools[0] ?? null);
  const [report, setReport] = useState<FirewallReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [askSudo, setAskSudo] = useState(false);

  // Loads when opened, when the tool changes and on Refresh — not on a timer,
  // because every elevated read is logged by sudo on the server.
  const load = useCallback(async () => {
    if (!sessionId || !tool) return;
    setLoading(true);
    try {
      setReport(await ipc.sysmonFirewall(sessionId, tool, elevate));
      setError(null);
    } catch (e) {
      setError(String(e));
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [sessionId, tool, elevate]);

  useEffect(() => {
    setReport(null);
    void load();
  }, [load]);

  const sudoPrefix = probe?.root === "root" ? "" : "sudo ";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        {tools.length > 1 ? (
          <div
            role="radiogroup"
            aria-label="Firewall tool"
            className="flex h-6 shrink-0 overflow-hidden rounded-md border border-border text-[11px]"
          >
            {tools.map((t, i) => (
              <button
                key={t}
                role="radio"
                aria-checked={tool === t}
                onClick={() => setTool(t)}
                className={cn(
                  "px-2.5 [&:active]:scale-100",
                  i > 0 && "border-l border-border",
                  tool === t ? "bg-bg-hover font-medium text-text" : "text-text-dim hover:text-text"
                )}
              >
                {TOOL_LABEL[t]}
              </button>
            ))}
          </div>
        ) : (
          tool && <span className="font-mono text-[11px] text-text-muted">{TOOL_LABEL[tool]}</span>
        )}
        {report?.active != null && !report.failed && (
          <Badge variant={report.active ? "success" : "warning"}>
            {report.active ? "Active" : "Inactive"}
          </Badge>
        )}
        <span className="flex-1 text-[11px] text-text-dim">Read-only</span>
        <RefreshButton onClick={() => void load()} busy={loading} />
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {report?.failed && (
        <Notice
          tone={root ? "error" : "info"}
          action={
            !root && tool && sessionId ? (
              canAsk ? (
                <AskSudoButton onClick={() => setAskSudo(true)} />
              ) : (
                <button
                  onClick={() => runInTerminal(sessionId, `${sudoPrefix}${TOOL_COMMAND[tool]}`)}
                  className="shrink-0 rounded-md border border-border px-2 py-0.5 text-[11px] text-text hover:bg-bg-hover"
                >
                  Open in terminal
                </button>
              )
            ) : undefined
          }
        >
          {root
            ? report.raw || "The firewall could not be read."
            : `Reading the firewall needs root.${report.raw ? `\n${report.raw}` : ""}`}
        </Notice>
      )}

      {report && !report.failed && (
        <div className="min-h-0 flex-1 overflow-auto">
          {report.summary.length > 0 && (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 border-b border-border px-3 py-2 text-xs">
              {report.summary.map(([k, v], i) => (
                <div key={i} className="contents">
                  <dt className="text-text-dim">{k}</dt>
                  <dd className="font-mono text-text-muted">{v}</dd>
                </div>
              ))}
            </dl>
          )}

          {report.rules.length > 0 && (
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className={TH}>To</th>
                  <th className={TH}>Action</th>
                  <th className={TH}>{report.tool === "firewalld" ? "Zone" : "From"}</th>
                </tr>
              </thead>
              <tbody>
                {report.rules.map((r, i) => {
                  const blocks = /deny|reject|drop|limit/i.test(r.action);
                  return (
                    <tr key={i} className="hover:bg-bg-hover/50">
                      <td className={cn(TD, "font-mono")}>{r.to}</td>
                      <td className={cn(TD, "font-mono", blocks ? "text-danger" : "text-text-muted")}>
                        {r.action}
                      </td>
                      <td className={cn(TD, "font-mono text-text-muted")}>{r.from}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {report.rules.length === 0 && report.active === false && (
            <div className="px-3 py-3 text-xs text-text-muted">
              {TOOL_LABEL[report.tool as FirewallTool] ?? report.tool} is installed but not
              filtering.{tools.length > 1 ? " Rules may still exist in another tool above." : ""}
            </div>
          )}

          {report.rules.length > 0 ? (
            <details className="border-t border-border">
              <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-text-dim hover:text-text">
                Raw output
              </summary>
              <RawOutput text={report.raw} />
            </details>
          ) : (
            report.raw && report.active !== false && <RawOutput text={report.raw} />
          )}
        </div>
      )}

      {!report && !error && (
        <div className="px-3 py-6 text-center text-[11px] text-text-dim">Reading the firewall…</div>
      )}

      {askSudo && (
        <SudoPasswordModal
          host={probe?.hostname || "this server"}
          onClose={() => setAskSudo(false)}
          // Agreeing changes `elevate`, which re-reads the firewall as root.
          onConfirm={allow}
        />
      )}
    </div>
  );
}

function RawOutput({ text }: { text: string }) {
  return (
    <pre
      tabIndex={0}
      className="selectable overflow-auto whitespace-pre px-3 py-2 font-mono text-[11px] leading-relaxed text-text-muted"
    >
      {text}
    </pre>
  );
}
