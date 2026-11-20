import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { FolderOpen, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { cn } from "@/lib/cn";
import { Btn, InfoTip, Note, Status } from "./settings/kit";
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

/** One command-line tool as a single row: name · version and source (dim,
 *  path on hover) · status dot · actions. `boxed` draws the list border for
 *  a row that stands alone; inside another list or row, leave it off. */
export function ToolRow({
  name,
  meta,
  metaTitle,
  help,
  status,
  actions,
  message,
  boxed,
  className,
  ...data
}: {
  name: string;
  /** "2.41.0 · found on PATH". Rendered dim after the name. */
  meta?: ReactNode;
  /** Hover text for the name and meta (the full path). */
  metaTitle?: string;
  help?: ReactNode;
  status: ReactNode;
  actions?: ReactNode;
  /** The last action's one-line result. */
  message?: ReactNode;
  boxed?: boolean;
  className?: string;
} & Record<`data-${string}`, string | undefined>) {
  return (
    <div {...data} className={cn(boxed && "rounded border border-border px-3 py-2", className)}>
      <div className="flex min-h-7 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
          <span className="min-w-0 truncate text-text" title={metaTitle}>
            {name}
            {meta && <span className="text-text-dim"> {meta}</span>}
          </span>
          {help && <InfoTip text={help} />}
        </div>
        <div className="shrink-0">{status}</div>
        {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
      </div>
      {message && (
        <div className="mt-1">
          <Note>{message}</Note>
        </div>
      )}
    </div>
  );
}

/** A Faro-managed tool's row: version and source, Install / Update, Check
 *  and Use my own. `compact` drops the outer border (inside another list). */
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
  /** Behind the (i) while the tool is missing. */
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
  const missing = s?.source === "missing";
  // The one action that changes something, only when there is a reason.
  const install = !s
    ? null
    : missing
      ? `Install ${name}`
      : s.updateAvailable
        ? s.source === "managed"
          ? `Update to ${s.latest}`
          : "Install Faro's copy"
        : null;

  const status = tool.busy ? (
    <Status tone="busy">Working</Status>
  ) : !s ? (
    <Status tone="busy">Checking</Status>
  ) : missing ? (
    <Status tone="off">Not installed</Status>
  ) : s.updateAvailable ? (
    <Status tone="warn">{s.latest} is available</Status>
  ) : s.latest ? (
    <Status tone="ok">Up to date</Status>
  ) : (
    <Status tone="ok">Installed</Status>
  );

  return (
    <ToolRow
      data-testid={testId}
      data-settings-focus={focusId}
      data-tool-source={s?.source}
      boxed={!compact}
      name={name}
      meta={s && !missing ? `${s.version ?? "unknown version"} · ${SOURCE_LABEL[s.source]}` : undefined}
      metaTitle={s?.path}
      help={missing ? missingText : undefined}
      status={status}
      message={s?.message}
      actions={
        <>
          {install && (
            <Btn size="sm" data-tool-install onClick={() => void tool.install()} disabled={tool.busy}>
              {install}
            </Btn>
          )}
          <Btn
            size="sm"
            variant="ghost"
            data-tool-check
            title="Check for updates"
            onClick={() => void tool.check()}
            disabled={tool.busy}
          >
            Check
          </Btn>
          {s?.customPath ? (
            <Btn
              size="sm"
              variant="ghost"
              aria-label="Stop using my own"
              title={`Stop using my own ${name}`}
              onClick={() => void tool.setCustomPath(null)}
              disabled={tool.busy}
              icon={<X size={13} />}
            />
          ) : (
            <Btn
              size="sm"
              variant="ghost"
              aria-label="Use my own…"
              title={`Use my own ${name}…`}
              onClick={() => void browse()}
              disabled={tool.busy}
              icon={<FolderOpen size={13} />}
            />
          )}
        </>
      }
    />
  );
}
