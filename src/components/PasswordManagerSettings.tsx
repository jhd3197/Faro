import { useEffect, useState } from "react";
import { Copy, Lock } from "lucide-react";
import { isComposing } from "@faro/file-ui";
import { messageOf } from "@/lib/errors";
import { SETTINGS_FOCUS } from "@/lib/settingsNav";
import type { AgentInfo, PmState, PmStatus } from "@/lib/types";
import { usePasswordManagers } from "@/stores/passwordManagersStore";
import { ManagedToolCard, toolOps, useManagedTool } from "./ManagedToolCard";
import { toast } from "@/stores/toastStore";
import { Advanced, Btn, Note, Row, Status, SubHeading, TextInput, type Tone } from "./settings/kit";

const STATE_LABEL: Record<PmState, string> = {
  missing: "Not installed",
  signedOut: "Signed out",
  locked: "Locked",
  ready: "Ready",
};

const STATE_TONE: Record<PmState, Tone> = {
  missing: "off",
  signedOut: "warn",
  locked: "warn",
  ready: "ok",
};

const ABOUT =
  "Connect with passwords and SSH keys kept in your password manager. Faro reads a secret only when a connection opens and never stores it.";

// Settings › Password managers (Plan 33): one block per manager with its
// state, account, SSH agent and CLI, plus Check again / Unlock / Lock.
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
    <div className="flex flex-col gap-6">
      {!loaded && status.length === 0 ? (
        <Status tone="busy">Checking</Status>
      ) : (
        status.map((pm) => (
          <ManagerSection
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

function ManagerSection({
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
  const refresh = usePasswordManagers((s) => s.refresh);
  const isOp = pm.id === "1password";
  const toolId = isOp ? "op" : "bw";
  const cliName = isOp ? "1Password CLI" : "Bitwarden CLI";
  // Installing or pointing at a CLI changes what the manager can do.
  const cli = useManagedTool(toolOps(toolId), cliName, toolId, () => void refresh());
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

  const bwSignedOut = !isOp && pm.state === "signedOut";
  const showDetail = pm.detail && pm.state !== "missing" && !bwSignedOut;

  return (
    <div data-pm-card={pm.id} data-pm-state={pm.state} className="flex flex-col gap-0.5">
      <SubHeading
        title={pm.name}
        help={
          isOp
            ? ABOUT
            : `${ABOUT} Install the Bitwarden CLI (bw), sign in once, then check again.`
        }
        actions={
          <>
            <span data-pm-state-label className="mr-1.5">
              <Status tone={STATE_TONE[pm.state]}>{STATE_LABEL[pm.state]}</Status>
            </span>
            {isOp && (pm.state === "locked" || pm.state === "signedOut") && (
              <Btn size="sm" busy={busy} onClick={() => void run(() => unlock("1password", ""))}>
                Sign in
              </Btn>
            )}
            {!isOp && pm.state === "ready" && (
              <Btn
                size="sm"
                data-pm-lock
                disabled={busy}
                icon={<Lock size={12} />}
                onClick={() => void run(() => lock("bitwarden"))}
              >
                Lock
              </Btn>
            )}
            <Btn size="sm" variant="ghost" data-pm-check busy={checking} onClick={onCheck}>
              Check again
            </Btn>
          </>
        }
      />
      {(showDetail || error) && (
        <div className="pt-1.5">
          {showDetail && <Note>{pm.detail}</Note>}
          {error && (
            <p role="alert" className="text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      )}

      {pm.account && (
        <Row label="Account">
          <span className="min-w-0 truncate text-sm text-text">{pm.account}</span>
        </Row>
      )}
      {bwSignedOut && <BwLogin cliPath={pm.cliPath} />}
      {!isOp && pm.state === "locked" && (
        <Row label="Master password">
          <div className="w-full max-w-sm">
            <UnlockForm focusId={SETTINGS_FOCUS.bitwardenPassword} />
          </div>
        </Row>
      )}
      <AgentRow agent={agent} />
      <Row label="Command-line tool">
        <div className="min-w-0 flex-1" data-pm-cli={toolId}>
          <ManagedToolCard
            tool={cli}
            name={cliName}
            compact
            focusId={isOp ? SETTINGS_FOCUS.opCli : SETTINGS_FOCUS.bwCli}
            missingText={`The ${cliName} isn't installed. Faro can install the official release for you.`}
          />
        </div>
      </Row>

      {isOp && (
        <Advanced title="How to connect" open={pm.state !== "ready"}>
          <ol className="list-decimal space-y-0.5 pl-9 text-xs leading-relaxed text-text-muted">
            <li>Install the 1Password CLI above, or use your own.</li>
            <li>In 1Password, Settings › Developer: turn on Integrate with 1Password CLI.</li>
            <li>For SSH keys, turn on Use the SSH agent on the same page.</li>
          </ol>
        </Advanced>
      )}
    </div>
  );
}

/** `bw login` needs the email, master password and two-step code in a
 *  terminal once. The command names the exact CLI Faro runs, which may be
 *  Faro's own copy and so not on PATH. */
function BwLogin({ cliPath }: { cliPath?: string }) {
  const command = cliPath ? `${/\s/.test(cliPath) ? `"${cliPath}"` : cliPath} login` : "bw login";
  return (
    <div data-pm-bw-login>
      <Row
        label="Sign in"
        help="Bitwarden isn't signed in. Run this once in a terminal, then check again."
      >
        <code
          title={command}
          className="flex h-7 min-w-0 flex-1 items-center truncate rounded border border-border bg-bg-subtle px-2.5 font-mono text-xs text-text"
        >
          {command}
        </code>
        <Btn
          size="sm"
          variant="ghost"
          aria-label="Copy the sign-in command"
          icon={<Copy size={12} />}
          onClick={() => {
            void navigator.clipboard.writeText(command);
            toast.success("Copied the sign-in command");
          }}
        >
          Copy
        </Btn>
      </Row>
    </div>
  );
}

function AgentRow({ agent }: { agent?: AgentInfo }) {
  if (!agent) return null;
  const sharedPipe = /openssh-ssh-agent/i.test(agent.path);
  return (
    <div data-pm-agent={agent.available ? "found" : "missing"}>
      <Row
        label="SSH agent"
        help={agent.available ? `${agent.path}${sharedPipe ? " (the shared OpenSSH pipe)" : ""}` : undefined}
      >
        {agent.available ? <Status tone="ok">Found</Status> : <Status tone="off">Not running</Status>}
      </Row>
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
        <TextInput
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
          className="flex-1"
        />
        <Btn variant="primary" data-pm-unlock-button busy={busy} onClick={() => void submit()}>
          Unlock
        </Btn>
      </div>
      {error && <p role="alert" data-pm-unlock-error className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}
