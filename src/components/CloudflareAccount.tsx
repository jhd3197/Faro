import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { toast } from "@/stores/toastStore";
import { toastError } from "@/lib/errors";
import { openExternal } from "@/lib/openExternal";
import type { CfAccountStatus, CfSshHostname } from "@/lib/types";
import { SETTINGS_FOCUS } from "@/lib/settingsNav";
import { cn } from "@/lib/cn";
import { Btn, Group, List, ListRow, Row, Status, TextInput } from "./settings/kit";

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

/** A connector timestamp as a short relative phrase, with the raw value kept
 *  for the tooltip. Future or unparseable values stay as a date. */
function formatSeen(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 0) return iso.slice(0, 16).replace("T", " ");
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return iso.slice(0, 10);
}

/** Tunnel health: a dot and the status, and when we know them the
 *  connector's last seen time and the cloudflared version on the server.
 *  Inline, so it can sit inside a sentence or a status line. */
export function TunnelHealth({
  status,
  lastSeen,
  version,
}: {
  status?: string;
  lastSeen?: string;
  version?: string;
}) {
  if (!status && !lastSeen && !version) return null;
  const dot = status === "healthy" ? "bg-success" : status === "degraded" ? "bg-warning" : "bg-danger";
  return (
    <span
      className="inline-flex min-w-0 items-center gap-1.5 text-text-muted"
      data-tunnel-status={status || undefined}
      data-testid="tunnel-health"
      title={lastSeen}
    >
      {status && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
      <span className="truncate">
        {status ? `tunnel ${status === "inactive" ? "not connected" : status}` : "tunnel"}
        {version ? <span className="text-text-dim"> · cloudflared {version}</span> : null}
        {lastSeen ? <span className="text-text-dim"> · connector {formatSeen(lastSeen)}</span> : null}
      </span>
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

  if (!status) return null;
  return (
    <div data-testid="cf-account" data-settings-focus={SETTINGS_FOCUS.cloudflareAccount}>
      <Group
        title="Cloudflare account"
        help="Lets Faro list the account's SSH servers, show tunnel health, keep a service token for faro-cli, invite teammates and move servers behind Cloudflare. Without one, Cloudflare connections still work: type the server's hostname in the connection editor."
      >
        {!status.connected ? (
          <>
            <Row
              label="API token"
              keywords="cloudflare account connect"
              help={
                <>
                  Create an API token with these permissions and paste it here. It's kept in the
                  system keychain.
                  <span className="mt-1 block">{status.permissions.join(" · ")}</span>
                </>
              }
            >
              <TextInput
                type="password"
                aria-label="Cloudflare API token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder="API token"
                autoComplete="off"
                className="min-w-0 flex-1"
              />
              <Btn variant="primary" busy={busy} disabled={!token.trim()} onClick={() => void connect()}>
                Connect account
              </Btn>
              <Btn variant="ghost" onClick={() => openExternal(TOKEN_PAGE)}>
                Create a token…
              </Btn>
            </Row>
            {status.choices.length > 0 && (
              <Row label="Pick an account" help="This token reaches several accounts.">
                {status.choices.map((a) => (
                  <Btn key={a.id} onClick={() => void connect(a.id)} disabled={busy}>
                    {a.name}
                  </Btn>
                ))}
              </Row>
            )}
          </>
        ) : (
          <>
            <Row label="Account" keywords="cloudflare">
              <span className="min-w-0 truncate text-sm text-text">{status.accountName}</span>
              <span className="min-w-0 truncate font-mono text-xs text-text-dim">{status.accountId}</span>
              <Btn
                className="ml-auto"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await ipc.cfAccountDisconnect();
                    setHosts(null);
                    return await ipc.cfAccountStatus();
                  }, "Couldn't disconnect")
                }
              >
                Disconnect
              </Btn>
            </Row>
            <Row
              label="Service token"
              keywords="faro-cli unattended"
              help="faro-cli uses it to reach Cloudflare servers with no browser to sign in. Add it to an application's policy to let it in; Faro does when it sets up a server."
            >
              {status.serviceTokenClientId ? (
                <>
                  <span
                    className="min-w-0 flex-1 truncate font-mono text-xs text-text"
                    data-testid="cf-service-token"
                  >
                    {status.serviceTokenClientId}
                  </span>
                  <Btn
                    variant="danger"
                    disabled={busy}
                    onClick={() => void run(ipc.cfAccountDeleteServiceToken, "Couldn't delete the service token")}
                  >
                    Delete
                  </Btn>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 text-sm text-text-dim">None</span>
                  <Btn
                    disabled={busy}
                    onClick={() => void run(ipc.cfAccountCreateServiceToken, "Couldn't create the service token")}
                  >
                    Create
                  </Btn>
                </>
              )}
            </Row>
            <Row
              label="SSH servers"
              keywords="hostnames tunnel"
              help="SSH servers in this account. Move a server behind Cloudflare from its rail menu."
            >
              {hosts === null ? (
                <Status tone="busy">Loading…</Status>
              ) : hosts.length === 0 ? (
                <span className="text-sm text-text-dim">None yet</span>
              ) : (
                <List data-testid="cf-hostnames" className="w-full">
                  {hosts.map((h) => (
                    <ListRow
                      key={h.hostname}
                      title={<span className="font-mono">{h.hostname}</span>}
                      detail={h.label || undefined}
                      status={
                        h.tunnelStatus ? (
                          <span className="text-xs">
                            <TunnelHealth
                              status={h.tunnelStatus}
                              lastSeen={h.connectorLastSeen}
                              version={h.connectorVersion}
                            />
                          </span>
                        ) : (
                          <Status tone="off">No tunnel</Status>
                        )
                      }
                    />
                  ))}
                </List>
              )}
            </Row>
          </>
        )}
      </Group>
    </div>
  );
}
