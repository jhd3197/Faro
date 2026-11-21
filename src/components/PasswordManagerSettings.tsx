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
  const [usePassword, setUsePassword] = useState(false);

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
            {isOp && pm.signIn === "app" && (
              <Btn size="sm" data-pm-op-app busy={busy} onClick={() => void run(() => unlock("1password", ""))}>
                Sign in
              </Btn>
            )}
            {isOp && pm.state === "ready" && (
              <Btn size="sm" data-pm-op-signout disabled={busy} onClick={() => void run(() => lock("1password"))}>
                Sign out
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
      {isOp && pm.signIn === "add" && <OpAddAccountForm />}
      {isOp && (pm.signIn === "password" || (pm.signIn === "app" && usePassword)) && (
        <Row label="Password" help="Your 1Password account password. Faro passes it to the 1Password CLI once and keeps only the session it returns, in memory.">
          <div className="w-full max-w-sm">
            <UnlockForm provider="1password" />
          </div>
        </Row>
      )}
      {isOp && pm.signIn === "app" && !usePassword && (
        <button type="button" data-pm-op-use-password className="self-start text-xs text-accent hover:underline" onClick={() => setUsePassword(true)}>
          Sign in with your account password instead
        </button>
      )}
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
            <li>Faro installs the 1Password CLI for you (above), or use your own.</li>
            <li>Sign in above with your 1Password account. No 1Password app needed.</li>
            <li>
              Or, with the 1Password app on this computer: Settings › Developer › Integrate with 1Password CLI, then Sign
              in approves with Windows Hello or Touch ID.
            </li>
            <li>For SSH keys, turn on Use the SSH agent on the same page of the app.</li>
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
export function UnlockForm({
  focusId,
  onUnlocked,
  autoFocus,
  provider = "bitwarden",
}: {
  focusId?: string;
  onUnlocked?: () => void;
  autoFocus?: boolean;
  provider?: "bitwarden" | "1password";
}) {
  const isOp = provider === "1password";
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
      setError(isOp ? "Enter your 1Password account password." : "Enter your master password.");
      return;
    }
    setBusy(true);
    try {
      await unlock(provider, pw);
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
          aria-label={isOp ? "1Password account password" : "Bitwarden master password"}
          placeholder={isOp ? "Account password" : "Master password"}
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
          {isOp ? "Sign in" : "Unlock"}
        </Btn>
      </div>
      {error && <p role="alert" data-pm-unlock-error className="mt-1.5 text-xs text-danger">{error}</p>}
    </div>
  );
}

/** 1Password with no account in the CLI yet: the four things 1Password asks
 *  for on a new device. Faro hands them to `op account add` (password on
 *  stdin, Secret Key in that one process's environment) and keeps only the
 *  session. The password and Secret Key fields clear right after. */
function OpAddAccountForm() {
  const addOpAccount = usePasswordManagers((s) => s.addOpAccount);
  const [address, setAddress] = useState("my.1password.com");
  const [email, setEmail] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async () => {
    if (busy) return;
    const [key, pw] = [secretKey, password];
    setError("");
    if (!email.trim() || !key.trim() || !pw) {
      setError("Fill in your email, Secret Key and password.");
      return;
    }
    setPassword("");
    setBusy(true);
    try {
      await addOpAccount(address, email, key, pw);
      setSecretKey("");
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || isComposing(e)) return;
    e.preventDefault();
    e.stopPropagation();
    void submit();
  };

  return (
    <div data-pm-op-add className="flex flex-col gap-0.5">
      <Row label="Sign-in address" help="Where you sign in to 1Password on the web: my.1password.com, or your team's address.">
        <TextInput aria-label="1Password sign-in address" value={address} disabled={busy} onChange={(e) => setAddress(e.target.value)} onKeyDown={onEnter} className="w-full max-w-sm" />
      </Row>
      <Row label="Email">
        <TextInput aria-label="1Password email" type="email" autoComplete="off" value={email} disabled={busy} onChange={(e) => setEmail(e.target.value)} onKeyDown={onEnter} className="w-full max-w-sm" />
      </Row>
      <Row label="Secret Key" help="Starts with A3-. It's in your Emergency Kit, or in the 1Password app under your account settings.">
        <TextInput aria-label="1Password Secret Key" type="password" autoComplete="off" placeholder="A3-XXXXXX-…" value={secretKey} disabled={busy} onChange={(e) => setSecretKey(e.target.value)} onKeyDown={onEnter} className="w-full max-w-sm" />
      </Row>
      <Row label="Password">
        <div className="flex w-full max-w-sm items-center gap-2">
          <TextInput aria-label="1Password account password" type="password" autoComplete="off" value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} onKeyDown={onEnter} className="flex-1" />
          <Btn variant="primary" data-pm-op-add-button busy={busy} onClick={() => void submit()}>
            Sign in
          </Btn>
        </div>
      </Row>
      {error && (
        <p role="alert" data-pm-op-add-error className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
