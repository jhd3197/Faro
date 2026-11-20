import { useEffect } from "react";
import { useCliUpdater } from "@/stores/cliUpdaterStore";
import type { CliUpdateMode } from "@/lib/types";
import { Btn, Row, Segmented, Status } from "./settings/kit";
import { ToolRow } from "./ManagedToolCard";

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
    <div className="flex flex-col gap-3">
      <ToolRow
        boxed
        data-cli-status={!status ? "checking" : missing ? "missing" : status.stale ? "stale" : "current"}
        name="faro-cli"
        meta={status?.cliVersion ? `v${status.cliVersion}` : undefined}
        metaTitle={status?.cliPath ?? undefined}
        help={
          missing
            ? "Not found on your PATH. Install downloads the build that matches this app into Faro's data folder."
            : "The command-line client ships separately from the app, so it can fall behind after an app update."
        }
        status={
          busy ? (
            <Status tone="busy">Updating</Status>
          ) : !status ? (
            <Status tone="busy">Checking</Status>
          ) : missing ? (
            <Status tone="off">Not installed</Status>
          ) : status.stale ? (
            <Status tone="warn">Older than Faro v{status.appVersion}</Status>
          ) : (
            <Status tone="ok">Up to date</Status>
          )
        }
        message={status?.message ?? undefined}
        actions={
          <>
            {action && (
              <Btn size="sm" onClick={() => void update()} disabled={busy}>
                {action}
              </Btn>
            )}
            <Btn size="sm" variant="ghost" onClick={() => void refresh()} disabled={busy}>
              Check again
            </Btn>
          </>
        }
      />

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
    </div>
  );
}
