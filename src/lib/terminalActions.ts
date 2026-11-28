// Everyday terminal actions (Plan 36 Phase 2), shared by the command palette,
// the keyboard shortcuts and the tab menu so each behaves the same wherever
// it is triggered.

import { save } from "@tauri-apps/plugin-dialog";
import { ipc } from "./ipc";
import { clearPane, paneText, selectAllInPane } from "./terminalRegistry";
import { useTerminals, type TerminalTab } from "@/stores/terminalsStore";
import { toast } from "@/stores/toastStore";
import { toastError } from "./errors";

export function activeTerminalTab(): TerminalTab | null {
  const t = useTerminals.getState();
  return t.tabs.find((x) => x.id === t.activeId) ?? null;
}

export function clearTerminal(tab: TerminalTab | null = activeTerminalTab()): void {
  if (tab) clearPane(tab.activePaneId);
}

export function selectAllTerminal(tab: TerminalTab | null = activeTerminalTab()): void {
  if (tab) selectAllInPane(tab.activePaneId);
}

export async function copyTerminalOutput(
  tab: TerminalTab | null = activeTerminalTab()
): Promise<void> {
  const text = tab ? paneText(tab.activePaneId) : null;
  if (!text) {
    toast.info("Nothing to copy", "This terminal has no output yet.");
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Output copied", `${text.split("\n").length.toLocaleString()} lines`);
  } catch (e) {
    toastError(e, "Couldn't copy the output");
  }
}

/** A file name that is safe on every OS, from a tab title. */
export function outputFileName(title: string, now = new Date()): string {
  const stem = title.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "terminal";
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}`;
  return `${stem}-${stamp}.txt`;
}

export async function saveTerminalOutput(
  tab: TerminalTab | null = activeTerminalTab()
): Promise<void> {
  const text = tab ? paneText(tab.activePaneId) : null;
  if (!tab || !text) {
    toast.info("Nothing to save", "This terminal has no output yet.");
    return;
  }
  try {
    const path = await save({
      title: "Save terminal output",
      defaultPath: outputFileName(tab.title),
      filters: [{ name: "Text", extensions: ["txt", "log"] }],
    });
    if (!path) return;
    await ipc.writeTextFile(path, text + "\n");
    toast.success("Output saved", path);
  } catch (e) {
    toastError(e, "Couldn't save the output");
  }
}

export function toggleBroadcast(tab: TerminalTab | null = activeTerminalTab()): void {
  if (tab) useTerminals.getState().toggleBroadcast(tab.id);
}
