// Terminal workspace (Plan 36 Phase 4): keeps each connection's terminal tabs
// (titles, split layout, pin and lock) in faro.db and rebuilds them the next
// time that connection opens its terminal. With persistent sessions on, the
// rebuilt panes reattach to the shells they had.
//
// This module also decides whether a connection's shells are persistent, and
// tells the terminals store, which can't import the connections store itself.

import { ipc } from "./ipc";
import { LOCAL_SESSION, type SessionId } from "./types";
import { useConnections } from "@/stores/connectionsStore";
import { useSettings } from "@/stores/settingsStore";
import {
  setPersistDecider,
  useTerminals,
  type TerminalTab,
} from "@/stores/terminalsStore";
import {
  claimedSessionNames,
  parseWorkspace,
  serializeWorkspace,
  workspaceKey,
} from "./terminalWorkspaceCore";

/** The profile a session belongs to; local tabs share one key. */
function profileKeyOf(sessionId: SessionId): string | null {
  if (sessionId === LOCAL_SESSION) return LOCAL_SESSION;
  return (
    useConnections.getState().sessions.find((s) => s.sessionId === sessionId)?.profileId ?? null
  );
}

/** Are this connection's shells kept running on the host? The per-connection
 *  choice wins over the global setting. Never for local shells. */
export function persistEnabled(sessionId: SessionId): boolean {
  if (sessionId === LOCAL_SESSION) return false;
  const s = useSettings.getState();
  const profileId = profileKeyOf(sessionId);
  const override = profileId ? s.terminalPersistOverrides[profileId] : undefined;
  return override ?? s.terminalPersist === "on";
}

setPersistDecider(persistEnabled);

// ---- Saving ----

const lastSaved = new Map<string, string>();
let timer: ReturnType<typeof setTimeout> | null = null;

function saveNow() {
  timer = null;
  if (!useSettings.getState().terminalRestoreWorkspace) return;
  const tabs = useTerminals.getState().tabs;
  const groups = new Map<string, TerminalTab[]>();
  for (const tab of tabs) {
    const key = profileKeyOf(tab.sessionId);
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push(tab);
    groups.set(key, list);
  }
  for (const [key, list] of groups) {
    const json = JSON.stringify(serializeWorkspace(list));
    if (lastSaved.get(key) === json) continue;
    lastSaved.set(key, json);
    ipc.settingsSet(workspaceKey(key), json).catch(() => {});
  }
  // A connection whose tabs were all closed by hand starts fresh next time.
  // Tabs that vanished because the connection closed are kept: that is
  // exactly the case a workspace is restored for.
  const connected = new Set(useConnections.getState().sessions.map((s) => s.profileId));
  connected.add(LOCAL_SESSION);
  for (const key of [...lastSaved.keys()]) {
    if (groups.has(key) || !connected.has(key)) continue;
    lastSaved.delete(key);
    ipc.settingsDelete(workspaceKey(key)).catch(() => {});
  }
}

let started = false;

// A connection's workspace is restored once, the first time its terminal is
// shown. After that, an empty strip means the user closed everything.
const restored = new Set<string>();
const loading = new Map<string, Promise<RestoreResult>>();

/** `restored`: saved tabs were rebuilt. `first`: this is the first time the
 *  terminal is shown for this connection and nothing was saved. `done`: it
 *  was already handled, so an empty strip is the user's doing. */
export type RestoreResult = "restored" | "first" | "done";

/** Start saving workspaces as tabs change. Safe to call more than once. */
export function startWorkspaceSync(): void {
  if (started) return;
  started = true;
  useTerminals.subscribe((state, prev) => {
    if (state.tabs === prev.tabs) return;
    if (timer === null) timer = setTimeout(saveNow, 400);
  });
  // A connection that closed gets its workspace back when it connects again,
  // whether or not it is given the same session id.
  useConnections.subscribe((state, prev) => {
    if (state.sessions === prev.sessions) return;
    const live = new Set(state.sessions.map((s) => s.sessionId));
    for (const id of [...restored]) {
      if (id !== LOCAL_SESSION && !live.has(id)) restored.delete(id);
    }
  });
  window.addEventListener("beforeunload", () => {
    if (timer !== null) {
      clearTimeout(timer);
      saveNow();
    }
  });
}

// ---- Restoring ----

async function restoreOne(sessionId: SessionId): Promise<RestoreResult> {
  if (restored.has(sessionId)) return "done";
  restored.add(sessionId);
  if (!useSettings.getState().terminalRestoreWorkspace) return "first";
  const key = profileKeyOf(sessionId);
  if (!key) return "first";
  let raw: string | null = null;
  try {
    raw = await ipc.settingsGet(workspaceKey(key));
  } catch {
    return "first";
  }
  const saved = parseWorkspace(raw);
  if (!saved) return "first";
  // The connection may have closed, or the user may have opened a tab, while
  // the workspace was loading.
  if (sessionId !== LOCAL_SESSION && !profileKeyOf(sessionId)) return "done";
  if (useTerminals.getState().tabs.some((t) => t.sessionId === sessionId)) return "done";
  lastSaved.set(key, JSON.stringify(saved));
  useTerminals.getState().restoreTabs(sessionId, saved.tabs);
  return "restored";
}

/** Rebuild the saved tabs of one connection (or of the local shells, with
 *  `LOCAL_SESSION`). Each is restored once; see `RestoreResult`. */
export function restoreWorkspace(sessionId: SessionId): Promise<RestoreResult> {
  let pending = loading.get(sessionId);
  if (!pending) {
    pending = restoreOne(sessionId).finally(() => loading.delete(sessionId));
    loading.set(sessionId, pending);
  }
  return pending;
}

// ---- Sessions left on the host ----

export interface DetachedSession {
  name: string;
  /** Seconds since the epoch, 0 when unknown. */
  lastActivity: number;
}

/** Faro's tmux sessions on this connection's host that no open pane is
 *  attached to: left by a closed app, another device, or a layout that was
 *  never restored. */
export async function detachedSessions(sessionId: SessionId): Promise<DetachedSession[]> {
  if (sessionId === LOCAL_SESSION) return [];
  const all = await ipc.terminalPersistList(sessionId).catch(() => []);
  const claimed = claimedSessionNames(
    useTerminals.getState().tabs.filter((t) => t.sessionId === sessionId)
  );
  return all
    .filter((s) => !claimed.has(s.name))
    .map((s) => ({ name: s.name, lastActivity: s.lastActivity }));
}
