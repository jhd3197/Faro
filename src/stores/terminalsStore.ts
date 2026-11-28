import { create } from "zustand";
import { LOCAL_SESSION, type SessionId } from "@/lib/types";
import { disposePane } from "@/lib/terminalRegistry";
import { setBroadcastResolver } from "@/lib/terminalBroadcast";

// A terminal tab owns a LAYOUT TREE of panes (Plan 11 Phase 2). A fresh tab is
// a single leaf; splitting a leaf replaces it with a split node holding the
// original leaf plus a new one. Every leaf's `paneId` keys a live xterm in the
// terminal registry — the tree only describes geometry, never the instance.
// Multiple tabs may belong to the same SSH session; each pane opens its own PTY
// channel on that one pooled connection (no re-auth).

/** One split direction: `row` = side-by-side (vertical divider, Cmd+D),
 *  `col` = stacked (horizontal divider, Cmd+Shift+D). */
export type SplitDir = "row" | "col";

export type PaneNode =
  | { kind: "leaf"; paneId: string }
  | {
      kind: "split";
      id: string;
      dir: SplitDir;
      /** Fraction (0..1) of the space the first child gets. */
      ratio: number;
      a: PaneNode;
      b: PaneNode;
    };

export interface TerminalTab {
  id: string; // client-side id, used as React key
  sessionId: SessionId;
  title: string; // editable; defaults to `Shell N`
  /** The pane layout for this tab. */
  root: PaneNode;
  /** The focused leaf within this tab (target for splits / close-pane). */
  activePaneId: string;
  /** When set, only this pane is shown full-size (others stay mounted). */
  zoomedPaneId: string | null;
  /** The one pane seeded with `initialCommand` (the tab's original leaf). */
  initialPaneId: string;
  /** Sent to that pane's PTY once, right after it opens (e.g. a `cd`). */
  initialCommand?: string;
  /** Protected from closing: shortcut, middle click and bulk closes skip it. */
  locked?: boolean;
  /** Kept first in the strip, shown compact. */
  pinned?: boolean;
  /** Typing in one pane goes to every pane of this tab. Never saved. */
  broadcast?: boolean;
  /** Local tabs: the shell profile id every pane of this tab runs. */
  shell?: string;
  /** Local tabs: the folder the shell starts in. */
  cwd?: string;
}

/** What it takes to reopen a closed tab: a fresh shell on the same session,
 *  same title, and the same starting folder when the tab was opened in one. */
export interface ClosedTab {
  sessionId: SessionId;
  title: string;
  initialCommand?: string;
  shell?: string;
  cwd?: string;
}

/** How many closed tabs "Reopen closed tab" remembers. */
export const CLOSED_TAB_LIMIT = 20;

interface TerminalsState {
  tabs: TerminalTab[];
  activeId: string | null;
  /** Recently closed tabs, newest last. */
  closed: ClosedTab[];

  openTab: (
    sessionId: SessionId,
    initialCommand?: string,
    opts?: { title?: string; shell?: string; cwd?: string }
  ) => TerminalTab;
  /** Close a tab. Closing the active one focuses its right-hand neighbour in
   *  the same session (else the left one). `remember: false` keeps it off the
   *  reopen stack (a pane handed to its own window isn't "closed"). */
  closeTab: (id: string, opts?: { remember?: boolean; force?: boolean }) => boolean;
  /** Close several tabs; if the active one goes, `focus` (when still open)
   *  takes over. Locked tabs stay; returns how many were kept. */
  closeTabs: (ids: string[], focus?: string) => number;
  /** Lock / unlock a tab against closing. */
  toggleLock: (id: string) => void;
  /** Pin / unpin a tab; pinned tabs sort first within their group. */
  togglePin: (id: string) => void;
  /** A new tab like this one, placed right after it. */
  duplicateTab: (id: string) => TerminalTab | null;
  /** Reopen the most recently closed tab of a session. Null when none. */
  reopenClosed: (sessionId: SessionId) => TerminalTab | null;
  /** Move a tab to `index` among its session's tabs. */
  moveTab: (id: string, index: number) => void;
  setActive: (id: string) => void;
  renameTab: (id: string, title: string) => void;
  /** Drop all tabs for a session (called on disconnect). */
  dropSessionTabs: (sessionId: SessionId) => void;

  // ---- Split panes ----
  /** Split the given tab's active pane; the new pane becomes active. */
  splitActivePane: (tabId: string, dir: SplitDir) => void;
  /** Close one pane; collapses its split, or closes the tab if it was last. */
  closePane: (
    tabId: string,
    paneId: string,
    opts?: { remember?: boolean; force?: boolean }
  ) => void;
  /** Focus a pane within a tab. */
  setPaneActive: (tabId: string, paneId: string) => void;
  /** Toggle "zoom" on the active pane (full-size, siblings hidden). */
  toggleZoom: (tabId: string) => void;
  /** Drag-resize: set a split node's ratio. */
  setSplitRatio: (tabId: string, splitId: string, ratio: number) => void;
  /** Turn broadcast input on or off for a tab. */
  toggleBroadcast: (tabId: string) => void;
}

function genId() {
  return crypto.randomUUID();
}

// ---- Pure tree helpers ----

function leafIds(node: PaneNode): string[] {
  return node.kind === "leaf"
    ? [node.paneId]
    : [...leafIds(node.a), ...leafIds(node.b)];
}

function firstLeaf(node: PaneNode): string {
  return node.kind === "leaf" ? node.paneId : firstLeaf(node.a);
}

function replaceLeaf(node: PaneNode, paneId: string, repl: PaneNode): PaneNode {
  if (node.kind === "leaf") return node.paneId === paneId ? repl : node;
  const a = replaceLeaf(node.a, paneId, repl);
  const b = replaceLeaf(node.b, paneId, repl);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Remove a leaf, collapsing its parent split to the surviving sibling. Returns
 *  null only when the removed leaf WAS the whole tree. */
function removeLeaf(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === "leaf") return node.paneId === paneId ? null : node;
  const a = removeLeaf(node.a, paneId);
  const b = removeLeaf(node.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

function setRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.kind === "leaf") return node;
  if (node.id === splitId) return { ...node, ratio };
  const a = setRatio(node.a, splitId, ratio);
  const b = setRatio(node.b, splitId, ratio);
  return a === node.a && b === node.b ? node : { ...node, a, b };
}

/** Keep one session's tabs ordered pinned-first, without moving any other
 *  session's tabs out of the slots they hold in the global list. */
function pinnedFirst(tabs: TerminalTab[], sessionId: SessionId): TerminalTab[] {
  const peers = tabs.filter((t) => t.sessionId === sessionId);
  const order = [...peers.filter((t) => t.pinned), ...peers.filter((t) => !t.pinned)];
  if (order.every((t, i) => t === peers[i])) return tabs;
  let k = 0;
  return tabs.map((t) => (t.sessionId === sessionId ? order[k++] : t));
}

/** Tabs of one session, in strip order. */
export function sessionTabsOf(tabs: TerminalTab[], sessionId: SessionId): TerminalTab[] {
  return tabs.filter((t) => t.sessionId === sessionId);
}

/** The tabs the dock shows while `sessionId` is focused: that connection's
 *  shells, then the local ones (which are on screen for every connection). */
export function dockTabsOf(tabs: TerminalTab[], sessionId: SessionId | null): TerminalTab[] {
  const remote =
    sessionId && sessionId !== LOCAL_SESSION ? sessionTabsOf(tabs, sessionId) : [];
  return [...remote, ...sessionTabsOf(tabs, LOCAL_SESSION)];
}

export const useTerminals = create<TerminalsState>((set, get) => ({
  tabs: [],
  activeId: null,
  closed: [],

  openTab: (sessionId, initialCommand, opts) => {
    const sessionCount = get().tabs.filter((t) => t.sessionId === sessionId).length;
    const paneId = genId();
    const tab: TerminalTab = {
      id: genId(),
      sessionId,
      title: opts?.title ?? `Shell ${sessionCount + 1}`,
      root: { kind: "leaf", paneId },
      activePaneId: paneId,
      zoomedPaneId: null,
      initialPaneId: paneId,
      initialCommand,
      shell: opts?.shell,
      cwd: opts?.cwd,
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
    return tab;
  },

  closeTab: (id, opts) => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return true;
    // A locked tab stays unless the caller insists (its shell moved away).
    if (tab.locked && !opts?.force) return false;
    // Store-driven disposal: tear down every pane the tab owned.
    for (const paneId of leafIds(tab.root)) disposePane(paneId);
    const tabs = s.tabs.filter((t) => t.id !== id);
    let activeId = s.activeId;
    if (s.activeId === id) {
      // The neighbour that slides under the pointer: right, else left.
      const peers = sessionTabsOf(s.tabs, tab.sessionId);
      const at = peers.findIndex((t) => t.id === id);
      const sibling =
        peers[at + 1] ?? peers[at - 1] ?? tabs[tabs.length - 1] ?? null;
      activeId = sibling ? sibling.id : null;
    }
    const closed =
      opts?.remember === false
        ? s.closed
        : [
            ...s.closed,
            {
              sessionId: tab.sessionId,
              title: tab.title,
              initialCommand: tab.initialCommand,
              shell: tab.shell,
              cwd: tab.cwd,
            },
          ].slice(-CLOSED_TAB_LIMIT);
    set({ tabs, activeId, closed });
    return true;
  },

  closeTabs: (ids, focus) => {
    const before = get().activeId;
    let kept = 0;
    for (const id of ids) if (!get().closeTab(id)) kept++;
    if (focus && before && ids.includes(before) && get().tabs.some((t) => t.id === focus)) {
      set({ activeId: focus });
    }
    return kept;
  },

  toggleLock: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, locked: !t.locked } : t)),
    })),

  togglePin: (id) =>
    set((s) => {
      const tab = s.tabs.find((t) => t.id === id);
      if (!tab) return {};
      const tabs = s.tabs.map((t) => (t.id === id ? { ...t, pinned: !t.pinned } : t));
      return { tabs: pinnedFirst(tabs, tab.sessionId) };
    }),

  duplicateTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return null;
    const copy = get().openTab(tab.sessionId, tab.initialCommand, {
      title: `${tab.title} copy`,
      shell: tab.shell,
      cwd: tab.cwd,
    });
    const peers = sessionTabsOf(get().tabs, tab.sessionId);
    get().moveTab(copy.id, peers.findIndex((t) => t.id === id) + 1);
    return copy;
  },

  reopenClosed: (sessionId) => {
    const s = get();
    let at = -1;
    for (let i = s.closed.length - 1; i >= 0; i--) {
      if (s.closed[i].sessionId === sessionId) {
        at = i;
        break;
      }
    }
    if (at < 0) return null;
    const entry = s.closed[at];
    set({ closed: s.closed.filter((_, i) => i !== at) });
    return get().openTab(sessionId, entry.initialCommand, {
      title: entry.title,
      shell: entry.shell,
      cwd: entry.cwd,
    });
  },

  moveTab: (id, index) => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === id);
    if (!tab) return;
    const peers = sessionTabsOf(s.tabs, tab.sessionId);
    const from = peers.findIndex((t) => t.id === id);
    const to = clamp(Math.round(index), 0, peers.length - 1);
    if (from === to) return;
    const order = peers.slice();
    order.splice(from, 1);
    order.splice(to, 0, tab);
    // Write the new session order back into the slots the session already
    // holds in the global list, so other sessions' tabs don't move.
    let k = 0;
    const tabs = s.tabs.map((t) => (t.sessionId === tab.sessionId ? order[k++] : t));
    // A drag can't carry an unpinned tab in front of the pinned ones.
    set({ tabs: pinnedFirst(tabs, tab.sessionId) });
  },

  setActive: (id) => set({ activeId: id }),

  renameTab: (id, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)),
    })),

  dropSessionTabs: (sessionId) => {
    const s = get();
    for (const t of s.tabs) {
      if (t.sessionId === sessionId)
        for (const paneId of leafIds(t.root)) disposePane(paneId);
    }
    const tabs = s.tabs.filter((t) => t.sessionId !== sessionId);
    const activeStillThere = tabs.some((t) => t.id === s.activeId);
    set({ tabs, activeId: activeStillThere ? s.activeId : tabs[0]?.id ?? null });
  },

  splitActivePane: (tabId, dir) =>
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t;
        const newPane = genId();
        const split: PaneNode = {
          kind: "split",
          id: genId(),
          dir,
          ratio: 0.5,
          a: { kind: "leaf", paneId: t.activePaneId },
          b: { kind: "leaf", paneId: newPane },
        };
        return {
          ...t,
          root: replaceLeaf(t.root, t.activePaneId, split),
          activePaneId: newPane,
          // A split and a zoom are mutually exclusive — splitting un-zooms.
          zoomedPaneId: null,
        };
      }),
    })),

  closePane: (tabId, paneId, opts) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    // Last pane in the tab → close the whole tab (handles disposal + active).
    if (leafIds(tab.root).length <= 1) {
      get().closeTab(tabId, opts);
      return;
    }
    disposePane(paneId);
    set((s) => ({
      tabs: s.tabs.map((t) => {
        if (t.id !== tabId) return t;
        const root = removeLeaf(t.root, paneId) ?? t.root;
        const remaining = leafIds(root);
        const activePaneId = remaining.includes(t.activePaneId)
          ? t.activePaneId
          : firstLeaf(root);
        return {
          ...t,
          root,
          activePaneId,
          zoomedPaneId:
            t.zoomedPaneId && remaining.includes(t.zoomedPaneId)
              ? t.zoomedPaneId
              : null,
        };
      }),
    }));
  },

  setPaneActive: (tabId, paneId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, activePaneId: paneId } : t
      ),
    })),

  toggleZoom: (tabId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, zoomedPaneId: t.zoomedPaneId ? null : t.activePaneId }
          : t
      ),
    })),

  toggleBroadcast: (tabId) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, broadcast: !t.broadcast } : t)),
    })),

  setSplitRatio: (tabId, splitId, ratio) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId
          ? { ...t, root: setRatio(t.root, splitId, clamp(ratio, 0.1, 0.9)) }
          : t
      ),
    })),
}));

// Broadcast input: the registry asks which other panes share a pane's tab.
setBroadcastResolver((paneId) => {
  for (const t of useTerminals.getState().tabs) {
    if (!t.broadcast) continue;
    const ids = leafIds(t.root);
    if (ids.includes(paneId)) return ids.filter((id) => id !== paneId);
  }
  return null;
});

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

// Exposed for tests / the split renderer.
export const _tree = { leafIds, firstLeaf, replaceLeaf, removeLeaf, setRatio };
