// Broadcast input (Plan 36 Phase 2): while a tab has it on, what is typed in
// one pane is written to every pane of that tab.
//
// xterm reports two different things through the same `onData` stream: what
// the user typed or pasted, and the terminal's own answers to questions the
// program asked (cursor position, device attributes, focus changes). Only the
// first kind may be copied to other panes; an answer sent to a shell that
// never asked would show up as garbage on its prompt.

/** Is `data` an automatic terminal reply rather than user input? */
export function isTerminalReply(data: string): boolean {
  if (!data.startsWith("\x1b")) return false;
  // Cursor position / device status: ESC [ row ; col R, ESC [ 0 n
  // Device attributes: ESC [ ? … c, ESC [ > … c
  if (/^\x1b\[[?>]?[\d;]*[Rnc]$/.test(data)) return true;
  // Focus in / out.
  if (data === "\x1b[I" || data === "\x1b[O") return true;
  // OSC and DCS answers (colour queries, XTGETTCAP, DECRQSS).
  if (/^\x1b\][\s\S]*(\x07|\x1b\\)$/.test(data)) return true;
  if (/^\x1bP[\s\S]*\x1b\\$/.test(data)) return true;
  return false;
}

type Resolver = (paneId: string) => string[] | null;

let resolver: Resolver | null = null;

/** The terminals store tells the registry which panes share a broadcast. The
 *  resolver returns the OTHER panes to write to, or null when the pane's tab
 *  isn't broadcasting. */
export function setBroadcastResolver(fn: Resolver): void {
  resolver = fn;
}

export function broadcastTargets(paneId: string): string[] {
  return resolver?.(paneId) ?? [];
}
