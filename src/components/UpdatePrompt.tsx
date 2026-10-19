import { useEffect } from "react";
import { ArrowUpCircle, X, Loader2 } from "lucide-react";
import { useUpdater } from "@/stores/updaterStore";
import { openExternal } from "@/lib/openExternal";
import { UpdateProgress } from "./UpdateProgress";

/** Nonblocking launch prompt. Downloads never close Faro; installation is explicit. */
export function UpdatePrompt() {
  const { status, version, downloaded, total, dismissed, error, retryAction,
    releaseUrl, download, restart, retry, dismiss } = useUpdater();

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    void useUpdater.getState().init().then((c) => {
      if (cancelled) c();
      else cleanup = c;
    });
    return () => { cancelled = true; cleanup?.(); };
  }, []);

  const failedAction = status === "error" && retryAction !== "check";
  if (dismissed || !(["available", "manual", "downloading", "verifying", "ready", "installing"].includes(status) || failedAction)) return null;
  const busy = ["downloading", "verifying", "installing"].includes(status);
  const message = status === "manual" ? `Faro ${version} is available as a manual download.`
    : status === "available" ? `Faro ${version} is available.`
    : status === "ready" ? `Faro ${version} is ready. Save your work before restarting.`
    : status === "downloading" ? "Downloading update…"
    : status === "verifying" ? "Verifying update…"
    : status === "installing" ? "Installing and restarting Faro…" : error;
  const action = failedAction ? retry : status === "manual" ? () => openExternal(releaseUrl)
    : status === "ready" ? restart : download;
  const label = failedAction ? "Try again" : status === "manual" ? "Open Downloads"
    : status === "ready" ? "Install & restart" : "Download update";

  return (
    <div className="flex items-center gap-3 border-t border-accent/40 bg-accent/10 px-4 py-2 text-sm">
      {busy ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-accent" />
        : <ArrowUpCircle className="h-4 w-4 shrink-0 text-accent" />}
      <span role="status" className="min-w-0 flex-1 text-text">{message}</span>
      {status === "downloading" && <div className="w-1/3"><UpdateProgress downloaded={downloaded} total={total} /></div>}
      {!busy && <button onClick={() => void action()}
        className="shrink-0 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/90 active:scale-[0.98]">
        {label}
      </button>}
      {status !== "installing" && <button onClick={dismiss} title="Not now" aria-label="Dismiss update notification"
        className="shrink-0 rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text">
        <X className="h-4 w-4" />
      </button>}
    </div>
  );
}
