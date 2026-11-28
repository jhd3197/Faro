// Local terminal tabs (Plan 36 Phase 1): shell profiles found on this machine
// and the one place that opens a local tab, so the dock button, the command
// palette and "Open terminal here" all behave the same.

import { ipc } from "./ipc";
import { LOCAL_SESSION, type LocalShell } from "./types";
import { useSettings } from "@/stores/settingsStore";
import { useTerminals, type TerminalTab } from "@/stores/terminalsStore";
import { useLayout } from "@/stores/layoutStore";

let cached: Promise<LocalShell[]> | null = null;

/** Shells on this machine, the default first. Looked up once per launch;
 *  `refresh` asks again (a distro or shell installed since). */
export function localShells(refresh = false): Promise<LocalShell[]> {
  if (!cached || refresh) {
    cached = ipc.listLocalShells().catch(() => {
      cached = null;
      return [] as LocalShell[];
    });
  }
  return cached;
}

/** The profile a new local tab uses: the saved default when it is still
 *  installed, else the machine's first shell. */
export function pickDefaultShell(shells: LocalShell[], saved: string): LocalShell | null {
  return shells.find((s) => s.id === saved) ?? shells[0] ?? null;
}

/** Open a local shell tab and show the dock. `shell` is a profile id; without
 *  one the default profile is used. */
export async function openLocalTerminal(opts?: {
  shell?: string;
  cwd?: string;
}): Promise<TerminalTab> {
  const shells = await localShells();
  const saved = useSettings.getState().terminalLocalShell;
  const profile =
    (opts?.shell ? shells.find((s) => s.id === opts.shell) : null) ??
    pickDefaultShell(shells, saved);
  const t = useTerminals.getState();
  const sameName = t.tabs.filter(
    (x) => x.sessionId === LOCAL_SESSION && x.shell === profile?.id
  ).length;
  const base = profile?.name ?? "Local";
  useLayout.getState().setTerminalOpen(true);
  return t.openTab(LOCAL_SESSION, undefined, {
    title: sameName ? `${base} ${sameName + 1}` : base,
    shell: profile?.id,
    cwd: opts?.cwd,
  });
}
