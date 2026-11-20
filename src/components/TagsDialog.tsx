import { useEffect, useState } from "react";
import { Tag, X } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useIndex } from "@/stores/indexStore";
import { toast } from "@/stores/toastStore";
import { Dialog } from "@/components/ui/Dialog";

/// Tags for one or more files on a connection. Tags every file already has
/// show as chips (× removes them from all); new ones are added to all. On
/// S3-compatible and Azure connections they're stored in the object's
/// metadata too.
export function TagsDialog() {
  const req = useIndex((s) => s.tagsRequest);
  const close = useIndex((s) => s.closeTags);
  const [shared, setShared] = useState<string[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!req) return;
    setRemoved([]);
    setInput("");
    setError(null);
    // Chips = tags on every selected file.
    void Promise.all(req.paths.map((p) => ipc.tagsGet(req.connectionId, p)))
      .then((lists) => setShared(lists.reduce((acc, l) => acc.filter((t) => l.includes(t)), lists[0] ?? [])))
      .catch(() => setShared([]));
  }, [req]);

  if (!req) return null;
  const add = input
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);

  const save = async () => {
    try {
      const r = await ipc.tagsApply(req.connectionId, req.paths, add, removed);
      if (r.errors?.length) {
        setError(r.errors.join("\n"));
        return false;
      }
      toast.success(
        "Tags saved",
        r.localOnly
          ? `${r.updated} file${r.updated === 1 ? "" : "s"} — kept on this PC (this connection can't store tags).`
          : `${r.updated} file${r.updated === 1 ? "" : "s"} — stored with the files too.`
      );
      void useIndex.getState().refreshRoots();
      close();
    } catch (e) {
      setError(String(e));
      return false;
    }
  };

  return (
    <Dialog
      title={req.paths.length === 1 ? `Tags — ${req.paths[0].split(/[\\/]/).pop()}` : `Tags — ${req.paths.length} files`}
      icon={<Tag size={14} />}
      onClose={close}
      onConfirm={save}
      confirmLabel="Save"
      confirmDisabled={add.length === 0 && removed.length === 0}
      data-testid="tags-dialog"
    >
      <div className="flex flex-col gap-2 text-[12px]">
        <div className="flex flex-wrap gap-1">
          {shared.filter((t) => !removed.includes(t)).map((t) => (
            <span key={t} className="flex items-center gap-1 rounded bg-bg-hover px-1.5 py-0.5" data-tag={t}>
              {t}
              <button aria-label={`Remove ${t}`} onClick={() => setRemoved((r) => [...r, t])} className="text-text-dim hover:text-text">
                <X size={10} />
              </button>
            </span>
          ))}
          {shared.length === removed.length && <span className="text-text-dim">No shared tags yet.</span>}
        </div>
        <input
          aria-label="Add tags"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Add tags, comma-separated"
          className="rounded border border-border bg-bg-panel px-2 py-1"
        />
        {error && <div className="whitespace-pre-wrap rounded border border-danger/40 px-2 py-1.5 text-danger">{error}</div>}
      </div>
    </Dialog>
  );
}
