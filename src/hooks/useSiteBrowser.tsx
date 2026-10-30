import { useCallback, useState } from "react";
import { BookmarkPlus, House } from "lucide-react";
import { useSites } from "@/stores/sitesStore";
import { SiteDialog } from "@/components/SiteDialog";
import type { ConnectionProfile } from "@/lib/types";
import { resolveLaunchRemotePath } from "@/lib/localFolder";

/** Shared navigation keeps site locations intact across browser layouts and reconnects. */
export function useSiteBrowser(profile: ConnectionProfile | null) {
  const { sites, activeByProfile, sitePaths, serverPaths, navigate } = useSites();
  const [saveTarget, setSaveTarget] = useState<{ profileId: string; serverName: string; path: string } | null>(null);
  const site = profile ? sites.find(s => s.profileId === profile.id && s.id === activeByProfile[profile.id]) : undefined;
  // Site shortcuts win over the server's last folder and the profile default.
  // The remembered local folder is not consulted here.
  const path = site
    ? resolveLaunchRemotePath({ sitePath: sitePaths[site.id] ?? site.path })
    : resolveLaunchRemotePath({
        serverPath: profile ? serverPaths[profile.id] : undefined,
        defaultRemotePath: profile?.defaultRemotePath,
      });
  const profileId = profile?.id;
  const setPath = useCallback((next: string) => { if (profileId) navigate(profileId, next); }, [profileId, navigate]);
  const saveSite = (path: string) => {
    if (profile) setSaveTarget({ profileId: profile.id, serverName: profile.name, path });
  };
  return {
    site, path, setPath,
    saveSite,
    toolbar: <>
      {site && <button onClick={() => setPath(site.path)} title={`Site home: ${site.path}`} aria-label="Site home"
        className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-text-muted hover:bg-bg-hover hover:text-text"><House size={12} /> Site home</button>}
      <button onClick={() => saveSite(path)} title="Save this folder as a site" aria-label="Save as site"
        className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text"><BookmarkPlus size={13} /></button>
    </>,
    dialog: saveTarget ? <SiteDialog key={`${saveTarget.profileId}:${saveTarget.path}`} {...saveTarget} onClose={() => setSaveTarget(null)} /> : null,
  };
}
