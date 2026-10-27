import { useId, useMemo, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { Upload, Loader2, Lock, FileJson, Terminal as TerminalIcon } from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useConnections } from "@/stores/connectionsStore";
import { useDialog } from "@/hooks/useDialog";
import { toast } from "@/stores/toastStore";
import { toastError } from "@/lib/errors";
import type { ExportRequest } from "@/stores/layoutStore";
import type { ConnectionProfile, ExportFormat } from "@/lib/types";
import { cn } from "@/lib/cn";

interface Props {
  request: ExportRequest | null;
  onClose: () => void;
}

const isSsh = (p: ConnectionProfile) => p.protocol === "sftp";

/** A file name from a connection or group name. */
function fileStem(label: string | undefined): string {
  const stem = (label ?? "").trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ");
  return stem || "faro-connections";
}

// Export connections as a `.faro` file (no secrets, or all of them encrypted
// with a passphrase) or as OpenSSH Host blocks. Opened from a connection's or
// group's rail menu (pre-ticked), or File > Export (everything).
export function ExportDialog({ request, onClose }: Props) {
  const profiles = useConnections((s) => s.profiles);
  const [format, setFormat] = useState<ExportFormat>(request?.format ?? "faro");
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(request?.ids ?? profiles.map((p) => p.id))
  );
  const [secrets, setSecrets] = useState(false);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, { onClose });

  // Ungrouped first, then each group, like the rail.
  const sections = useMemo(() => {
    const groups = new Map<string, ConnectionProfile[]>();
    for (const p of profiles) {
      const g = p.group ?? "";
      groups.set(g, [...(groups.get(g) ?? []), p]);
    }
    return [...groups.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  }, [profiles]);

  const usable = (p: ConnectionProfile) => format === "faro" || isSsh(p);
  const chosen = profiles.filter((p) => selected.has(p.id) && usable(p));
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allChosen = profiles.filter(usable).every((p) => selected.has(p.id));

  const passProblem =
    format === "faro" && secrets
      ? pass.length < 8
        ? "Use a passphrase of at least 8 characters."
        : pass !== pass2
          ? "The passphrases don't match."
          : null
      : null;

  const doExport = async () => {
    if (chosen.length === 0 || passProblem) return;
    const stem = fileStem(request?.label);
    const path = await save(
      format === "faro"
        ? {
            title: "Export connections",
            defaultPath: `${stem}.faro`,
            filters: [{ name: "Faro connections", extensions: ["faro"] }],
          }
        : { title: "Export as OpenSSH config", defaultPath: `${stem}.ssh_config` }
    );
    if (!path) return;
    setBusy(true);
    try {
      const s = await ipc.exportConnections({
        ids: chosen.map((p) => p.id),
        path,
        format,
        includeSecrets: format === "faro" && secrets,
        passphrase: format === "faro" && secrets ? pass : undefined,
      });
      const notes = [
        s.addedJumps.length ? `Added the jump host${s.addedJumps.length === 1 ? "" : "s"} ${s.addedJumps.join(", ")}.` : "",
        s.skipped.length ? `Left out (not SSH): ${s.skipped.join(", ")}.` : "",
        format === "faro" && secrets ? "Encrypted; share the passphrase separately." : "",
      ].filter(Boolean);
      toast.success(
        `Exported ${s.connections} connection${s.connections === 1 ? "" : "s"}`,
        [path, ...notes].join(" ")
      );
      onClose();
    } catch (e) {
      toastError(e, "Export failed");
    } finally {
      setBusy(false);
    }
  };

  const input =
    "w-full rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-[12px] outline-none focus:border-accent";

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="anim-modal flex max-h-[85vh] w-[34rem] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-4 py-3">
          <Upload size={14} className="text-accent" />
          <span id={titleId} className="text-sm font-semibold">Export</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="rounded-md px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text"
          >
            Close
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-3 overflow-hidden px-4 py-3">
          <div role="radiogroup" aria-label="Format" className="grid grid-cols-2 gap-2">
            {(
              [
                { id: "faro", label: "Faro file", hint: "Every connection, route and group", icon: FileJson },
                { id: "openssh", label: "OpenSSH config", hint: "Host blocks for SSH connections", icon: TerminalIcon },
              ] as const
            ).map(({ id, label, hint, icon: Icon }) => (
              <button
                key={id}
                role="radio"
                aria-checked={format === id}
                onClick={() => setFormat(id)}
                className={cn(
                  "flex items-start gap-2 rounded-md border px-3 py-2 text-left",
                  format === id ? "border-accent bg-accent-soft" : "border-border bg-bg-subtle hover:bg-bg-hover"
                )}
              >
                <Icon size={13} className="mt-0.5 shrink-0 text-text-muted" />
                <span>
                  <span className="block text-[12px] font-medium">{label}</span>
                  <span className="block text-[10.5px] text-text-dim">{hint}</span>
                </span>
              </button>
            ))}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-bg-subtle">
            <label className="flex items-center gap-2 border-b border-border bg-bg-panel px-3 py-1.5 text-[11px] text-text-muted">
              <input
                type="checkbox"
                checked={allChosen}
                onChange={(e) =>
                  setSelected(e.target.checked ? new Set(profiles.filter(usable).map((p) => p.id)) : new Set())
                }
                className="accent-accent"
              />
              <span data-testid="export-count">
                {chosen.length} of {profiles.filter(usable).length} selected
              </span>
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {sections.map(([group, members]) => (
                <div key={group || "(ungrouped)"}>
                  {group && (
                    <div className="px-3 pb-0.5 pt-2 text-[10px] uppercase tracking-wider text-text-dim">{group}</div>
                  )}
                  {members.map((p) => (
                    <label
                      key={p.id}
                      className={cn(
                        "flex items-center gap-2.5 px-3 py-1.5 hover:bg-bg-hover",
                        usable(p) ? "cursor-pointer" : "cursor-not-allowed opacity-50"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(p.id) && usable(p)}
                        disabled={!usable(p)}
                        onChange={() => toggle(p.id)}
                        className="accent-accent"
                      />
                      <span className="min-w-0 flex-1 truncate text-[12px]">{p.name}</span>
                      <span className="truncate font-mono text-[10.5px] text-text-dim">
                        {usable(p) ? `${p.username ? `${p.username}@` : ""}${p.host}` : "not SSH"}
                      </span>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </div>

          {format === "faro" ? (
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-2 text-[12px]">
                <input
                  type="checkbox"
                  checked={secrets}
                  onChange={(e) => setSecrets(e.target.checked)}
                  className="accent-accent"
                />
                <Lock size={12} className="text-text-muted" />
                Include secrets
              </label>
              {secrets ? (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="password"
                      aria-label="Passphrase"
                      value={pass}
                      onChange={(e) => setPass(e.target.value)}
                      placeholder="Passphrase"
                      autoComplete="new-password"
                      className={input}
                    />
                    <input
                      type="password"
                      aria-label="Confirm passphrase"
                      value={pass2}
                      onChange={(e) => setPass2(e.target.value)}
                      placeholder="Confirm passphrase"
                      autoComplete="new-password"
                      className={input}
                    />
                  </div>
                  <p className="text-[11px] text-text-dim">
                    Saved passwords, key passphrases, keychain keys and service token secrets are included, and
                    the file is encrypted with this passphrase. Share it separately from the file.
                    {passProblem && pass && <span className="block text-warning">{passProblem}</span>}
                  </p>
                </>
              ) : (
                <p className="text-[11px] text-text-dim">
                  No passwords, passphrases or token secrets are written. Key file paths are kept as hints;
                  whoever imports it picks their own key or types the password.
                </p>
              )}
            </div>
          ) : (
            <p className="text-[11px] text-text-dim">
              One Host block per SSH connection, with its jump host, proxy, Cloudflare Access route and
              certificate. No secrets. Paste it into ~/.ssh/config, or import it back in Faro.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-xs hover:bg-bg-hover"
          >
            Cancel
          </button>
          <button
            onClick={doExport}
            disabled={busy || chosen.length === 0 || !!passProblem}
            className="btn-accent flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
            Export{chosen.length > 0 ? ` (${chosen.length})` : ""}…
          </button>
        </div>
      </div>
    </div>
  );
}
