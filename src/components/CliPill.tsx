import { useMemo, useRef, useState } from "react";
import { LogIn, TerminalSquare } from "lucide-react";
import { cn } from "@/lib/cn";
import { useClis } from "@/stores/cliStore";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { STATE_LABEL, isProblem, stateForUse, usageByTool } from "@/lib/cliUsage";
import type { CliToolStatus } from "@/lib/types";
import { Popover } from "@/components/ui/Popover";

interface Problem {
  status: CliToolStatus;
  /** Connections it stops. */
  count: number;
  /** The account to sign in again, when one is to blame. */
  account?: string;
}

/** CLIs some connection uses that are signed out, expired or missing. */
export function cliProblems(statuses: Record<string, CliToolStatus>, usage: ReturnType<typeof usageByTool>): Problem[] {
  const out: Problem[] = [];
  for (const [tool, list] of usage) {
    const status = statuses[tool];
    if (!status) continue;
    let count = 0;
    let account: string | undefined;
    for (const { uses } of list) {
      const bad = uses.find((u) => isProblem(stateForUse(status, u)));
      if (bad) {
        count++;
        account ??= bad.account && bad.account !== "default" ? bad.account : undefined;
      }
    }
    if (count > 0) out.push({ status, count, account });
  }
  return out.sort((a, b) => b.count - a.count);
}

/// Status-bar pill for the CLIs page (Plan 35). Hidden while every CLI that
/// a connection uses is fine; otherwise names the problem and how many
/// connections it stops, with one action each.
export function CliPill() {
  const statuses = useClis((s) => s.statuses);
  const signIn = useClis((s) => s.signIn);
  const profiles = useConnections((s) => s.profiles);
  const openClis = useLayout((s) => s.openClis);
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const problems = useMemo(() => cliProblems(statuses, usageByTool(profiles)), [statuses, profiles]);
  if (problems.length === 0) return null;
  const first = problems[0];
  const label =
    problems.length === 1
      ? `${first.status.name}: ${STATE_LABEL[first.status.installed ? (first.account ? first.status.accounts.find((a) => a.id === first.account)?.state ?? first.status.state : first.status.state) : "missing"].toLowerCase()} · ${first.count} connection${first.count === 1 ? "" : "s"}`
      : `${problems.length} CLIs need attention`;

  return (
    <div className="relative flex items-center" ref={wrap}>
      <button
        data-cli-pill=""
        onClick={() => setOpen((v) => !v)}
        title={label}
        aria-label={`CLIs: ${label}`}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 transition-colors",
          open ? "bg-accent-soft text-accent" : "text-warning hover:bg-bg-hover"
        )}
      >
        <TerminalSquare size={11} />
        <span className="max-w-[16rem] truncate max-[960px]:hidden">{label}</span>
      </button>
      {open && (
        <Popover open anchorRef={wrap} onClose={() => setOpen(false)} placement="top-end" layer="dropdown" className="w-80">
          <div className="flex items-center justify-between border-b border-border bg-bg-subtle px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-text-dim">CLIs</span>
            <button
              onClick={() => {
                setOpen(false);
                openClis();
              }}
              className="text-[10px] text-accent hover:underline"
            >
              Open CLIs
            </button>
          </div>
          {problems.map((p) => (
            <div key={p.status.id} className="flex items-center gap-2 border-b border-border px-3 py-2 text-[11.5px] last:border-b-0" data-cli-problem={p.status.id}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-text">{p.status.name}</span>
                <span className="block truncate text-text-dim">
                  {p.status.installed ? STATE_LABEL[p.status.state] : "Not installed"} · {p.count} connection{p.count === 1 ? "" : "s"}
                  {p.account ? ` · ${p.account}` : ""}
                </span>
              </span>
              {p.status.installed && p.status.signIn ? (
                <button
                  onClick={() => void signIn(p.status.id, p.account)}
                  className="flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] hover:bg-bg-hover"
                >
                  <LogIn size={11} /> Sign in
                </button>
              ) : (
                <button
                  onClick={() => {
                    setOpen(false);
                    openClis(p.status.id);
                  }}
                  className="rounded border border-border px-2 py-0.5 text-[11px] hover:bg-bg-hover"
                >
                  Open
                </button>
              )}
            </div>
          ))}
        </Popover>
      )}
    </div>
  );
}
