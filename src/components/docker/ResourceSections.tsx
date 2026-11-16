import { useState } from "react";
import { FolderOpen, Loader2, Trash2 } from "lucide-react";
import { ConfirmModal } from "@faro/file-ui";
import { ipc } from "@/lib/ipc";
import {
  containersOnNetwork,
  containersUsingImage,
  containersUsingVolume,
  useDocker,
} from "@/stores/dockerStore";
import { useLayout } from "@/stores/layoutStore";
import { useServerView } from "@/stores/serverViewStore";
import { toast } from "@/stores/toastStore";
import { fmtSize } from "@/lib/format";
import { cn } from "@/lib/cn";
import type { DockerResourceKind } from "@/lib/types";
import { TD, TH } from "../server/shared";
import { RowButton, type SectionProps } from "./ContainersSection";

/** What removing one resource runs, and what the confirm dialog must say. */
interface Removal {
  kind: DockerResourceKind;
  /** What goes on the command line. */
  id: string;
  /** What the user knows it as. */
  label: string;
  command: string;
  warning: string;
}

/** Confirm-then-remove for one image, volume or network, shared by the tables. */
function useRemoval({ sessionId, elevate, sudoPrefix }: SectionProps, after: () => void) {
  const [pending, setPending] = useState<Removal | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (r: Removal) => {
    setBusy(r.id);
    try {
      const res = await ipc.dockerRemove(sessionId, r.kind, r.id, elevate);
      if (res.ok) toast.success(`Removed ${r.label}`);
      // Docker refuses to remove what is in use; its own words say by what.
      else toast.error(`Could not remove ${r.label}`, res.output || undefined);
    } catch (e) {
      toast.error(`Could not remove ${r.label}`, String(e));
    } finally {
      setBusy(null);
      after();
    }
  };

  const modal = pending && (
    <ConfirmModal
      title={`Remove ${pending.label}?`}
      message={`${pending.warning}\n\nRuns:\n${sudoPrefix}${pending.command}`}
      destructive
      confirmLabel="Remove"
      onClose={() => setPending(null)}
      onConfirm={() => {
        const r = pending;
        setPending(null);
        void run(r);
      }}
    />
  );
  return { ask: setPending, busy, modal };
}

function UsedBy({ names, count }: { names: string[]; count?: number | null }) {
  if (names.length > 0) {
    return (
      <span className="font-mono text-text-muted" title={names.join(", ")}>
        {names.join(", ")}
      </span>
    );
  }
  // Docker counted references we couldn't name from the container list.
  if (count) return <span className="text-text-muted">{count} container{count === 1 ? "" : "s"}</span>;
  return <span className="text-text-dim">unused</span>;
}

function Placeholder({ cols, children }: { cols: number; children: React.ReactNode }) {
  return (
    <tr>
      <td colSpan={cols} className="px-3 py-6 text-center text-[11px] text-text-dim">
        {children}
      </td>
    </tr>
  );
}

function RemoveCell({ busy, label, disabled, onClick }: { busy: boolean; label: string; disabled?: boolean; onClick: () => void }) {
  return (
    <td className={cn(TD, "text-right")}>
      {busy ? (
        <Loader2 size={13} className="ml-auto animate-spin text-accent" />
      ) : (
        <RowButton label={label} disabled={disabled} onClick={onClick}>
          <Trash2 size={13} />
        </RowButton>
      )}
    </td>
  );
}

export function ImagesSection(props: SectionProps) {
  const images = useDocker((s) => s.images);
  const containers = useDocker((s) => s.containers);
  const refresh = useDocker((s) => s.refreshImages);
  const { ask, busy, modal } = useRemoval(props, () => void refresh(props.elevate));

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className={cn(TH, "w-[34%]")}>Image</th>
            <th className={TH}>ID</th>
            <th className={cn(TH, "text-right")}>Size</th>
            <th className={TH}>Created</th>
            <th className={TH}>Used by</th>
            <th className={cn(TH, "w-12")}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(images ?? []).map((img) => {
            const tagged = img.repository !== "<none>";
            const name = tagged ? `${img.repository}:${img.tag}` : "<untagged>";
            const short = img.id.replace(/^sha256:/, "").slice(0, 12);
            const users = containersUsingImage(containers, img);
            // A tagged image is removed by its tag (several tags can share
            // one id); an untagged one only has its id.
            const target = tagged ? name : img.id;
            return (
              <tr key={img.id + name} className="hover:bg-bg-hover/50">
                <td className={cn(TD, "max-w-0 truncate font-mono", !tagged && "text-text-dim")} title={name}>
                  {name}
                </td>
                <td className={cn(TD, "font-mono text-text-muted")} title={img.id}>
                  {short}
                </td>
                <td className={cn(TD, "text-right font-mono tabular-nums")}>{fmtSize(img.size)}</td>
                <td className={cn(TD, "whitespace-nowrap text-text-muted")} title={img.createdAt}>
                  {img.createdSince}
                </td>
                <td className={cn(TD, "max-w-0 truncate")}>
                  <UsedBy names={users} />
                </td>
                <RemoveCell
                  busy={busy === target}
                  label={`Remove image ${name}`}
                  onClick={() =>
                    ask({
                      kind: "image",
                      id: target,
                      label: name,
                      command: `docker rmi ${target}`,
                      warning:
                        users.length > 0
                          ? `Used by ${users.join(", ")}: Docker will refuse until those containers are removed.`
                          : "The image is deleted from this host. It can be pulled again if a registry has it.",
                    })
                  }
                />
              </tr>
            );
          })}
          {images && images.length === 0 && <Placeholder cols={6}>No images on this host.</Placeholder>}
          {!images && <Placeholder cols={6}>Loading images…</Placeholder>}
        </tbody>
      </table>
      {modal}
    </div>
  );
}

export function VolumesSection(props: SectionProps) {
  const volumes = useDocker((s) => s.volumes);
  const containers = useDocker((s) => s.containers);
  const refresh = useDocker((s) => s.refreshVolumes);
  const requestReveal = useLayout((s) => s.requestReveal);
  const closeView = useServerView((s) => s.close);
  const { ask, busy, modal } = useRemoval(props, () => void refresh(props.elevate));

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className={cn(TH, "w-[24%]")}>Volume</th>
            <th className={TH}>Driver</th>
            <th className={cn(TH, "text-right")}>Size</th>
            <th className={TH}>Used by</th>
            <th className={TH}>Data directory</th>
            <th className={cn(TH, "w-20")}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(volumes ?? []).map((v) => {
            const users = containersUsingVolume(containers, v.name);
            return (
              <tr key={v.name} className="hover:bg-bg-hover/50">
                <td className={cn(TD, "max-w-0 truncate font-mono")} title={v.name}>
                  {v.name}
                </td>
                <td className={cn(TD, "text-text-muted")}>{v.driver}</td>
                <td className={cn(TD, "text-right font-mono tabular-nums")}>
                  {v.size != null ? fmtSize(v.size) : <span className="text-text-dim">–</span>}
                </td>
                <td className={cn(TD, "max-w-0 truncate")}>
                  <UsedBy names={users} count={v.links} />
                </td>
                <td className={cn(TD, "max-w-0 truncate font-mono text-text-muted")} title={v.mountpoint}>
                  {v.mountpoint}
                </td>
                <td className={cn(TD, "whitespace-nowrap text-right")}>
                  {busy === v.name ? (
                    <Loader2 size={13} className="ml-auto animate-spin text-accent" />
                  ) : (
                    <span className="inline-flex items-center gap-0.5">
                      <RowButton
                        label={`Show ${v.name} in the file browser`}
                        disabled={!v.mountpoint}
                        onClick={() => {
                          requestReveal(props.sessionId, v.mountpoint);
                          closeView();
                        }}
                      >
                        <FolderOpen size={13} />
                      </RowButton>
                      <RowButton
                        label={`Remove volume ${v.name}`}
                        onClick={() =>
                          ask({
                            kind: "volume",
                            id: v.name,
                            label: v.name,
                            command: `docker volume rm ${v.name}`,
                            warning:
                              (users.length > 0
                                ? `Used by ${users.join(", ")}: Docker will refuse until those containers are removed.\n`
                                : "") + "Everything stored in the volume is deleted. This can't be undone.",
                          })
                        }
                      >
                        <Trash2 size={13} />
                      </RowButton>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
          {volumes && volumes.length === 0 && <Placeholder cols={6}>No volumes on this host.</Placeholder>}
          {!volumes && <Placeholder cols={6}>Loading volumes…</Placeholder>}
        </tbody>
      </table>
      {modal}
    </div>
  );
}

export function NetworksSection(props: SectionProps) {
  const networks = useDocker((s) => s.networks);
  const containers = useDocker((s) => s.containers);
  const refresh = useDocker((s) => s.refreshNetworks);
  const { ask, busy, modal } = useRemoval(props, () => void refresh(props.elevate));

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className={cn(TH, "w-[26%]")}>Network</th>
            <th className={TH}>Driver</th>
            <th className={TH}>Scope</th>
            <th className={TH}>Containers</th>
            <th className={cn(TH, "w-12")}>
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {(networks ?? []).map((n) => {
            const users = containersOnNetwork(containers, n.name);
            return (
              <tr key={n.id || n.name} className="hover:bg-bg-hover/50">
                <td className={cn(TD, "max-w-0 truncate font-mono")} title={n.id}>
                  {n.name}
                  {n.builtin && <span className="ml-2 font-sans text-[10px] text-text-dim">built in</span>}
                </td>
                <td className={cn(TD, "text-text-muted")}>{n.driver}</td>
                <td className={cn(TD, "text-text-muted")}>{n.scope}</td>
                <td className={cn(TD, "max-w-0 truncate")}>
                  <UsedBy names={users} />
                </td>
                <RemoveCell
                  busy={busy === n.name}
                  label={n.builtin ? `${n.name} comes with Docker and can't be removed` : `Remove network ${n.name}`}
                  disabled={n.builtin}
                  onClick={() =>
                    ask({
                      kind: "network",
                      id: n.name,
                      label: n.name,
                      command: `docker network rm ${n.name}`,
                      warning:
                        users.length > 0
                          ? `${users.join(", ")} ${users.length === 1 ? "is" : "are"} attached: Docker will refuse until they are disconnected.`
                          : "Containers created later with this network name will fail until it exists again.",
                    })
                  }
                />
              </tr>
            );
          })}
          {networks && networks.length === 0 && <Placeholder cols={5}>No networks.</Placeholder>}
          {!networks && <Placeholder cols={5}>Loading networks…</Placeholder>}
        </tbody>
      </table>
      {modal}
    </div>
  );
}
