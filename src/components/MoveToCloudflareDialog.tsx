import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Cloud,
  Loader2,
  CheckCircle2,
  Circle,
  Copy,
  AlertTriangle,
  Undo2,
  Settings as SettingsIcon,
  Plug,
} from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { useDialog } from "@/hooks/useDialog";
import { toast } from "@/stores/toastStore";
import { toastError, messageOf } from "@/lib/errors";
import { useCloudflareAccount, TunnelHealth } from "./CloudflareAccount";
import type { CfSetupState, CfZone, ConnectionProfile, RootRun } from "@/lib/types";
import { cn } from "@/lib/cn";

interface Props {
  profileId: string;
  onClose: () => void;
}

const SETUP_OK = "FARO_SETUP_OK";

/** `web-1` from "Web 1 (prod)". */
function labelFrom(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\(.*?\)/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "server"
  );
}

type Step = "form" | "cloudflare" | "server" | "connect" | "ports" | "done";

function StepRow({ done, active, title, children }: { done: boolean; active: boolean; title: string; children?: React.ReactNode }) {
  return (
    <div className={cn("rounded-md border px-3 py-2", active ? "border-accent/50" : "border-border")}>
      <div className="flex items-center gap-2 text-[12.5px] font-medium text-text">
        {done ? <CheckCircle2 size={14} className="text-success" /> : active ? <Loader2 size={14} className="animate-spin text-accent" /> : <Circle size={14} className="text-text-dim" />}
        {title}
      </div>
      {children && <div className="mt-1.5 pl-6 text-[11.5px] text-text-muted">{children}</div>}
    </div>
  );
}

// "Move this server behind Cloudflare", from a working direct connection:
// Faro does the Cloudflare side through the API, runs (or hands over) one
// root script on the server, waits for the tunnel, creates and tests the new
// connection, then says which ports can now be closed. Undo all reverses it.
export function MoveToCloudflareDialog({ profileId, onClose }: Props) {
  const profile = useConnections((s) => s.profiles.find((p) => p.id === profileId));
  const sessionId = useConnections((s) => s.sessions.find((x) => x.profileId === profileId)?.sessionId);
  const connect = useConnections((s) => s.connect);
  const saveProfile = useConnections((s) => s.saveProfile);
  const deleteProfile = useConnections((s) => s.deleteProfile);
  const openDialog = useLayout((s) => s.openDialog);
  const { status } = useCloudflareAccount();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, { onClose });

  const [zones, setZones] = useState<CfZone[] | null>(null);
  const [name, setName] = useState(() => labelFrom(profile?.name ?? ""));
  const [zoneId, setZoneId] = useState("");
  const [panel, setPanel] = useState(false);
  const [panelPort, setPanelPort] = useState(8443);
  const [people, setPeople] = useState("");
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<CfSetupState | null>(null);
  const [run, setRun] = useState<RootRun | null>(null);
  const [sudoPassword, setSudoPassword] = useState("");
  const [tunnel, setTunnel] = useState<string>("");
  const [newProfile, setNewProfile] = useState<ConnectionProfile | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [openPorts, setOpenPorts] = useState<number[] | null>(null);
  const [undone, setUndone] = useState(false);

  useEffect(() => {
    if (!status?.connected) return;
    ipc
      .cfAccountZones()
      .then((z) => {
        setZones(z);
        if (z.length && !zoneId) setZoneId(z[0].id);
      })
      .catch((e) => {
        setZones([]);
        setError(messageOf(e));
      });
  }, [status?.connected]); // eslint-disable-line react-hooks/exhaustive-deps

  const zone = zones?.find((z) => z.id === zoneId);
  const peopleList = useMemo(
    () => people.split(/[\s,;]+/).map((p) => p.trim()).filter(Boolean),
    [people]
  );
  const nameOk = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/i.test(name);
  const formOk = nameOk && !!zone && peopleList.length > 0 && (!panel || (panelPort > 0 && panelPort < 65536));

  // Step 3 turns green on its own once the tunnel's connector is up, however
  // the script was run.
  useEffect(() => {
    if (step !== "server" || !setup) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await ipc.cfTunnelStatus(setup.tunnelId);
        if (stop) return;
        setTunnel(s);
        if (s === "healthy") setStep("connect");
      } catch {
        /* keep polling */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [step, setup]);

  // Step 4: the new connection, saved and tested.
  useEffect(() => {
    if (step !== "connect" || !setup || !profile || newProfile) return;
    const p: ConnectionProfile = {
      ...profile,
      id: crypto.randomUUID(),
      name: `${profile.name} via Cloudflare`,
      host: setup.sshHostname,
      port: 22,
      auth: { kind: "cloudflarecert" },
      proxy: undefined,
      jumpProfile: undefined,
      proxyCommand: { kind: "cloudflare" },
      sortOrder: undefined,
      autoConnect: undefined,
    };
    setNewProfile(p);
    void (async () => {
      try {
        await saveProfile(p);
        await ipc.testConnection(p);
        setTestError(null);
        setOpenPorts(await ipc.checkOpenPorts(profile.host, [...new Set([profile.port || 22, 80, 443, ...(panel ? [panelPort] : [])])]));
        setStep("ports");
      } catch (e) {
        setTestError(messageOf(e));
      }
    })();
  }, [step, setup, profile, newProfile, saveProfile, panel, panelPort]);

  if (!profile) return null;

  const startCloudflare = async () => {
    if (!zone) return;
    setBusy(true);
    setError(null);
    setStep("cloudflare");
    try {
      const s = await ipc.cfSetupCloudflare(profile.id, {
        name,
        zoneId: zone.id,
        zoneName: zone.name,
        panelPort: panel ? panelPort : undefined,
        people: peopleList,
      });
      setSetup(s);
      setStep("server");
    } catch (e) {
      setError(messageOf(e));
      setStep("form");
    } finally {
      setBusy(false);
    }
  };

  const runScript = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      let sid = sessionId;
      if (!sid) {
        await connect(profile.id, { focus: false });
        sid = useConnections.getState().sessions.find((x) => x.profileId === profile.id)?.sessionId;
      }
      if (!sid) throw new Error(`${profile.name} isn't connected`);
      const r = await ipc.sshRunAsRoot(sid, setup.script, sudoPassword || undefined);
      setRun({ ...r, ok: r.ok && r.output.includes(SETUP_OK) });
    } catch (e) {
      toastError(e, "Couldn't run the setup on the server");
    } finally {
      setBusy(false);
    }
  };

  const undoAll = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      const failed = await ipc.cfSetupUndo(setup.created);
      if (newProfile) await deleteProfile(newProfile.id).catch(() => {});
      let serverNote = "";
      if (run?.ok && sessionId) {
        const r = await ipc.sshRunAsRoot(sessionId, setup.undoScript, sudoPassword || undefined).catch(() => null);
        serverNote = r?.ok ? " The server's sshd and cloudflared changes were reverted." : " Revert the server with the undo command (copied).";
        if (!r?.ok) await navigator.clipboard.writeText(setup.undoScript).catch(() => {});
      } else if (run?.ok || tunnel === "healthy") {
        await navigator.clipboard.writeText(setup.undoScript).catch(() => {});
        serverNote = " Paste the undo command (copied) into a root console to revert the server.";
      }
      setUndone(true);
      if (failed.length) toast.warning("Undo left some things behind", failed.join("\n"));
      else toast.success("Undone", `Everything Faro created in Cloudflare was deleted.${serverNote}`);
    } catch (e) {
      toastError(e, "Undo failed");
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string, what: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`));

  const order: Step[] = ["form", "cloudflare", "server", "connect", "ports", "done"];
  const at = order.indexOf(step);
  const input = "w-full rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-[12px] outline-none focus:border-accent";

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="anim-modal flex max-h-[88vh] w-[40rem] max-w-[94vw] flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-4 py-3">
          <Cloud size={14} className="text-accent" />
          <span id={titleId} className="text-sm font-semibold">Move {profile.name} behind Cloudflare</span>
          <div className="flex-1" />
          <button onClick={onClose} className="rounded-md px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text">
            Close
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3 text-[12px]">
          {!status ? (
            <Loader2 size={14} className="animate-spin text-text-muted" />
          ) : !status.connected ? (
            <div className="flex items-start gap-2 rounded-md border border-border px-2.5 py-2">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
              <div className="min-w-0 flex-1 text-text-muted">
                Faro sets up the Cloudflare side through the API, so connect the Cloudflare account first in Settings ›
                Cloudflare.
              </div>
              <button
                onClick={() => openDialog("settings")}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover"
              >
                <SettingsIcon size={11} /> Settings
              </button>
            </div>
          ) : step === "form" ? (
            <>
              <p className="text-text-muted">
                Faro creates the tunnel, DNS names, Access application and its certificate authority in{" "}
                <span className="text-text">{status.accountName}</span>, then needs root on the server once. Your direct
                connection keeps working until you close the port.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <label>
                  <div className="mb-1 text-[11px] text-text-muted">Name</div>
                  <input aria-label="Name" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className={input} />
                </label>
                <label>
                  <div className="mb-1 text-[11px] text-text-muted">Domain</div>
                  <select aria-label="Domain" value={zoneId} onChange={(e) => setZoneId(e.target.value)} className={input}>
                    {zones === null && <option>Loading…</option>}
                    {zones?.length === 0 && <option value="">No domains in this account</option>}
                    {zones?.map((z) => (
                      <option key={z.id} value={z.id}>
                        {z.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="text-[11px] text-text-dim" data-testid="setup-hostnames">
                {nameOk && zone ? (
                  <>
                    SSH at <span className="font-mono text-text">{name}-ssh.{zone.name}</span>
                    {panel && (
                      <>
                        , panel at <span className="font-mono text-text">{name}-panel.{zone.name}</span>
                      </>
                    )}
                    . One level under the domain, which Cloudflare's free certificate covers.
                  </>
                ) : (
                  "Letters, digits and dashes, no dots."
                )}
              </div>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={panel} onChange={(e) => setPanel(e.target.checked)} className="accent-accent" />
                Also publish a web control panel on port
                <input
                  type="number"
                  aria-label="Panel port"
                  value={panelPort}
                  onChange={(e) => setPanelPort(Number(e.target.value) || 0)}
                  disabled={!panel}
                  className="w-20 rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-[12px] disabled:opacity-50"
                />
              </label>
              <label>
                <div className="mb-1 text-[11px] text-text-muted">Who gets in (emails, or @domain for everyone there)</div>
                <input
                  aria-label="Who gets in"
                  value={people}
                  onChange={(e) => setPeople(e.target.value)}
                  placeholder="jane@example.com, @example.com"
                  className={input}
                />
              </label>
              <p className="text-[11px] text-text-dim">
                Everyone listed by email can log in as <span className="font-mono">{profile.username}</span> with their
                Cloudflare identity, so include your own. Invite more people later from the new connection.
              </p>
              {error && (
                <div role="alert" className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-2.5 py-2 text-[11.5px] text-text">
                  <AlertTriangle size={12} className="mt-0.5 shrink-0 text-danger" />
                  <span className="break-words">{error}</span>
                </div>
              )}
            </>
          ) : (
            <>
              <StepRow done={at > 1} active={step === "cloudflare"} title="Set up Cloudflare">
                {setup && (
                  <ul className="list-disc pl-4" data-testid="setup-created">
                    {setup.created.map((c) => (
                      <li key={c.path}>{c.label}</li>
                    ))}
                    <li>tunnel routes, Access policies and the SSH certificate authority</li>
                  </ul>
                )}
              </StepRow>
              <StepRow done={at > 2} active={step === "server"} title="Root on the server, once">
                {step === "server" && setup && (
                  <>
                    <p className="mb-1.5">
                      Installs cloudflared as a service, trusts the Access CA, lists who may log in as{" "}
                      <span className="font-mono">{profile.username}</span>, and checks sshd's config before switching
                      (the old one comes back if sshd rejects it).
                    </p>
                    <details className="mb-1.5">
                      <summary className="cursor-pointer text-[11px] text-text-dim">Show the script</summary>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-bg-subtle px-2 py-1 font-mono text-[10.5px]" data-testid="setup-script">
                        {setup.script}
                      </pre>
                    </details>
                    {run && !run.ok && !run.needsPassword && (
                      <p className="mb-1.5 whitespace-pre-wrap text-danger">It failed: {run.output.split("\n").slice(-4).join("\n")}</p>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {run?.needsPassword && (
                        <input
                          type="password"
                          aria-label="sudo password"
                          value={sudoPassword}
                          onChange={(e) => setSudoPassword(e.target.value)}
                          placeholder="sudo password"
                          className="w-40 rounded border border-border bg-bg-subtle px-2 py-0.5 text-[11px]"
                        />
                      )}
                      {!run?.ok && (
                        <button
                          onClick={() => void runScript()}
                          disabled={busy || (run?.needsPassword && !sudoPassword)}
                          className="inline-flex items-center gap-1 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white disabled:opacity-60"
                        >
                          {busy ? <Loader2 size={11} className="animate-spin" /> : <Plug size={11} />}
                          Run with sudo over {profile.name}
                        </button>
                      )}
                      <button
                        onClick={() => void copy(setup.script, "Setup script")}
                        className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-[11px] hover:bg-bg-hover"
                      >
                        <Copy size={11} /> Copy to paste as root
                      </button>
                    </div>
                    <p className="mt-1.5 text-[11px] text-text-dim">
                      No sudo? Paste it into any root console: the provider's web console, a root SSH session or a
                      control panel terminal. This step turns green by itself when the tunnel connects.{" "}
                      {tunnel && <TunnelHealth status={tunnel} />}
                    </p>
                  </>
                )}
              </StepRow>
              <StepRow done={at > 3} active={step === "connect"} title="Connect through Cloudflare">
                {newProfile && (
                  <span>
                    New connection <span className="text-text">{newProfile.name}</span> to{" "}
                    <span className="font-mono">{setup?.sshHostname}</span>
                    {step === "connect" && !testError && ", testing…"}
                  </span>
                )}
                {testError && (
                  <div className="mt-1 text-danger" role="alert">
                    {testError}
                    <button
                      onClick={() => {
                        setTestError(null);
                        setNewProfile(null);
                      }}
                      className="ml-2 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover"
                    >
                      Try again
                    </button>
                  </div>
                )}
              </StepRow>
              <StepRow done={step === "done"} active={step === "ports"} title="Close the ports">
                {openPorts && (
                  <div data-testid="open-ports">
                    {openPorts.length === 0 ? (
                      <p>Nothing Faro checked answers directly from here any more.</p>
                    ) : (
                      <p>
                        Still open from here:{" "}
                        <span className="font-mono text-text">{openPorts.join(", ")}</span>. In the cloud provider's
                        firewall, allow nothing for SSH (it now comes in through the tunnel), and 80/443 only if this is a
                        public web server. Faro doesn't change the firewall itself; to roll back, detach the firewall.
                      </p>
                    )}
                    {step === "ports" && (
                      <button
                        onClick={() => setStep("done")}
                        className="mt-1.5 rounded bg-accent px-2 py-1 text-[11px] font-medium text-white"
                      >
                        Done
                      </button>
                    )}
                  </div>
                )}
              </StepRow>
              {step === "done" && (
                <p className="text-text">
                  <CheckCircle2 size={13} className="mr-1 inline text-success" />
                  {profile.name} is reachable through Cloudflare. Use Invite… on the new connection to add teammates.
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          {setup && !undone && (
            <button
              onClick={() => void undoAll()}
              disabled={busy}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-danger disabled:opacity-50"
            >
              <Undo2 size={12} /> Undo all
            </button>
          )}
          <div className="flex-1" />
          {step === "form" && status?.connected ? (
            <button
              onClick={() => void startCloudflare()}
              disabled={busy || !formOk}
              className="btn-accent inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? <Loader2 size={11} className="animate-spin" /> : <Cloud size={11} />}
              Set it up
            </button>
          ) : (
            <button onClick={onClose} className="rounded-md border border-border px-3 py-1.5 text-xs hover:bg-bg-hover">
              {step === "done" || undone ? "Close" : "Close (keeps what's done)"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
