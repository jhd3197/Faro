import React from "react";
import { createRoot } from "react-dom/client";
import { useRememberedLocalPath } from "../../src/hooks/useRememberedLocalPath";
import { useSiteBrowser } from "../../src/hooks/useSiteBrowser";
import { useSyncedPanes } from "../../src/hooks/useSyncedPanes";
import { browserLocationKey, useSites } from "../../src/stores/sitesStore";
import { useConnections } from "../../src/stores/connectionsStore";
import { ipc } from "../../src/lib/ipc";
import { LOCAL_SESSION, type ConnectionProfile } from "../../src/lib/types";

const initial = { siteShortcuts: JSON.stringify([
  { id: "a", profileId: "p1", name: "A", path: "/remote/a" },
  { id: "b", profileId: "p1", name: "B", path: "/remote/b" },
  { id: "c", profileId: "p2", name: "C", path: "/other/c" },
]) };
const settings: Record<string, string> = JSON.parse(sessionStorage.getItem("pair-settings") ?? JSON.stringify(initial));
const control = {
  useSites, useConnections, browserLocationKey, settings, LOCAL_SESSION,
  current: null as any,
  calls: [] as { session: string; path: string }[],
  failPaths: [] as string[],
  failSave: false,
  writes: [] as string[],
  pending: [] as { session: string; path: string; resolve: () => void; reject: () => void }[],
  hold: null as { session: string; path: string } | null,
  delayLoad: false, releaseLoad: () => {},
  delaySave: false, releaseSave: () => {},
  mount: () => root.render(<React.StrictMode><Harness /></React.StrictMode>),
  unmount: () => root.render(null),
};
let loadGate: Promise<void> | null = null;
ipc.settingsGetAll = async () => {
  // Capture before the wait to test hydration racing an early navigation.
  const snapshot = { ...settings };
  if (control.delayLoad) await (loadGate ??= new Promise<void>(resolve => { control.releaseLoad = () => { control.delayLoad = false; loadGate = null; resolve(); }; }));
  return snapshot;
};
ipc.settingsSet = async (key, value) => {
  if (key === "siteNavigation.v1") {
    control.writes.push(value);
    if (control.delaySave) await new Promise<void>(resolve => { control.releaseSave = resolve; });
    if (control.failSave) throw Error("Test: save failed");
  }
  settings[key] = value;
  sessionStorage.setItem("pair-settings", JSON.stringify(settings));
};
ipc.listDirectory = async (session, path) => {
  control.calls.push({ session, path });
  if (control.hold?.session === session && control.hold.path === path) {
    control.hold = null;
    await new Promise<void>((resolve, reject) => control.pending.push({ session, path, resolve, reject: () => reject(Error("Permission denied")) }));
  }
  if (control.failPaths.includes(path)) throw Error("No such file or directory");
  return [];
};
const profiles = [
  { id: "p1", name: "One", defaultLocalPath: "/local/default1", defaultRemotePath: "/remote/default1" },
  { id: "p2", name: "Two", defaultLocalPath: "/local/default2", defaultRemotePath: "/remote/default2" },
] as ConnectionProfile[];
useConnections.setState({ profiles, activeProfileId: "p1", activeSessionId: "s1", sessions: [
  { profileId: "p1", sessionId: "s1" }, { profileId: "p2", sessionId: "s2" },
] });
function Harness() {
  const connection = useConnections();
  const profile = connection.profiles.find(p => p.id === connection.activeProfileId) ?? null;
  const site = useSiteBrowser(profile);
  const [localPath, setLocalPath] = useRememberedLocalPath(profile, connection.activeSessionId);
  const sync = useSyncedPanes({ profileId: profile?.id, siteId: site.site?.id,
    sessionId: connection.activeSessionId, localPath, remotePath: site.path,
    setLocalPath, setRemotePath: site.setPath });
  control.current = { localPath, remotePath: site.path, setLocalPath, setRemotePath: site.setPath, ...sync };
  return <div><output data-local={localPath} data-remote={site.path} data-enabled={sync.enabled} />
    {sync.toolbar}{sync.hint && <p role="status">{sync.hint.title}</p>}</div>;
}
const root = createRoot(document.getElementById("root")!);
Object.assign(window, { pairTest: control });
