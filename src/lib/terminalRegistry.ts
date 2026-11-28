// Terminal instance registry (Plan 11 Phase 1). xterm instances — and the DOM
// node each one renders into — live here, OUTSIDE React, keyed by a stable
// pane id. React components are thin viewports: on mount they `attach(el)` the
// cached node, on unmount they `detach()` it; the instance (and its scrollback,
// PTY, and listeners) survives remounts, dock toggles, split-tree restructures,
// popouts, and HMR. Disposal is driven explicitly by the terminals store (the
// source of truth), never by a React unmount.
//
// This is what makes split panes cheap: re-parenting a pane in the layout tree
// remounts its React node, but the xterm element is just moved, not rebuilt.

import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import { ipc, onTerminalData, onTerminalExit } from "./ipc";
import { openExternal } from "./openExternal";
import { attachSuggestions, type SuggestHandle } from "./termSuggest";
import { registerTerminalPane } from "./termInput";
import { isTerminalChord } from "./terminalChords";
import { attachHighlighter, isDarkHex } from "./terminalHighlight";
import { broadcastTargets, isTerminalReply } from "./terminalBroadcast";
import {
  MAX_PASTE_BYTES,
  blobToBase64,
  clipboardImage,
  imageExt,
  quotePastePath,
} from "./terminalPaste";
import { toastError } from "./errors";
import { toast } from "@/stores/toastStore";
import { useSettings, TERMINAL_THEMES, type PersistedSettings } from "@/stores/settingsStore";
import { useConnections } from "@/stores/connectionsStore";
import type { SessionId } from "./types";

export type TermStatus = "opening" | "ready" | "exited";

export interface PaneState {
  status: TermStatus;
  error: string | null;
  exitCode: number | null;
}

export interface PaneEntry {
  paneId: string;
  sessionId: SessionId;
  term: XTerm;
  /** The host node the xterm rendered into — cached and re-parented on attach. */
  element: HTMLDivElement;
  getTerminalId(): string | null;
  /** Serialize scrollback (capped) for a popout handoff. */
  serialize(): string;
  attach(container: HTMLElement): void;
  /** Remove the cached node from the DOM. Pass the container this pane was
   *  attached to so a re-parent (split restructure / StrictMode) doesn't pull
   *  the node out of a DIFFERENT leaf that just adopted it. */
  detach(container?: HTMLElement): void;
  /** Re-measure to fill the current container. Safe to call when hidden. */
  refit(): void;
  /** Subscribe to status changes; fires immediately with the current state. */
  subscribe(cb: (s: PaneState) => void): () => void;
  /** Flag this pane's PTY as handed off to a popout window — dispose must NOT
   *  close it (the new window owns its lifetime). Reset to false to reclaim it
   *  if the popout failed to open. */
  setHandedOff(v: boolean): void;
  /** Write to this pane's PTY. A no-op until the shell is open. */
  send(data: string): void;
}

interface InternalEntry extends PaneEntry {
  state: PaneState;
  listeners: Set<(s: PaneState) => void>;
  suggest: SuggestHandle;
  unregisterInput: () => void;
  unlistenData: (() => void) | null;
  unlistenExit: (() => void) | null;
  disposables: Array<{ dispose: () => void }>;
  onWindowResize: () => void;
  handedOff: boolean;
  disposed: boolean;
  terminalId: string | null;
}

const panes = new Map<string, InternalEntry>();

/** The xterm options that follow Settings › Terminal. One function so new
 *  panes, live panes and popped-out windows can't drift apart. */
export function terminalOptions(s: PersistedSettings) {
  return {
    fontFamily: s.terminalFontFamily,
    fontSize: s.terminalFontSize,
    lineHeight: s.terminalLineHeight,
    cursorStyle: s.terminalCursorStyle,
    cursorBlink: s.terminalCursorBlink,
    theme: TERMINAL_THEMES[s.terminalTheme],
  } as const;
}

/** Everything in a terminal's buffer as plain text: scrollback and screen,
 *  soft-wrapped lines joined back together. */
export function bufferText(term: XTerm): string {
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n");
}

/** OSC 52: let a program on the host put text on the local clipboard
 *  (`ESC ] 52 ; c ; <base64> BEL`). Write-only: a `?` read request is ignored,
 *  so a host can never read what is on the clipboard. */
export function attachOsc52(term: XTerm): { dispose: () => void } {
  return term.parser.registerOscHandler(52, (data) => {
    if (!useSettings.getState().terminalOsc52) return true;
    const at = data.indexOf(";");
    const payload = at >= 0 ? data.slice(at + 1) : "";
    if (!payload || payload === "?") return true;
    try {
      const bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));
      const text = new TextDecoder().decode(bytes);
      if (text) navigator.clipboard.writeText(text).catch(() => {});
    } catch {
      // not base64 — ignore
    }
    return true;
  });
}

export function hasPane(paneId: string): boolean {
  return panes.has(paneId);
}

export function getPane(paneId: string): PaneEntry | undefined {
  return panes.get(paneId);
}

/** Get the pane for `paneId`, creating (and opening a PTY for) it if absent.
 *  Idempotent: a second call with the same id returns the live instance. */
export function acquirePane(
  paneId: string,
  opts: {
    sessionId: SessionId;
    initialCommand?: string;
    shell?: string;
    cwd?: string;
    /** Run inside this tmux session on the host (persistent pane). */
    persistName?: string;
  }
): PaneEntry {
  const existing = panes.get(paneId);
  if (existing) return existing;

  const { sessionId, initialCommand, shell, cwd, persistName } = opts;
  const settings = useSettings.getState();

  const term = new XTerm({
    ...terminalOptions(settings),
    scrollback: settings.terminalScrollback,
    allowProposedApi: true,
  });
  const fit = new FitAddon();
  const serialize = new SerializeAddon();
  term.loadAddon(fit);
  // The addon's default handler uses window.open, which goes nowhere in Tauri.
  term.loadAddon(new WebLinksAddon((_e, uri) => openExternal(uri)));
  term.loadAddon(serialize);

  // The xterm renders into this cached node; React only re-parents it. Opening
  // on a detached element is fine — content is buffered and shown once attached.
  const element = document.createElement("div");
  element.className = "h-full w-full";
  term.open(element);

  const entry: InternalEntry = {
    paneId,
    sessionId,
    term,
    element,
    state: { status: "opening", error: null, exitCode: null },
    listeners: new Set(),
    handedOff: false,
    disposed: false,
    terminalId: null,
    suggest: null as unknown as SuggestHandle,
    unregisterInput: () => {},
    unlistenData: null,
    unlistenExit: null,
    disposables: [],
    onWindowResize: () => {},
    send: () => {},
    getTerminalId: () => entry.terminalId,
    serialize: () => serialize.serialize({ scrollback: 2000 }),
    attach: (container) => {
      if (element.parentElement !== container) container.appendChild(element);
    },
    detach: (container) => {
      // Only pull the node if it still lives in the container we were asked
      // about (or unconditionally when none is given, e.g. on dispose).
      if (container && element.parentElement !== container) return;
      element.parentElement?.removeChild(element);
    },
    refit: () => {
      try {
        fit.fit();
      } catch {}
    },
    subscribe: (cb) => {
      entry.listeners.add(cb);
      cb(entry.state);
      return () => entry.listeners.delete(cb);
    },
    setHandedOff: (v) => {
      entry.handedOff = v;
    },
  };

  const setState = (patch: Partial<PaneState>) => {
    entry.state = { ...entry.state, ...patch };
    for (const cb of entry.listeners) cb(entry.state);
  };

  // History is keyed by profile so suggestions survive reconnects to the server.
  const historyKey =
    useConnections
      .getState()
      .sessions.find((x) => x.sessionId === sessionId)?.profileId ?? sessionId;
  entry.suggest = attachSuggestions(term, {
    historyKey,
    send: (data) => {
      if (entry.terminalId) ipc.terminalWrite(entry.terminalId, data).catch(() => {});
    },
    swallowKey: isTerminalChord,
  });

  entry.unregisterInput = registerTerminalPane(paneId, {
    write: (data) => {
      if (entry.terminalId) ipc.terminalWrite(entry.terminalId, data).catch(() => {});
    },
    focus: () => term.focus(),
  });

  const send = (data: string) => {
    if (entry.terminalId) ipc.terminalWrite(entry.terminalId, data).catch(() => {});
  };
  entry.send = send;
  entry.disposables.push(
    term.onData((data) => {
      send(data);
      // Broadcast: copy what the user typed to the tab's other panes, but
      // never the terminal's own answers to a program's queries.
      if (isTerminalReply(data)) return;
      for (const other of broadcastTargets(paneId)) panes.get(other)?.send(data);
    })
  );
  entry.disposables.push(attachOsc52(term));
  entry.disposables.push(
    attachHighlighter(term, () => {
      const s = useSettings.getState();
      return {
        enabled: s.terminalHighlight,
        rules: s.terminalHighlightRules,
        darkBackground: isDarkHex(TERMINAL_THEMES[s.terminalTheme].background),
      };
    })
  );

  // Plain paste: skip xterm's bracketed-paste markers for programs that
  // mangle them. Capture phase, so this runs before xterm's own handler.
  // Image paste: save the image where the shell runs and type its path.
  const pasteImage = async (file: File) => {
    if (file.size > MAX_PASTE_BYTES) {
      toast.warning(
        "Image too large to paste",
        `Pasted images can be at most ${MAX_PASTE_BYTES / (1024 * 1024)} MB.`
      );
      return;
    }
    try {
      const path = await ipc.terminalPasteImage(
        sessionId,
        await blobToBase64(file),
        imageExt(file.type)
      );
      send(quotePastePath(path) + " ");
    } catch (e) {
      toastError(e, "Couldn't paste the image");
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    if (useSettings.getState().terminalPasteImages) {
      const image = clipboardImage(e.clipboardData);
      if (image) {
        e.preventDefault();
        e.stopPropagation();
        void pasteImage(image);
        return;
      }
    }
    if (!useSettings.getState().terminalPlainPaste) return;
    const text = e.clipboardData?.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    e.stopPropagation();
    send(text.replace(/\r?\n/g, "\r"));
  };
  element.addEventListener("paste", onPaste, true);
  entry.disposables.push({
    dispose: () => element.removeEventListener("paste", onPaste, true),
  });
  entry.disposables.push(
    term.onResize(({ cols, rows }) => {
      if (entry.terminalId)
        ipc.terminalResize(entry.terminalId, cols, rows).catch(() => {});
    })
  );
  // Copy-on-select (PuTTY style); read the toggle live so Settings takes effect
  // without reopening. Empty selections are ignored so we don't wipe the board.
  entry.disposables.push(
    term.onSelectionChange(() => {
      if (!useSettings.getState().terminalCopyOnSelect) return;
      const text = term.getSelection();
      if (text) navigator.clipboard.writeText(text).catch(() => {});
    })
  );

  entry.onWindowResize = () => entry.refit();
  window.addEventListener("resize", entry.onWindowResize);

  // Open the PTY and wire its lifecycle. Runs once per pane.
  (async () => {
    try {
      // Output can arrive before `openTerminal` returns the id (a local PTY
      // asks for the cursor position the moment it starts, and waits for the
      // answer). Hold it until the id is known instead of dropping it.
      let early: { terminalId: string; data: string }[] | null = [];
      entry.unlistenData = await onTerminalData((e) => {
        if (entry.terminalId === null) {
          if (early && early.length < 500) early.push(e);
          return;
        }
        if (e.terminalId === entry.terminalId) term.write(e.data);
      });
      entry.unlistenExit = await onTerminalExit((e) => {
        if (e.terminalId === entry.terminalId) {
          setState({
            status: "exited",
            exitCode: e.code ?? null,
          });
          term.writeln(
            `\r\n\x1b[33m[session ended${
              e.code !== null ? ` (exit ${e.code})` : ""
            }]\x1b[0m`
          );
        }
      });
      const id = await ipc.openTerminal(sessionId, term.cols || 80, term.rows || 24, {
        shell,
        cwd,
        persistName,
        scrollback: settings.terminalScrollback,
      });
      entry.terminalId = id;
      for (const e of early ?? []) if (e.terminalId === id) term.write(e.data);
      early = null;
      if (entry.disposed) {
        ipc.closeTerminal(id).catch(() => {});
        return;
      }
      setState({ status: "ready" });
      term.focus();
      // "Open terminal here" seeds a cd; run it once the shell is live.
      if (initialCommand) ipc.terminalWrite(id, initialCommand).catch(() => {});
    } catch (e) {
      setState({ status: "exited", error: String(e) });
    }
  })();

  panes.set(paneId, entry);
  return entry;
}

/** Wipe a pane's screen and scrollback. The running program is untouched: a
 *  `tail -f` keeps going on a clean screen. */
export function clearPane(paneId: string): void {
  const entry = panes.get(paneId);
  if (!entry) return;
  entry.term.clear();
  entry.term.focus();
}

export function selectAllInPane(paneId: string): void {
  const entry = panes.get(paneId);
  if (!entry) return;
  entry.term.selectAll();
  entry.term.focus();
}

/** A pane's whole output as plain text, or null when the pane is gone. */
export function paneText(paneId: string): string | null {
  const entry = panes.get(paneId);
  return entry ? bufferText(entry.term) : null;
}

/** Fully tear down a pane (store-driven, on tab/pane close or disconnect).
 *  Closes the PTY unless it was handed off to a popout window. */
export function disposePane(paneId: string, opts?: { detach?: boolean }): void {
  const entry = panes.get(paneId);
  if (!entry) return;
  panes.delete(paneId);
  entry.disposed = true;
  window.removeEventListener("resize", entry.onWindowResize);
  entry.unregisterInput();
  entry.suggest.dispose();
  for (const d of entry.disposables) d.dispose();
  entry.unlistenData?.();
  entry.unlistenExit?.();
  if (entry.terminalId && !entry.handedOff) {
    // `detach`: the connection is going away, or the pane is being reopened.
    // A persistent pane's shell keeps running on the host either way.
    ipc.closeTerminal(entry.terminalId, !opts?.detach).catch(() => {});
  }
  entry.detach();
  entry.term.dispose();
}

// HMR: dispose every live pane so a hot reload doesn't leak xterm instances or
// orphan PTYs. The store re-acquires panes on the next render.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    for (const id of [...panes.keys()]) disposePane(id, { detach: true });
  });
}
