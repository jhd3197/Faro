import { useId, useRef, useState } from "react";
import { Folder, X } from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { useSites, type SiteShortcut } from "@/stores/sitesStore";
import { messageOf } from "@/lib/errors";

export function SiteDialog({ profileId, serverName, path, site, onClose }: {
  profileId: string;
  serverName: string;
  path: string;
  site?: SiteShortcut;
  onClose: () => void;
}) {
  const [name, setName] = useState(site?.name ?? path.split(/[/\\]/).filter(Boolean).pop() ?? serverName);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const inputId = useId();
  useDialog(panel, { onClose: () => { if (!saving) onClose(); }, initialFocus: input });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      await useSites.getState().save({ id: site?.id ?? crypto.randomUUID(), profileId, name, path });
      onClose();
    } catch (e) {
      setError(messageOf(e));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60" onClick={() => !saving && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}
        onClick={e => e.stopPropagation()} className="anim-modal w-[26rem] max-w-[92vw] rounded-xl border border-border bg-bg-panel p-5 shadow-elev-3">
        <div className="mb-5 flex items-center justify-between">
          <h2 id={titleId} className="text-sm font-semibold">{site ? "Rename site" : "Save as site"}</h2>
          <button type="button" aria-label="Close" disabled={saving} onClick={onClose} className="rounded p-1 text-text-muted hover:bg-bg-hover"><X size={16} /></button>
        </div>
        <form onSubmit={submit}>
          <label htmlFor={inputId} className="mb-1.5 block text-xs font-medium">Site name</label>
          <input ref={input} id={inputId} value={name} maxLength={120} disabled={saving}
            onFocus={e => e.currentTarget.select()} onChange={e => setName(e.target.value)}
            className="w-full rounded-md border border-border bg-bg-subtle px-3 py-2 text-sm outline-none focus:border-accent" />
          <div className="my-4 flex gap-2.5 text-text-muted">
            <Folder size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 text-xs"><div className="font-medium text-text">{serverName}</div><div className="mt-1 break-all font-mono text-[11px]">{path}</div></div>
          </div>
          <p className="text-xs leading-relaxed text-text-dim">Uses this server’s connection and permissions.</p>
          {error && <p role="alert" className="mt-3 text-xs text-danger">{error}</p>}
          <div className="mt-5 flex justify-end gap-2">
            <button type="button" disabled={saving} onClick={onClose} className="rounded-md border border-border px-3.5 py-1.5 text-sm hover:bg-bg-hover">Cancel</button>
            <button type="submit" disabled={!name.trim() || saving} className="btn-accent rounded-md px-3.5 py-1.5 text-sm font-medium text-white disabled:opacity-40">{saving ? "Saving…" : site ? "Save name" : "Save site"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
