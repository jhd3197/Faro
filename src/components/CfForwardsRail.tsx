import { useCallback, useEffect, useState } from "react";
import { Globe, Loader2, Square } from "lucide-react";
import { ipc, onCfForwardsChanged } from "@/lib/ipc";
import type { CfForwardStatus, ConnectionProfile } from "@/lib/types";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/cn";

/// Running (and failed) Access TCP forwards, under the server list. Hidden
/// until a connection defines one, and only drawn once the rail is expanded
/// so the collapsed column keeps its height.
export function CfForwardsRail({
  expanded,
  profiles,
}: {
  expanded: boolean;
  profiles: ConnectionProfile[];
}) {
  const [rows, setRows] = useState<CfForwardStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const defined = profiles.flatMap((p) =>
    (p.cfForwards ?? [])
      .filter((f) => f.name.trim())
      .map((f) => ({
        profileId: p.id,
        profileName: p.name,
        name: f.name,
        hostname: f.hostname || p.proxyCommand?.hostname || p.host,
        localPort: f.localPort,
        web: !!f.web,
      }))
  );

  const refresh = useCallback(async () => {
    try {
      setRows(await ipc.cfForwardsStatus());
    } catch {
      setRows([]);
    }
  }, []);

  const signature = defined.map((f) => `${f.profileId}:${f.name}:${f.localPort}:${f.web}`).join("|");
  useEffect(() => {
    void refresh();
  }, [refresh, signature]);
  useEffect(() => {
    let dead = false;
    let unlisten: (() => void) | undefined;
    void onCfForwardsChanged(() => void refresh()).then((u) => {
      if (dead) u();
      else unlisten = u;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, [refresh]);

  if (!expanded || defined.length === 0) return null;

  const byKey = new Map((rows ?? []).map((r) => [`${r.profileId}\0${r.name}`, r]));

  const run = async (key: string, fn: () => Promise<unknown>, what: string) => {
    setBusy(key);
    try {
      await fn();
      await refresh();
    } catch (e) {
      toastError(e, what);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mt-3 w-full px-2" data-testid="cf-forwards-rail">
      <div className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-text-dim">
        Forwards
      </div>
      <div className="flex flex-col gap-1">
        {defined.map((f) => {
          const key = `${f.profileId}\0${f.name}`;
          const live = byKey.get(key);
          const running = !!live?.running;
          const error = live?.error;
          return (
            <div
              key={key}
              data-testid="cf-forward-row"
              data-forward-name={f.name}
              data-forward-state={error ? "error" : running ? "running" : "stopped"}
              className="rounded-lg bg-bg-subtle/80 px-2 py-1.5"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "h-1.5 w-1.5 shrink-0 rounded-full",
                    error ? "bg-danger" : running ? "bg-success" : "bg-text-dim"
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text">{f.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-text-dim">:{f.localPort}</span>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-text-dim">
                {f.profileName}
                {running ? " · listening" : error ? "" : " · stopped"}
              </div>
              {error && (
                <p className="mt-0.5 text-[10px] leading-snug text-danger" data-testid="cf-forward-error">
                  {error}
                </p>
              )}
              <div className="mt-1 flex gap-1">
                {f.web && (
                  <button
                    type="button"
                    data-testid="cf-forward-open"
                    disabled={busy === key}
                    onClick={() =>
                      void run(key, () => ipc.cfForwardOpen(f.profileId, f.name), "Couldn't open the panel")
                    }
                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60"
                  >
                    {busy === key ? <Loader2 size={10} className="animate-spin" /> : <Globe size={10} />}
                    Open
                  </button>
                )}
                {running ? (
                  <button
                    type="button"
                    data-testid="cf-forward-stop"
                    disabled={busy === key}
                    onClick={() =>
                      void run(key, () => ipc.cfForwardStop(f.profileId, f.name), "Couldn't stop the forward")
                    }
                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60"
                  >
                    <Square size={9} /> Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="cf-forward-start"
                    disabled={busy === key}
                    onClick={() =>
                      void run(key, () => ipc.cfForwardStart(f.profileId, f.name), "Couldn't start the forward")
                    }
                    className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60"
                  >
                    Start
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
