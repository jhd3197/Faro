import { useRef } from "react";
import { create } from "zustand";
import {
  AlertTriangle,
  BookOpen,
  Check,
  Circle,
  Cloud,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  X,
} from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { cn } from "@/lib/cn";
import { ipc } from "@/lib/ipc";
import { messageOf } from "@/lib/errors";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { toast } from "@/stores/toastStore";
import type { ConnectionProfile, HostDecision, HostPromptEvent } from "@/lib/types";
import { AllowFromRefusal } from "./CloudflareServerLogin";

// Issue #86: a `faro://connect` / `faro://site` link through Cloudflare goes
// from click to files in one pass. The sheet asks once (a link never connects
// on its own), then gets cloudflared, signs in to Access, checks the server's
// key the first time, and connects. It stops only where the person is needed.

export const ACCESS_SSH_GUIDE = "https://github.com/jhd3197/faro/blob/main/docs/cloudflare-access-ssh.md";

type StepId = "cloudflared" | "signin" | "server" | "open";
type StepState = "todo" | "active" | "waiting" | "done" | "failed";
interface Step {
  state: StepState;
  detail?: string;
}

const LABEL: Record<StepId, string> = {
  cloudflared: "cloudflared",
  signin: "Sign in to Cloudflare",
  server: "Check the server",
  open: "Open files",
};

const FRESH: Record<StepId, Step> = {
  cloudflared: { state: "todo" },
  signin: { state: "todo" },
  server: { state: "todo" },
  open: { state: "todo" },
};

interface CfConnectState {
  profile: ConnectionProfile | null;
  /** Already in the connection list (a matched link), so nothing to save. */
  saved: boolean;
  phase: "ready" | "running" | "done" | "failed" | "refused";
  steps: Record<StepId, Step>;
  /** The first-time host-key question, answered in the sheet. */
  hostPrompt: HostPromptEvent | null;
  /** After a refusal: the name on the certificate (e.g. jane.doe). */
  principal: string | null;
  /** Bumped by Cancel, so a running pass ignores what it gets back. */
  run: number;
  /** After it connects (a `site` link opens its folder). */
  onDone?: () => void;
  start: (profile: ConnectionProfile, opts: { saved: boolean; onDone?: () => void }) => void;
  connect: () => Promise<void>;
  close: () => void;
  /** HostKeyModal offers each prompt here first; true = the sheet shows it. */
  takeHostPrompt: (e: HostPromptEvent) => boolean;
  answerHost: (d: HostDecision) => Promise<void>;
}

export const useCfConnect = create<CfConnectState>((set, get) => {
  const step = (id: StepId, s: Step) => set((st) => ({ steps: { ...st.steps, [id]: s } }));
  return {
    profile: null,
    saved: false,
    phase: "ready",
    steps: FRESH,
    hostPrompt: null,
    principal: null,
    run: 0,
    start: (profile, { saved, onDone }) =>
      set({ profile, saved, onDone, phase: "ready", steps: FRESH, hostPrompt: null, principal: null }),
    close: () => {
      const { hostPrompt } = get();
      if (hostPrompt) void ipc.respondToHostPrompt(hostPrompt.requestId, "reject").catch(() => {});
      set((st) => ({ profile: null, hostPrompt: null, run: st.run + 1 }));
    },
    takeHostPrompt: (e) => {
      const { profile, steps } = get();
      // Only a first-time SSH key during this sheet's connect. A changed key
      // keeps the full warning dialog.
      if (!profile || steps.server.state !== "active" || e.kind === "mismatch" || e.tlsReason) return false;
      set({ hostPrompt: e });
      step("server", { state: "waiting", detail: "First time connecting — confirm it's the right server." });
      return true;
    },
    answerHost: async (d) => {
      const { hostPrompt } = get();
      if (!hostPrompt) return;
      set({ hostPrompt: null });
      step("server", d === "reject" ? { state: "failed", detail: "Not trusted" } : { state: "active", detail: "Trusted" });
      await ipc.respondToHostPrompt(hostPrompt.requestId, d).catch(() => {});
    },
    connect: async () => {
      const { profile, saved } = get();
      if (!profile) return;
      const run = get().run;
      const live = () => get().run === run && !!get().profile;
      set({ phase: "running", steps: FRESH });
      const access = profile.proxyCommand?.hostname?.trim() || profile.host;

      // 1. cloudflared, installed without a separate prompt.
      step("cloudflared", { state: "active", detail: "Checking…" });
      try {
        let s = await ipc.cloudflaredStatus();
        if (s.source === "missing") {
          if (!live()) return;
          step("cloudflared", { state: "active", detail: "Installing…" });
          s = await ipc.cloudflaredInstall();
        }
        if (!live()) return;
        step("cloudflared", { state: "done", detail: s.version ? `Ready (${s.version})` : "Ready" });
      } catch (e) {
        if (!live()) return;
        step("cloudflared", { state: "failed", detail: `Couldn't install cloudflared: ${messageOf(e)}` });
        set({ phase: "failed" });
        return;
      }

      // 2. The Access sign-in, in the browser when it's needed.
      step("signin", { state: "active", detail: "Checking…" });
      try {
        let s = await ipc.cfAccessStatus(access);
        if (s.state !== "loggedIn" && s.state !== "notProtected") {
          if (!live()) return;
          step("signin", { state: "active", detail: "Finish in the browser tab that just opened." });
          s = await ipc.cfAccessLogin(access);
        }
        if (!live()) return;
        step("signin", {
          state: "done",
          detail: s.state === "notProtected" ? "No sign-in needed" : s.identity ? `Signed in as ${s.identity}` : "Signed in",
        });
      } catch (e) {
        if (!live()) return;
        step("signin", { state: "failed", detail: messageOf(e) });
        set({ phase: "failed" });
        return;
      }

      // 3–4. Save it (a new link), then connect: the host key, then files.
      const conns = useConnections.getState();
      try {
        if (!saved) {
          await conns.saveProfile(profile);
          set({ saved: true });
        }
        if (!live()) return;
        step("server", { state: "active", detail: "Connecting…" });
        await conns.connect(profile.id);
        if (!live()) return;
        step("server", { state: "done", detail: "Trusted" });
        step("open", { state: "done" });
        set({ phase: "done" });
        const onDone = get().onDone;
        setTimeout(() => {
          if (get().run === run) set((st) => ({ profile: null, run: st.run + 1 }));
          onDone?.();
        }, 500);
      } catch (e) {
        if (!live()) return;
        if (get().steps.server.state === "failed") {
          set({ phase: "failed" });
          return;
        }
        const message = messageOf(e);
        const refused = /cloudflare issued a certificate|refused the cloudflare certificate/i.test(message);
        step("server", { state: "done", detail: "Trusted" });
        // The name on the certificate, from ssh_cert's refusal, else the
        // signed-in email's user part (cloudflared names it that way).
        const signedIn = /Signed in as ([^@\s]+)@/.exec(get().steps.signin.detail ?? "")?.[1];
        const principal = /certificate for `([^`]+)`/.exec(message)?.[1] ?? signedIn ?? null;
        step("open", {
          state: "failed",
          detail: refused ? `The server didn't accept your Cloudflare sign-in for ${profile.username}.` : message,
        });
        set({ phase: refused ? "refused" : "failed", principal: refused ? principal : null });
      }
    },
  };
});

export function CloudflareConnectSheet() {
  const { profile, saved, phase, steps, hostPrompt, principal, connect, close, answerHost } = useCfConnect();
  const panelRef = useRef<HTMLDivElement>(null);
  useDialog(panelRef, { onClose: close });
  if (!profile) return null;

  const editDetails = () => {
    close();
    if (saved) useLayout.getState().openEditProfile(profile.id);
    else {
      const { id: _id, ...rest } = profile;
      useLayout.getState().openNewConnection(rest);
    }
  };
  const who = principal ?? "my Cloudflare login";
  const adminNote =
    `Faro couldn't log in to ${profile.host} as ${profile.username} with my Cloudflare Access certificate` +
    (principal ? ` (it's for ${principal})` : "") +
    `. Could you allow ${who} to log in as ${profile.username} on that server? How: ${ACCESS_SSH_GUIDE}`;

  const title =
    phase === "ready"
      ? `Connect to ${profile.name}`
      : phase === "done"
        ? `Connected to ${profile.name}`
        : `Connecting to ${profile.name}`;
  const btn = "rounded-md border border-border bg-bg-panel px-3 py-1.5 text-xs font-medium hover:bg-bg-hover";

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="cf-connect"
        className="anim-modal w-[30rem] max-w-[92vw] overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        <div className="flex items-center gap-2.5 border-b border-border bg-bg-subtle px-4 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-soft text-accent">
            <Cloud size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold">{title}</div>
            <div className="truncate font-mono text-[11px] text-text-dim">
              {profile.username}@{profile.host}
            </div>
          </div>
          <button onClick={close} className="rounded-md p-1 text-text-muted hover:bg-bg-hover hover:text-text" title="Cancel">
            <X size={13} />
          </button>
        </div>

        <ol className="px-4 pb-1 pt-3">
          {(Object.keys(LABEL) as StepId[]).map((id) => {
            const s = steps[id];
            return (
              <li key={id} className="flex gap-2.5 pb-3" data-step={id} data-state={s.state}>
                <StepIcon state={s.state} />
                <div className="min-w-0 flex-1">
                  <div
                    className={cn(
                      "text-[12.5px] font-medium",
                      s.state === "todo" && "text-text-dim",
                      s.state === "failed" && "text-danger"
                    )}
                  >
                    {LABEL[id]}
                  </div>
                  {s.detail && <div className="select-text break-words text-[11.5px] text-text-muted">{s.detail}</div>}
                </div>
              </li>
            );
          })}
        </ol>

        {hostPrompt && (
          <div className="px-4 pb-4">
            <div className="flex items-center gap-2 rounded-md border border-border bg-bg-subtle px-2.5 py-2">
              <KeyRound size={13} className="text-accent" />
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-medium uppercase tracking-wider text-text-dim">
                  {hostPrompt.host} · {hostPrompt.keyType}
                </div>
                <div className="selectable truncate font-mono text-[11px]" title={hostPrompt.fingerprint}>
                  {hostPrompt.fingerprint}
                </div>
              </div>
            </div>
            <p className="mt-2 text-[11.5px] text-text-muted">
              Faro remembers this key, so you won't see this again for this server.
            </p>
          </div>
        )}

        {phase === "refused" && (
          <div className="px-4 pb-4">
            <div className="rounded-md border border-border bg-bg-subtle px-3 py-2.5 text-[11.5px] leading-relaxed text-text-muted">
              <div className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-text">
                <AlertTriangle size={13} className="text-warning" />
                Ask the server's admin to let you in
              </div>
              The server only lets listed people log in as{" "}
              <span className="font-mono text-text">{profile.username}</span>. Its admin can add{" "}
              {principal ? <span className="font-mono text-text">{principal}</span> : "you"} to that list. Or, to manage
              access only in Cloudflare, they can let anyone your Access policy allows log in.
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() =>
                    navigator.clipboard
                      .writeText(adminNote)
                      .then(() => toast.success("Note copied", "Send it to the server's admin.", undefined, { log: false }))
                      .catch(() => {})
                  }
                  className="inline-flex items-center gap-1 rounded border border-border bg-bg-panel px-2 py-1 text-[11px] text-text hover:bg-bg-hover"
                >
                  <Copy size={11} />
                  Copy note for your admin
                </button>
                <button
                  type="button"
                  onClick={() => void ipc.openExternalUrl(ACCESS_SSH_GUIDE).catch(() => {})}
                  className="inline-flex items-center gap-1 rounded border border-border bg-bg-panel px-2 py-1 text-[11px] text-text hover:bg-bg-hover"
                >
                  <BookOpen size={11} />
                  Server setup guide
                  <ExternalLink size={10} className="text-text-dim" />
                </button>
              </div>
              {/* You're the admin (another login to this server is saved): fix it here. */}
              <AllowFromRefusal profile={profile} principal={principal} onAllowed={() => void connect()} />
            </div>
          </div>
        )}

        <div className="flex items-center gap-2 border-t border-border bg-bg-subtle px-4 py-3">
          <button type="button" onClick={editDetails} className="text-[11.5px] text-text-muted hover:text-text">
            {phase === "refused" ? "Use a key or password instead" : "Edit details"}
          </button>
          <div className="flex-1" />
          {hostPrompt ? (
            <>
              <button onClick={() => void answerHost("reject")} className={btn}>
                Cancel
              </button>
              <button
                onClick={() => void answerHost("trust")}
                className="btn-accent rounded-md px-3 py-1.5 text-xs font-medium text-white"
              >
                Trust &amp; connect
              </button>
            </>
          ) : (
            <>
              <button onClick={close} className={btn}>
                {phase === "refused" || phase === "failed" ? "Close" : "Cancel"}
              </button>
              {(phase === "ready" || phase === "refused" || phase === "failed") && (
                <button
                  onClick={() => void connect()}
                  className="btn-accent rounded-md px-3 py-1.5 text-xs font-medium text-white"
                >
                  {phase === "ready" ? "Connect" : "Try again"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/// Under a check that failed on a refused Cloudflare certificate: the guide
/// for the server change.
export function AccessGuideLink({ detail }: { detail: string }) {
  if (!/didn't accept your Cloudflare sign-in/.test(detail)) return null;
  return (
    <button
      type="button"
      onClick={() => void ipc.openExternalUrl(ACCESS_SSH_GUIDE).catch(() => {})}
      className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
    >
      <BookOpen size={11} />
      Server setup guide
    </button>
  );
}

function StepIcon({ state }: { state: StepState }) {
  const dot = "flex h-4 w-4 items-center justify-center rounded-full";
  return (
    <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
      {state === "done" ? (
        <span className={cn(dot, "bg-success/20 text-success")}>
          <Check size={10} strokeWidth={3} />
        </span>
      ) : state === "failed" ? (
        <span className={cn(dot, "bg-danger/20 text-danger")}>
          <X size={10} strokeWidth={3} />
        </span>
      ) : state === "active" ? (
        <Loader2 size={15} className="animate-spin text-accent" />
      ) : state === "waiting" ? (
        <span className={cn(dot, "border-2 border-accent")}>
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
      ) : (
        <Circle size={15} className="text-text-dim/50" />
      )}
    </span>
  );
}
