import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { openExternal } from "@/lib/openExternal";
import { toast } from "@/stores/toastStore";
import { useSettings } from "@/stores/settingsStore";
import { useLayout } from "@/stores/layoutStore";
import { SETTINGS_ENTRY_POINTS } from "@/lib/settingsNav";
import { useUpdater } from "@/stores/updaterStore";
import { ReleaseNotesText } from "./DiscoveryDialog";
import { releaseChanges } from "@/lib/releaseNotes";
import { useTips } from "@/stores/tipsStore";
import { UpdateProgress } from "./UpdateProgress";
import type { PathStatus } from "@/lib/types";
import { getVersion } from "@tauri-apps/api/app";
import { Advanced, Btn, CheckRow, Group, Note, Row, Status, type Tone } from "./settings/kit";

/// Settings → About. The app's version and updates, desktop notifications,
/// tips, and the one-click "Add faro-cli to PATH" row (Plan 16).
export function AboutSettings() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await getVersion();
        if (!cancelled) setVersion(v);
      } catch {
        /* not in a Tauri context (mock/browser) — just omit the version */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <Group title="Faro" help="A client for SFTP, FTP, S3 and Azure, plus the Agent Bridge.">
        <Row label="Version" keywords="about version">
          <span className="text-sm tabular-nums text-text">{version ?? "Unknown"}</span>
        </Row>
        <UpdaterRows />
      </Group>

      <Group title="Help">
        <TipsRows />
      </Group>

      <NotificationsGroup />

      <PathGroup />
    </>
  );
}

/// In-app updater (Plan 16 Phase 1/2). Manual "Check for updates", the current
/// status, and the download → restart flow. The launch check + the prompt bar
/// live in UpdatePrompt; this is the on-demand surface.
function UpdaterRows() {
  const { status, version, downloaded, total, error, errorDetail, releaseUrl,
    notes, lastChecked, retryAction, check, download, restart, retry } = useUpdater();
  const busy = ["checking", "downloading", "verifying", "installing"].includes(status);
  const title = status === "current" ? "You're on the latest version."
    : status === "available" || status === "manual" ? `Faro ${version} is available.`
    : status === "checking" ? "Checking for updates…"
    : status === "downloading" ? `Downloading Faro ${version}…`
    : status === "verifying" ? "Verifying update…"
    : status === "ready" ? `Faro ${version} is ready to install.`
    : status === "installing" ? "Installing and restarting Faro…"
    : status === "error" ? retryAction === "check" ? "Couldn't check for updates" : "Update couldn't finish"
    : "Not checked yet";
  const tone: Tone = busy ? "busy"
    : status === "current" ? "ok"
    : status === "error" ? "bad"
    : status === "available" || status === "manual" || status === "ready" ? "warn"
    : "off";
  const help = status === "manual" ? "This update needs a manual download. Open Downloads to get the installer."
    : status === "available" ? "Download while you work. Install and restart when you're ready."
    : status === "ready" ? "The download is verified. Finish your transfers and save your work before restarting."
    : status === "verifying" ? "Checking the download's signature before installing."
    : undefined;
  const note = status === "error" ? <Note tone="danger">{error}</Note>
    : status === "ready" ? "Save your work before restarting."
    : lastChecked && !busy ? `Last checked ${new Date(lastChecked).toLocaleString()}`
    : undefined;
  const action = status === "available" ? download : status === "ready" ? restart
    : status === "manual" ? () => openExternal(releaseUrl)
    : status === "error" ? retry : () => check(false);
  const label = status === "available" ? "Download update" : status === "ready" ? "Install & restart"
    : status === "manual" ? "Open Downloads"
    : status === "error" ? retryAction === "download" ? "Retry download" : "Try again"
    : "Check for updates";
  const primary = ["available", "manual", "ready"].includes(status);
  const showNotes = !!releaseChanges(notes) && ["available", "manual", "ready"].includes(status);

  return (
    <>
      <Row label="Updates" help={help} note={note} keywords="update upgrade check release">
        <span role="status" aria-live="polite" className="min-w-0">
          <Status tone={tone}>{title}</Status>
        </span>
      </Row>
      {status === "downloading" && (
        <Row label="">
          <div className="w-full">
            <UpdateProgress downloaded={downloaded} total={total} />
          </div>
        </Row>
      )}
      {!busy && (
        <Row label="">
          <Btn variant={primary ? "primary" : "default"} onClick={() => void action()}>
            {label}
          </Btn>
          {status !== "manual" && (
            <Btn variant="ghost" onClick={() => openExternal(releaseUrl)}>
              {status === "error" ? "Open Downloads" : "Release notes"}
            </Btn>
          )}
          {status === "manual" && (
            <Btn variant="ghost" onClick={() => void check(false)}>
              Check again
            </Btn>
          )}
        </Row>
      )}
      {showNotes && (
        <Row label="What's new">
          <section aria-label="Release notes" className="max-h-52 w-full overflow-auto text-sm">
            <ReleaseNotesText notes={notes} />
          </section>
        </Row>
      )}
      {errorDetail && (
        <Row label="">
          <div className="w-full">
            <Advanced title="Technical details">
              <p className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text-muted">
                {errorDetail}
              </p>
            </Advanced>
          </div>
        </Row>
      )}
    </>
  );
}

/// Desktop-notification toggles (Plan 16 Phase 3). OS toasts for a curated set of
/// events (transfer batch done/failed, folder-sync error, edit-in-place save
/// failure). Off-window by default so they don't double up with in-app toasts.
function NotificationsGroup() {
  const notifications = useSettings((s) => s.notifications);
  const setNotifications = useSettings((s) => s.setNotifications);

  return (
    <Group title="Notifications">
      <CheckRow
        label="Desktop notifications"
        keywords="notifications toasts os"
        help="OS toasts for finished transfers, folder-sync errors and failed edit-in-place saves, so you see them while Faro is in the background."
        checked={notifications.enabled}
        onChange={(v) => setNotifications({ ...notifications, enabled: v })}
      />
      {/* Only matters while notifications are on: indented under it. */}
      <div data-settings-dependent={notifications.enabled ? "on" : "off"}>
        <CheckRow
          indent
          label="Only when Faro isn't focused"
          help="Skip OS toasts while the window is in front. In-app toasts already cover it."
          checked={notifications.unfocusedOnly}
          disabled={!notifications.enabled}
          disabledReason="Turn on desktop notifications first."
          onChange={(v) => setNotifications({ ...notifications, unfocusedOnly: v })}
        />
      </div>
    </Group>
  );
}

/** Tips are one-time pointers in the real UI; bring them back or switch them off. */
function TipsRows() {
  const enabled = useTips((s) => s.enabled);
  useEffect(() => { void useTips.getState().init(); }, []);
  return (
    <>
      <CheckRow
        label="Show tips"
        keywords="tips hints onboarding"
        checked={enabled}
        onChange={(v) => useTips.getState().setEnabled(v)}
      />
      <Row label="" keywords="welcome tips what's new">
        <Btn variant="ghost" className="-ml-3" onClick={() => useLayout.getState().openDialog("welcome")}>Show welcome</Btn>
        <Btn variant="ghost" onClick={() => useLayout.getState().openDialog("whatsNew")}>What's new</Btn>
        <Btn variant="ghost" onClick={() => useTips.getState().reset()}>Reset tips</Btn>
      </Row>
    </>
  );
}

/// One-click "Add faro-cli to PATH" (Plan 16 Phase 4). Per-user only, so it never
/// needs admin. `faro-cli` ships as a separate binary from the app; once it's on
/// PATH it works in any terminal. On Windows this writes the per-user
/// `HKCU\Environment\Path` (new terminals pick it up immediately); on macOS/Linux
/// it symlinks into `~/.local/bin` and, if needed, adds one guarded line to the
/// shell profile.
function PathGroup() {
  const openSettings = useLayout((s) => s.openSettings);
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
      ? ["ok", "faro-cli is on your PATH (managed by Faro).", status.binDir]
      : onPath
        ? ["ok", "faro-cli is already on your PATH.", status.cliLocation]
        : canInstallFirst
          ? ["off", "faro-cli isn't installed yet.", null]
          : ["off", "faro-cli isn't on your PATH.", status.binDir];

  return (
    <Group
      title="faro-cli on PATH"
      help="Puts the faro-cli command on your PATH so it works in any terminal. Per-user only, no admin needed."
    >
      <Row label="Status" keywords="faro-cli path terminal command line">
        <span className="min-w-0" title={where ?? undefined}>
          <Status tone={tone}>{text}</Status>
        </span>
      </Row>
      <Row label="">
        {canInstallFirst ? (
          <Btn
            data-settings-link="aboutCliInstall"
            onClick={() => openSettings(SETTINGS_ENTRY_POINTS.aboutCliInstall)}
          >
            Install faro-cli…
          </Btn>
        ) : managed ? (
          <Btn onClick={() => void remove()} busy={busy}>
            Remove from PATH
          </Btn>
        ) : (
          <Btn onClick={() => void add()} busy={busy} disabled={onPath || !status}>
            Add to PATH
          </Btn>
        )}
        <Btn variant="ghost" onClick={() => void load()} disabled={busy}>
          Refresh
        </Btn>
      </Row>
    </Group>
  );
}
