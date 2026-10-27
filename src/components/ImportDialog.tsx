import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import {
  Download,
  FileText,
  FileJson,
  FolderOpen,
  Server,
  Terminal as TerminalIcon,
  ShieldOff,
  ShieldCheck,
  Cloud,
  Globe,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Lock,
} from "lucide-react";
import { ipc } from "@/lib/ipc";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { toast } from "@/stores/toastStore";
import { useDialog } from "@/hooks/useDialog";
import type {
  ImportNeed,
  ImportResolution,
  ImporterKind,
  ImporterPaths,
  ProfilePreview,
  Protocol,
} from "@/lib/types";
import { cn } from "@/lib/cn";

interface Props {
  onClose: () => void;
}

const TABS = [
  { id: "faro", label: "Faro file", icon: FileJson },
  { id: "openssh", label: "OpenSSH config", icon: TerminalIcon },
  { id: "filezilla", label: "FileZilla", icon: Server },
  { id: "putty", label: "PuTTY", icon: ShieldCheck },
] as const;

// Tabbed import dialog. Each tab auto-loads the importer's default-path
// listing on first activation; the user picks which entries to actually
// import. Selection state is per-tab so switching tabs doesn't lose work.
// The Faro tab reads `.faro` files from Export (or dropped on the window).
export function ImportDialog({ onClose }: Props) {
  const importFile = useLayout((s) => s.importFile);
  const [tab, setTab] = useState<ImporterKind>("faro");
  const [paths, setPaths] = useState<ImporterPaths | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialog(panelRef, { onClose });

  useEffect(() => {
    ipc.importerDefaultPaths().then(setPaths);
  }, []);

  return (
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="anim-modal flex max-h-[85vh] w-[38rem] max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3"
      >
        <div className="flex items-center gap-2 border-b border-border bg-bg-subtle px-4 py-3">
          <Download size={14} className="text-accent" />
          <span id={titleId} className="text-sm font-semibold">Import</span>
          <div className="flex-1" />
          <button
            onClick={onClose}
            className="rounded-md px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text"
          >
            Close
          </button>
        </div>

        <div role="tablist" className="flex border-b border-border bg-bg-panel px-2 pt-2">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "flex items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 text-[12px] transition-colors",
                tab === id
                  ? "border-accent text-text"
                  : "border-transparent text-text-muted hover:text-text"
              )}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>

        {TABS.map(({ id }) => (
          <ImporterTab
            key={id}
            active={tab === id}
            kind={id}
            paths={paths}
            initialPath={id === "faro" ? importFile ?? undefined : undefined}
            onDone={onClose}
          />
        ))}
      </div>
    </div>
  );
}

function ImporterTab({
  active,
  kind,
  paths,
  initialPath,
  onDone,
}: {
  active: boolean;
  kind: ImporterKind;
  paths: ImporterPaths | null;
  initialPath?: string;
  onDone: () => void;
}) {
  const loadProfiles = useConnections((s) => s.loadProfiles);
  const [path, setPath] = useState<string>(initialPath ?? "");
  const [pathTouched, setPathTouched] = useState(!!initialPath);
  const [previews, setPreviews] = useState<ProfilePreview[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [resolutions, setResolutions] = useState<Record<string, ImportResolution>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState<number | null>(null);
  const [autoScanned, setAutoScanned] = useState(false);
  // Faro tab: an encrypted file waiting for (or holding) its passphrase.
  const [locked, setLocked] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [withSecrets, setWithSecrets] = useState(false);
  // A Faro file picked with Browse (or dropped) is opened right away.
  const [openRequested, setOpenRequested] = useState(!!initialPath);

  // Pre-populate the path from the auto-detected default the moment paths arrive.
  useEffect(() => {
    if (paths && !pathTouched && kind !== "faro") {
      const next =
        kind === "openssh"
          ? paths.openssh ?? ""
          : kind === "filezilla"
            ? paths.filezilla ?? ""
            : paths.putty ?? "";
      setPath(next);
    }
  }, [paths, kind, pathTouched]);

  const defaultPath =
    kind === "openssh" ? paths?.openssh : kind === "filezilla" ? paths?.filezilla : null;
  const defaultExists =
    kind === "openssh" ? paths?.opensshExists : kind === "filezilla" ? paths?.filezillaExists : true;
  // The default file not existing is normal (no ~/.ssh/config yet, FileZilla
  // never installed): say so plainly instead of showing a read error.
  const missingDefault = !!paths && !defaultExists && !!path && path === defaultPath;

  const show = (result: ProfilePreview[]) => {
    setPreviews(result);
    // Select everything by default — users usually want to bring it all in
    // and then drop the few they don't. Duplicates default to Skip.
    setSelected(new Set(result.map((p) => p.previewId)));
    setResolutions(
      Object.fromEntries(result.filter((p) => p.conflict).map((p) => [p.previewId, "skip" as const]))
    );
  };

  const scan = useCallback(async () => {
    if (missingDefault) {
      setError(null);
      setPreviews(null);
      setAutoScanned(true);
      return;
    }
    setLoading(true);
    setError(null);
    setSavedCount(null);
    try {
      if (kind === "faro") {
        const r = await ipc.importFaroFile(path, passphrase || undefined);
        setLocked(r.encrypted);
        setWithSecrets(r.secrets);
        if (r.previews) show(r.previews);
        else setPreviews(null);
      } else if (kind === "openssh") {
        show(await ipc.importOpenssh(path || undefined));
      } else if (kind === "filezilla") {
        show(await ipc.importFilezilla(path || undefined));
      } else {
        show(await ipc.importPutty());
      }
    } catch (e) {
      setError(String(e));
      setPreviews(null);
    } finally {
      setLoading(false);
      setAutoScanned(true);
    }
  }, [kind, path, missingDefault, passphrase]);

  // Auto-scan when the tab opens, but only when the path is autodetected.
  useEffect(() => {
    if (active && !autoScanned && kind !== "faro" && !pathTouched && (kind === "putty" || path)) {
      scan();
    }
  }, [active, autoScanned, kind, path, pathTouched, scan]);

  useEffect(() => {
    if (active && openRequested && path) {
      setOpenRequested(false);
      scan();
    }
  }, [active, openRequested, path, scan]);

  const browse = async () => {
    const picked = await open({
      title: kind === "faro" ? "Choose a Faro connections file" : "Choose a file to import",
      multiple: false,
      filters:
        kind === "faro"
          ? [{ name: "Faro connections", extensions: ["faro"] }]
          : kind === "filezilla"
            ? [{ name: "FileZilla sites", extensions: ["xml"] }]
            : undefined,
    });
    if (typeof picked !== "string") return;
    setPath(picked);
    setPathTouched(true);
    setPreviews(null);
    setLocked(false);
    setPassphrase("");
    setError(null);
    setOpenRequested(true);
  };

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = useMemo(
    () => previews !== null && previews.every((p) => selected.has(p.previewId)),
    [previews, selected]
  );

  // What Import will actually save: ticked rows, minus duplicates set to Skip.
  const toImport = useMemo(
    () =>
      (previews ?? [])
        .filter((p) => selected.has(p.previewId))
        .filter((p) => !p.conflict || resolutions[p.previewId] !== "skip"),
    [previews, selected, resolutions]
  );

  const importSelected = async () => {
    if (toImport.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const n = await ipc.saveImportedProfiles(
        toImport.map((p) => ({ ...p, resolution: p.conflict ? resolutions[p.previewId] : undefined }))
      );
      setSavedCount(n);
      await loadProfiles();
      const unfinished = toImport.filter((p) => p.needs?.length).length;
      if (unfinished) {
        toast.info(
          `${unfinished} imported connection${unfinished === 1 ? " needs" : "s need"} a credential`,
          "Open them from the rail to pick a key, enter a password or sign in."
        );
      }
      // Auto-close after a moment so the user sees the success state.
      setTimeout(onDone, 900);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  const isRegistry = kind === "putty" && path.startsWith("HKCU\\");
  const conflicts = (previews ?? []).filter((p) => p.conflict).length;

  return (
    <div
      role="tabpanel"
      className={cn(
        "flex flex-1 flex-col overflow-hidden px-4 py-3",
        !active && "hidden"
      )}
    >
      <div className="mb-3 flex items-end gap-2">
        <label className="flex-1">
          <div className="mb-1 text-[10px] uppercase tracking-wider text-text-muted">
            {kind === "putty" && isRegistry ? "Source (registry)" : "File path"}
          </div>
          <input
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setPathTouched(true);
              setLocked(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && path) scan();
            }}
            disabled={isRegistry}
            className="w-full rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 font-mono text-[11.5px] outline-none focus:border-accent disabled:opacity-60"
            placeholder={hintFor(kind)}
          />
        </label>
        {kind !== "putty" && (
          <button
            onClick={browse}
            className="flex items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-[12px] hover:bg-bg-hover"
          >
            <FolderOpen size={12} />
            Browse…
          </button>
        )}
        <button
          onClick={scan}
          disabled={loading || (kind !== "putty" && !path)}
          className="flex items-center gap-1.5 rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-[12px] hover:bg-bg-hover disabled:opacity-40"
          title="Re-scan"
        >
          {loading ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          {kind === "faro" ? "Open" : "Scan"}
        </button>
      </div>

      {kind === "faro" && locked && previews === null && (
        <form
          className="mb-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (passphrase) scan();
          }}
        >
          <label className="flex-1">
            <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-text-muted">
              <Lock size={10} />
              This file is encrypted
            </div>
            <input
              type="password"
              aria-label="Passphrase"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoFocus
              placeholder="Passphrase"
              className="w-full rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-[12px] outline-none focus:border-accent"
            />
          </label>
          <button
            type="submit"
            disabled={loading || !passphrase}
            className="btn-accent rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            Unlock
          </button>
        </form>
      )}

      {error && (
        <div role="alert" className="mb-2 flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft px-2.5 py-2 text-[11.5px] text-text">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-danger" />
          <span className="break-all">{error}</span>
        </div>
      )}

      {savedCount !== null && (
        <div role="status" className="mb-2 flex items-center gap-2 rounded-md border border-accent/30 bg-accent-soft px-2.5 py-2 text-[11.5px]">
          <CheckCircle2 size={12} className="text-accent" />
          Imported {savedCount} connection{savedCount === 1 ? "" : "s"}.
        </div>
      )}

      <div className="flex-1 overflow-y-auto rounded-md border border-border bg-bg-subtle">
        {missingDefault && previews === null && !loading && !error && (
          <Empty>
            No {kind === "openssh" ? "OpenSSH config" : "FileZilla site list"} found at{" "}
            <code className="break-all font-mono text-[11px] text-text-muted">{path}</code>.{" "}
            {kind === "openssh"
              ? "That's normal if you've never created one."
              : "That's normal if FileZilla isn't installed or has no saved sites."}{" "}
            Choose a file, or try another tab.
          </Empty>
        )}
        {!missingDefault && previews === null && !loading && !error && !locked && (
          <Empty>
            {kind === "faro" ? (
              <>
                Choose a <strong>.faro</strong> file exported from Faro, or drop one onto the window.
              </>
            ) : (
              <>
                Click <strong>Scan</strong> to read connections from this source.
              </>
            )}
          </Empty>
        )}
        {previews && previews.length === 0 && (
          <Empty>
            No connections found.{" "}
            {kind === "faro"
              ? "The file is empty."
              : kind === "openssh"
                ? "Try editing the path — or check that ~/.ssh/config exists."
                : kind === "filezilla"
                  ? "Check that FileZilla has any saved sites."
                  : "No PuTTY sessions are registered for this user."}
          </Empty>
        )}
        {previews && previews.length > 0 && (
          <>
            <div className="sticky top-0 z-sticky flex items-center gap-2 border-b border-border bg-bg-panel px-3 py-1.5 text-[11px] text-text-muted">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelected(new Set(previews.map((p) => p.previewId)));
                  } else {
                    setSelected(new Set());
                  }
                }}
                className="accent-accent"
              />
              <span>
                {selected.size} of {previews.length} selected
              </span>
              <div className="flex-1" />
              {kind === "faro" && (
                <span className="text-text-dim">{withSecrets ? "with secrets" : "no secrets in this file"}</span>
              )}
              {conflicts > 0 && (
                <span className="text-text-dim">
                  · {conflicts} already exist{conflicts === 1 ? "s" : ""}
                </span>
              )}
            </div>
            {previews.map((p) => (
              <PreviewRow
                key={p.previewId}
                preview={p}
                checked={selected.has(p.previewId)}
                onToggle={() => toggle(p.previewId)}
                resolution={resolutions[p.previewId]}
                onResolve={(r) => setResolutions((prev) => ({ ...prev, [p.previewId]: r }))}
              />
            ))}
          </>
        )}
      </div>

      <div className="mt-3 flex items-center justify-end gap-2">
        <button
          onClick={onDone}
          className="rounded-md border border-border bg-bg-subtle px-3 py-1.5 text-xs hover:bg-bg-hover"
        >
          Cancel
        </button>
        <button
          onClick={importSelected}
          disabled={saving || toImport.length === 0}
          className="btn-accent flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40"
        >
          {saving ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <Download size={11} />
          )}
          Import {toImport.length > 0 ? `(${toImport.length})` : ""}
        </button>
      </div>
    </div>
  );
}

const NEED_LABEL: Record<ImportNeed, string> = {
  key: "needs a key",
  password: "needs a password",
  "sign-in": "needs sign-in",
  "token secret": "needs token secret",
};

const NEED_HINT: Record<ImportNeed, string> = {
  key: "No key file at this path on this machine; pick one in the connection editor.",
  password: "The password didn't come along; you'll be asked for it, or can save it in the editor.",
  "sign-in": "Sign in to this cloud account again after importing.",
  "token secret": "The Access service token secret didn't come along; enter it in the editor.",
};

function PreviewRow({
  preview: p,
  checked,
  onToggle,
  resolution,
  onResolve,
}: {
  preview: ProfilePreview;
  checked: boolean;
  onToggle: () => void;
  resolution?: ImportResolution;
  onResolve: (r: ImportResolution) => void;
}) {
  return (
    <div
      data-testid="import-row"
      className={cn(
        "border-b border-border-subtle px-3 py-2 hover:bg-bg-hover",
        checked ? "bg-bg-panel" : ""
      )}
    >
      <label className="flex cursor-pointer items-center gap-2.5">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="accent-accent"
        />
        <ProtocolBadge protocol={p.protocol} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12.5px] font-medium">{p.name}</div>
          <div className="truncate font-mono text-[11px] text-text-dim">
            {p.username ? `${p.username}@` : ""}
            {p.host}
            {p.port && p.port !== defaultPortFor(p.protocol)
              ? `:${p.port}`
              : ""}
          </div>
        </div>
        {p.needs?.map((n) => (
          <span
            key={n}
            title={NEED_HINT[n]}
            className="shrink-0 rounded bg-warning-soft px-1.5 py-0.5 text-[10px] text-text"
          >
            {NEED_LABEL[n]}
          </span>
        ))}
        {p.identityFile && !p.needs?.includes("key") && (
          <span
            title={p.identityFile}
            className="rounded bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-dim"
          >
            <FileText size={10} className="mr-0.5 inline align-text-bottom" />
            key
          </span>
        )}
        {p.note && (
          <span className="max-w-[9rem] truncate text-[10px] text-text-dim">{p.note}</span>
        )}
      </label>
      {p.conflict && checked && (
        <div className="mt-1.5 flex items-center gap-2 pl-6 text-[11px] text-text-muted">
          <span className="min-w-0 truncate">
            {p.conflict.byName ? "A connection named" : "Same server as"} “{p.conflict.name}” already exists.
          </span>
          <select
            aria-label={`What to do with ${p.name}`}
            value={resolution ?? "skip"}
            onChange={(e) => onResolve(e.target.value as ImportResolution)}
            className="ml-auto rounded border border-border bg-bg-subtle px-1.5 py-0.5 text-[11px] outline-none focus:border-accent"
          >
            <option value="skip">Skip</option>
            <option value="copy">Import as copy</option>
            <option value="replace">Replace</option>
          </select>
        </div>
      )}
    </div>
  );
}

function ProtocolBadge({ protocol }: { protocol: Protocol }) {
  let Icon = TerminalIcon;
  let label = protocol.toUpperCase();
  if (protocol === "ftp") Icon = ShieldOff;
  else if (protocol === "ftps") Icon = ShieldCheck;
  else if (protocol === "s3" || protocol === "azure" || protocol === "gcs") Icon = Cloud;
  else if (protocol === "webdav" || protocol === "http") Icon = Globe;
  else if (protocol === "dropbox" || protocol === "onedrive" || protocol === "gdrive" || protocol === "box") Icon = Cloud;
  return (
    <span className="flex h-5 items-center gap-1 rounded bg-bg-subtle px-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
      <Icon size={9} />
      {label}
    </span>
  );
}

function defaultPortFor(p: Protocol): number {
  if (p === "sftp") return 22;
  if (p === "ftp" || p === "ftps") return 21;
  return 443;
}

function hintFor(kind: ImporterKind): string {
  switch (kind) {
    case "faro":
      return "connections.faro";
    case "openssh":
      return "~/.ssh/config";
    case "filezilla":
      return "sitemanager.xml";
    case "putty":
      return "(PuTTY registry)";
  }
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-10 text-center text-[12px] text-text-dim">
      {children}
    </div>
  );
}
