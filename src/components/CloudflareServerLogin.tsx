import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  Terminal as TerminalIcon,
  UserMinus,
  UserPlus,
  X,
  XCircle,
} from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { cn } from "@/lib/cn";
import { ipc } from "@/lib/ipc";
import { messageOf } from "@/lib/errors";
import { useConnections } from "@/stores/connectionsStore";
import type {
  CfLoginApplyResult,
  CfLoginPlan,
  CfLoginRequest,
  CfLoginState,
  CfPersonCommand,
  ConnectionProfile,
  RootRun,
} from "@/lib/types";

// "Cloudflare login" on a server (issue #86 follow-up): who may log in with
// their Cloudflare sign-in. Set up by an admin already connected another way
// (a key or password login), whose session runs the root commands. Every
// change shows its files and commands first; sshd changes are backed up,
// checked with `sshd -t`, reloaded, tested with a certificate login, and put
// back if anything fails.

/** The server a Cloudflare connection reaches, for finding an admin login. */
export interface LoginTarget {
  id: string;
  host: string;
  port: number;
  /** The Cloudflare Access hostname, lowercased. */
  accessHost: string;
}

export const accessHostOf = (p: Pick<ConnectionProfile, "host" | "proxyCommand">): string =>
  p.proxyCommand?.kind === "cloudflare" ? (p.proxyCommand.hostname?.trim() || p.host).toLowerCase() : "";

export const targetOf = (p: ConnectionProfile): LoginTarget => ({
  id: p.id,
  host: p.host,
  port: p.port,
  accessHost: accessHostOf(p),
});

/** The user part of a signed-in email: the name on its certificates. */
export const principalOf = (email?: string | null) => (email && email.includes("@") ? email.split("@")[0] : null);

interface Admin {
  profile: ConnectionProfile;
  sessionId?: string;
}

/** Saved SSH logins to the same server that aren't a Cloudflare sign-in:
 *  through the same Access hostname, or straight to the same host and port.
 *  Connected ones first. */
export function adminCandidates(
  target: LoginTarget,
  profiles: ConnectionProfile[],
  sessions: { sessionId: string; profileId: string }[]
): Admin[] {
  const port = (n?: number) => n || 22;
  return profiles
    .filter((p) => p.protocol === "sftp" && p.auth.kind !== "cloudflarecert")
    .filter((p) => {
      const access = accessHostOf(p);
      if (target.accessHost && access === target.accessHost) return true;
      return !!target.host && p.host.toLowerCase() === target.host.toLowerCase() && port(p.port) === port(target.port);
    })
    .map((profile) => ({ profile, sessionId: sessions.find((s) => s.profileId === profile.id)?.sessionId }))
    .sort((a, b) => Number(!!b.sessionId) - Number(!!a.sessionId));
}

/** `anyConnected`: with no login matching the server, offer every connected
 *  SSH login (a direct login by IP can't be matched to an Access hostname). */
function useAdmin(target: LoginTarget, anyConnected = false) {
  const profiles = useConnections((s) => s.profiles);
  const sessions = useConnections((s) => s.sessions);
  const [chosen, setChosen] = useState<string | null>(null);
  const candidates = useMemo(() => {
    const matched = adminCandidates(target, profiles, sessions);
    if (matched.length || !anyConnected) return matched;
    return profiles
      .filter((p) => p.protocol === "sftp" && p.auth.kind !== "cloudflarecert" && p.id !== target.id)
      .map((profile) => ({ profile, sessionId: sessions.find((s) => s.profileId === profile.id)?.sessionId }))
      .filter((c) => c.sessionId);
  }, [target.id, target.host, target.port, target.accessHost, profiles, sessions, anyConnected]);
  const admin =
    candidates.find((c) => c.profile.id === chosen && c.sessionId) ?? candidates.find((c) => c.sessionId) ?? candidates[0];
  return { candidates, admin, choose: setChosen };
}

function useLoginState(sessionId: string | undefined, user: string) {
  const [state, setState] = useState<CfLoginState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    if (!sessionId || !user.trim()) {
      setState(null);
      return;
    }
    setLoading(true);
    try {
      setState(await ipc.cfLoginState(sessionId, user.trim()));
      setError(null);
    } catch (e) {
      setState(null);
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }, [sessionId, user]);
  useEffect(() => {
    const t = setTimeout(() => void reload(), 300);
    return () => clearTimeout(t);
  }, [reload]);
  return { state, error, loading, reload };
}

const MODE_LABEL: Record<CfLoginState["mode"], string> = {
  notSetUp: "Not set up",
  listed: "Only listed people",
  policy: "Anyone the Access policy allows",
};

const small = "inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover disabled:opacity-50";
const primary = "inline-flex items-center gap-1 rounded bg-accent px-2 py-0.5 text-[11px] font-medium text-white disabled:opacity-60";

/** A root command shown before it runs, with sudo's password when asked. */
function RootCommand({
  sessionId,
  command,
  label,
  onDone,
  onCancel,
}: {
  sessionId: string;
  command: string;
  label: string;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RootRun | null>(null);
  const [password, setPassword] = useState("");
  const go = async () => {
    setBusy(true);
    try {
      const r = await ipc.sshRunAsRoot(sessionId, command, password || undefined);
      setRun(r);
      if (r.ok) onDone();
    } catch (e) {
      setRun({ ok: false, output: messageOf(e), needsPassword: false });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-1.5" data-testid="cf-login-command">
      <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-subtle px-2 py-1 font-mono text-[10.5px] text-text-muted">
        {command}
      </pre>
      {run && !run.ok && !run.needsPassword && (
        <p className="mt-1 text-[11px] text-danger">It failed{run.output ? `: ${run.output}` : "."}</p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
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
        <button type="button" onClick={() => void go()} disabled={busy || (run?.needsPassword && !password)} className={primary}>
          {busy && <Loader2 size={11} className="animate-spin" />}
          {label}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} className={small}>
            Cancel
          </button>
        )}
        {run?.needsPassword && <span className="text-[11px] text-text-dim">sudo wants a password for this user.</span>}
      </div>
    </div>
  );
}

type ChangeKind = "setup" | "policyOn" | "policyOff" | "remove";

const TITLE: Record<ChangeKind, string> = {
  setup: "Set up Cloudflare login",
  policyOn: "Let anyone in the Access policy log in",
  policyOff: "Only listed people",
  remove: "Remove Cloudflare login",
};

/** One sshd change: what it does, the exact files and commands, then run it
 *  with backup, `sshd -t`, reload, a test login and restore on failure. */
export function LoginChangeDialog({
  kind,
  sessionId,
  adminName,
  user,
  accessHost,
  state,
  addPeople = [],
  testProfile,
  onClose,
  onDone,
}: {
  kind: ChangeKind;
  sessionId: string;
  adminName: string;
  user: string;
  accessHost: string;
  state: CfLoginState;
  addPeople?: string[];
  testProfile: () => ConnectionProfile;
  onClose: () => void;
  onDone: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, { onClose });
  const setup = kind === "setup";

  // Who's signed in to Cloudflare here: the test logs in as them.
  const [me, setMe] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    if (!accessHost) return;
    ipc
      .cfAccessStatus(accessHost)
      .then((s) => s.state === "loggedIn" && setMe(principalOf(s.identity)))
      .catch(() => {});
  }, [accessHost]);
  const signIn = async () => {
    setSigningIn(true);
    try {
      const s = await ipc.cfAccessLogin(accessHost);
      setMe(principalOf(s.identity));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setSigningIn(false);
    }
  };

  // Setup: the CA key (API, else pasted), who's listed, and the opt-in.
  const [ca, setCa] = useState("");
  const [caSource, setCaSource] = useState<"loading" | "api" | "paste">(setup ? "loading" : "paste");
  const [caNote, setCaNote] = useState<string | null>(null);
  useEffect(() => {
    if (!setup) return;
    ipc
      .cfLoginCa(accessHost)
      .then((r) => {
        if (r.key) {
          setCa(r.key);
          setCaSource("api");
        } else {
          setCaSource("paste");
          setCaNote(r.account ? r.error ?? null : null);
        }
      })
      .catch((e) => {
        setCaSource("paste");
        setCaNote(messageOf(e));
      });
  }, [setup, accessHost]);
  const [people, setPeople] = useState<string[]>(addPeople);
  useEffect(() => {
    if (setup && me) setPeople((p) => (p.includes(me) ? p : [me, ...p]));
  }, [setup, me]);
  const [person, setPerson] = useState("");
  const [policy, setPolicy] = useState(false);

  const [plan, setPlan] = useState<CfLoginPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [result, setResult] = useState<CfLoginApplyResult | null>(null);

  const request = (): CfLoginRequest =>
    setup
      ? { user, caKey: ca.trim(), addPeople: people, policy }
      : kind === "remove"
        ? { user, remove: true }
        : { user, policy: kind === "policyOn" };
  const review = async () => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await ipc.cfLoginPlan(sessionId, request()));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!setup) void review();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const policyAfter = kind === "policyOn" || (setup && policy) || (kind !== "policyOff" && kind !== "remove" && state.mode === "policy");
  const listedAfter = [...state.people, ...(plan?.principals ?? [])];
  const willTest = kind !== "remove" && (policyAfter || (!!me && listedAfter.includes(me)));

  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const r = await ipc.cfLoginApply(sessionId, plan, willTest ? testProfile() : null, password || undefined);
      setResult(r);
      if (r.ok) onDone();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const warnPolicy = kind === "policyOn" || (setup && policy);
  const done = result?.ok;

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="cf-login-dialog"
        className="anim-modal flex max-h-[88vh] w-[38rem] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-4 py-3">
          <ShieldCheck size={14} className="text-accent" />
          <div className="min-w-0 flex-1">
            <div id={titleId} className="text-sm font-semibold">
              {TITLE[kind]}
            </div>
            <div className="truncate text-[11px] text-text-dim">
              Log in as <span className="font-mono">{user}</span> · runs as root through {adminName}
            </div>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text" aria-label="Close">
            <X size={13} />
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 text-[12px]">
          {setup && !plan && (
            <>
              <p className="text-text-muted">
                The server will trust certificates from your Cloudflare Access team. By default only the people listed
                here can log in as <span className="font-mono text-text">{user}</span> with their Cloudflare sign-in;
                the Access policy still has to let them in too.
              </p>

              <div>
                <div className="mb-1 text-[11px] font-medium text-text-muted">Access CA public key</div>
                {caSource === "loading" ? (
                  <Loader2 size={12} className="animate-spin text-text-muted" />
                ) : caSource === "api" ? (
                  <div className="truncate rounded bg-bg-subtle px-2 py-1 font-mono text-[10.5px] text-text-muted" title={ca}>
                    {ca}
                  </div>
                ) : (
                  <>
                    <textarea
                      aria-label="Access CA public key"
                      value={ca}
                      onChange={(e) => setCa(e.target.value)}
                      rows={2}
                      placeholder="ecdsa-sha2-nistp256 AAAA… open-ssh-ca@cloudflareaccess.org"
                      className="w-full resize-none rounded-md border border-border bg-bg-subtle px-2 py-1 font-mono text-[10.5px] outline-none focus:border-accent"
                    />
                    <p className="text-[11px] text-text-dim">
                      {caNote ? `${caNote}. ` : "No Cloudflare account is connected in Settings, so paste it. "}
                      It's in Zero Trust › Access › Service credentials › SSH, for the {accessHost} application.
                    </p>
                  </>
                )}
              </div>

              <div>
                <div className="mb-1 text-[11px] font-medium text-text-muted">
                  Who can log in as <span className="font-mono">{user}</span>
                </div>
                <div className="flex flex-wrap gap-1.5" data-testid="cf-login-setup-people">
                  {people.map((p) => (
                    <span key={p} className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[11px]">
                      {p}
                      {p === me && <span className="font-sans text-text-dim">(you)</span>}
                      <button type="button" aria-label={`Remove ${p}`} onClick={() => setPeople(people.filter((x) => x !== p))} className="text-text-dim hover:text-danger">
                        <X size={10} />
                      </button>
                    </span>
                  ))}
                </div>
                <form
                  className="mt-1.5 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = person.trim();
                    const name = v.includes("@") ? principalOf(v) : v;
                    if (name && !people.includes(name)) setPeople([...people, name]);
                    setPerson("");
                  }}
                >
                  <input
                    aria-label="Person to list"
                    value={person}
                    onChange={(e) => setPerson(e.target.value)}
                    placeholder="teammate@example.com or jane.doe"
                    className="min-w-0 flex-1 rounded-md border border-border bg-bg-subtle px-2 py-1 text-[11.5px] outline-none focus:border-accent"
                  />
                  <button type="submit" disabled={!person.trim()} className={small}>
                    <UserPlus size={11} /> Add
                  </button>
                </form>
                {!me && (
                  <p className="mt-1 text-[11px] text-text-dim">
                    Sign in to Cloudflare to add yourself, so Faro can test the login before keeping it.{" "}
                    <button type="button" onClick={() => void signIn()} disabled={signingIn} className="font-medium text-accent hover:underline">
                      {signingIn ? "Waiting for the browser…" : "Sign in"}
                    </button>
                  </p>
                )}
              </div>

              <label className="flex items-start gap-2 rounded-md border border-border px-2.5 py-2">
                <input type="checkbox" checked={policy} onChange={(e) => setPolicy(e.target.checked)} className="mt-0.5" aria-label="Anyone the Access policy allows" />
                <span className="text-text-muted">
                  <span className="font-medium text-text">Anyone the Access policy allows</span> can log in as{" "}
                  <span className="font-mono">{user}</span>, listed or not.
                </span>
              </label>

              {state.otherCa && (
                <p className="flex items-start gap-1.5 text-[11px] text-warning">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                  This server already trusts a CA ({state.otherCa}). Faro's setting goes first in sshd_config, so that
                  CA stops being used.
                </p>
              )}
            </>
          )}

          {warnPolicy && (
            <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11.5px] text-text" data-testid="cf-login-policy-warning">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
              <div>
                Anyone your Cloudflare Access policy lets in will be able to log in as{" "}
                <span className="font-mono">{user}</span>, with no list on this server. The only way to take someone's
                access away is to remove them from the policy.
              </div>
            </div>
          )}

          {plan && (
            <div className="flex flex-col gap-2" data-testid="cf-login-plan">
              <div>
                <div className="mb-1 text-[11px] font-medium text-text-muted">What changes</div>
                <ul className="list-disc pl-4 text-text">
                  {plan.changes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                  <li className="text-text-muted">sshd_config is checked with sshd -t, then sshd reloads. Open sessions stay connected.</li>
                </ul>
              </div>
              <div>
                <div className="mb-1 text-[11px] font-medium text-text-muted">Files (backed up first)</div>
                <div className="flex flex-wrap gap-1">
                  {plan.files.map((f) => (
                    <span key={f} className="rounded bg-bg-subtle px-1.5 py-0.5 font-mono text-[10.5px] text-text-muted">
                      {f}
                    </span>
                  ))}
                </div>
              </div>
              <details open>
                <summary className="cursor-pointer text-[11px] font-medium text-text-muted">Commands, run as root</summary>
                <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-subtle px-2 py-1 font-mono text-[10.5px] text-text-muted">
                  {plan.script}
                </pre>
              </details>
              <p className="text-[11px] text-text-dim" data-testid="cf-login-test-note">
                {willTest
                  ? `Then Faro logs in as ${user} with your Cloudflare sign-in. If that fails, the backup goes back.`
                  : kind === "remove" || kind === "policyOff"
                    ? "Not tested with a login: this only takes access away."
                    : "Not tested with a login: you aren't on the list, so Faro can't try one."}
              </p>
            </div>
          )}

          {result && !result.ok && !result.needsPassword && (
            <div className="rounded-md border border-danger/40 bg-danger/10 px-2.5 py-2 text-[11.5px]" data-testid="cf-login-failed">
              <div className="mb-1 flex items-center gap-1.5 font-medium text-danger">
                <XCircle size={13} />
                {result.testError ? "The test login failed" : "The change didn't go through"}
                {result.restored && <span className="font-normal text-text">· the old settings are back</span>}
              </div>
              {result.testError && <div className="mb-1 text-text">{result.testError}</div>}
              {result.output && (
                <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[10.5px] text-text-muted">{result.output}</pre>
              )}
            </div>
          )}
          {done && (
            <div className="flex items-center gap-1.5 text-success" data-testid="cf-login-done">
              <CheckCircle2 size={13} />
              {result?.tested ? "Done, and a Cloudflare login worked." : "Done."}
            </div>
          )}
          {error && <p className="text-[11.5px] text-danger">{error}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-border bg-bg-subtle px-4 py-3">
          {result?.needsPassword && !done && (
            <input
              type="password"
              aria-label="sudo password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="sudo password"
              className="w-40 rounded-md border border-border bg-bg-panel px-2 py-1 text-[11.5px] outline-none focus:border-accent"
            />
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="rounded-md border border-border bg-bg-panel px-3 py-1.5 text-xs font-medium hover:bg-bg-hover">
            {done ? "Close" : "Cancel"}
          </button>
          {!done &&
            (plan ? (
              <button
                onClick={() => void apply()}
                disabled={busy || (result?.needsPassword && !password)}
                className={cn("btn-accent inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50")}
              >
                {busy && <Loader2 size={12} className="animate-spin" />}
                {busy && willTest ? "Applying and testing…" : result && !result.ok ? "Try again" : "Apply"}
              </button>
            ) : (
              setup && (
                <button
                  onClick={() => void review()}
                  disabled={busy || !ca.trim() || caSource === "loading"}
                  className="btn-accent inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                >
                  {busy && <Loader2 size={12} className="animate-spin" />}
                  Review changes
                </button>
              )
            ))}
        </div>
      </div>
    </div>
  );
}

/** Editor › Cloudflare: the server's Cloudflare login for the user this
 *  connection logs in as, and the controls to change it. */
export function ServerLoginSection({
  target,
  user,
  testProfile,
}: {
  target: LoginTarget;
  user: string;
  testProfile: () => ConnectionProfile;
}) {
  const { candidates, admin, choose } = useAdmin(target, true);
  const profiles = useConnections((s) => s.profiles);
  const sessions = useConnections((s) => s.sessions);
  const guessed = !adminCandidates(target, profiles, sessions).length;
  const connect = useConnections((s) => s.connect);
  const [connecting, setConnecting] = useState(false);
  const { state, error, loading, reload } = useLoginState(admin?.sessionId, user);
  const [change, setChange] = useState<ChangeKind | null>(null);
  const [person, setPerson] = useState("");
  const [pending, setPending] = useState<(CfPersonCommand & { add: boolean }) | null>(null);
  const connected = candidates.filter((c) => c.sessionId);

  const propose = async (who: string, add: boolean) => {
    try {
      setPending({ ...(await ipc.cfLoginPersonCommand(user, who, add)), add });
    } catch (e) {
      setPending(null);
      setPersonError(messageOf(e));
    }
  };
  const [personError, setPersonError] = useState<string | null>(null);

  const box = "mb-3 rounded-md border border-border px-3 py-2.5 text-[11.5px]";
  if (!user.trim() || !target.accessHost) return null;

  return (
    <div className={box} data-testid="cf-server-login" data-mode={state?.mode ?? ""}>
      <div className="flex items-center gap-1.5">
        <ShieldCheck size={13} className="text-text-muted" />
        <span className="font-medium text-text">Cloudflare login on the server</span>
        {state && (
          <span
            data-testid="cf-login-mode"
            className={cn(
              "ml-auto rounded px-1.5 py-0.5 text-[10.5px] font-medium",
              state.mode === "notSetUp" ? "bg-bg-subtle text-text-muted" : state.mode === "policy" ? "bg-warning/15 text-warning" : "bg-success/15 text-success"
            )}
          >
            {MODE_LABEL[state.mode]}
          </span>
        )}
        {loading && !state && <Loader2 size={11} className="ml-auto animate-spin text-text-muted" />}
      </div>

      {!admin ? (
        <p className="mt-1 text-text-dim">
          Who may log in as <span className="font-mono">{user}</span> with a Cloudflare sign-in is set on the server.
          To see or change it, save a key or password login to this server and connect it.
        </p>
      ) : !admin.sessionId ? (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-text-dim">
          <span>Connect your own login to see and change it.</span>
          <button
            type="button"
            className={small}
            disabled={connecting}
            onClick={async () => {
              setConnecting(true);
              try {
                await connect(admin.profile.id, { focus: false });
              } catch {
                // the store toasts
              } finally {
                setConnecting(false);
              }
            }}
          >
            {connecting && <Loader2 size={11} className="animate-spin" />}
            Connect {admin.profile.name}
          </button>
        </div>
      ) : (
        <>
          <div className="mt-0.5 text-[11px] text-text-dim">
            Changes run as root through{" "}
            {connected.length > 1 ? (
              <select
                aria-label="Run through"
                value={admin.profile.id}
                onChange={(e) => choose(e.target.value)}
                className="rounded border border-border bg-bg-subtle px-1 text-[11px]"
              >
                {connected.map((c) => (
                  <option key={c.profile.id} value={c.profile.id}>
                    {c.profile.name}
                  </option>
                ))}
              </select>
            ) : (
              admin.profile.name
            )}
            .{guessed && " It isn't saved as this server's address, so check it's the same machine."}
          </div>
          {error && <p className="mt-1 text-danger">{error}</p>}
          {state?.unreadable && <p className="mt-1 text-text-dim">sshd_config isn't readable without a sudo password, so this may be incomplete.</p>}

          {state?.mode === "notSetUp" && (
            <div className="mt-1.5">
              <p className="text-text-muted">
                The server doesn't trust Cloudflare Access certificates yet, so a Cloudflare sign-in can't log in as{" "}
                <span className="font-mono">{user}</span>.
              </p>
              <button type="button" onClick={() => setChange("setup")} className={cn(primary, "mt-1.5")}>
                Set up Cloudflare login…
              </button>
            </div>
          )}

          {state && state.mode !== "notSetUp" && (
            <div className="mt-2">
              <div className="mb-1 text-[11px] font-medium text-text-muted">
                Listed for <span className="font-mono">{user}</span>
              </div>
              {state.people.length === 0 ? (
                <p className="text-text-dim">Nobody yet.</p>
              ) : (
                <div className="flex flex-col gap-0.5" data-testid="cf-login-people">
                  {state.people.map((p) => (
                    <div key={p} className="flex items-center gap-2 rounded px-1 py-0.5 hover:bg-bg-hover">
                      <span className="min-w-0 flex-1 truncate font-mono">{p}</span>
                      <button type="button" onClick={() => void propose(p, false)} aria-label={`Remove ${p}`} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-text-muted hover:text-danger">
                        <UserMinus size={11} /> Remove
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <form
                className="mt-1.5 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (person.trim()) void propose(person.trim(), true);
                }}
              >
                <input
                  aria-label="Person to allow"
                  value={person}
                  onChange={(e) => {
                    setPerson(e.target.value);
                    setPersonError(null);
                  }}
                  placeholder="teammate@example.com or jane.doe"
                  className="min-w-0 flex-1 rounded-md border border-border bg-bg-subtle px-2 py-1 text-[11.5px] outline-none focus:border-accent"
                />
                <button type="submit" disabled={!person.trim()} className={small}>
                  <UserPlus size={11} /> Add
                </button>
              </form>
              {personError && <p className="mt-1 text-danger">{personError}</p>}
              {pending && admin.sessionId && (
                <div className="mt-1.5 rounded-md border border-border px-2 py-1.5">
                  <div className="flex items-center gap-1.5 text-text">
                    <TerminalIcon size={11} className="text-text-muted" />
                    {pending.add ? "Allow" : "Stop"} <span className="font-mono">{pending.principal}</span>{" "}
                    {pending.add ? "to log in" : "logging in"} as <span className="font-mono">{user}</span>
                  </div>
                  <RootCommand
                    key={pending.command}
                    sessionId={admin.sessionId}
                    command={pending.command}
                    label="Run with sudo"
                    onCancel={() => setPending(null)}
                    onDone={() => {
                      setPending(null);
                      setPerson("");
                      void reload();
                    }}
                  />
                </div>
              )}
              <p className="mt-1 text-[11px] text-text-dim">The Access policy still has to let them in too (Share › Invite does both).</p>

              <label className="mt-2 flex items-start gap-2">
                <input
                  type="checkbox"
                  aria-label="Anyone the Access policy allows"
                  checked={state.mode === "policy"}
                  onChange={(e) => setChange(e.target.checked ? "policyOn" : "policyOff")}
                  className="mt-0.5"
                />
                <span className="text-text-muted">
                  <span className="font-medium text-text">Anyone the Access policy allows</span> can log in as{" "}
                  <span className="font-mono">{user}</span>. Off: only the people listed.
                </span>
              </label>
              <button type="button" onClick={() => setChange("remove")} className="mt-1.5 text-[11px] text-text-dim hover:text-danger">
                Remove Cloudflare login from this server…
              </button>
            </div>
          )}
        </>
      )}

      {change && state && admin?.sessionId && (
        <LoginChangeDialog
          kind={change}
          sessionId={admin.sessionId}
          adminName={admin.profile.name}
          user={user}
          accessHost={target.accessHost}
          state={state}
          testProfile={testProfile}
          onClose={() => {
            setChange(null);
            void reload();
          }}
          onDone={() => void reload()}
        />
      )}
    </div>
  );
}

/** Refused-certificate state: "Allow <name> to log in as <user>" in one
 *  click, through the admin's own login to the same server, when there is one. */
export function AllowFromRefusal({
  profile,
  principal,
  onAllowed,
}: {
  profile: ConnectionProfile;
  principal: string | null;
  onAllowed: () => void;
}) {
  const target = useMemo(() => targetOf(profile), [profile]);
  const { admin } = useAdmin(target);
  const connect = useConnections((s) => s.connect);
  const [connecting, setConnecting] = useState(false);
  const { state, loading } = useLoginState(admin?.sessionId, profile.username);
  const [command, setCommand] = useState<string | null>(null);
  const [setup, setSetup] = useState(false);
  useEffect(() => {
    if (!principal || !state || state.mode === "notSetUp") return;
    ipc
      .cfLoginPersonCommand(profile.username, principal, true)
      .then((c) => setCommand(c.command))
      .catch(() => setCommand(null));
  }, [principal, state, profile.username]);

  if (!principal || !admin) return null;
  const wrap = "mt-2 rounded-md border border-border bg-bg-panel px-3 py-2 text-[11.5px]";
  if (!admin.sessionId) {
    return (
      <div className={wrap} data-testid="cf-allow">
        You can log in to this server as its admin with {admin.profile.name}.
        <button
          type="button"
          className={cn(primary, "ml-2")}
          disabled={connecting}
          onClick={async () => {
            setConnecting(true);
            try {
              await connect(admin.profile.id, { focus: false });
            } catch {
              // the store toasts
            } finally {
              setConnecting(false);
            }
          }}
        >
          {connecting && <Loader2 size={11} className="animate-spin" />}
          Connect {admin.profile.name} to let {principal} in
        </button>
      </div>
    );
  }
  if (loading || !state) return <Loader2 size={12} className="mt-2 animate-spin text-text-muted" />;
  if (state.mode === "notSetUp") {
    return (
      <div className={wrap} data-testid="cf-allow">
        This server doesn't trust Cloudflare sign-ins yet.
        <button type="button" onClick={() => setSetup(true)} className={cn(primary, "ml-2")}>
          Set up Cloudflare login…
        </button>
        {setup && (
          <LoginChangeDialog
            kind="setup"
            sessionId={admin.sessionId}
            adminName={admin.profile.name}
            user={profile.username}
            accessHost={target.accessHost}
            state={state}
            addPeople={[principal]}
            testProfile={() => profile}
            onClose={() => setSetup(false)}
            onDone={onAllowed}
          />
        )}
      </div>
    );
  }
  if (state.people.includes(principal) || !command) return null;
  return (
    <div className={wrap} data-testid="cf-allow">
      <div className="font-medium text-text">
        Allow <span className="font-mono">{principal}</span> to log in as <span className="font-mono">{profile.username}</span>
      </div>
      <div className="text-[11px] text-text-dim">Adds the name to the server's list, as root through {admin.profile.name}:</div>
      <RootCommand
        sessionId={admin.sessionId}
        command={command}
        label={`Allow ${principal} to log in as ${profile.username}`}
        onDone={onAllowed}
      />
    </div>
  );
}
