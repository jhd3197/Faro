import { useCallback, useEffect, useId, useRef, useState } from "react";
import { UserPlus, Loader2, CheckCircle2, Copy, Terminal as TerminalIcon, UserMinus, AlertTriangle, Settings as SettingsIcon } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { useDialog } from "@/hooks/useDialog";
import { toast } from "@/stores/toastStore";
import { toastError } from "@/lib/errors";
import { connectLink } from "@/lib/connectLink";
import { useCloudflareAccount } from "./CloudflareAccount";
import type { CfInvitePlan, ConnectionProfile, RootRun } from "@/lib/types";
import { cn } from "@/lib/cn";

interface Props {
  ids: string[];
  onClose: () => void;
}

const isCloudflare = (p: ConnectionProfile) => p.protocol === "sftp" && p.proxyCommand?.kind === "cloudflare";

/** One server's step 2 (the principals file): run with sudo, or paste. */
function RootStep({ profile, plan }: { profile: ConnectionProfile; plan: CfInvitePlan }) {
  const sessionId = useConnections((s) => s.sessions.find((x) => x.profileId === profile.id)?.sessionId);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RootRun | null>(null);
  const [password, setPassword] = useState("");
  const go = async () => {
    if (!sessionId) return;
    setBusy(true);
    try {
      setRun(await ipc.sshRunAsRoot(sessionId, plan.rootCommand, password || undefined));
    } catch (e) {
      toastError(e, "Couldn't run it on the server");
    } finally {
      setBusy(false);
    }
  };
  const copy = () =>
    navigator.clipboard
      .writeText(plan.rootCommand)
      .then(() => toast.success("Command copied", `Paste it into a root console on ${profile.name}.`));
  return (
    <div className="rounded-md border border-border px-2.5 py-2" data-testid="invite-root-step">
      <div className="mb-1 flex items-center gap-1.5 text-[11.5px] text-text">
        <TerminalIcon size={12} className="text-text-muted" />
        <span className="font-medium">{profile.name}</span>
        <span className="text-text-dim">
          · lets <span className="font-mono">{plan.principal}</span> log in as{" "}
          <span className="font-mono">{plan.username}</span>
        </span>
        {run?.ok && <CheckCircle2 size={13} className="ml-auto text-success" data-testid="root-done" />}
      </div>
      <pre className="mb-1.5 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-subtle px-2 py-1 font-mono text-[10.5px] text-text-muted">
        {plan.rootCommand}
      </pre>
      {run && !run.ok && !run.needsPassword && (
        <p className="mb-1.5 text-[11px] text-danger">It failed{run.output ? `: ${run.output}` : "."}</p>
      )}
      {!run?.ok && (
        <div className="flex flex-wrap items-center gap-2">
          {sessionId ? (
            <>
              {run?.needsPassword && (
                <input
                  type="password"
                  aria-label="sudo password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="sudo password"
                  className="w-40 rounded border border-border bg-bg-subtle px-2 py-0.5 text-[11px] outline-none focus:border-accent"
                />
              )}
              <button
                onClick={() => void go()}
                disabled={busy || (run?.needsPassword && !password)}
                className="inline-flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-60"
              >
                {busy ? <Loader2 size={11} className="animate-spin" /> : null}
                Run with sudo
              </button>
            </>
          ) : (
            <span className="text-[11px] text-text-dim">Not connected: paste it into any root console.</span>
          )}
          <button
            onClick={() => void copy()}
            className="inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover"
          >
            <Copy size={11} /> Copy
          </button>
          {run?.needsPassword && (
            <span className="text-[11px] text-text-dim">sudo wants a password for this user.</span>
          )}
        </div>
      )}
    </div>
  );
}

// Invite a teammate to one server or a folder's Cloudflare servers: (1) the
// email goes into the Access policy through the API, (2) its principal into
// each server's principals file, with sudo or a pasted root command, (3) a
// faro:// link with the connection prefilled, no secrets. Removing someone
// reverses 1 and 2.
export function InviteDialog({ ids, onClose }: Props) {
  const profiles = useConnections((s) => s.profiles);
  const openDialog = useLayout((s) => s.openDialog);
  const openExport = useLayout((s) => s.openExport);
  const targets = profiles.filter((p) => ids.includes(p.id) && isCloudflare(p));
  const { status } = useCloudflareAccount();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ add: boolean; plans: [ConnectionProfile, CfInvitePlan][] } | null>(null);
  const [people, setPeople] = useState<string[] | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, { onClose });

  const single = targets.length === 1 ? targets[0] : null;
  const loadPeople = useCallback(async () => {
    if (!single || !status?.connected) return;
    try {
      setPeople(await ipc.cfAccessPeople(single.id));
    } catch (e) {
      setPeople([]);
      toastError(e, "Couldn't read who has access");
    }
  }, [single?.id, status?.connected]);
  useEffect(() => {
    void loadPeople();
  }, [loadPeople]);

  const apply = async (who: string, add: boolean) => {
    setBusy(true);
    try {
      const plans: [ConnectionProfile, CfInvitePlan][] = [];
      for (const p of targets) plans.push([p, await ipc.cfInvite(p.id, who, add)]);
      setResult({ add, plans });
      if (add) setEmail("");
      await loadPeople();
    } catch (e) {
      toastError(e, add ? "Invite failed" : "Couldn't remove access");
    } finally {
      setBusy(false);
    }
  };

  const copyLink = (p: ConnectionProfile) =>
    navigator.clipboard
      .writeText(connectLink(p))
      .then(() => toast.success("Invite link copied", "Send it to them; it carries no password or key."));

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="anim-modal flex max-h-[85vh] w-[36rem] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-4 py-3">
          <UserPlus size={14} className="text-accent" />
          <span id={titleId} className="text-sm font-semibold">
            Invite to {single ? single.name : `${targets.length} servers`}
          </span>
          <div className="flex-1" />
          <button onClick={onClose} className="rounded-md px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text">
            Close
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-[12px]">
          {targets.length === 0 ? (
            <p className="text-text-muted">Only connections reached through Cloudflare can be shared this way.</p>
          ) : !status ? (
            <Loader2 size={14} className="animate-spin text-text-muted" />
          ) : !status.connected ? (
            <div className="flex items-start gap-2 rounded-md border border-border px-2.5 py-2">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
              <div className="min-w-0 flex-1 text-text-muted">
                Invites change the server's Access policy, so Faro needs the Cloudflare account. Connect it once in
                Settings › Cloudflare.
              </div>
              <button
                onClick={() => openDialog("settings")}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover"
              >
                <SettingsIcon size={11} /> Settings
              </button>
            </div>
          ) : (
            <>
              <p className="text-text-muted">
                They sign in with their email; no SSH key is created or shared. Faro adds them to the Access policy,
                lets their certificate log in as the connection's user, and gives you a link to send.
              </p>
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (validEmail) void apply(email.trim(), true);
                }}
              >
                <input
                  type="email"
                  aria-label="Email to invite"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@example.com"
                  autoFocus
                  className="min-w-0 flex-1 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 outline-none focus:border-accent"
                />
                <button
                  type="submit"
                  disabled={busy || !validEmail}
                  className="btn-accent inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
                >
                  {busy ? <Loader2 size={11} className="animate-spin" /> : <UserPlus size={11} />}
                  Invite
                </button>
              </form>

              {result && (
                <div className="flex flex-col gap-2" data-testid="invite-result">
                  <div className="flex items-center gap-1.5 text-text">
                    <CheckCircle2 size={13} className="text-success" />
                    {result.add ? "Added" : "Removed"} <span className="font-mono">{result.plans[0][1].email}</span>{" "}
                    {result.add ? "to" : "from"} the Access polic{result.plans.length === 1 ? "y" : "ies"}
                    {result.plans.every(([, plan]) => !plan.policyChanged) && " (no change needed)"}.
                  </div>
                  <div className="text-[11px] font-medium text-text-muted">
                    {result.add ? "Let their certificate log in" : "Stop their certificate logging in"} (root, once per server):
                  </div>
                  {result.plans.map(([p, plan]) => (
                    <RootStep key={p.id} profile={p} plan={plan} />
                  ))}
                  {result.add && (
                    <>
                      <div className="text-[11px] font-medium text-text-muted">Send them the connection:</div>
                      <div className="flex flex-wrap gap-2">
                        {result.plans.map(([p]) => (
                          <button
                            key={p.id}
                            onClick={() => void copyLink(p)}
                            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-muted hover:bg-bg-hover"
                          >
                            <Copy size={11} /> Copy link{targets.length > 1 ? ` for ${p.name}` : ""}
                          </button>
                        ))}
                        {targets.length > 1 && (
                          <button
                            onClick={() => openExport({ ids: targets.map((t) => t.id), format: "faro", label: "team" })}
                            className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] text-text-muted hover:bg-bg-hover"
                          >
                            Export all as one .faro file…
                          </button>
                        )}
                      </div>
                      <p className="text-[11px] text-text-dim">
                        They open it in Faro, which installs cloudflared if needed, signs them in with their email, and
                        connects.
                      </p>
                    </>
                  )}
                </div>
              )}

              {single && (
                <div>
                  <div className="mb-1 text-[11px] font-medium text-text-muted">Who has access</div>
                  {people === null ? (
                    <Loader2 size={12} className="animate-spin text-text-muted" />
                  ) : people.length === 0 ? (
                    <p className="text-[11px] text-text-dim">Nobody by email yet.</p>
                  ) : (
                    <div className="flex flex-col gap-0.5" data-testid="access-people">
                      {people.map((who) => (
                        <div key={who} className={cn("flex items-center gap-2 rounded px-1 py-0.5 hover:bg-bg-hover")}>
                          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">{who}</span>
                          {!who.startsWith("@") && (
                            <button
                              onClick={() => void apply(who, false)}
                              disabled={busy}
                              aria-label={`Remove ${who}`}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-subtle hover:text-danger"
                            >
                              <UserMinus size={11} /> Remove
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
