import { useEffect, useState } from "react";
import { openExternal } from "@/lib/openExternal";
import { DISCORD_URL, issueUrl, systemInfo } from "@/lib/feedback";
import { useSettings } from "@/stores/settingsStore";
import { useLayout } from "@/stores/layoutStore";
import { useUpdater } from "@/stores/updaterStore";
import { ReleaseNotesText } from "./DiscoveryDialog";
import { releaseChanges } from "@/lib/releaseNotes";
import { useTips } from "@/stores/tipsStore";
import { UpdateProgress } from "./UpdateProgress";
import { getVersion } from "@tauri-apps/api/app";
import { Advanced, Btn, CheckRow, Group, Note, Row, Status, type Tone } from "./settings/kit";

/// Settings → About. The app's version and updates, desktop notifications,
/// and tips (Plan 16). faro-cli's PATH row lives under Command line.
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

      <FeedbackGroup />

      <NotificationsGroup />

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
        <span role="status" aria-live="polite" className="min-w-0 flex-1">
          <Status tone={tone}>{title}</Status>
        </span>
        {!busy && (
          <>
            <Btn size="sm" variant={primary ? "primary" : "default"} onClick={() => void action()}>
              {label}
            </Btn>
            {status !== "manual" && (
              <Btn size="sm" variant="ghost" onClick={() => openExternal(releaseUrl)}>
                {status === "error" ? "Open Downloads" : "Release notes"}
              </Btn>
            )}
            {status === "manual" && (
              <Btn size="sm" variant="ghost" onClick={() => void check(false)}>
                Check again
              </Btn>
            )}
          </>
        )}
      </Row>
      {status === "downloading" && (
        <Row label="">
          <div className="w-full">
            <UpdateProgress downloaded={downloaded} total={total} />
          </div>
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
        group="Desktop"
        label="Show notifications"
        keywords="desktop notifications toasts os"
        help="OS toasts for finished transfers, folder-sync errors and failed edit-in-place saves, so you see them while Faro is in the background."
        checked={notifications.enabled}
        onChange={(v) => setNotifications({ ...notifications, enabled: v })}
      />
      {/* Only matters while notifications are on: indented under it. */}
      <div data-settings-dependent={notifications.enabled ? "on" : "off"}>
        <CheckRow
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
        group="Tips"
        label="Show tips"
        help="One-time pointers in the app. Reset brings back the ones you dismissed."
        keywords="tips hints onboarding"
        checked={enabled}
        onChange={(v) => useTips.getState().setEnabled(v)}
      />
      <Row label="Guides" keywords="welcome tips what's new reset">
        <Btn size="sm" onClick={() => useLayout.getState().openDialog("welcome")}>Welcome</Btn>
        <Btn size="sm" onClick={() => useLayout.getState().openDialog("whatsNew")}>What's new</Btn>
        <Btn size="sm" variant="ghost" onClick={() => useTips.getState().reset()}>Reset tips</Btn>
      </Row>
    </>
  );
}

/** Feedback goes to GitHub or Discord in the browser. Faro sends nothing on
 *  its own: the issue opens prefilled and the user reviews it there. */
function FeedbackGroup() {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(await systemInfo());
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <Group
      title="Feedback"
      help="Opens GitHub with a short template and your Faro version, OS and WebView filled in. You review it before anything is sent. No hosts, paths or passwords are included."
    >
      <Row label="Something broke" keywords="report bug issue problem crash feedback">
        <Btn size="sm" data-feedback="bug" onClick={() => void issueUrl("bug").then(openExternal)}>
          Report a bug
        </Btn>
        <Btn size="sm" variant="ghost" data-feedback="copy-info" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy system info"}
        </Btn>
      </Row>
      <Row label="An idea" keywords="feature request suggestion enhancement feedback">
        <Btn size="sm" data-feedback="idea" onClick={() => void issueUrl("idea").then(openExternal)}>
          Suggest a feature
        </Btn>
      </Row>
      <Row label="Community" keywords="discord chat help support">
        <Btn size="sm" data-feedback="discord" onClick={() => openExternal(DISCORD_URL)}>
          Discord
        </Btn>
      </Row>
    </Group>
  );
}
