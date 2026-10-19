import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePane, FileUiProvider, type FileSystemAdapter, type PaneSettings } from "../../packages/file-ui/src";
import "../../src/styles.css";

// A transport boundary with controllable response order. Tests mount the real
// pane, breadcrumbs, history, selection and warnings; no component mocks.
const requests: Array<{ path: string; session: string; kind: string; resolve: (value: any) => void; reject: (error: string) => void; done?: boolean }> = [];
const request = (kind: string, session: string, path: string) => new Promise<any>((resolve, reject) => {
  requests.push({ kind, session, path, resolve, reject });
});
const capabilities = { canChmod: true, canSymlink: false, canRename: true, hasDirectories: true };
const fs: FileSystemAdapter = {
  listDirectory: (s, p) => request("strict", s, p),
  browseDirectory: (s, p) => request("browse", s, p),
  capabilities: async () => capabilities,
  rename: async () => {}, remove: async () => {}, mkdir: async () => {}, chmod: async () => {},
};
const legacyFs = { ...fs, browseDirectory: undefined };
const settings: PaneSettings = {
  showHiddenFiles: true, sortField: "name", sortDirection: "asc", paneViewMode: "list", paneDensity: "comfortable",
  setSortField() {}, setSortDirection() {}, setPaneViewMode() {}, setPaneDensity() {},
};

function Fixture() {
  const [path, setPath] = useState("/mixed");
  const [session, setSession] = useState<string | null>("ftp");
  const [legacy, setLegacy] = useState(false);
  Object.assign(window, { listingTest: {
    requests, setPath, setSession, setLegacy,
    resolve(index: number, entries: any[], skippedEntries = 0) {
      const r = requests[index];
      r.done = true;
      r.resolve(r.kind === "browse" ? { entries, skippedEntries } : entries);
    },
    reject(index: number, error: string) { requests[index].done = true; requests[index].reject(error); },
  } });
  return <FileUiProvider fs={legacy ? legacyFs : fs} settings={settings}>
    <div style={{ height: "100vh" }} data-path={path} data-session={session}>
      <FilePane paneId="test" title="Test" sessionId={session} path={path} onPathChange={setPath} />
    </div>
  </FileUiProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
