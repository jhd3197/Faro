// Mock-only test bench for the shared UI primitives: mounts one of them in a
// fresh root so scripts/primitives.test.mjs can drive it with real keys and
// read back what it reported. Exposed as window.__primitives.
import { useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Dialog, type DialogCloseReason } from "@/components/ui/Dialog";
import { Menu, type MenuOption } from "@/components/ui/Menu";
import { Dropdown } from "@/components/ui/Dropdown";
import { Popover } from "@/components/ui/Popover";
import { ShowMore } from "@/components/ui/ShowMore";
import { SelectAll } from "@/components/ui/SelectAll";

const log: string[] = [];
let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactNode) {
  unmount();
  log.length = 0;
  host = document.createElement("div");
  host.id = "primitives-bench";
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(node);
}

function unmount() {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

function DialogBench({ confirmDisabled, textarea }: { confirmDisabled?: boolean; textarea?: boolean }) {
  const [open, setOpen] = useState(true);
  if (!open) return null;
  return (
    <Dialog
      title="Rename server"
      size="sm"
      confirmLabel="Rename"
      confirmDisabled={confirmDisabled}
      footerLeft={<span>Only the display name changes.</span>}
      onConfirm={() => {
        log.push("confirm");
      }}
      onClose={(reason: DialogCloseReason) => {
        log.push(`close:${reason}`);
        setOpen(false);
      }}
      data-testid="bench-dialog"
    >
      <label className="block text-[11px]">
        Name
        <input data-bench="name" defaultValue="web-1" className="mt-1 w-full rounded-md border border-border bg-bg-subtle px-2.5 py-1.5 text-sm text-text outline-none focus:border-accent" />
      </label>
      {textarea && <textarea data-bench="notes" className="mt-2 w-full rounded-md border border-border bg-bg-subtle p-2 text-sm" />}
    </Dialog>
  );
}

const SERVERS: MenuOption<string>[] = [
  { value: "web-1", label: "web-1", group: "Production", hint: "10.0.0.11" },
  { value: "web-2", label: "web-2", group: "Production", hint: "10.0.0.12" },
  { value: "db", label: "db-primary", group: "Production", disabled: true, hint: "offline" },
  { value: "staging", label: "staging", group: "Staging", hint: "10.1.0.5" },
  { value: "build", label: "build-runner", group: "Staging", hint: "10.1.0.9" },
];

function MenuBench({ searchable, value }: { searchable?: boolean; value?: string }) {
  return (
    <div className="fixed left-10 top-24 z-palette w-64 rounded-md border border-border bg-bg-panel shadow-elev-3">
      <Menu
        options={SERVERS}
        value={value}
        searchable={searchable}
        searchPlaceholder="Find a server"
        aria-label="Servers"
        onSelect={(v) => log.push(`select:${v}`)}
        onClose={() => log.push("close")}
      />
    </div>
  );
}

function DropdownBench() {
  const [v, setV] = useState("staging");
  return (
    <div className="fixed left-10 top-24 z-palette w-64">
      <Dropdown value={v} options={SERVERS} searchable aria-label="Server" onChange={(n) => { setV(n); log.push(`change:${n}`); }} />
    </div>
  );
}

function PopoverBench() {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <div data-bench="scroller" className="fixed left-10 top-24 z-palette h-40 w-64 overflow-y-auto border border-border bg-bg-panel">
      <div className="h-8" />
      <button ref={anchor} data-bench="anchor" className="ml-3 rounded border border-border px-2 py-1 text-sm">Anchor</button>
      <div className="h-[600px]" />
      <Popover open={open} anchorRef={anchor} matchWidth onClose={(r) => { log.push(`close:${r}`); setOpen(false); }}>
        <div data-bench="pop" className="p-2 text-sm">Popover body</div>
      </Popover>
    </div>
  );
}

function ShowMoreBench({ text, width = 320 }: { text: string; width?: number }) {
  return (
    <div className="fixed left-10 top-24 z-palette rounded-md border border-danger/30 bg-bg-panel p-3 text-[12px] leading-5 text-text" style={{ width }}>
      <ShowMore lines={3}>{text}</ShowMore>
    </div>
  );
}

function SelectAllBench({ filter = "" }: { filter?: string }) {
  const all = ["web-1", "web-2", "db-primary", "staging", "build-runner"];
  const [sel, setSel] = useState<Set<string>>(new Set(["db-primary"]));
  const [q, setQ] = useState(filter);
  const shown = all.filter((x) => x.includes(q));
  (window as any).__primitives.selection = () => [...sel].sort();
  return (
    <div className="fixed left-10 top-24 z-palette w-64 rounded-md border border-border bg-bg-panel p-2 text-sm">
      <div className="flex items-center gap-2">
        <SelectAll visible={shown} selected={sel} onChange={setSel} />
        <input data-bench="filter" value={q} onChange={(e) => setQ(e.target.value)} className="min-w-0 flex-1 border border-border bg-bg-subtle px-1" />
      </div>
      {shown.map((x) => (
        <label key={x} className="flex items-center gap-2">
          <input type="checkbox" checked={sel.has(x)} onChange={() => setSel((s) => { const n = new Set(s); if (n.has(x)) n.delete(x); else n.add(x); return n; })} />
          {x}
        </label>
      ))}
    </div>
  );
}

(window as any).__primitives = {
  log,
  unmount,
  dialog: (opts: { confirmDisabled?: boolean; textarea?: boolean } = {}) => mount(<DialogBench {...opts} />),
  menu: (opts: { searchable?: boolean; value?: string } = {}) => mount(<MenuBench {...opts} />),
  dropdown: () => mount(<DropdownBench />),
  popover: () => mount(<PopoverBench />),
  showMore: (text: string, width?: number) => mount(<ShowMoreBench text={text} width={width} />),
  selectAll: (filter?: string) => mount(<SelectAllBench filter={filter} />),
};
