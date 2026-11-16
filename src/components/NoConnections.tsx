import { useEffect } from "react";
import { Download, Plus, ServerOff } from "lucide-react";
import { useDiscovery } from "@/stores/discoveryStore";
import { useLayout } from "@/stores/layoutStore";

const primary = "inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90";
const secondary = "inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs text-text hover:bg-bg-hover";

/** Before any connection exists: the two ways to get one. `pane` fills the
 *  remote side of the split view; `strip` sits above the single-pane local
 *  listing, which stays usable underneath. */
export function NoConnections({ variant = "pane" }: { variant?: "pane" | "strip" }) {
  const found = useDiscovery((s) => s.found);
  useEffect(() => { void useDiscovery.getState().scanImports(); }, []);
  const total = found?.reduce((n, f) => n + f.count, 0) ?? 0;
  const first = found?.[0];
  const actions = <>
    <button onClick={() => useLayout.getState().openNewConnection()} className={primary}>
      <Plus size={13} /> New connection
    </button>
    <button onClick={() => useLayout.getState().openImport(undefined, first?.kind)} className={secondary}>
      <Download size={13} />
      {total > 0 ? `Import ${total} found on this computer` : "Import connections"}
    </button>
  </>;
  if (variant === "strip") {
    return (
      <div data-no-connections="" className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-bg-subtle px-3 py-2">
        <ServerOff size={14} className="shrink-0 text-text-dim" aria-hidden="true" />
        <p className="min-w-0 flex-1 text-xs text-text-muted">
          <span className="font-medium text-text">No connections yet.</span>{" "}
          {total > 0 ? `${found!.map((f) => f.label).join(" and ")} on this computer ${total === 1 ? "has one" : `have ${total}`} you can bring over.` : "Add a server or storage account to browse it here."}
        </p>
        <div className="flex shrink-0 gap-2">{actions}</div>
      </div>
    );
  }
  return (
    <div data-no-connections="" className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <ServerOff size={20} className="text-text-dim" aria-hidden="true" />
      <div>
        <p className="text-sm font-medium text-text">No connections yet</p>
        <p className="mt-1 max-w-xs text-xs text-text-muted">Add a server or storage account, or bring over the connections you already use.</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">{actions}</div>
      {first && <p className="text-[11px] text-text-dim">From {found!.map((f) => f.label).join(", ")}</p>}
    </div>
  );
}
