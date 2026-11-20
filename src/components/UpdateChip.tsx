import { useEffect, useRef, useState } from "react";
import { ArrowUpCircle, Loader2, RotateCw, AlertTriangle } from "lucide-react";
import { useUpdater } from "@/stores/updaterStore";
import { useCliUpdater } from "@/stores/cliUpdaterStore";
import { nudgeId, useNudgeDismissed, useNudges } from "@/stores/nudgeStore";
import { openExternal } from "@/lib/openExternal";
import { cn } from "@/lib/cn";
import { Popover } from "./ui/Popover";
import { ReleaseNotesText } from "./DiscoveryDialog";
import { UpdateProgress } from "./UpdateProgress";
import { Btn } from "./settings/kit";

/**
 * Pending updates as one small chip in the title bar, next to Settings,
 * instead of a full-width bar above the status bar: it never takes a row,
 * never hides under toasts, and drops to an icon in a narrow window. The
 * popover holds the details and actions for the app update and, when the
 * installed faro-cli lags the app (mode "ask"), for the CLI too.
 */
export function UpdateChip() {
  const app = useUpdater();
  const cli = useCliUpdater();
  const [open, setOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);

  // The launch check (app) and the CLI drift check start here.
  useEffect(() => {
    let cleanups: (() => void)[] = [];
    let cancelled = false;
    for (const init of [useUpdater.getState().init, useCliUpdater.getState().init]) {
      void init().then((c) => {
        if (cancelled) c();
        else cleanups.push(c);
      });
    }
    return () => {
      cancelled = true;
      cleanups.forEach((c) => c());
      cleanups = [];
    };
  }, []);
  useEffect(() => setNotesOpen(false), [app.version]);

  // --- App update
  const failedAction = app.status === "error" && app.retryAction !== "check";
  const appShown =
    !app.dismissed &&
    (["available", "manual", "downloading", "verifying", "ready", "installing"].includes(app.status) || failedAction);
  const busy = ["downloading", "verifying", "installing"].includes(app.status);
  const pct = app.total ? Math.min(100, Math.round((app.downloaded / app.total) * 100)) : null;

  // --- CLI drift ("Not now" is remembered for this Faro version)
  const versionNudge = cli.status?.appVersion ? nudgeId("cli-update", cli.status.appVersion) : null;
  const versionDismissed = useNudgeDismissed(versionNudge);
  const cliShown =
    !cli.dismissed &&
    !versionDismissed &&
    cli.status?.installed === true &&
    cli.status.stale === true &&
    cli.status.mode === "ask";

  if (!appShown && !cliShown) return null;

  const chip: { label: string; title: string; icon: React.ReactNode; tone: "accent" | "fill" | "danger" | "muted" } =
    !appShown
      ? { label: "Update CLI", title: "A newer faro-cli is available", icon: <ArrowUpCircle size={12} />, tone: "accent" }
      : failedAction
        ? { label: "Update failed", title: app.error ?? "The update couldn't finish", icon: <AlertTriangle size={12} />, tone: "danger" }
        : app.status === "ready"
          ? { label: "Restart to update", title: `Faro ${app.version} is ready to install`, icon: <RotateCw size={12} />, tone: "fill" }
          : app.status === "downloading"
            ? { label: pct === null ? "Downloading…" : `Updating ${pct}%`, title: `Downloading Faro ${app.version}`, icon: <Loader2 size={12} className="animate-spin" />, tone: "muted" }
            : busy
              ? { label: app.status === "verifying" ? "Verifying…" : "Installing…", title: `Faro ${app.version}`, icon: <Loader2 size={12} className="animate-spin" />, tone: "muted" }
              : { label: "Update", title: `Faro ${app.version} is available`, icon: <ArrowUpCircle size={12} />, tone: "accent" };

  const appMessage =
    app.status === "manual" ? `Faro ${app.version} is a manual download.`
    : app.status === "available" ? `Faro ${app.version} is available.`
    : app.status === "ready" ? `Faro ${app.version} is ready. Save your work before restarting.`
    : app.status === "downloading" ? `Downloading Faro ${app.version}…`
    : app.status === "verifying" ? "Verifying the download…"
    : app.status === "installing" ? "Installing and restarting Faro…"
    : app.error ?? "The update couldn't finish.";
  const appAction = failedAction ? app.retry
    : app.status === "manual" ? () => openExternal(app.releaseUrl)
    : app.status === "ready" ? app.restart
    : app.download;
  const appLabel = failedAction ? "Try again"
    : app.status === "manual" ? "Open Downloads"
    : app.status === "ready" ? "Install & restart"
    : "Download update";

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={chip.title}
        data-update-chip={appShown ? app.status : "cli"}
        className={cn(
          "flex h-6 shrink-0 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors",
          chip.tone === "fill" && "btn-accent text-white",
          chip.tone === "accent" && "text-accent hover:bg-bg-hover",
          chip.tone === "danger" && "text-danger hover:bg-bg-hover",
          chip.tone === "muted" && "text-text-muted hover:bg-bg-hover",
          open && chip.tone !== "fill" && "bg-bg-hover"
        )}
      >
        {chip.icon}
        {/* A narrow window keeps the icon only. */}
        <span className="max-sm:hidden">{chip.label}</span>
      </button>
      <Popover
        open={open}
        anchorRef={anchor}
        placement="bottom-end"
        layer="dropdown"
        onClose={() => setOpen(false)}
        role="dialog"
        aria-label="Updates"
        className="w-80 max-w-[calc(100vw-1rem)] divide-y divide-border p-0"
      >
        {appShown && (
          <div className="space-y-2.5 p-3">
            <p role="status" className={cn("text-sm", failedAction ? "text-danger" : "text-text")}>
              {appMessage}
            </p>
            {app.status === "downloading" && <UpdateProgress downloaded={app.downloaded} total={app.total} />}
            {notesOpen && (
              <section aria-label="Update release notes" className="max-h-56 overflow-y-auto text-sm">
                <ReleaseNotesText notes={app.notes} />
                <button onClick={() => openExternal(app.releaseUrl)} className="mt-2 text-xs text-accent hover:underline">
                  Full release notes
                </button>
              </section>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
              {!busy && (
                <Btn size="sm" variant="primary" onClick={() => void appAction()}>
                  {appLabel}
                </Btn>
              )}
              <Btn size="sm" variant="ghost" aria-expanded={notesOpen} onClick={() => setNotesOpen((v) => !v)}>
                What's new
              </Btn>
              {app.status !== "installing" && (
                <Btn
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  aria-label="Dismiss update notification"
                  onClick={() => {
                    app.dismiss();
                    if (!cliShown) setOpen(false);
                  }}
                >
                  Not now
                </Btn>
              )}
            </div>
          </div>
        )}
        {cliShown && cli.status && (
          <div className="space-y-2.5 p-3">
            <p className="text-sm text-text">
              faro-cli v{cli.status.cliVersion} is older than Faro v{cli.status.appVersion}.
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Btn size="sm" variant={appShown ? "default" : "primary"} busy={cli.busy} onClick={() => void cli.update()}>
                {cli.busy ? "Updating…" : "Update faro-cli"}
              </Btn>
              <Btn size="sm" variant="ghost" disabled={cli.busy} onClick={() => void cli.setMode("auto")}>
                Always automatic
              </Btn>
              <Btn
                size="sm"
                variant="ghost"
                className="ml-auto"
                disabled={cli.busy}
                onClick={() => {
                  cli.dismiss();
                  if (versionNudge) useNudges.getState().dismiss(versionNudge);
                  if (!appShown) setOpen(false);
                }}
              >
                Not now
              </Btn>
            </div>
          </div>
        )}
      </Popover>
    </>
  );
}
