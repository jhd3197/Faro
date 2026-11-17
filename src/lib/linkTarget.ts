import { useConnections } from "@/stores/connectionsStore";
import { useLayout } from "@/stores/layoutStore";
import { useSites } from "@/stores/sitesStore";
import { leaveSiteNavigation } from "@/components/ServerSites";

/** Where a deep link points inside a saved connection. JSON, so a toast can carry it. */
export interface LinkTarget {
  profileId: string;
  /** A saved site to open at its home folder. */
  siteId?: string;
  /** A folder to open when there is no site for it. */
  path?: string;
}

/**
 * Show a link's target in an already-open session: select the site (or the
 * server) and go to the folder. Returns false when the server isn't connected,
 * so nothing here ever opens a connection.
 */
export function showLinkTarget(t: LinkTarget): boolean {
  const session = useConnections.getState().sessions.find((s) => s.profileId === t.profileId);
  if (!session) return false;
  const sites = useSites.getState();
  const site = t.siteId ? sites.sites.find((s) => s.id === t.siteId && s.profileId === t.profileId) : undefined;
  leaveSiteNavigation();
  sites.select(t.profileId, site?.id);
  if (site) sites.navigate(t.profileId, site.path);
  else if (t.path) sites.navigateAt(t.profileId, undefined, t.path);
  useLayout.getState().setBrowseLocal(false);
  useConnections.getState().setActiveSession(session.sessionId);
  return true;
}

/** The user's Connect press on a link's toast: connect, then show the target. */
export async function connectLinkTarget(t: LinkTarget): Promise<void> {
  try {
    await useConnections.getState().connect(t.profileId, { focus: false });
  } catch {
    return; // The connection store reports authentication/network errors.
  }
  showLinkTarget(t);
}
