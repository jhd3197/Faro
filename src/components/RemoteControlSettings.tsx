import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { toast } from "@/stores/toastStore";
import type { AgentHostStatus } from "@/lib/types";
import { onAgentHostPaired } from "@/lib/ipc";
import { SETTINGS_FOCUS } from "@/lib/settingsNav";
import {
  Advanced,
  Btn,
  CheckRow,
  Empty,
  Group,
  InfoTip,
  List,
  ListRow,
  Row,
  Status,
  SubHeading,
  SwitchRow,
  TextInput,
} from "./settings/kit";

/// Settings → Remote control. Lets THIS machine be driven from the user's other
/// Faros: flip it on, click "Pair a device", read the six digits into the
/// other device. No separate daemon download, no terminal — the app hosts the
/// same faro-agentd stack in-process.
export function RemoteControlSettings() {
  const [status, setStatus] = useState<AgentHostStatus | null>(null);
  const [relayAddress, setRelayAddress] = useState("");
  const [relayKey, setRelayKey] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const next = await ipc.agentHostStatus();
      setStatus(next);
      setRelayAddress(next.relay?.address ?? "");
      setRelayKey(next.relay?.publicKey ?? "");
    } catch (e) {
      toast.error("Remote control unavailable", String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!status?.running || !status.relay) return;
    const timer = setInterval(() => { void ipc.agentHostStatus().then(setStatus).catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [status?.running, status?.relay?.address]);

  // A controller finished pairing — refresh the peer list and celebrate.
  useEffect(() => {
    const un = onAgentHostPaired((e) => {
      toast.success("New machine paired", `${e.name} can now control this computer`);
      void refresh();
    });
    return () => {
      void un.then((f) => f());
    };
  }, [refresh]);

  // While a pairing window is open, tick the countdown down once a second.
  const hasWindow = !!status?.pairing;
  useEffect(() => {
    if (!hasWindow) return;
    const t = setInterval(() => {
      setStatus((s) =>
        s?.pairing
          ? {
              ...s,
              pairing:
                s.pairing.remainingSecs <= 1
                  ? null
                  : { ...s.pairing, remainingSecs: s.pairing.remainingSecs - 1 },
            }
          : s
      );
    }, 1000);
    return () => clearInterval(t);
  }, [hasWindow]);

  const run = async (fn: () => Promise<AgentHostStatus>) => {
    setBusy(true);
    try {
      setStatus(await fn());
    } catch (e) {
      toast.error("Remote control", String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <Status tone="busy">Loading…</Status>;
  }

  const relayState = status.relay
    ? status.relayOnline
      ? "Relay available"
      : "Reconnecting to relay…"
    : null;
  const switchStatus = status.running
    ? `Listening on port ${status.port}${relayState ? ` · ${relayState}` : ""}`
    : status.enabled
      ? "Not running"
      : "Off";
  const saveRelay = () =>
    run(() =>
      ipc.agentHostSetRelay(
        relayAddress.trim() ? { address: relayAddress.trim(), publicKey: relayKey.trim() } : null
      )
    );

  return (
    <div className="space-y-4">
      <SwitchRow
        label="Remote control"
        help={
          <>
            Runs an encrypted agent so another Faro on your network can browse, transfer files and,
            if you allow it, run commands here.
            {navigator.platform.startsWith("Win") && " Windows may ask to allow Faro through the firewall the first time."}
          </>
        }
        status={switchStatus}
        checked={status.enabled}
        onChange={(v) => run(() => ipc.agentHostSetEnabled(v))}
        busy={busy}
        keywords="pair agent remote"
      />

      {status.running && (
        <>
          <section className="space-y-2">
            <SubHeading
              title={`Paired devices (${status.peers.length})`}
              help="Paired devices can connect to this computer until you remove them."
              actions={
                !status.pairing && (
                  <Btn
                    variant="primary"
                    size="sm"
                    data-settings-focus={SETTINGS_FOCUS.showPairingCode}
                    disabled={busy}
                    onClick={() => run(() => ipc.agentHostOpenPairing())}
                  >
                    Pair a device
                  </Btn>
                )
              }
            />
            {status.pairing && (
              <PairingCode
                code={status.pairing.code}
                remainingSecs={status.pairing.remainingSecs}
                hostname={status.hostname}
                busy={busy}
                onClose={() => run(() => ipc.agentHostClosePairing())}
              />
            )}
            {status.peers.length === 0 ? (
              <Empty>No paired devices.</Empty>
            ) : (
              <List data-testid="paired-devices">
                {status.peers.map((p) => (
                  <ListRow
                    key={p.publicKey}
                    title={p.name}
                    detail={<span className="font-mono">{p.fingerprint}</span>}
                    actions={
                      <Btn
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        title="This device can no longer connect"
                        onClick={() => run(() => ipc.agentHostRevokePeer(p.publicKey))}
                      >
                        Remove
                      </Btn>
                    }
                  />
                ))}
              </List>
            )}
          </section>

          <Group title="Paired machines may">
            <CheckRow
              label="Run commands"
              help="Paired controllers, and any AI agent driving them, can run shell commands here. Turn off for browse and transfer only."
              note={status.allowExec ? "Only pair devices you trust." : undefined}
              checked={status.allowExec}
              disabled={busy}
              keywords="exec shell"
              onChange={(v) => run(() => ipc.agentHostSetPolicy(v, status.allowWrite))}
            />
            <CheckRow
              label="Write files"
              help="Upload, delete and rename. Reading and listing are always allowed once paired."
              checked={status.allowWrite}
              disabled={busy}
              keywords="upload delete rename"
              onChange={(v) => run(() => ipc.agentHostSetPolicy(status.allowExec, v))}
            />
          </Group>
        </>
      )}

      <Advanced open={!!status.relay}>
        <Row
          label="Relay address"
          help="A self-hosted relay reaches this machine over the internet. Pair your devices first, then add this machine and its controllers to the relay allowlist."
          keywords="relay internet self-hosted"
        >
          <TextInput
            className="w-full"
            aria-label="Host relay address"
            placeholder="relay.example.com:8723"
            value={relayAddress}
            onChange={(e) => setRelayAddress(e.target.value)}
          />
        </Row>
        <Row label="Relay public key" keywords="relay">
          <TextInput
            className="w-full font-mono"
            aria-label="Host relay public key"
            placeholder="Base64"
            value={relayKey}
            onChange={(e) => setRelayKey(e.target.value)}
          />
        </Row>
        {status.publicKey && (
          <Row label="This machine's key" help="Add it to the relay allowlist." keywords="public key relay">
            <CopyValue value={status.publicKey} />
          </Row>
        )}
        {status.fingerprint && (
          <Row label="Fingerprint" keywords="key">
            <span className="truncate font-mono text-xs text-text" title={status.os}>
              {status.fingerprint}
            </span>
          </Row>
        )}
        {/* An action row with no label: the button lines up with the inputs. */}
        <div className="grid grid-cols-[12.5rem_minmax(0,1fr)] gap-x-5 py-1">
          <div />
          <div className="flex min-h-8 items-center gap-2">
            <Btn
              disabled={busy || (!!relayAddress.trim() && !relayKey.trim())}
              title={relayAddress.trim() && !relayKey.trim() ? "Enter the relay public key" : undefined}
              onClick={saveRelay}
            >
              Save
            </Btn>
            <span className="text-xs text-text-dim">Saving disconnects active sessions.</span>
          </div>
        </div>
      </Advanced>
    </div>
  );
}

function PairingCode({
  code,
  remainingSecs,
  hostname,
  busy,
  onClose,
}: {
  code: string;
  remainingSecs: number;
  hostname: string;
  busy: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the code is on screen anyway */
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="pairing-code">
      <span
        aria-label="Pairing code"
        className="flex h-9 select-all items-center rounded border border-border bg-bg-subtle px-3 font-mono text-xl font-semibold tracking-[0.3em] text-text"
      >
        {code}
      </span>
      <InfoTip
        label="How to pair"
        text={`On your other machine: New Connection › Faro Agent › ${hostname || "this machine"} › enter this code.`}
      />
      <Btn size="sm" variant="ghost" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </Btn>
      <span className="ml-auto text-xs tabular-nums text-text-dim">
        Expires in {formatCountdown(remainingSecs)}
      </span>
      <Btn size="sm" disabled={busy} onClick={onClose}>
        Close
      </Btn>
    </div>
  );
}

/** A long value shown mono and truncated, full text on hover, with Copy. */
function CopyValue({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <span className="min-w-0 flex-1 select-all truncate font-mono text-xs text-text" title={value}>
        {value}
      </span>
      <Btn
        size="sm"
        variant="ghost"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          } catch {
            /* clipboard blocked; the value is selectable */
          }
        }}
      >
        {copied ? "Copied" : "Copy"}
      </Btn>
    </>
  );
}

function formatCountdown(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
