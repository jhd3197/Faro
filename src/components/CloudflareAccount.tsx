import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Link2, Loader2, LogOut, Server, Trash2, AlertTriangle } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { toast } from "@/stores/toastStore";
import { toastError } from "@/lib/errors";
import { openExternal } from "@/lib/openExternal";
import type { CfAccountStatus, CfSshHostname } from "@/lib/types";
import { SETTINGS_FOCUS } from "@/lib/settingsNav";

const TOKEN_PAGE = "https://dash.cloudflare.com/profile/api-tokens";

/** The connected Cloudflare account, for Settings and the editor. */
export function useCloudflareAccount() {
  const [status, setStatus] = useState<CfAccountStatus | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await ipc.cfAccountStatus());
    } catch {
      setStatus(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { status, setStatus, refresh };
}

/** Tunnel health as a short word with a colour. */
export function TunnelHealth({ status }: { status?: string }) {
  if (!status) return null;
  const tone = status === "healthy" ? "text-success" : status === "degraded" ? "text-warning" : "text-danger";
  return (
    <span className={tone} data-tunnel-status={status}>
      tunnel {status === "inactive" ? "not connected" : status}
    </span>
  );
}

/// Settings › Cloudflare › Account: connect once with a scoped API token, so
/// Faro can list SSH hostnames, show tunnel health, hold one service token
/// for unattended runs, invite teammates and move servers behind Cloudflare.
export function CloudflareAccountCard() {
  const { status, setStatus } = useCloudflareAccount();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [hosts, setHosts] = useState<CfSshHostname[] | null>(null);

  const loadHosts = useCallback(async () => {
    try {
      setHosts(await ipc.cfAccountHostnames());
    } catch (e) {
      setHosts([]);
      toastError(e, "Couldn't list the account's servers");
    }
  }, []);
  useEffect(() => {
    if (status?.connected) void loadHosts();
  }, [status?.connected, loadHosts]);

  const run = async (f: () => Promise<CfAccountStatus | void>, what: string) => {
    setBusy(true);
    try {
      const s = await f();
      if (s) setStatus(s);
    } catch (e) {
      toastError(e, what);
    } finally {
      setBusy(false);
    }
  };

  const connect = (accountId?: string) =>
    run(async () => {
      const s = await ipc.cfAccountConnect(token, accountId);
      if (s.connected) {
        setToken("");
        toast.success("Cloudflare account connected", s.accountName ?? undefined);
      }
      return s;
    }, "Couldn't connect the Cloudflare account");

  const btn =
    "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60";

  if (!status) return null;
  return (
    <div
      className="rounded-lg border border-border bg-bg-subtle/50 p-3 text-sm"
      data-testid="cf-account"
      data-settings-focus={SETTINGS_FOCUS.cloudflareAccount}
    >
      <div className="mb-1 font-medium text-text">Cloudflare account</div>
      {!status.connected ? (
        <>
          <p className="mb-2 text-xs text-text-muted">
            Connect an account once so Faro can list its SSH servers, show tunnel health, keep one
            service token for faro-cli, invite teammates and move servers behind Cloudflare. Create
            an API token with these permissions, and paste it here. It's kept in the system
            keychain.
          </p>
          <ul className="mb-2 list-disc pl-5 text-[11px] text-text-dim">
            {status.permissions.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          <div className="flex gap-2">
            <input
              type="password"
              aria-label="Cloudflare API token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="API token"
              autoComplete="off"
              className="min-w-0 flex-1 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-xs outline-none focus:border-accent"
            />
            <button
              onClick={() => void connect()}
              disabled={busy || !token.trim()}
              className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-60"
            >
              {busy ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
              Connect account
            </button>
            <button onClick={() => openExternal(TOKEN_PAGE)} className={btn}>
              Create a token…
            </button>
          </div>
          {status.choices.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              <div className="text-xs text-text-muted">This token reaches several accounts. Which one?</div>
              {status.choices.map((a) => (
                <button key={a.id} onClick={() => void connect(a.id)} disabled={busy} className={btn}>
                  {a.name}
                </button>
              ))}
            </div>
          )}
          <p className="mt-2 text-[11px] text-text-dim">
            Without an account, Cloudflare connections still work: type the server's hostname in the
            connection editor.
          </p>
        </>
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs">
            <CheckCircle2 size={14} className="text-success" />
            <span className="text-text">{status.accountName}</span>
            <span className="text-text-dim">· {status.accountId}</span>
            <button
              onClick={() => void run(async () => {
                await ipc.cfAccountDisconnect();
                setHosts(null);
                return await ipc.cfAccountStatus();
              }, "Couldn't disconnect")}
              disabled={busy}
              className={`${btn} ml-auto`}
            >
              <LogOut size={13} /> Disconnect
            </button>
          </div>

          <div className="mb-3 rounded-md border border-border px-2.5 py-2">
            <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-text">
              <KeyRound size={13} /> Service token for unattended runs
            </div>
            {status.serviceTokenClientId ? (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span className="min-w-0 flex-1 truncate font-mono" data-testid="cf-service-token">
                  {status.serviceTokenClientId}
                </span>
                <button
                  onClick={() => void run(ipc.cfAccountDeleteServiceToken, "Couldn't delete the service token")}
                  disabled={busy}
                  className={btn}
                >
                  <Trash2 size={13} /> Delete
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-text-muted">
                <span className="min-w-0 flex-1">
                  faro-cli uses it to reach Cloudflare servers with no browser to sign in. Add it to an
                  application's policy to let it in (Faro does when it sets up a server).
                </span>
                <button
                  onClick={() => void run(ipc.cfAccountCreateServiceToken, "Couldn't create the service token")}
                  disabled={busy}
                  className={btn}
                >
                  <KeyRound size={13} /> Create
                </button>
              </div>
            )}
          </div>

          <div className="text-xs font-medium text-text">SSH servers in this account</div>
          {hosts === null ? (
            <div className="mt-1 flex items-center gap-1.5 text-xs text-text-muted">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          ) : hosts.length === 0 ? (
            <p className="mt-1 text-xs text-text-muted">
              None yet. Move a server behind Cloudflare from its rail menu.
            </p>
          ) : (
            <div className="mt-1 flex flex-col gap-1" data-testid="cf-hostnames">
              {hosts.map((h) => (
                <div key={h.hostname} className="flex items-center gap-2 text-xs">
                  <Server size={12} className="shrink-0 text-text-dim" />
                  <span className="font-mono text-text">{h.hostname}</span>
                  <span className="text-text-dim">{h.label}</span>
                  <span className="ml-auto">
                    {h.tunnelStatus ? <TunnelHealth status={h.tunnelStatus} /> : (
                      <span className="inline-flex items-center gap-1 text-text-dim">
                        <AlertTriangle size={11} /> no tunnel here
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
