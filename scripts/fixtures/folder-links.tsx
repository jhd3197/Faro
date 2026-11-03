import { useState } from "react";
import { createRoot } from "react-dom/client";
import { FilePane, FileUiProvider, LOCAL_SESSION, type FileSystemAdapter, type PaneSettings } from "../../packages/file-ui/src";
import { toTransferItem } from "../../src/stores/transfersStore";
import "../../src/styles.css";

// The real pane, fed listings that include folder links, file links and broken
// links. Ops are recorded so a test can see that delete is non-recursive and
// that Duplicate is offered for the link.
const requests: Array<{ path: string; session: string; kind: string; resolve: (value: any) => void; reject: (error: string) => void; done?: boolean }> = [];
const ops: Array<{ op: string; session: string; path: string; recursive?: boolean; kind?: string }> = [];
const request = (kind: string, session: string, path: string) => new Promise<any>((resolve, reject) => {
  requests.push({ kind, session, path, resolve, reject });
});
const capabilities = { canChmod: true, canSymlink: true, canRename: true, hasDirectories: true, hasShell: true };
const fs: FileSystemAdapter = {
  listDirectory: (s, p) => request("strict", s, p),
  browseDirectory: (s, p) => request("browse", s, p),
  capabilities: async () => capabilities,
  rename: async () => {},
  remove: async (session, path, recursive) => { ops.push({ op: "remove", session, path, recursive }); },
  mkdir: async () => {},
  chmod: async () => {},
  duplicate: async (session, path, kind) => { ops.push({ op: "duplicate", session, path, kind }); },
};
const settings: PaneSettings = {
  showHiddenFiles: true, sortField: "name", sortDirection: "asc", paneViewMode: "list", paneDensity: "comfortable",
  setSortField() {}, setSortDirection() {}, setPaneViewMode() {}, setPaneDensity() {},
};

function Fixture() {
  const [path, setPath] = useState("/links");
  const [session, setSession] = useState<string | null>(LOCAL_SESSION);
  Object.assign(window, { listingTest: {
    requests, ops, setPath, setSession, toTransferItem,
    resolve(index: number, entries: any[], skippedEntries = 0) {
      const r = requests[index];
      r.done = true;
      r.resolve(r.kind === "browse" ? { entries, skippedEntries } : entries);
    },
    reject(index: number, error: string) { requests[index].done = true; requests[index].reject(error); },
  } });
  return <FileUiProvider fs={fs} settings={settings}>
    <div style={{ height: "100vh" }} data-path={path} data-session={session ?? ""}>
      <FilePane paneId="test" title="Links" sessionId={session} path={path} onPathChange={setPath} />
    </div>
  </FileUiProvider>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
