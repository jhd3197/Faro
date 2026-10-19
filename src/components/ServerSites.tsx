import { useState } from "react";
import { ChevronDown, ChevronRight, Folder, MoreHorizontal, Pencil, Trash2, House } from "lucide-react";
import { createPortal } from "react-dom";
import { useSites, type SiteShortcut } from "@/stores/sitesStore";
import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { toastError } from "@/lib/errors";
import { cn } from "@/lib/cn";
import { SiteDialog } from "./SiteDialog";
import { ContextMenu } from "./ContextMenu";

let navigation = 0;
/** A parent/local click cancels any pending site navigation. */
export function leaveSiteNavigation() { navigation++; }

export function ServerSites({ profileId, serverName, expanded, onMenuChange }: {
  profileId: string;
  serverName: string;
  expanded: boolean;
  onMenuChange: (open: boolean) => void;
}) {
  const allSites = useSites(s => s.sites);
  const activeSiteId = useSites(s => s.activeByProfile[profileId]);
  const activeProfileId = useConnections(s => s.activeProfileId);
  const browseLocal = useLayout(s => s.browseLocal);
  const sites = allSites.filter(s => s.profileId === profileId);
  const [collapsed, setCollapsed] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [editing, setEditing] = useState<SiteShortcut | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; site: SiteShortcut } | null>(null);
  const closeMenu = () => { setMenu(null); onMenuChange(false); };
  const openSite = async (site: SiteShortcut, home = false) => {
    const intent = ++navigation;
    setOpening(site.id);
    try {
      await useConnections.getState().connect(profileId, { focus: false });
      if (intent !== navigation || !useSites.getState().sites.some(s => s.id === site.id)) return;
      const session = useConnections.getState().sessions.find(s => s.profileId === profileId);
      if (!session) return;
      useSites.getState().select(profileId, site.id);
      if (home) useSites.getState().navigate(profileId, site.path);
      useLayout.getState().setBrowseLocal(false);
      useConnections.getState().setActiveSession(session.sessionId);
    } catch {
      // The connection store reports authentication/network errors.
    } finally {
      setOpening(current => current === site.id ? null : current);
    }
  };
  const showMenu = (e: React.MouseEvent, site: SiteShortcut) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ x: rect.right + 5, y: rect.top, site });
    onMenuChange(true);
  };
  if (!sites.length) return null;
  return <>
    {expanded && <div role="group" className="mb-1 ml-[29px] mr-2 border-l border-border pl-3" aria-label={`${serverName} sites`}>
      <button onClick={() => setCollapsed(v => !v)} aria-expanded={!collapsed} aria-label={`Sites on ${serverName}`}
        className="mb-0.5 flex w-full items-center gap-1.5 rounded px-2 py-1 text-[10px] font-medium text-text-dim hover:text-text">
        {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />} Sites <span className="ml-auto tabular-nums">{sites.length}</span>
      </button>
      {!collapsed && sites.map(site => {
        const active = !browseLocal && activeProfileId === profileId && activeSiteId === site.id;
        return <div key={site.id} className={cn("group/site flex min-w-0 items-center rounded-md", active ? "bg-accent-soft text-accent" : "text-text-muted hover:bg-bg-hover hover:text-text")}>
          <button aria-label={`Open site ${site.name}`} aria-current={active ? "page" : undefined}
            title={`${site.name}\n${site.path}`} onClick={() => void openSite(site)} onContextMenu={e => showMenu(e, site)}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left focus-visible:outline focus-visible:outline-accent">
            <Folder size={13} className="shrink-0" />
            <span className="min-w-0"><span className="block truncate text-xs font-medium">{site.name}</span>
              <span className="mt-0.5 block truncate font-mono text-[10px] opacity-60">{opening === site.id ? "Connecting…" : site.path}</span></span>
          </button>
          <button aria-label={`Options for ${site.name}`} onClick={e => showMenu(e, site)}
            className="mr-1 rounded p-1 text-text-dim opacity-0 hover:bg-bg-hover hover:text-text focus:opacity-100 group-hover/site:opacity-100"><MoreHorizontal size={14} /></button>
        </div>;
      })}
    </div>}
    {menu && createPortal(<ContextMenu x={menu.x} y={menu.y} onClose={closeMenu} items={[
      { label: "Open site home", icon: <House size={13} />, onClick: () => void openSite(menu.site, true) },
      { label: "Rename site…", icon: <Pencil size={13} />, onClick: () => setEditing(menu.site) },
      { label: "Remove shortcut", icon: <Trash2 size={13} />, onClick: () => {
        void useSites.getState().remove(menu.site.id).catch(e => toastError(e, "Couldn't remove site shortcut"));
      } },
    ]} />, document.body)}
    {editing && createPortal(<SiteDialog site={editing} profileId={profileId} serverName={serverName} path={editing.path} onClose={() => setEditing(null)} />, document.body)}
  </>;
}
