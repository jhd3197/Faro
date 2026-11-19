import { useEffect, useState } from "react";
import { KeyRound, Loader2, Lock, RotateCw } from "lucide-react";
import { isComposing } from "@faro/file-ui";
import { cn } from "@/lib/cn";
import { messageOf } from "@/lib/errors";
import { SETTINGS_FOCUS } from "@/lib/settingsNav";
import type { AgentInfo, PmState, PmStatus } from "@/lib/types";
import { usePasswordManagers } from "@/stores/passwordManagersStore";

const STATE_LABEL: Record<PmState, string> = {
  missing: "Not installed",
  signedOut: "Signed out",
  locked: "Locked",
  ready: "Ready",
};

const STATE_TONE: Record<PmState, string> = {
  missing: "bg-bg-hover text-text-muted",
  signedOut: "bg-warning-soft text-warning",
  locked: "bg-warning-soft text-warning",
  ready: "bg-success-soft text-success",
};

const btn =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60";

// Settings › Password managers (Plan 33): one card per manager with its
// state, account and SSH agent, plus Check again / Unlock / Lock.
export function PasswordManagerSettings() {
  const status = usePasswordManagers((s) => s.status);
  const agents = usePasswordManagers((s) => s.agents);
  const loaded = usePasswordManagers((s) => s.loaded);
  const refresh = usePasswordManagers((s) => s.refresh);
  const refreshAgents = usePasswordManagers((s) => s.refreshAgents);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    void refresh();
    void refreshAgents();
  }, [refresh, refreshAgents]);

  const checkAgain = async () => {
    setChecking(true);
    try {
      await Promise.all([refresh(), refreshAgents()]);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-text-muted">
        Connect with passwords and SSH keys kept in 1Password or Bitwarden. Faro
        reads a secret only when a connection opens and never stores it.
      </p>
      {!loaded && status.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-text-muted">
          <Loader2 size={14} className="animate-spin" /> Checking…
        </div>
      ) : (
        status.map((pm) => (
          <ManagerCard
            key={pm.id}
            pm={pm}
            agent={agents.find((a) => a.id === pm.id)}
            checking={checking}
            onCheck={() => void checkAgain()}
          />
        ))
      )}
    </div>
  );
}

function ManagerCard({
  pm,
  agent,
  checking,
  onCheck,
}: {
  pm: PmStatus;
  agent?: AgentInfo;
  checking: boolean;
  onCheck: () => void;
}) {
  const lock = usePasswordManagers((s) => s.lock);
  const unlock = usePasswordManagers((s) => s.unlock);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const isOp = pm.id === "1password";
  return (
    <div
      data-pm-card={pm.id}
      data-pm-state={pm.state}
      className="rounded-lg border border-border bg-bg-subtle/50 p-3 text-sm"
    >
      <div className="flex items-center gap-2">
        <KeyRound size={15} className="shrink-0 text-accent" />
        <span className="font-medium text-text">{pm.name}</span>
        <span
          data-pm-state-label
          className={cn("rounded px-1.5 py-0.5 text-[10.5px] font-medium", STATE_TONE[pm.state])}
        >
          {STATE_LABEL[pm.state]}
        </span>
      </div>

      {pm.account && <div className="mt-1.5 text-xs text-text">{pm.account}</div>}
      {pm.cliPath && <div className="mt-0.5 truncate font-mono text-[11px] text-text-dim">{pm.cliPath}</div>}
      {pm.detail && <p className="mt-1.5 text-xs text-text-muted">{pm.detail}</p>}
      {!isOp && pm.state === "signedOut" && !pm.detail && (
        <p className="mt-1.5 text-xs text-text-muted">
          Run <code>bw login</code> once in a terminal, then check again.
        </p>
      )}

      <AgentLine agent={agent} />

      {!isOp && pm.state === "locked" && (
        <div className="mt-3">
          <UnlockForm focusId={SETTINGS_FOCUS.bitwardenPassword} />
        </div>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {isOp && (pm.state === "locked" || pm.state === "signedOut") && (
          <button type="button" disabled={busy} className={btn} onClick={() => void run(() => unlock("1password", ""))}>
            {busy && <Loader2 size={12} className="animate-spin" />}Sign in
          </button>
        )}
        {!isOp && pm.state === "ready" && (
          <button type="button" data-pm-lock disabled={busy} className={btn} onClick={() => void run(() => lock("bitwarden"))}>
            <Lock size={12} />Lock
          </button>
        )}
        <button type="button" data-pm-check disabled={checking} className={btn} onClick={onCheck}>
          {checking ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
          Check again
        </button>
      </div>
      {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}

      {isOp && (
        <details className="mt-3 text-xs text-text-muted" open={pm.state !== "ready"}>
          <summary className="cursor-pointer select-none text-text-muted hover:text-text">How to connect</summary>
          <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
            <li>Install the 1Password CLI (<code>op</code>).</li>
            <li>In 1Password, open Settings › Developer and turn on Integrate with 1Password CLI.</li>
            <li>For SSH keys, turn on Use the SSH agent on the same page.</li>
          </ol>
        </details>
      )}
      {!isOp && pm.state === "missing" && (
        <p className="mt-3 text-xs text-text-muted">
          Install the Bitwarden CLI (<code>bw</code>), run <code>bw login</code> once, then check again.
        </p>
      )}
    </div>
  );
}

function AgentLine({ agent }: { agent?: AgentInfo }) {
  if (!agent) return null;
  const sharedPipe = /openssh-ssh-agent/i.test(agent.path);
  return (
    <div data-pm-agent={agent.available ? "found" : "missing"} className="mt-1.5 text-xs text-text-muted">
      {agent.available ? (
        <>
          SSH agent: found at <span className="break-all font-mono text-[11px]">{agent.path}</span>
          {sharedPipe && " (the shared OpenSSH pipe)"}
        </>
      ) : (
        "SSH agent: not running"
      )}
    </div>
  );
}

/** Bitwarden master-password field. The password goes to the backend once
 *  and is cleared from the field right after, whatever the result. */
export function UnlockForm({ focusId, onUnlocked, autoFocus }: { focusId?: string; onUnlocked?: () => void; autoFocus?: boolean }) {
  const unlock = usePasswordManagers((s) => s.unlock);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (busy) return;
    const pw = password;
    setPassword("");
    setError("");
    if (!pw) {
      setError("Enter your master password.");
      return;
    }
    setBusy(true);
    try {
      await unlock("bitwarden", pw);
      onUnlocked?.();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-settings-focus={focusId} data-pm-unlock>
      <div className="flex items-center gap-2">
        <input
          type="password"
          aria-label="Bitwarden master password"
          placeholder="Master password"
          autoComplete="off"
          autoFocus={autoFocus}
          value={password}
          disabled={busy}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || isComposing(e)) return;
            e.preventDefault();
            e.stopPropagation();
            void submit();
          }}
          className="min-w-0 flex-1 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-sm outline-none focus:border-accent"
        />
        <button
          type="button"
          data-pm-unlock-button
          disabled={busy}
          onClick={() => void submit()}
          className="btn-accent inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-60"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}Unlock
        </button>
      </div>
      {error && <p role="alert" data-pm-unlock-error className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
