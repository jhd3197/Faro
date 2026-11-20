import { useEffect, useState } from "react";
import { FolderOpen, HardDrive, Pencil, Trash2 } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useConnections } from "@/stores/connectionsStore";
import { useMounts } from "@/stores/mountStore";
import { Btn, List, ListRow, Note, Status, SubHeading, Switch } from "./settings/kit";
import type { MountView } from "@/lib/types";

/// Settings › Sync › Mounts: connections shown as on-demand Windows folders.
/// Hidden on builds without on-demand support.
export function MountsSettings() {
  const supported = useMounts((s) => s.supported);
  const mounts = useMounts((s) => s.mounts);

  useEffect(() => {
    void useMounts.getState().refresh();
  }, []);

  if (!supported) return null;

  return (
    <div className="space-y-2" data-mounts="">
      <SubHeading
        title="Mounts"
        help="A connection shown as a Windows folder. Files appear right away and download when you open them. Right-click a connection › Mount as folder… to add one."
      />
      {mounts.length === 0 ? (
        <Note>No mounts yet.</Note>
      ) : (
        <List data-mount-list="">
          {mounts.map((m) => (
            <MountRow key={m.id} mount={m} />
          ))}
        </List>
      )}
    </div>
  );
}

function MountRow({ mount }: { mount: MountView }) {
  const profiles = useConnections((s) => s.profiles);
  const { setEnabled, remove, freeUpSpace, open } = useMounts.getState();
  const [freeing, setFreeing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const profile = profiles.find((p) => p.id === mount.profileId);
  const tone = !mount.enabled ? "off" : mount.lastError ? "bad" : mount.running ? "ok" : "warn";
  const text = !mount.enabled ? "Off" : mount.lastError ? "Error" : mount.running ? "Mounted" : "Starting";
  const changes = mount.localChanges.length;

  return (
    <ListRow
      data-mount={mount.id}
      title={
        <span className="flex min-w-0 items-baseline gap-2">
          <HardDrive size={11} className="shrink-0 self-center text-text-dim" />
          <span className="truncate">{mount.name}</span>
          <span className="shrink-0 text-xs text-text-dim">{profile?.name ?? "unknown connection"}</span>
        </span>
      }
      detail={
        <span className="flex min-w-0 items-center gap-1.5 font-mono" title={`${mount.localRoot}\n${mount.remoteRoot}`}>
          <span className="min-w-0 truncate">{mount.localRoot}</span>
          <span className="shrink-0">←</span>
          <span className="min-w-0 truncate">{mount.remoteRoot}</span>
        </span>
      }
      status={<Status tone={tone}>{text}</Status>}
      actions={
        <>
          <Btn
            size="sm"
            variant="ghost"
            icon={<FolderOpen size={12} />}
            onClick={() => void ipc.revealLocalPath(mount.localRoot)}
            title="Open in Explorer"
            aria-label="Open in Explorer"
            className="w-6 px-0"
          />
          <Btn
            size="sm"
            busy={freeing}
            disabled={!mount.running}
            title="Turn downloaded files back into placeholders"
            onClick={async () => {
              setFreeing(true);
              try {
                await freeUpSpace(mount.id);
              } finally {
                setFreeing(false);
              }
            }}
          >
            Free up space
          </Btn>
          <Switch checked={mount.enabled} onChange={(v) => void setEnabled(mount.id, v)} label={`Mount ${mount.name}`} />
          <Btn
            size="sm"
            variant="ghost"
            icon={<Pencil size={12} />}
            onClick={() => open({ edit: mount })}
            title="Edit"
            aria-label="Edit mount"
            className="w-6 px-0"
          />
          <Btn
            size="sm"
            variant="ghost"
            icon={<Trash2 size={12} />}
            onClick={() => (confirmRemove ? void remove(mount.id) : setConfirmRemove(true))}
            title={confirmRemove ? "Click again to unmount" : "Unmount"}
            aria-label="Unmount"
            className={confirmRemove ? "px-1 text-danger" : "w-6 px-0 hover:text-danger"}
          >
            {confirmRemove ? "Unmount?" : undefined}
          </Btn>
        </>
      }
    >
      {(mount.lastError || changes > 0) && (
        <div className="space-y-1">
          {mount.lastError && (
            <Note tone="danger">
              <span className="break-all">{mount.lastError}</span>
            </Note>
          )}
          {changes > 0 && (
            <Note tone="warning">
              {changes} file{changes === 1 ? "" : "s"} changed here {mount.writeBack ? "waiting to upload" : "and not uploaded"}
              : <span className="font-mono">{mount.localChanges.slice(0, 3).join(", ")}</span>
              {changes > 3 && ` and ${changes - 3} more`}
            </Note>
          )}
        </div>
      )}
    </ListRow>
  );
}
