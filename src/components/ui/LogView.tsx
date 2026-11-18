import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { Copy, Eraser, Pause, Play, RefreshCw } from "lucide-react";
import { ipc, onStreamEvent } from "@/lib/ipc";
import { useSettings, TERMINAL_THEMES } from "@/stores/settingsStore";
import { toast } from "@/stores/toastStore";
import { cn } from "@/lib/cn";

/** Lines kept for "Copy" and for catching up after a pause. */
const KEEP = 5000;

/**
 * A read-only log: a container's output or a unit's journal, followed live
 * where the host allows it. Rendered in an xterm so ANSI colour in the log
 * shows as colour, with the terminal's own font and theme.
 *
 * `follow` starts the backend stream for `streamKey` (lines then arrive as
 * `stream://lines` events). Pass `null` where a live stream is impossible —
 * root only through a sudo password — and the view shows `tail` with a
 * Refresh button instead, and says why.
 */
export function LogView({
  sessionId,
  streamKey,
  follow,
  tail,
  className,
}: {
  sessionId: string;
  /** Names the log, e.g. `docker:<id>`; must match what the backend emits. */
  streamKey: string;
  follow: (() => Promise<void>) | null;
  /** The last lines, without following. */
  tail: () => Promise<string>;
  className?: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const linesRef = useRef<string[]>([]);
  const pendingRef = useRef<string[]>([]);
  const pausedRef = useRef(false);
  const followRef = useRef(follow);
  const tailRef = useRef(tail);
  followRef.current = follow;
  tailRef.current = tail;

  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<"connecting" | "live" | "ended" | "static">(
    follow ? "connecting" : "static"
  );
  const [note, setNote] = useState<string | null>(null);
  const [skipped, setSkipped] = useState(0);
  const [loading, setLoading] = useState(false);

  const fontFamily = useSettings((s) => s.terminalFontFamily);
  const fontSize = useSettings((s) => s.terminalFontSize);
  const themeKey = useSettings((s) => s.terminalTheme);

  const write = useCallback((lines: string[]) => {
    const kept = linesRef.current;
    kept.push(...lines);
    if (kept.length > KEEP) kept.splice(0, kept.length - KEEP);
    if (pausedRef.current) {
      const pending = pendingRef.current;
      pending.push(...lines);
      if (pending.length > KEEP) pending.splice(0, pending.length - KEEP);
      return;
    }
    termRef.current?.write(lines.map((l) => l + "\r\n").join(""));
  }, []);

  // The terminal itself: created once per mount.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const s = useSettings.getState();
    const term = new XTerm({
      disableStdin: true,
      convertEol: true,
      cursorBlink: false,
      cursorInactiveStyle: "none",
      scrollback: KEEP,
      fontFamily: s.terminalFontFamily,
      fontSize: Math.max(10, s.terminalFontSize - 1),
      theme: TERMINAL_THEMES[s.terminalTheme],
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    term.write("\x1b[?25l"); // no cursor: nothing can be typed here
    // Ctrl/Cmd+C copies the selection (stdin is off, so nothing else would).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel);
        return false;
      }
      return true;
    });
    termRef.current = term;
    const refit = () => {
      try {
        fit.fit();
      } catch {
        // The host can be zero-sized for a frame while a drawer opens.
      }
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    return () => {
      ro.disconnect();
      // Nothing may write to it from here on.
      termRef.current = null;
      // xterm 5.5 schedules a viewport sync on a timer when it opens and
      // throws if the terminal is disposed before that runs, which React's
      // dev double-mount does at once. Timers fire in order, so disposing on
      // a later one lets xterm's own (and any queued writes) finish first.
      window.setTimeout(() => term.dispose(), 100);
    };
  }, []);

  // Live-apply terminal font and theme changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = Math.max(10, fontSize - 1);
    term.options.theme = TERMINAL_THEMES[themeKey];
  }, [fontFamily, fontSize, themeKey]);

  const loadTail = useCallback(async () => {
    setLoading(true);
    try {
      const text = await tailRef.current();
      termRef.current?.reset();
      termRef.current?.write("\x1b[?25l");
      linesRef.current = [];
      write(text.split("\n"));
      setNote(null);
    } catch (e) {
      setNote(String(e));
    } finally {
      setLoading(false);
    }
  }, [write]);

  // The stream for this key. Switching keys only swaps the subscription: the
  // backend replaces the running follow when the new one starts.
  const canFollow = follow !== null;
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    termRef.current?.reset();
    termRef.current?.write("\x1b[?25l");
    linesRef.current = [];
    pendingRef.current = [];
    setSkipped(0);
    setNote(null);

    if (!canFollow) {
      setStatus("static");
      void loadTail();
      return;
    }
    setStatus("connecting");
    void (async () => {
      const off = await onStreamEvent(
        (e) => {
          if (e.sessionId !== sessionId || e.key !== streamKey) return;
          setStatus("live");
          if (e.dropped > 0) setSkipped((n) => n + e.dropped);
          write(e.lines);
        },
        (e) => {
          if (e.sessionId !== sessionId || e.key !== streamKey) return;
          // A stop we asked for is not news.
          if (!e.stopped) {
            setStatus("ended");
            setNote(e.reason);
          }
        }
      );
      if (!alive) {
        off();
        return;
      }
      unlisten = off;
      try {
        await followRef.current?.();
        if (alive) setStatus((s) => (s === "connecting" ? "live" : s));
      } catch (e) {
        if (alive) {
          setStatus("ended");
          setNote(String(e));
        }
      }
    })();
    return () => {
      alive = false;
      unlisten?.();
      ipc.followStop(sessionId, streamKey).catch(() => {});
    };
  }, [sessionId, streamKey, canFollow, write, loadTail]);

  const togglePause = () => {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (!next && pendingRef.current.length > 0) {
      termRef.current?.write(pendingRef.current.map((l) => l + "\r\n").join(""));
      pendingRef.current = [];
    }
  };

  const clear = () => {
    termRef.current?.clear();
    linesRef.current = [];
    setSkipped(0);
  };

  const copyAll = () => {
    void navigator.clipboard.writeText(linesRef.current.join("\n"));
    toast.info("Log copied", `${linesRef.current.length} lines`, undefined, { log: false });
  };

  const theme = TERMINAL_THEMES[themeKey];

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1 text-[11px] text-text-muted">
        <span
          className={cn(
            "h-1.5 w-1.5 shrink-0 rounded-full",
            status === "live" && !paused
              ? "bg-success"
              : status === "ended"
                ? "bg-danger"
                : "bg-border"
          )}
        />
        <span role="status" className="min-w-0 flex-1 truncate" title={note ?? undefined}>
          {status === "static"
            ? "Not live: sudo needs a password here, which a stream can't type"
            : status === "connecting"
              ? "Connecting…"
              : status === "ended"
                ? `Ended${note ? `: ${note}` : ""}`
                : paused
                  ? "Paused"
                  : "Live"}
          {skipped > 0 && ` · ${skipped.toLocaleString()} lines skipped`}
        </span>
        {status === "static" ? (
          <LogButton label="Refresh" onClick={() => void loadTail()} disabled={loading}>
            <RefreshCw size={12} className={loading ? "animate-spin" : undefined} />
          </LogButton>
        ) : (
          <LogButton label={paused ? "Resume" : "Pause"} onClick={togglePause} pressed={paused}>
            {paused ? <Play size={12} /> : <Pause size={12} />}
          </LogButton>
        )}
        <LogButton label="Clear" onClick={clear}>
          <Eraser size={12} />
        </LogButton>
        <LogButton label="Copy log" onClick={copyAll}>
          <Copy size={12} />
        </LogButton>
      </div>
      <div
        className="min-h-0 flex-1 overflow-hidden px-2 py-1"
        style={{ background: theme.background }}
      >
        <div ref={hostRef} className="h-full w-full" data-testid="log-view" />
      </div>
    </div>
  );
}

function LogButton({
  label,
  onClick,
  pressed,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={cn(
        "rounded p-1 hover:bg-bg-hover hover:text-text disabled:opacity-60",
        pressed ? "bg-bg-hover text-text" : "text-text-dim"
      )}
    >
      {children}
    </button>
  );
}
