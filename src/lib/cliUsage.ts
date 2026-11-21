// Which CLIs a connection depends on, and how (Plan 35). Mirrors
// src-tauri/src/cli_integrations/usage.rs; keep the two in step.
import type { CliState, CliToolStatus, ConnectionProfile, ManagedToolId } from "./types";

export type CliHow = "tunnel" | "secret" | "signIn" | "imported";

export interface ToolUse {
  tool: ManagedToolId;
  how: CliHow;
  /** The CLI account it uses ("default" = the CLI's own default). */
  account?: string;
  /** The jump host this comes through, by name. */
  via?: string;
}

const MAX_JUMP_HOPS = 8;

function trimmed(s?: string): string | undefined {
  const t = s?.trim();
  return t ? t : undefined;
}

/** The tool a ProxyCommand line runs (`cloudflared`, `aws`, `gcloud`). */
function commandTool(line: string): ManagedToolId | undefined {
  const first = line.split(/\s+/).find((w) => w && w !== "exec");
  if (!first) return undefined;
  const base = first.replace(/^["']|["']$/g, "").split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd)$/, "");
  return (["cloudflared", "aws", "gcloud"] as const).find((t) => t === base);
}

function own(p: ConnectionProfile): ToolUse[] {
  const out: ToolUse[] = [];
  const pc = p.proxyCommand;
  if (pc) {
    if (pc.kind === "cloudflare") out.push({ tool: "cloudflared", how: "tunnel" });
    else if (pc.kind === "awsSsm") out.push({ tool: "aws", how: "tunnel", account: trimmed(pc.cliAccount) ?? "default" });
    else if (pc.kind === "gcpIap") out.push({ tool: "gcloud", how: "tunnel", account: trimmed(pc.cliAccount) });
    else if (pc.kind === "command") {
      const t = commandTool(pc.command ?? "");
      if (t) out.push({ tool: t, how: "tunnel" });
    }
  }
  if (p.auth.kind === "cloudflarecert" && pc?.kind !== "cloudflare") out.push({ tool: "cloudflared", how: "tunnel" });
  if (p.credentialRef?.provider === "1password") out.push({ tool: "op", how: "secret" });
  if (p.credentialRef?.provider === "bitwarden") out.push({ tool: "bw", how: "secret" });
  if (p.cliAuth) out.push({ tool: p.cliAuth.tool, how: "signIn", account: trimmed(p.cliAuth.account) ?? "default" });
  if (p.cliSource) out.push({ tool: p.cliSource.tool as ManagedToolId, how: "imported", account: trimmed(p.cliSource.account) });
  return out;
}

/** Every CLI `profile` depends on, its jump hosts' included. */
export function profileTools(profile: ConnectionProfile, all: ConnectionProfile[]): ToolUse[] {
  const out = own(profile);
  const seen = [profile.id];
  let next = profile.jumpProfile;
  for (let i = 0; i < MAX_JUMP_HOPS && next; i++) {
    if (seen.includes(next)) break;
    const hop = all.find((p) => p.id === next);
    if (!hop) break;
    seen.push(hop.id);
    for (const u of own(hop)) if (u.how !== "imported") out.push({ ...u, via: hop.name });
    next = hop.jumpProfile;
  }
  return out;
}

/** Connections per CLI, with how each uses it. */
export function usageByTool(all: ConnectionProfile[]): Map<string, { profile: ConnectionProfile; uses: ToolUse[] }[]> {
  const map = new Map<string, { profile: ConnectionProfile; uses: ToolUse[] }[]>();
  for (const p of all) {
    const byTool = new Map<string, ToolUse[]>();
    for (const u of profileTools(p, all)) byTool.set(u.tool, [...(byTool.get(u.tool) ?? []), u]);
    for (const [tool, uses] of byTool) map.set(tool, [...(map.get(tool) ?? []), { profile: p, uses }]);
  }
  return map;
}

/** States a person has to fix. */
export function isProblem(state: CliState | undefined): boolean {
  return state === "missing" || state === "signedOut" || state === "expired" || state === "error";
}

/** The state that matters for one use: the account's own when known. */
export function stateForUse(status: CliToolStatus | undefined, use: ToolUse): CliState | undefined {
  if (!status) return undefined;
  if (!status.installed) return "missing";
  if (use.how === "imported") return undefined;
  const acct = use.account && status.accounts.find((a) => a.id === use.account);
  if (acct) return acct.state;
  return status.state;
}

/** Problems that would stop `profile` from connecting, worst first. */
export function blockingProblems(
  profile: ConnectionProfile,
  all: ConnectionProfile[],
  statuses: Record<string, CliToolStatus>
): { use: ToolUse; status: CliToolStatus; state: CliState }[] {
  const out: { use: ToolUse; status: CliToolStatus; state: CliState }[] = [];
  for (const use of profileTools(profile, all)) {
    const status = statuses[use.tool];
    const state = stateForUse(status, use);
    // Only states Faro is sure about block a connect; an unchecked CLI or a
    // failed check lets the connect try.
    if (status && state && (state === "missing" || state === "signedOut" || state === "expired")) out.push({ use, status, state });
  }
  return out;
}

export const HOW_LABEL: Record<CliHow, string> = {
  tunnel: "Tunnel",
  secret: "Secret",
  signIn: "Sign-in",
  imported: "Imported from",
};

export const STATE_LABEL: Record<CliState, string> = {
  missing: "Not installed",
  signedOut: "Signed out",
  ready: "Ready",
  expired: "Login expired",
  error: "Error",
  unknown: "Installed",
};
