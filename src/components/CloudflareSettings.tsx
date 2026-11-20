import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ipc } from "@/lib/ipc";
import { useConnections } from "@/stores/connectionsStore";
import { toastError } from "@/lib/errors";
import type { AccessStatus, ConnectionProfile } from "@/lib/types";
import { ManagedToolCard, useManagedTool, type ToolOps } from "./ManagedToolCard";
import { CloudflareAccountCard } from "./CloudflareAccount";
import { SETTINGS_FOCUS } from "@/lib/settingsNav";
import { Btn, Empty, List, ListRow, Status, SubHeading, type Tone } from "./settings/kit";

/** The Access hostname a Cloudflare connection signs in to. */
export function accessHostname(p: ConnectionProfile): string | null {
  if (p.proxyCommand?.kind !== "cloudflare") return null;
  return p.proxyCommand.hostname?.trim() || p.host.trim() || null;
}

function expiresIn(expiresAt?: number): string {
  if (!expiresAt) return "";
  const left = expiresAt - Date.now() / 1000;
  if (left <= 0) return "expired";
  if (left < 3600) return `expires in ${Math.max(1, Math.round(left / 60))} min`;
  if (left < 86400) return `expires in ${Math.round(left / 3600)} h`;
  return `expires in ${Math.round(left / 86400)} d`;
}

function describe(s: AccessStatus): { text: string; tone: Tone; canLogin: boolean } {
  switch (s.state) {
    case "loggedIn": {
      const soon = !!s.expiresAt && s.expiresAt - Date.now() / 1000 < 3600;
      return {
        text: `Signed in as ${s.identity ?? "?"}${s.expiresAt ? ` · ${expiresIn(s.expiresAt)}` : ""}`,
        tone: soon ? "warn" : "ok",
        canLogin: true,
      };
    }
    case "expired":
      return { text: "Sign-in expired", tone: "warn", canLogin: true };
    case "loggedOut":
      return { text: "Not signed in", tone: "off", canLogin: true };
    case "notProtected":
      return { text: "No Access sign-in needed", tone: "ok", canLogin: false };
    default:
      return { text: s.message ? `Can't check: ${s.message}` : "Can't check the sign-in", tone: "bad", canLogin: true };
  }
}

/** One Access hostname's sign-in state, with Log in / Log in again. A list
 *  row in Settings; one quiet line (`compact`) in the connection editor. */
export function AccessSignIn({
  hostname,
  compact,
  quiet,
  extra,
}: {
  hostname: string;
  compact?: boolean;
  /** Offer "Log in again" only once the sign-in has expired or is about to. */
  quiet?: boolean;
  /** More status after the sign-in text (the editor's tunnel and login). */
  extra?: (signedIn: boolean) => ReactNode;
}) {
  const [status, setStatus] = useState<AccessStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!hostname.trim()) return;
    try {
      setStatus(await ipc.cfAccessStatus(hostname.trim()));
      setError(null);
    } catch (e) {
      setStatus(null);
      setError(String(e));
    }
  }, [hostname]);

  useEffect(() => {
    // Typing in the hostname field shouldn't run cloudflared per keystroke.
    const t = setTimeout(() => void load(), 400);
    return () => clearTimeout(t);
  }, [load]);

  const login = async () => {
    setBusy(true);
    try {
      setStatus(await ipc.cfAccessLogin(hostname.trim()));
      setError(null);
    } catch (e) {
      toastError(e, "Couldn't sign in to Cloudflare");
    } finally {
      setBusy(false);
    }
  };

  let state: ReactNode;
  let action: ReactNode = null;
  if (error) {
    state = <Status tone="bad">{error}</Status>;
  } else if (!status) {
    state = <Status tone="busy">Checking sign-in…</Status>;
  } else {
    const d = describe(status);
    const fresh =
      status.state === "loggedIn" && (!status.expiresAt || status.expiresAt - Date.now() / 1000 > 3600);
    state = (
      <Status tone={d.tone}>
        <span data-access-state={status.state}>
          {d.text}
          {extra?.(status.state === "loggedIn")}
        </span>
      </Status>
    );
    if (d.canLogin && !(quiet && fresh)) {
      action = (
        <Btn size="sm" busy={busy} onClick={() => void login()}>
          {busy ? "Waiting for the browser…" : status.state === "loggedIn" ? "Log in again" : "Log in"}
        </Btn>
      );
    }
  }

  if (compact) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 flex-1">{state}</div>
        {action}
      </div>
    );
  }
  return <ListRow title={<span className="font-mono">{hostname}</span>} status={state} actions={action} />;
}

const CLOUDFLARED_OPS: ToolOps = {
  status: ipc.cloudflaredStatus,
  check: ipc.cloudflaredCheck,
  install: ipc.cloudflaredInstall,
  setCustomPath: ipc.cloudflaredSetCustomPath,
};

/** cloudflared's state, with Install / Update; shared by Settings and the editor. */
export function useCloudflared() {
  return useManagedTool(CLOUDFLARED_OPS, "cloudflared", "cloudflared");
}

/** Install button for when cloudflared is missing (editor). */
export function InstallCloudflared({ onInstalled }: { onInstalled?: () => void }) {
  const cf = useCloudflared();
  if (!cf.status || cf.status.source !== "missing") return null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded border border-border px-3 py-1.5">
      <div className="flex min-w-0 flex-1">
        <Status tone="warn">cloudflared isn't installed</Status>
      </div>
      <Btn
        size="sm"
        busy={cf.busy}
        onClick={async () => {
          await cf.install();
          onInstalled?.();
        }}
      >
        {cf.busy ? "Installing…" : "Install cloudflared"}
      </Btn>
    </div>
  );
}

/// Settings → Cloudflare (Plan 29): which cloudflared Faro runs (install or
/// update Faro's own verified copy, or point at your own), the connected
/// account, and the Access sign-in of every hostname the saved connections use.
export function CloudflareSettings() {
  const cf = useCloudflared();
  const profiles = useConnections((s) => s.profiles);
  const hostnames = [...new Set(profiles.map(accessHostname).filter((h): h is string => !!h))];
  const s = cf.status;

  return (
    <div className="space-y-4">
      <ManagedToolCard
        tool={cf}
        name="cloudflared"
        testId="cloudflared-status"
        focusId={SETTINGS_FOCUS.cloudflared}
      />

      <CloudflareAccountCard />

      <section className="space-y-2">
        <SubHeading
          title="Access sign-ins"
          help="The Cloudflare Access hostnames your saved connections use, and whether you're signed in to each."
        />
        {hostnames.length === 0 ? (
          <Empty>No connections use Cloudflare Access.</Empty>
        ) : !s || s.source === "missing" ? (
          <Empty>Install cloudflared to manage sign-ins.</Empty>
        ) : (
          <List data-testid="access-signins">
            {hostnames.map((h) => (
              <AccessSignIn key={h} hostname={h} />
            ))}
          </List>
        )}
      </section>
    </div>
  );
}
