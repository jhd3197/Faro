import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, Columns2, Folder, Radio, Server, TerminalSquare, X } from "lucide-react";
import { useDialog } from "@/hooks/useDialog";
import { useLayout } from "@/stores/layoutStore";
import { NOTES_KEY, useDiscovery } from "@/stores/discoveryStore";
import { ipc } from "@/lib/ipc";
import { openExternal } from "@/lib/openExternal";
import { cn } from "@/lib/cn";
import { releaseChanges } from "@/lib/releaseNotes";

const steps = [
  { title: "Welcome to Faro", text: "Connect to your servers and cloud storage, move files, and keep a terminal close by.", icon: Server },
  { title: "Your connections live on the left", text: "Add a connection with your provider and credentials, or import connections you already use. Select a saved connection to browse its files.", icon: Server },
  { title: "Move files between two panes", text: "Keep a local folder beside a remote folder. Select files, then upload or download. Try a practice upload below.", icon: Columns2 },
  { title: "Keep tools within reach", text: "SFTP connections include an SSH terminal. Folder Sync keeps chosen folders in sync, and Agent Bridge gives your AI tools controlled access.", icon: TerminalSquare },
  { title: "Make your first connection", text: "You're ready. Add a server or storage account, import saved connections, or explore Faro on your own.", icon: Check },
];
const secondary = "rounded-md border border-border px-3 py-2 text-sm hover:bg-bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent";
const primary = "inline-flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

export function DiscoveryDialog({ mode }: { mode: "welcome" | "whatsNew" }) {
  const [step, setStep] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const version = useDiscovery(s => s.version);
  const close = () => {
    useDiscovery.getState().acknowledge();
    useLayout.getState().closeDialog();
  };
  const go = (destination: "newConnection" | "import") => {
    useDiscovery.getState().acknowledge();
    useLayout.getState().openDialog(destination);
  };
  useDialog(panel, { onClose: close, initialFocus: heading });
  useEffect(() => { heading.current?.focus(); }, [step]);
  const current = steps[step];
  const Icon = current.icon;
  return <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={titleId}
      className="anim-modal flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border bg-bg-panel shadow-elev-3">
      <header className="flex items-center justify-between border-b border-border px-6 py-3">
        <span className="text-xs font-medium text-text-muted">FARO <span className="ml-2 text-text-dim">{mode === "welcome" ? "Getting started" : version ? `Version ${version}` : "Release notes"}</span></span>
        <button onClick={close} aria-label="Close introduction" className="rounded p-1 text-text-muted hover:bg-bg-hover"><X size={18} /></button>
      </header>
      <div className="overflow-y-auto p-6 sm:p-8">
        {mode === "welcome" ? <>
          <Icon size={28} className="mb-5 text-accent" />
          <h1 ref={heading} tabIndex={-1} id={titleId} className="text-2xl font-semibold tracking-tight outline-none">{current.title}</h1>
          <p className="mt-3 max-w-lg text-sm leading-relaxed text-text-muted">{current.text}</p>
          <div className="mt-6">
            {step === 0 && <div className="grid grid-cols-3 divide-x divide-border rounded-lg border border-border bg-bg-subtle py-5 text-center text-xs text-text-muted">
              {[{ icon: Server, label: "Connect" }, { icon: Columns2, label: "Transfer" }, { icon: TerminalSquare, label: "Work" }].map(({ icon: Item, label }) => <div key={label}><Item size={22} className="mx-auto mb-3 text-accent" />{label}</div>)}
            </div>}
            {step === 1 && <ConnectionPractice />}
            {step === 2 && <TransferPractice />}
            {step === 3 && <ToolsPractice />}
            {step === 4 && <div className="flex flex-wrap gap-3"><button className={primary} onClick={() => go("newConnection")}>Add connection <ArrowRight size={15} /></button><button className={secondary} onClick={() => go("import")}>Import connections</button></div>}
          </div>
          <p className="mt-5 text-xs text-text-dim">{step > 0 && step < 4 ? "Practice only — no servers are contacted or files changed." : "You can replay this walkthrough from Help at any time."}</p>
        </> : <>
          <h1 ref={heading} tabIndex={-1} id={titleId} className="text-2xl font-semibold outline-none">What's new in Faro{version ? ` ${version}` : ""}</h1>
          <InstalledNotes version={version} />
        </>}
      </div>
      <footer className="flex flex-wrap items-center gap-3 border-t border-border bg-bg-subtle px-6 py-4">
        {mode === "welcome" ? <>
          <nav aria-label="Walkthrough steps" className="flex gap-1.5">
            {steps.map((item, i) => <button key={item.title} onClick={() => setStep(i)} aria-label={`Step ${i + 1}: ${item.title}`} aria-current={step === i ? "step" : undefined}
              className={cn("h-7 w-7 rounded-full text-xs", step === i ? "bg-accent text-white" : "text-text-muted hover:bg-bg-hover")}>{i + 1}</button>)}
          </nav>
          <div className="flex-1" />
          {step > 0 && <button className={secondary} onClick={() => setStep(step - 1)}>Back</button>}
          {step < 4 ? <><button className="text-xs text-text-muted hover:text-text" onClick={close}>Skip tour</button><button className={primary} onClick={() => setStep(step + 1)}>{step === 0 ? "Take a quick tour" : "Next"}<ArrowRight size={14} /></button></> : <button className={secondary} onClick={close}>Start exploring</button>}
        </> : <><button className={secondary} onClick={() => { useDiscovery.getState().acknowledge(); useLayout.getState().openDialog("welcome"); }}>Explore Faro</button><div className="flex-1" /><button className={primary} onClick={close}>Done</button></>}
      </footer>
    </div>
  </div>;
}

function ConnectionPractice() {
  const [selected, setSelected] = useState(false);
  return <div className="flex min-h-36 overflow-hidden rounded-lg border border-border">
    <div className="flex w-20 shrink-0 justify-center border-r border-border bg-bg-subtle py-5"><button aria-label="Select demo server" aria-pressed={selected} onClick={() => setSelected(true)} className={cn("h-11 w-11 rounded-xl border", selected ? "border-accent bg-accent/10 text-accent" : "border-border hover:bg-bg-hover")}><Server size={20} className="mx-auto" /></button></div>
    <div className="p-5 text-sm" role="status">{selected ? <><span className="flex items-center gap-2 font-medium"><Check size={16} className="text-accent" /> Demo server selected</span><p className="mt-3 font-mono text-xs text-text-muted">/home/demo</p><p className="mt-2 flex items-center gap-2 text-text-muted"><Folder size={15} /> website</p></> : <p className="text-text-muted">Select the server on the left to open its files.</p>}</div>
  </div>;
}

function TransferPractice() {
  const [selected, setSelected] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  return <div className="overflow-hidden rounded-lg border border-border">
    <div className="grid grid-cols-2 divide-x divide-border">
      <div className="p-4"><p className="mb-3 text-xs text-text-dim">Local / website</p><button aria-pressed={selected} onClick={() => setSelected(!selected)} className={cn("w-full rounded px-2 py-2 text-left font-mono text-xs", selected ? "bg-accent/15 text-accent" : "bg-bg-subtle hover:bg-bg-hover")}>{selected ? "✓ " : ""}index.html</button></div>
      <div className="p-4"><p className="mb-3 text-xs text-text-dim">Demo server / public</p><p className="py-2 font-mono text-xs text-text-muted">{uploaded ? "index.html" : "Empty folder"}</p></div>
    </div>
    <div className="flex items-center gap-3 border-t border-border bg-bg-subtle p-3"><button disabled={!selected || uploaded} onClick={() => setUploaded(true)} className={cn(primary, "disabled:opacity-40")}>Upload <ArrowRight size={14} /></button><span role="status" className="text-xs text-text-muted">{uploaded ? "Practice upload complete. Track real uploads in Transfers." : "Select index.html, then choose Upload."}</span></div>
  </div>;
}

function ToolsPractice() {
  const [tool, setTool] = useState(0);
  const tools = [
    { name: "Terminal", icon: TerminalSquare, detail: "On an SFTP connection, choose View → Toggle terminal to open a shell beside your files." },
    { name: "Folder Sync", icon: Folder, detail: "Open Settings → Folder Sync to choose a local folder, a remote folder, and a sync direction. Review the pair before starting it." },
    { name: "Agent Bridge", icon: Radio, detail: "Open the Agent Bridge to configure access for AI tools. Review permissions and approval requests before allowing changes." },
  ];
  return <div className="rounded-lg border border-border bg-bg-subtle p-4"><div className="flex flex-wrap gap-2">{tools.map((item, i) => <button key={item.name} aria-pressed={tool === i} onClick={() => setTool(i)} className={cn(secondary, "flex items-center gap-2", tool === i && "border-accent text-accent")}><item.icon size={14} />{item.name}</button>)}</div><p role="status" className="mt-4 min-h-16 text-sm leading-relaxed text-text-muted">{tools[tool].detail}</p></div>;
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
export function ReleaseNotesText({ notes }: { notes: string | null }) {
  const changes = releaseChanges(notes);
  if (!changes) return <p className="text-sm text-text-muted">This release has no summary in Faro. Open the full release notes to see what changed.</p>;
  return <div className="space-y-2 break-words text-sm leading-relaxed text-text-muted">{changes.split(/\r?\n/).filter(line => line.trim()).map((line, i) => /^#{1,6}\s/.test(line)
    ? <h3 key={i} className="pt-2 font-semibold text-text">{inline(line.replace(/^#{1,6}\s+/, ""))}</h3>
    : /^\s*[-*]\s/.test(line) ? <p key={i} className="flex gap-2"><span aria-hidden="true">•</span><span>{inline(line.replace(/^\s*[-*]\s+/, ""))}</span></p>
    : <p key={i}>{inline(line)}</p>)}</div>;
}

function InstalledNotes({ version }: { version: string | null }) {
  const cached = useDiscovery(s => s.installedNotes);
  const [notes, setNotes] = useState(cached?.notes ?? null);
  const [loading, setLoading] = useState(!cached?.notes);
  useEffect(() => {
    if (cached?.notes) { setNotes(cached.notes); setLoading(false); return; }
    let cancelled = false;
    void ipc.appUpdateRelease().then(release => {
      if (!cancelled && release.version === version) {
        setNotes(release.notes);
        if (release.notes) {
          useDiscovery.setState({ installedNotes: { version: release.version, notes: release.notes } });
          void ipc.settingsSet(`${NOTES_KEY}:${version}`, JSON.stringify({ version, notes: release.notes })).catch(() => {});
        }
      }
    }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [version, cached]);
  return <div className="mt-5">
    {loading ? <p role="status" className="text-sm text-text-muted">Loading release notes…</p> : <ReleaseNotesText notes={notes} />}
    <button className={cn(secondary, "mt-5")} onClick={() => openExternal(version ? `https://github.com/jhd3197/Faro/releases/tag/v${encodeURIComponent(version)}` : "https://github.com/jhd3197/Faro/releases")}>Full release notes</button>
  </div>;
}
