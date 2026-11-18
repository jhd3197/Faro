// Command palette matching. The query is split on spaces and every term must
// match (in any order): each one fuzzy against the title first, then against
// the command's keywords. The result says *why* it matched — the title ranges
// to highlight, and the keyword words that carried the terms the title didn't.

import { fuzzyMatch } from "./fuzzy";

export interface PaletteMatch {
  score: number;
  /** [start, end) ranges in the title to highlight. */
  ranges: [number, number][];
  /** Keyword words that matched terms the title couldn't. */
  keywordHits: string[];
}

/** Merge overlapping / touching ranges, sorted. */
function mergeRanges(rs: [number, number][]): [number, number][] {
  const sorted = [...rs].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** The keyword word a term most plausibly matched: a word containing it,
 *  else a word it fuzzy-matches; null when it only matched across words. */
function keywordFor(term: string, keywords: string): string | null {
  const t = term.toLowerCase();
  const words = keywords.split(/\s+/).filter(Boolean);
  return (
    words.find((w) => w.toLowerCase().includes(t)) ??
    words.find((w) => fuzzyMatch(t, w).matched) ??
    null
  );
}

export function matchCommand(
  query: string,
  title: string,
  keywords?: string
): PaletteMatch | null {
  const q = query.trim();
  if (!q) return { score: 0, ranges: [], keywordHits: [] };

  // The whole query reading straight through the title is the best signal
  // ("folder sync" → "Folder Sync"), and keeps single-word ranking as it was.
  const whole = fuzzyMatch(q, title);
  if (whole.matched) {
    return { score: whole.score + 120, ranges: whole.ranges, keywordHits: [] };
  }

  const terms = q.split(/\s+/);
  let score = 0;
  let inTitle = 0;
  const ranges: [number, number][] = [];
  const keywordHits: string[] = [];
  for (const term of terms) {
    const tm = fuzzyMatch(term, title);
    if (tm.matched) {
      score += tm.score;
      ranges.push(...tm.ranges);
      inTitle++;
      continue;
    }
    if (!keywords) return null;
    const km = fuzzyMatch(term, keywords);
    if (!km.matched) return null;
    score += km.score;
    const kw = keywordFor(term, keywords);
    if (kw && !keywordHits.includes(kw)) keywordHits.push(kw);
  }
  // Title hits outrank keyword-only hits.
  if (inTitle === terms.length) score += 100;
  else if (inTitle > 0) score += 50;
  return { score, ranges: mergeRanges(ranges), keywordHits };
}
