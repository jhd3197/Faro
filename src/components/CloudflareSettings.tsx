import { useCallback, useEffect, useState } from "react";
import { Cloud, Loader2, CheckCircle2, AlertTriangle, Download, LogIn, FolderOpen, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/lib/ipc";
import { useConnections } from "@/stores/connectionsStore";
import { toastError } from "@/lib/errors";
import type { AccessStatus, CloudflaredStatus, ConnectionProfile } from "@/lib/types";

const SOURCE_LABEL: Record<CloudflaredStatus["source"], string> = {
  custom: "your own copy",
  managed: "installed by Faro",
  path: "found on PATH",
  missing: "",
};

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

function describe(s: AccessStatus): { text: string; ok: boolean; canLogin: boolean } {
  switch (s.state) {
    case "loggedIn":
      return {
        text: `Signed in as ${s.identity ?? "?"}${s.expiresAt ? ` · ${expiresIn(s.expiresAt)}` : ""}`,
        ok: true,
        canLogin: true,
      };
    case "expired":
      return { text: "Sign-in expired", ok: false, canLogin: true };
    case "loggedOut":
      return { text: "Not signed in", ok: false, canLogin: true };
    case "notProtected":
      return { text: "No Access sign-in needed", ok: true, canLogin: false };
    default:
      return { text: s.message ? `Can't check: ${s.message}` : "Can't check the sign-in", ok: false, canLogin: true };
  }
}

/** One Access hostname's sign-in state, with Log in / Log in again. */
export function AccessSignIn({
  hostname,
  compact,
  extra,
}: {
  hostname: string;
  compact?: boolean;
  /** More status after the sign-in text (the editor's tunnel and login). */
  extra?: (signedIn: boolean) => React.ReactNode;
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
      toastError(e, "Cloudflare sign-in");
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return <div className="text-[11.5px] text-text-muted">{error}</div>;
  }
  if (!status) {
    return (
      <div className="flex items-center gap-1.5 text-[11.5px] text-text-muted">
        <Loader2 size={12} className="animate-spin" /> Checking sign-in…
      </div>
    );
  }
  const d = describe(status);
  return (
    <div className="flex min-w-0 items-center gap-2 text-[11.5px]">
      {d.ok ? (
        <CheckCircle2 size={13} className="shrink-0 text-success" />
      ) : (
        <AlertTriangle size={13} className="shrink-0 text-warning" />
      )}
      {!compact && <span className="shrink-0 font-medium text-text">{hostname}</span>}
      <span className="min-w-0 truncate text-text-muted" data-access-state={status.state}>
        {d.text}
        {extra?.(status.state === "loggedIn")}
      </span>
      {d.canLogin && (
        <button
          type="button"
          onClick={() => void login()}
          disabled={busy}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60"
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <LogIn size={11} />}
          {busy ? "Waiting for the browser…" : status.state === "loggedIn" ? "Log in again" : "Log in"}
        </button>
      )}
    </div>
  );
}

/** cloudflared's state, with Install / Update; shared by Settings and the editor. */
export function useCloudflared() {
  const [status, setStatus] = useState<CloudflaredStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => setStatus(await ipc.cloudflaredStatus()), []);
  const run = async (f: () => Promise<CloudflaredStatus>) => {
    setBusy(true);
    try {
      setStatus(await f());
    } catch (e) {
      toastError(e, "cloudflared");
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return {
    status,
    busy,
    refresh,
    check: () => run(ipc.cloudflaredCheck),
    install: () => run(ipc.cloudflaredInstall),
    setCustomPath: (p: string | null) => run(() => ipc.cloudflaredSetCustomPath(p)),
  };
}

/** Install button for when cloudflared is missing (editor). */
export function InstallCloudflared({ onInstalled }: { onInstalled?: () => void }) {
  const cf = useCloudflared();
  if (!cf.status || cf.status.source !== "missing") return null;
  return (
    <div className="mb-3 flex items-center gap-2 rounded-md border border-border bg-bg-subtle px-2.5 py-2 text-[11.5px] text-text-muted">
      <AlertTriangle size={13} className="shrink-0 text-warning" />
      <span className="min-w-0 flex-1">cloudflared isn't installed on this computer.</span>
      <button
        type="button"
        onClick={async () => {
          await cf.install();
          onInstalled?.();
        }}
        disabled={cf.busy}
        className="inline-flex shrink-0 items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white hover:bg-accent/90 disabled:opacity-60"
      >
        {cf.busy ? <Loader2 size={11} className="animate-spin" /> : <Download size={11} />}
        {cf.busy ? "Installing…" : "Install cloudflared"}
      </button>
    </div>
  );
}

/// Settings → Cloudflare (Plan 29): which cloudflared Faro runs (install or
/// update Faro's own verified copy, or point at your own), and the Access
/// sign-in of every hostname the saved connections use.
export function CloudflareSettings() {
  const cf = useCloudflared();
  const profiles = useConnections((s) => s.profiles);
  const hostnames = [...new Set(profiles.map(accessHostname).filter((h): h is string => !!h))];
  const s = cf.status;

  const browse = async () => {
    const picked = await open({ multiple: false, directory: false, title: "Choose cloudflared" });
    if (typeof picked === "string") await cf.setCustomPath(picked);
  };

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h3 className="mb-1 flex items-center gap-2 text-sm font-medium text-text">
          <Cloud size={15} className="text-accent" />
          Cloudflare
        </h3>
        <p className="text-xs text-text-muted">
          Connections that use Cloudflare Access run <code>cloudflared</code>. Faro can
          download the official release for you (checksum-verified, into its own
          folder, no admin rights) and keep it up to date.
        </p>
      </div>

      <div className="rounded-lg border border-border bg-bg-subtle/50 p-3 text-sm" data-testid="cloudflared-status">
        {!s ? (
          <div className="flex items-center gap-2 text-text-muted">
            <Loader2 size={15} className="animate-spin" /> Checking…
          </div>
        ) : s.source === "missing" ? (
          <div className="flex items-start gap-2">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
            <div className="text-text">cloudflared isn't installed.</div>
          </div>
        ) : (
          <div className="flex items-start gap-2">
            <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
            <div className="min-w-0">
              <div className="text-text">
                cloudflared {s.version ?? "(version unknown)"}{" "}
                <span className="text-text-muted">· {SOURCE_LABEL[s.source]}</span>
              </div>
              {s.path && <p className="mt-0.5 truncate text-xs text-text-muted">{s.path}</p>}
              {s.updateAvailable && (
                <p className="mt-0.5 text-xs text-warning">cloudflared {s.latest} is available.</p>
              )}
              {s.latest && !s.updateAvailable && (
                <p className="mt-0.5 text-xs text-text-muted">Up to date (latest is {s.latest}).</p>
              )}
            </div>
          </div>
        )}
        {s?.message && (
          <p className="mt-2 border-t border-border/60 pt-2 text-xs text-text-muted">{s.message}</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            onClick={() => void cf.install()}
            disabled={cf.busy}
            className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-60"
          >
            {cf.busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
            {s?.source === "managed"
              ? s.updateAvailable
                ? `Update to ${s.latest}`
                : "Reinstall latest"
              : "Install Faro's copy"}
          </button>
          <button
            onClick={() => void cf.check()}
            disabled={cf.busy}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60"
          >
            Check for updates
          </button>
          <button
            onClick={() => void browse()}
            disabled={cf.busy}
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60"
          >
            <FolderOpen size={13} /> Use my own…
          </button>
          {s?.customPath && (
            <button
              onClick={() => void cf.setCustomPath(null)}
              disabled={cf.busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60"
            >
              <X size={13} /> Stop using my own
            </button>
          )}
        </div>
      </div>

      <div>
        <div className="mb-1.5 text-sm font-medium text-text">Access sign-ins</div>
        {hostnames.length === 0 ? (
          <p className="text-xs text-text-muted">No connections use Cloudflare Access yet.</p>
        ) : !s || s.source === "missing" ? (
          <p className="text-xs text-text-muted">Install cloudflared to see and manage sign-ins.</p>
        ) : (
          <div className="flex flex-col gap-1.5" data-testid="access-signins">
            {hostnames.map((h) => (
              <div key={h} className="rounded-md border border-border px-3 py-2">
                <AccessSignIn hostname={h} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
