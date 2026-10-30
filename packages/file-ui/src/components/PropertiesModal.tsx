import { useEffect, useId, useRef, useState } from "react";
import type { DirEntry, Ownership, SessionId } from "../types";
import { fmtSize, fmtMtime, formatMode } from "../lib/format";
import { useDialog } from "../hooks/useDialog";
import { useFileUi } from "../context";

interface Props {
  entry: DirEntry;
  /** With `canChangeOwner`, the sheet reads and edits owner/group. */
  sessionId?: SessionId | null;
  canChangeOwner?: boolean;
  onOwnerChanged?: () => void;
  onClose: () => void;
}

const KIND_LABEL: Record<DirEntry["kind"], string> = {
  file: "File",
  directory: "Folder",
  symlink: "Symlink",
  other: "Special",
};

const inputCls =
  "w-full min-w-0 rounded-md border border-border bg-bg-subtle px-2 py-1 text-sm outline-none focus:border-accent disabled:opacity-60";

// "Properties" sheet. Type/size/dates/mode are already on the DirEntry the pane
// listed. Owner and group aren't, so on backends that can change them the sheet
// fetches them once and lets you edit them in place.
export function PropertiesModal({ entry, sessionId, canChangeOwner, onOwnerChanged, onClose }: Props) {
  const { fs } = useFileUi();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, { onClose });

  const ownerEditable = !!(canChangeOwner && sessionId && fs.ownership && fs.chown);
  const [current, setCurrent] = useState<Ownership | null>(null);
  const [owner, setOwner] = useState("");
  const [group, setGroup] = useState("");
  const [recursive, setRecursive] = useState(false);
  const [ownerState, setOwnerState] = useState<"loading" | "ready" | "saving" | "saved">("loading");
  const [ownerError, setOwnerError] = useState<string | null>(null);

  useEffect(() => {
    if (!ownerEditable) return;
    let live = true;
    fs.ownership!(sessionId!, entry.path)
      .then((o) => {
        if (!live) return;
        setCurrent(o);
        setOwner(o.owner);
        setGroup(o.group);
        setOwnerState("ready");
      })
      .catch((e) => {
        if (!live) return;
        setOwnerError(String(e?.message ?? e));
        setOwnerState("ready");
      });
    return () => {
      live = false;
    };
  }, [ownerEditable, fs, sessionId, entry.path]);

  const ownerDirty =
    owner.trim() !== (current?.owner ?? "") || group.trim() !== (current?.group ?? "") || recursive;
  const applyOwner = async () => {
    // Only send what changed, so a group-only edit doesn't need root for chown.
    const nextOwner = owner.trim() === current?.owner && !recursive ? "" : owner.trim();
    const nextGroup = group.trim() === current?.group && !recursive ? "" : group.trim();
    setOwnerState("saving");
    setOwnerError(null);
    try {
      await fs.chown!(sessionId!, entry.path, nextOwner, nextGroup, recursive);
      setCurrent({ owner: owner.trim() || current?.owner || "", group: group.trim() || current?.group || "" });
      setRecursive(false);
      setOwnerState("saved");
      onOwnerChanged?.();
    } catch (e) {
      setOwnerError(String((e as { message?: string })?.message ?? e));
      setOwnerState("ready");
    }
  };

  const rows: Array<{ label: string; value: React.ReactNode }> = [
    { label: "Type", value: KIND_LABEL[entry.kind] },
  ];
  if (entry.kind === "file") {
    rows.push({
      label: "Size",
      value: (
        <span>
          {fmtSize(entry.size)}
          <span className="ml-1.5 text-text-dim">
            ({entry.size.toLocaleString()} bytes)
          </span>
        </span>
      ),
    });
  }
  rows.push({ label: "Modified", value: fmtMtime(entry.modified) || "—" });
  if (entry.mode != null) {
    rows.push({
      label: "Permissions",
      value: (
        <span className="font-mono">
          {formatMode(entry.mode)}
          <span className="ml-1.5 text-text-dim">
            {(entry.mode & 0o777).toString(8)}
          </span>
        </span>
      ),
    });
  }

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
        className="anim-modal w-[28rem] max-w-[92vw] rounded-xl border border-border bg-bg-panel p-5 shadow-elev-3"
      >
        <div
          id={titleId}
          className="mb-3 truncate text-sm font-semibold"
          title={entry.name}
        >
          {entry.name}
        </div>
        <dl className="space-y-2 text-sm">
          {rows.map((r) => (
            <div key={r.label} className="flex gap-3">
              <dt className="w-28 shrink-0 text-text-muted">{r.label}</dt>
              <dd className="min-w-0 flex-1 break-words">{r.value}</dd>
            </div>
          ))}
          {ownerEditable && (
            <div className="flex gap-3">
              <dt className="w-28 shrink-0 pt-1 text-text-muted">Owner : group</dt>
              <dd className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <input
                    aria-label="Owner"
                    placeholder={ownerState === "loading" ? "Loading…" : "user"}
                    value={owner}
                    disabled={ownerState === "loading" || ownerState === "saving"}
                    onChange={(e) => { setOwner(e.target.value); setOwnerState("ready"); }}
                    className={inputCls + " font-mono"}
                  />
                  <span className="text-text-dim">:</span>
                  <input
                    aria-label="Group"
                    placeholder={ownerState === "loading" ? "" : "group"}
                    value={group}
                    disabled={ownerState === "loading" || ownerState === "saving"}
                    onChange={(e) => { setGroup(e.target.value); setOwnerState("ready"); }}
                    className={inputCls + " font-mono"}
                  />
                </div>
                {entry.kind === "directory" && (
                  <label className="mt-1.5 flex items-center gap-2 text-xs text-text-muted">
                    <input
                      type="checkbox"
                      checked={recursive}
                      disabled={ownerState === "loading" || ownerState === "saving"}
                      onChange={(e) => setRecursive(e.target.checked)}
                    />
                    Also apply to everything inside
                  </label>
                )}
                <div className="mt-1.5 flex items-center gap-2">
                  <button
                    onClick={applyOwner}
                    disabled={!ownerDirty || ownerState !== "ready" || (!owner.trim() && !group.trim())}
                    className="rounded-md border border-border px-2.5 py-1 text-xs hover:bg-bg-hover disabled:opacity-50"
                  >
                    {ownerState === "saving" ? "Applying…" : "Apply owner"}
                  </button>
                  {ownerState === "saved" && <span role="status" className="text-xs text-text-muted">Owner updated</span>}
                </div>
                {ownerError && (
                  <p role="alert" className="mt-1.5 whitespace-pre-line text-xs text-danger">{ownerError}</p>
                )}
              </dd>
            </div>
          )}
          <div className="flex gap-3">
            <dt className="w-28 shrink-0 text-text-muted">Path</dt>
            <dd className="min-w-0 flex-1 break-all font-mono text-xs text-text-muted">
              {entry.path}
            </dd>
          </div>
        </dl>
        <div className="mt-5 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3.5 py-1.5 text-sm hover:bg-bg-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
