import { useEffect, useState } from "react";
import { HardDrive } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { ipc } from "@/lib/ipc";
import { useConnections } from "@/stores/connectionsStore";
import { useMounts } from "@/stores/mountStore";
import { useRules } from "@/stores/rulesStore";
import { toast } from "@/stores/toastStore";
import { Dialog } from "@/components/ui/Dialog";
import { Dropdown } from "@/components/ui/Dropdown";
import type { Mount } from "@/lib/types";

const field = "rounded border border-border bg-bg-panel px-2 py-1 font-mono text-[12px]";

/// Mount as folder: show a connection (or one folder of it) as an on-demand
/// Windows folder. Files appear right away and download when opened.
export function MountDialog() {
  const request = useMounts((s) => s.request);
  const close = useMounts((s) => s.close);
  const save = useMounts((s) => s.save);
  const profiles = useConnections((s) => s.profiles);
  const ruleSets = useRules((s) => s.sets);

  const editing = request && "edit" in request ? request.edit : null;
  const profileId = editing?.profileId ?? (request && "profileId" in request ? request.profileId : "");
  const profile = profiles.find((p) => p.id === profileId);

  const [name, setName] = useState("");
  const [remoteRoot, setRemoteRoot] = useState("/");
  const [localRoot, setLocalRoot] = useState("");
  const [index, setIndex] = useState(false);
  const [writeBack, setWriteBack] = useState(false);
  const [allowDeletes, setAllowDeletes] = useState(false);
  const [ruleSet, setRuleSet] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Seed the form whenever the dialog opens.
  useEffect(() => {
    if (!request) return;
    setError(null);
    if (editing) {
      setName(editing.name);
      setRemoteRoot(editing.remoteRoot);
      setLocalRoot(editing.localRoot);
      setIndex(editing.index);
      setWriteBack(editing.writeBack);
      setAllowDeletes(editing.allowDeletes);
      setRuleSet(editing.ruleSet ?? "");
      return;
    }
    const n = profile?.name ?? "Connection";
    setName(n);
    setRemoteRoot(("remoteRoot" in request && request.remoteRoot) || profile?.defaultRemotePath || "/");
    setIndex(false);
    setWriteBack(false);
    setAllowDeletes(false);
    setRuleSet("");
    void ipc.mountDefaultRoot(n).then(setLocalRoot).catch(() => setLocalRoot(""));
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!request) return null;

  const browse = async () => {
    const picked = await open({ directory: true, title: "Choose an empty folder" });
    if (typeof picked === "string") setLocalRoot(picked);
  };

  const submit = async () => {
    const mount: Mount = {
      id: editing?.id ?? "",
      name: name.trim() || profile?.name || "Connection",
      profileId,
      remoteRoot: remoteRoot.trim() || "/",
      localRoot: localRoot.trim(),
      enabled: editing?.enabled ?? true,
      writeBack,
      allowDeletes: writeBack && allowDeletes,
      index,
      ruleSet: ruleSet || null,
    };
    try {
      await save(mount);
      if (!editing) toast.success("Folder mounted", `${mount.name} is in ${mount.localRoot || "your Faro folder"}.`);
      close();
    } catch (e) {
      setError(String(e));
      return false;
    }
  };

  return (
    <Dialog
      title={editing ? `Edit ${editing.name}` : `Mount ${profile?.name ?? "connection"} as a folder`}
      icon={<HardDrive size={14} />}
      size="md"
      onClose={close}
      onConfirm={submit}
      confirmLabel={editing ? "Save" : "Mount"}
      confirmDisabled={!profileId}
      data-testid="mount-dialog"
    >
      <div className="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-2 text-[12px]">
        <label className="text-text-muted" htmlFor="mount-name">
          Name
        </label>
        <input id="mount-name" value={name} onChange={(e) => setName(e.target.value)} className={field} />
        <label className="text-text-muted" htmlFor="mount-remote">
          Remote folder
        </label>
        <input
          id="mount-remote"
          value={remoteRoot}
          onChange={(e) => setRemoteRoot(e.target.value)}
          className={field}
          spellCheck={false}
        />
        <label className="text-text-muted" htmlFor="mount-local">
          Local folder
        </label>
        <div className="flex gap-1.5">
          <input
            id="mount-local"
            value={localRoot}
            onChange={(e) => setLocalRoot(e.target.value)}
            className={`${field} min-w-0 flex-1`}
            spellCheck={false}
          />
          <button onClick={() => void browse()} className="rounded border border-border px-2 text-text-muted hover:text-text">
            Browse…
          </button>
        </div>
        <span />
        <label className="flex items-center gap-2 text-text-muted">
          <input type="checkbox" checked={index} onChange={(e) => setIndex(e.target.checked)} />
          Index files (dates, camera, thumbnails) for search
        </label>
        <span />
        <label className="flex items-center gap-2 text-text-muted">
          <input type="checkbox" checked={writeBack} onChange={(e) => setWriteBack(e.target.checked)} />
          Upload files I save here
        </label>
        {writeBack && (
          <>
            <span />
            <label className="flex items-center gap-2 pl-5 text-text-muted">
              <input type="checkbox" checked={allowDeletes} onChange={(e) => setAllowDeletes(e.target.checked)} />
              Also apply deletes and renames to the connection
            </label>
          </>
        )}
        {ruleSets.length > 0 && (
          <>
            <span className="text-text-muted">View folders</span>
            <Dropdown
              aria-label="View folders from rules"
              value={ruleSet}
              options={[{ value: "", label: "None" }, ...ruleSets.map((r) => ({ value: r.id, label: r.name }))]}
              onChange={setRuleSet}
            />
          </>
        )}
      </div>
      <p className="mt-3 text-[11px] text-text-dim">
        {writeBack
          ? "Saved files upload to the connection. If it changed in the meantime, both copies are kept."
          : "Edits stay on this PC; they're listed under the mount in Settings › Sync."}{" "}
        The folder must be empty or new.
      </p>
      {error && <div className="mt-2 rounded border border-danger/40 px-2 py-1.5 text-[12px] text-danger">{error}</div>}
    </Dialog>
  );
}
