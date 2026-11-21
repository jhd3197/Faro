import { useEffect, useId, useRef } from "react";
import { ArrowRight, FileCode2, Loader2, Plus, Server, ShieldCheck, TerminalSquare, X, Cloud } from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { useLayout } from "@/stores/layoutStore";
import { useDiscovery, type FoundSource } from "@/stores/discoveryStore";
import { openExternal } from "@/lib/openExternal";
import { cn } from "@/lib/cn";
import { releaseChanges } from "@/lib/releaseNotes";
import { formatCombo } from "@/lib/shortcuts";
import { BrandIcon, protocolIcon } from "@/lib/brandIcons";
import type { Protocol } from "@/lib/types";

const secondary = "inline-flex items-center justify-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text hover:bg-bg-hover";
const primary = "inline-flex items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90";
// The heading takes focus so screen readers announce the dialog, but it isn't a
// control: no focus ring around a title that can't be acted on.
const headingFocus = "outline-none focus-visible:!outline-none";

const NEW_CONNECTIONS: { protocol: Protocol | null; label: string; detail: string }[] = [
  { protocol: "sftp", label: "SFTP / SSH", detail: "Files, terminal, server view" },
  { protocol: "ftp", label: "FTP / FTPS", detail: "Shared hosting, legacy servers" },
  { protocol: "s3", label: "S3-compatible", detail: "AWS, R2, B2, Wasabi, MinIO" },
  { protocol: "azure", label: "Azure Blob", detail: "Containers and blobs" },
  { protocol: "webdav", label: "WebDAV", detail: "Nextcloud, NAS, web servers" },
  { protocol: null, label: "More types", detail: "Cloud drives, WordPress, more" },
];

const SOURCE_ICON = { openssh: TerminalSquare, filezilla: Server, putty: ShieldCheck, cli: Cloud } as const;

export function DiscoveryDialog({ mode }: { mode: "welcome" | "whatsNew" }) {
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const version = useDiscovery(s => s.version);
  const close = () => {
    useDiscovery.getState().acknowledge();
    useLayout.getState().closeDialog();
  };
  useDialog(panel, { onClose: close, initialFocus: heading });
  return <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}
      className="anim-modal flex max-h-[90vh] w-full max-w-[40rem] flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3">
      <header className="flex items-center justify-between border-b border-border px-5 py-2.5">
        <span className="text-[11px] text-text-dim"><span className="font-semibold text-text-muted">Faro</span>{version ? ` ${version}` : ""}</span>
        <button onClick={close} aria-label={mode === "welcome" ? "Close welcome" : "Close release notes"} className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"><X size={16} /></button>
      </header>
      {mode === "welcome"
        ? <Welcome heading={heading} titleId={titleId} close={close} />
        : <WhatsNew heading={heading} titleId={titleId} close={close} />}
    </div>
  </div>;
}

function Welcome({ heading, titleId, close }: { heading: React.RefObject<HTMLHeadingElement>; titleId: string; close: () => void }) {
  const found = useDiscovery(s => s.found);
  useEffect(() => { void useDiscovery.getState().scanImports(); }, []);
  const leaveTo = (open: () => void) => {
    useDiscovery.getState().acknowledge();
    open();
  };
  return <>
    <div className="overflow-y-auto px-5 py-5">
      <h1 ref={heading} tabIndex={-1} id={titleId} className={cn("text-lg font-semibold tracking-tight", headingFocus)}>Get connected</h1>
      <p className="mt-1 text-sm text-text-muted">One list for your servers and storage. Bring over the connections you already have, or add one.</p>

      <section aria-labelledby={`${titleId}-found`} className="mt-5">
        <h2 id={`${titleId}-found`} className="mb-2 text-xs font-medium text-text-muted">Found on this computer</h2>
        {found === null
          ? <p role="status" className="flex items-center gap-2 rounded-md border border-border px-3 py-2.5 text-xs text-text-dim"><Loader2 size={13} className="animate-spin" /> Looking in OpenSSH, FileZilla and PuTTY…</p>
          : found.length === 0
            ? <p className="rounded-md border border-dashed border-border px-3 py-2.5 text-xs text-text-dim">No new connections in OpenSSH, FileZilla or PuTTY on this computer.</p>
            : <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {found.map(source => <FoundRow key={source.kind} source={source} onImport={() => leaveTo(() => useLayout.getState().openImport(undefined, source.kind))} />)}
            </ul>}
      </section>

      <section aria-labelledby={`${titleId}-new`} className="mt-5">
        <h2 id={`${titleId}-new`} className="mb-2 text-xs font-medium text-text-muted">New connection</h2>
        <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
          {NEW_CONNECTIONS.map(item => <button key={item.label}
            onClick={() => leaveTo(() => useLayout.getState().openNewConnection(item.protocol ? { protocol: item.protocol } : undefined))}
            className="group flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5 text-left hover:border-accent/60 hover:bg-bg-hover">
            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-text-muted group-hover:text-accent">
              {item.protocol ? <BrandIcon icon={protocolIcon(item.protocol)} size={16} /> : <Plus size={15} />}
            </span>
            <span className="min-w-0">
              <span className="block text-xs font-medium text-text">{item.label}</span>
              <span className="block truncate text-[11px] text-text-dim">{item.detail}</span>
            </span>
          </button>)}
        </div>
      </section>
    </div>
    <footer className="flex flex-wrap items-center gap-3 border-t border-border bg-bg-subtle px-5 py-3">
      <p className="flex-1 text-[11px] text-text-dim"><kbd className="rounded border border-border bg-bg-panel px-1 font-mono text-[10px] text-text-muted">{formatCombo("mod+k")}</kbd> opens every command. Help › Welcome brings this back.</p>
      <button className={secondary} onClick={close}>Browse local files</button>
    </footer>
  </>;
}

function FoundRow({ source, onImport }: { source: FoundSource; onImport: () => void }) {
  const Icon = (SOURCE_ICON as Record<string, typeof Server>)[source.kind] ?? FileCode2;
  return <li className="flex items-center gap-3 px-3 py-2">
    <Icon size={14} className="shrink-0 text-text-muted" />
    <span className="min-w-0 flex-1">
      <span className="block text-xs font-medium text-text">{source.label}</span>
      {source.path && <span className="block truncate font-mono text-[11px] text-text-dim" title={source.path}>{source.path}</span>}
    </span>
    <span className="shrink-0 text-xs tabular-nums text-text-muted">{source.countLabel ?? `${source.count} ${source.count === 1 ? "connection" : "connections"}`}</span>
    <button className={primary} onClick={onImport}>Import <ArrowRight size={12} /></button>
  </li>;
}

function WhatsNew({ heading, titleId, close }: { heading: React.RefObject<HTMLHeadingElement>; titleId: string; close: () => void }) {
  const version = useDiscovery(s => s.version);
  const since = useDiscovery(s => s.since);
  const releases = useDiscovery(s => s.releases);
  const loading = useDiscovery(s => s.loadingReleases);
  useEffect(() => { if (!useDiscovery.getState().releases) void useDiscovery.getState().loadReleases(); }, []);
  const many = (releases?.length ?? 0) > 1;
  const url = version && !many ? `https://github.com/jhd3197/Faro/releases/tag/v${encodeURIComponent(version)}` : "https://github.com/jhd3197/Faro/releases";
  return <>
    <div className="overflow-y-auto px-5 py-5">
      <h1 ref={heading} tabIndex={-1} id={titleId} className={cn("text-lg font-semibold tracking-tight", headingFocus)}>What's new</h1>
      <p className="mt-1 text-sm text-text-muted">{since && many ? `Everything since ${since}, newest first.` : version ? `Faro ${version}` : "This version of Faro"}</p>
      <div className="mt-4">
        {!releases || loading
          ? <p role="status" className="flex items-center gap-2 text-sm text-text-muted"><Loader2 size={13} className="animate-spin" /> Loading release notes…</p>
          : <div className="divide-y divide-border">
            {releases.map(r => <section key={r.version} aria-label={`Faro ${r.version}`} className="py-3 first:pt-0 last:pb-0">
              {many && <h2 className="mb-1 font-mono text-xs text-text-dim">{r.version}{r.version === version ? " · installed" : ""}</h2>}
              <ReleaseNotesText notes={r.notes} fallback={many ? "No summary for this release." : undefined} />
            </section>)}
          </div>}
      </div>
    </div>
    <footer className="flex items-center gap-3 border-t border-border bg-bg-subtle px-5 py-3">
      <button className={secondary} onClick={() => openExternal(url)}>Full release notes</button>
      <div className="flex-1" />
      <button className={primary} onClick={close}>Done</button>
    </footer>
  </>;
}

// Bold, inline code and link text only; a link's target is dropped, never followed.
function inline(text: string) {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]*\))/).map((part, i) =>
    /^`[^`]+`$/.test(part) ? <code key={i} className="rounded bg-bg-subtle px-1 font-mono text-[0.92em] text-text">{part.slice(1, -1)}</code>
    : /^\*\*[^*]+\*\*$/.test(part) ? <strong key={i} className="font-semibold text-text">{part.slice(2, -2)}</strong>
    : /^\[[^\]]+\]\([^)]*\)$/.test(part) ? part.slice(1, part.indexOf("]"))
    : part);
}

/** A release body's marked summary as inert text, or a pointer to the full notes when it has none. */
export function ReleaseNotesText({ notes, fallback }: { notes: string | null; fallback?: string }) {
  const changes = releaseChanges(notes);
  if (!changes) return <p className="text-sm text-text-muted">{fallback ?? "This release has no summary in Faro. Open the full release notes to see what changed."}</p>;
  return <div className="space-y-2 break-words text-sm leading-relaxed text-text-muted">{changes.split(/\r?\n/).filter(line => line.trim()).map((line, i) => /^#{1,6}\s/.test(line)
    ? <h3 key={i} className="pt-1 font-semibold text-text">{inline(line.replace(/^#{1,6}\s+/, ""))}</h3>
    : /^\s*[-*]\s/.test(line) ? <p key={i} className="flex gap-2"><span aria-hidden="true">•</span><span>{inline(line.replace(/^\s*[-*]\s+/, ""))}</span></p>
    : <p key={i}>{inline(line)}</p>)}</div>;
}
