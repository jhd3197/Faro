// Terminal workspace (Plan 36 Phase 4), the pure part: what is saved for a
// connection's terminal tabs and how it is read back. No store imports, so it
// can be unit-tested on its own.
//
// Pane ids are saved and reused on restore. For a persistent pane the id is
// also what its tmux session is named after, which is how a restored pane
// finds the shell it had before.

export type SavedNode =
  | { kind: "leaf"; paneId: string }
  | { kind: "split"; id: string; dir: "row" | "col"; ratio: number; a: SavedNode; b: SavedNode };

export interface SavedTab {
  title: string;
  root: SavedNode;
  activePaneId: string;
  pinned?: boolean;
  locked?: boolean;
  /** Panes run inside tmux sessions on the host. */
  persist?: boolean;
  /** Panes attached to a session that isn't named after the pane id. */
  persistNames?: Record<string, string>;
  /** Local tabs: shell profile and starting folder. */
  shell?: string;
  cwd?: string;
}

export interface SavedWorkspace {
  v: 1;
  tabs: SavedTab[];
}

/** The fields of a live tab that are worth saving. Structural, so this module
 *  needs nothing from the store. */
export interface TabLike extends SavedTab {
  zoomedPaneId?: string | null;
  broadcast?: boolean;
  initialCommand?: string;
}

/** The tmux session a pane's shell lives in when it isn't adopted from
 *  elsewhere: `faro-` + the pane id's letters and digits. */
export function persistNameFor(paneId: string): string {
  const id = paneId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 24);
  return `faro-${id || "pane"}`;
}

export function leafIdsOf(node: SavedNode): string[] {
  return node.kind === "leaf" ? [node.paneId] : [...leafIdsOf(node.a), ...leafIdsOf(node.b)];
}

/** Every tmux session name a set of tabs is attached to. */
export function claimedSessionNames(tabs: TabLike[]): Set<string> {
  const out = new Set<string>();
  for (const tab of tabs) {
    if (!tab.persist) continue;
    for (const paneId of leafIdsOf(tab.root)) {
      out.add(tab.persistNames?.[paneId] ?? persistNameFor(paneId));
    }
  }
  return out;
}

function cleanNode(node: SavedNode): SavedNode {
  return node.kind === "leaf"
    ? { kind: "leaf", paneId: node.paneId }
    : {
        kind: "split",
        id: node.id,
        dir: node.dir,
        ratio: node.ratio,
        a: cleanNode(node.a),
        b: cleanNode(node.b),
      };
}

/** What to store for these tabs. Zoom, broadcast and the one-off start
 *  command are left out on purpose: they are not layout. */
export function serializeWorkspace(tabs: TabLike[]): SavedWorkspace {
  return {
    v: 1,
    tabs: tabs.map((t) => {
      const saved: SavedTab = {
        title: t.title,
        root: cleanNode(t.root),
        activePaneId: t.activePaneId,
      };
      if (t.pinned) saved.pinned = true;
      if (t.locked) saved.locked = true;
      if (t.persist) saved.persist = true;
      if (t.persist && t.persistNames && Object.keys(t.persistNames).length) {
        saved.persistNames = { ...t.persistNames };
      }
      if (t.shell) saved.shell = t.shell;
      if (t.cwd) saved.cwd = t.cwd;
      return saved;
    }),
  };
}

function validNode(node: unknown, seen: Set<string>, depth = 0): node is SavedNode {
  if (!node || typeof node !== "object" || depth > 12) return false;
  const n = node as Record<string, unknown>;
  if (n.kind === "leaf") {
    if (typeof n.paneId !== "string" || !n.paneId || seen.has(n.paneId)) return false;
    seen.add(n.paneId);
    return true;
  }
  return (
    n.kind === "split" &&
    typeof n.id === "string" &&
    (n.dir === "row" || n.dir === "col") &&
    typeof n.ratio === "number" &&
    n.ratio > 0 &&
    n.ratio < 1 &&
    validNode(n.a, seen, depth + 1) &&
    validNode(n.b, seen, depth + 1)
  );
}

/** Read a stored workspace. Anything malformed (an old format, a hand-edited
 *  value, duplicate pane ids) yields null rather than a half-built layout. */
export function parseWorkspace(raw: string | null | undefined): SavedWorkspace | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const ws = data as { v?: unknown; tabs?: unknown };
  if (ws.v !== 1 || !Array.isArray(ws.tabs)) return null;
  const seen = new Set<string>();
  const tabs: SavedTab[] = [];
  for (const t of ws.tabs as Record<string, unknown>[]) {
    if (!t || typeof t.title !== "string" || !validNode(t.root, seen)) return null;
    const leaves = leafIdsOf(t.root as SavedNode);
    const tab: SavedTab = {
      title: t.title,
      root: t.root as SavedNode,
      activePaneId:
        typeof t.activePaneId === "string" && leaves.includes(t.activePaneId)
          ? t.activePaneId
          : leaves[0],
    };
    if (t.pinned === true) tab.pinned = true;
    if (t.locked === true) tab.locked = true;
    if (t.persist === true) tab.persist = true;
    if (tab.persist && t.persistNames && typeof t.persistNames === "object") {
      const names: Record<string, string> = {};
      for (const [paneId, name] of Object.entries(t.persistNames as Record<string, unknown>)) {
        if (leaves.includes(paneId) && typeof name === "string" && /^faro-[a-z0-9]{1,40}$/.test(name)) {
          names[paneId] = name;
        }
      }
      if (Object.keys(names).length) tab.persistNames = names;
    }
    if (typeof t.shell === "string") tab.shell = t.shell;
    if (typeof t.cwd === "string") tab.cwd = t.cwd;
    tabs.push(tab);
  }
  return tabs.length ? { v: 1, tabs } : null;
}

/** The settings key a connection's workspace is stored under. */
export function workspaceKey(profileKey: string): string {
  return `terminalWorkspace:${profileKey}`;
}
