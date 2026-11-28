// Keyword highlighting for terminal output (Plan 36 Phase 2): words such as
// `error`, `warning` and `ok` are coloured as lines are written. Rules are
// user-editable regular expressions; matching is pure and unit-tested, the
// xterm side only places decorations.

import type { IDecoration, IDisposable, IMarker, Terminal as XTerm } from "@xterm/xterm";

export type HighlightColor = "red" | "yellow" | "green" | "blue" | "magenta" | "cyan";

export const HIGHLIGHT_COLORS: HighlightColor[] = [
  "red",
  "yellow",
  "green",
  "blue",
  "magenta",
  "cyan",
];

export interface HighlightRule {
  id: string;
  /** A regular expression source, matched case-insensitively. */
  pattern: string;
  color: HighlightColor;
  enabled: boolean;
}

export const DEFAULT_HIGHLIGHT_RULES: HighlightRule[] = [
  {
    id: "errors",
    pattern: "\\b(error|errors|failed|failure|fatal|denied|panic)\\b",
    color: "red",
    enabled: true,
  },
  {
    id: "warnings",
    pattern: "\\b(warn|warning|warnings|deprecated)\\b",
    color: "yellow",
    enabled: true,
  },
  {
    id: "success",
    pattern: "\\b(ok|success|successful|succeeded|done|passed)\\b",
    color: "green",
    enabled: true,
  },
];

// Readable on a dark and on a light terminal background respectively.
const ON_DARK: Record<HighlightColor, string> = {
  red: "#f87171",
  yellow: "#fbbf24",
  green: "#4ade80",
  blue: "#60a5fa",
  magenta: "#e879f9",
  cyan: "#22d3ee",
};
const ON_LIGHT: Record<HighlightColor, string> = {
  red: "#dc2626",
  yellow: "#b45309",
  green: "#15803d",
  blue: "#2563eb",
  magenta: "#a21caf",
  cyan: "#0e7490",
};

export function highlightHex(color: HighlightColor, darkBackground: boolean): string {
  return (darkBackground ? ON_DARK : ON_LIGHT)[color] ?? ON_DARK.red;
}

/** Is `#rrggbb` a dark colour? Decides which highlight palette to use. */
export function isDarkHex(hex: string): boolean {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return true;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  return 0.299 * r + 0.587 * g + 0.114 * b < 140;
}

export interface CompiledRule {
  re: RegExp;
  color: HighlightColor;
}

/** Compile the enabled rules. A rule that isn't a valid regular expression, or
 *  that can match nothing (which would loop forever), is reported by id and
 *  left out. */
export function compileRules(rules: HighlightRule[]): {
  compiled: CompiledRule[];
  errors: Record<string, string>;
} {
  const compiled: CompiledRule[] = [];
  const errors: Record<string, string> = {};
  for (const rule of rules) {
    if (!rule.pattern.trim()) {
      errors[rule.id] = "Enter a word or a regular expression.";
      continue;
    }
    try {
      const re = new RegExp(rule.pattern, "gi");
      if (re.test("")) {
        errors[rule.id] = "This pattern matches empty text.";
        continue;
      }
      if (rule.enabled) compiled.push({ re, color: rule.color });
    } catch (e) {
      errors[rule.id] = e instanceof Error ? e.message : "Not a valid regular expression.";
    }
  }
  return { compiled, errors };
}

export interface LineMatch {
  start: number;
  length: number;
  color: HighlightColor;
}

/** Non-overlapping matches in one line. Earlier rules win where two overlap. */
export function matchLine(text: string, rules: CompiledRule[], max = 12): LineMatch[] {
  const out: LineMatch[] = [];
  for (const rule of rules) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while (out.length < max && (m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (!out.some((o) => start < o.start + o.length && o.start < end)) {
        out.push({ start, length: m[0].length, color: rule.color });
      }
    }
    if (out.length >= max) break;
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface HighlightConfig {
  enabled: boolean;
  rules: HighlightRule[];
  darkBackground: boolean;
}

// One scan never walks further back than this, however much was written.
const MAX_SCAN_LINES = 500;
const MAX_LINE_LENGTH = 2000;

/** Colour matches as output is written. Only the normal buffer is touched, so
 *  full-screen programs (vim, htop, less) are left alone. */
export function attachHighlighter(term: XTerm, getConfig: () => HighlightConfig): IDisposable {
  let rulesRef: HighlightRule[] | null = null;
  let compiled: CompiledRule[] = [];
  // Where the last scan stopped. A marker, because scrollback trimming shifts
  // line numbers and a marker follows its line.
  let scanned: IMarker | null = null;
  // Decorations on the line the cursor was on: that line may still change
  // (a prompt being typed), so it is redone on the next scan.
  let tail: IDecoration[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const drop = (list: IDecoration[]) => {
    for (const d of list) {
      d.marker.dispose();
      d.dispose();
    }
  };

  const scan = () => {
    timer = null;
    const cfg = getConfig();
    if (!cfg.enabled) return;
    const buf = term.buffer.active;
    if (buf.type !== "normal") return;
    if (cfg.rules !== rulesRef) {
      rulesRef = cfg.rules;
      compiled = compileRules(cfg.rules).compiled;
    }
    const cursorLine = buf.baseY + buf.cursorY;
    let from =
      scanned && !scanned.isDisposed && scanned.line >= 0
        ? scanned.line
        : Math.max(0, cursorLine - term.rows);
    from = Math.max(from, cursorLine - MAX_SCAN_LINES, 0);
    drop(tail);
    tail = [];
    if (compiled.length) {
      for (let y = from; y <= cursorLine; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        const text = line.translateToString(true);
        if (!text || text.length > MAX_LINE_LENGTH) continue;
        for (const m of matchLine(text, compiled)) {
          const marker = term.registerMarker(y - cursorLine);
          if (!marker) continue;
          const deco = term.registerDecoration({
            marker,
            x: m.start,
            width: m.length,
            foregroundColor: highlightHex(m.color, cfg.darkBackground),
            layer: "top",
          });
          if (!deco) {
            marker.dispose();
            continue;
          }
          if (y === cursorLine) tail.push(deco);
        }
      }
    }
    scanned?.dispose();
    scanned = term.registerMarker(0) ?? null;
  };

  const sub = term.onWriteParsed(() => {
    if (timer === null) timer = setTimeout(scan, 40);
  });

  return {
    dispose: () => {
      sub.dispose();
      if (timer !== null) clearTimeout(timer);
      drop(tail);
      scanned?.dispose();
    },
  };
}
