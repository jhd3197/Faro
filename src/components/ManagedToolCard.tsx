import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Download, FolderOpen, Loader2, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/cn";
import { ipc, onToolStatus } from "@/lib/ipc";
import { toastError } from "@/lib/errors";
import type { CloudflaredStatus, ManagedToolId } from "@/lib/types";

// Faro-managed command-line tools (cloudflared, op, bw): which copy runs,
// with Install / Update / Use my own. The backend is `managed_tools`; every
// tool gets the same card.

const SOURCE_LABEL: Record<CloudflaredStatus["source"], string> = {
  custom: "your own copy",
  managed: "installed by Faro",
  path: "found on PATH",
  missing: "",
};

export interface ToolOps {
  status: () => Promise<CloudflaredStatus>;
  check: () => Promise<CloudflaredStatus>;
  install: () => Promise<CloudflaredStatus>;
  setCustomPath: (path: string | null) => Promise<CloudflaredStatus>;
}

export function toolOps(id: ManagedToolId): ToolOps {
  return {
    status: () => ipc.toolStatus(id),
    check: () => ipc.toolCheck(id),
    install: () => ipc.toolInstall(id),
    setCustomPath: (p) => ipc.toolSetCustomPath(id, p),
  };
}

export interface ManagedTool {
  status: CloudflaredStatus | null;
  busy: boolean;
  refresh: () => Promise<void>;
  check: () => Promise<void>;
  install: () => Promise<void>;
  setCustomPath: (p: string | null) => Promise<void>;
}

/** One tool's state and actions. `name` is for error toasts; `onChange`
 *  runs after an install or a path change (say, to re-check a manager). */
export function useManagedTool(ops: ToolOps, name: string, id?: ManagedToolId, onChange?: () => void): ManagedTool {
  const [status, setStatus] = useState<CloudflaredStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try {
      setStatus(await ops.status());
    } catch {
      /* leave the last known state */
    }
    // `ops` is rebuilt each render; the tool it points at doesn't change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const run = async (f: () => Promise<CloudflaredStatus>, changes: boolean) => {
    setBusy(true);
    try {
      setStatus(await f());
      if (changes) onChange?.();
    } catch (e) {
      toastError(e, `Couldn't install or update ${name}`);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
  }, [refresh]);
  // An update found in the background, or an install from another window.
  useEffect(() => {
    if (!id) return;
    let off: (() => void) | undefined;
    let gone = false;
    void onToolStatus((s) => {
      if (s.id === id) setStatus(s);
    }).then((u) => (gone ? u() : (off = u)));
    return () => {
      gone = true;
      off?.();
    };
  }, [id]);
  return {
    status,
    busy,
    refresh,
    check: () => run(ops.check, false),
    install: () => run(ops.install, true),
    setCustomPath: (p) => run(() => ops.setCustomPath(p), true),
  };
}

const quiet =
  "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-60";

/** The tool's version and source, with Install / Update, Check for updates
 *  and Use my own. `compact` drops the outer box (inside another card). */
export function ManagedToolCard({
  tool,
  name,
  missingText,
  testId,
  focusId,
  compact,
}: {
  tool: ManagedTool;
  /** "cloudflared", "1Password CLI". */
  name: string;
  missingText?: string;
  testId?: string;
  focusId?: string;
  compact?: boolean;
}) {
  const s = tool.status;
  const browse = async () => {
    const picked = await open({ multiple: false, directory: false, title: `Choose ${name}` });
    if (typeof picked === "string") await tool.setCustomPath(picked);
  };
  return (
    <div
      className={cn(compact ? "text-xs" : "rounded-lg border border-border bg-bg-subtle/50 p-3 text-sm")}
      data-testid={testId}
      data-settings-focus={focusId}
      data-tool-source={s?.source}
    >
      {!s ? (
        <div className="flex items-center gap-2 text-text-muted">
          <Loader2 size={compact ? 12 : 15} className="animate-spin" /> Checking…
        </div>
      ) : s.source === "missing" ? (
        <div className="flex items-start gap-2">
          <AlertTriangle size={compact ? 13 : 15} className="mt-0.5 shrink-0 text-warning" />
          <div className="text-text">{missingText ?? `${name} isn't installed.`}</div>
        </div>
      ) : (
        <div className="flex items-start gap-2">
          <CheckCircle2 size={compact ? 13 : 15} className="mt-0.5 shrink-0 text-success" />
          <div className="min-w-0">
            <div className="text-text">
              {name} {s.version ?? "(version unknown)"}{" "}
              <span className="text-text-muted">· {SOURCE_LABEL[s.source]}</span>
            </div>
            {s.path && <p className="mt-0.5 truncate font-mono text-[11px] text-text-dim">{s.path}</p>}
            {s.updateAvailable && (
              <p className="mt-0.5 text-xs text-warning">
                {name} {s.latest} is available.
              </p>
            )}
            {s.latest && !s.updateAvailable && (
              <p className="mt-0.5 text-xs text-text-muted">Up to date (latest is {s.latest}).</p>
            )}
          </div>
        </div>
      )}
      {s?.message && <p className="mt-2 border-t border-border/60 pt-2 text-xs text-text-muted">{s.message}</p>}
      <div className={cn("flex flex-wrap gap-2", compact ? "mt-2" : "mt-3")}>
        <button
          type="button"
          data-tool-install
          onClick={() => void tool.install()}
          disabled={tool.busy}
          className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-60"
        >
          {tool.busy ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {tool.busy
            ? "Working…"
            : s?.source === "managed"
              ? s.updateAvailable
                ? `Update to ${s.latest}`
                : "Reinstall latest"
              : s?.source === "missing"
                ? `Install ${name}`
                : "Install Faro's copy"}
        </button>
        <button type="button" data-tool-check onClick={() => void tool.check()} disabled={tool.busy} className={quiet}>
          Check for updates
        </button>
        <button type="button" onClick={() => void browse()} disabled={tool.busy} className={quiet}>
          <FolderOpen size={13} /> Use my own…
        </button>
        {s?.customPath && (
          <button type="button" onClick={() => void tool.setCustomPath(null)} disabled={tool.busy} className={quiet}>
            <X size={13} /> Stop using my own
          </button>
        )}
      </div>
    </div>
  );
}
