import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { toast } from "@/stores/toastStore";
import type { PathStatus } from "@/lib/types";
import { useCliUpdater } from "@/stores/cliUpdaterStore";
import type { CliUpdateMode } from "@/lib/types";
import { Btn, Group, Row, Segmented, Status, type Tone } from "./settings/kit";

const MODES: { value: CliUpdateMode; label: string }[] = [
  { value: "ask", label: "Ask me" },
  { value: "auto", label: "Automatic" },
  { value: "off", label: "Off" },
];

/// Settings → faro-cli (Plan 10 Phase 0c/0d). Shows whether the standalone
/// `faro-cli` is installed and current, lets the user update it, and persists the
/// ask / auto / off preference. `faro-cli` ships as a separate download from the
/// app, so it can lag after an app update — this is where drift is surfaced and
/// resolved.
export function CliUpdaterSettings() {
  const status = useCliUpdater((s) => s.status);
  const busy = useCliUpdater((s) => s.busy);
  const refresh = useCliUpdater((s) => s.refresh);
  const update = useCliUpdater((s) => s.update);
  const setMode = useCliUpdater((s) => s.setMode);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mode = status?.mode ?? "ask";
  const missing = status && !status.installed;
  const action = missing ? "Install faro-cli" : status?.stale ? "Update now" : null;

  return (
    <Group
      title="faro-cli"
      help="The command-line client. It ships separately from the app, so it can fall behind after an app update."
    >
      <Row
        label="Version"
        keywords="faro-cli install update version"
        help={missing ? "Install downloads the build that matches this app into Faro's data folder." : undefined}
        note={status?.message ?? undefined}
      >
        <span
          data-cli-status={!status ? "checking" : missing ? "missing" : status.stale ? "stale" : "current"}
          className="flex min-w-0 flex-1 items-center gap-3"
          title={status?.cliPath ?? undefined}
        >
          {status?.cliVersion && <span className="text-sm tabular-nums text-text">v{status.cliVersion}</span>}
          {busy ? (
            <Status tone="busy">Updating</Status>
          ) : !status ? (
            <Status tone="busy">Checking</Status>
          ) : missing ? (
            <Status tone="off">Not installed</Status>
          ) : status.stale ? (
            <Status tone="warn">Older than Faro v{status.appVersion}</Status>
          ) : (
            <Status tone="ok">Up to date</Status>
          )}
        </span>
        {action && (
          <Btn size="sm" onClick={() => void update()} disabled={busy}>
            {action}
          </Btn>
        )}
        <Btn size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy}>
          Check again
        </Btn>
      </Row>
      <Row
        label="When out of date"
        keywords="update automatic ask"
        help="Ask me: prompt when the CLI is older than the app. Automatic: update quietly at launch. Off: never check."
      >
        <Segmented
          label="When the CLI is out of date"
          value={mode}
          onChange={(v) => void setMode(v)}
          options={MODES}
          disabled={busy}
        />
      </Row>
      <CliPathRow />
    </Group>
  );
}

/// One-click "Add faro-cli to PATH" (Plan 16 Phase 4). Per-user only, so it never
/// needs admin. `faro-cli` ships as a separate binary from the app; once it's on
/// PATH it works in any terminal. On Windows this writes the per-user
/// `HKCU\Environment\Path` (new terminals pick it up immediately); on macOS/Linux
/// it symlinks into `~/.local/bin` and, if needed, adds one guarded line to the
/// shell profile.
export function CliPathRow() {
  const [status, setStatus] = useState<PathStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setStatus(await ipc.pathStatus());
    } catch (e) {
      toast.error(`Couldn't read PATH status: ${e}`);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const add = async () => {
    setBusy(true);
    try {
      const next = await ipc.pathAdd();
      setStatus(next);
      toast.success(next.detail ?? "Added faro-cli to your PATH.");
    } catch (e) {
      toast.error(`Add to PATH failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      const next = await ipc.pathRemove();
      setStatus(next);
      toast.success(next.detail ?? "Removed faro-cli from your PATH.");
    } catch (e) {
      toast.error(`Remove from PATH failed: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  // Prefer the managed flag for the primary action: right after an add, our
  // registry/symlink entry is present even though this already-running process's
  // own PATH won't reflect it until a new terminal (or app restart).
  const managed = status?.managed ?? false;
  const onPath = status?.onPath ?? false;
  const canInstallFirst = status ? !status.binHasCli && !onPath && !managed : false;

  const [tone, text, where]: [Tone, string, string | null | undefined] = !status
    ? ["busy", "Checking…", null]
    : managed
      ? ["ok", "On PATH (added by Faro)", status.binDir]
      : onPath
        ? ["ok", "On PATH", status.cliLocation]
        : canInstallFirst
          ? ["off", "Install faro-cli first", null]
          : ["off", "Not on PATH", status.binDir];

  return (
    <>
      <Row
        label="On PATH"
        help="Puts the faro-cli command on your PATH so it works in any terminal. Per-user only, no admin needed."
        keywords="faro-cli path terminal command line"
      >
        <span className="min-w-0 flex-1" title={where ?? undefined}>
          <Status tone={tone}>{text}</Status>
        </span>
        {managed ? (
          <Btn size="sm" onClick={() => void remove()} busy={busy}>
            Remove from PATH
          </Btn>
        ) : (
          <Btn size="sm" onClick={() => void add()} busy={busy} disabled={onPath || !status || canInstallFirst}>
            Add to PATH
          </Btn>
        )}
        <button
          type="button"
          onClick={() => void load()}
          disabled={busy}
          title="Refresh"
          aria-label="Refresh"
          className="flex h-6 w-6 items-center justify-center rounded text-text-dim hover:bg-bg-hover hover:text-text disabled:opacity-50"
        >
          <RefreshCw size={12} />
        </button>
      </Row>
    </>
  );
}
