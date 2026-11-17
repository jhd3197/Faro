// Loose matching for the rail's server search. Spaces, dashes, underscores and
// dots are ignored on both sides, each word of the query is matched on its own
// (in any order, against any field), and a word that isn't a plain substring
// can still match as an in-order subsequence (`prd` finds `production`).

import { fuzzyMatch } from "./fuzzy";

/** Separators a server name or query may or may not use. */
const SEPARATORS = /[\s\-_.]+/g;

/** Lowercase with spaces, dashes, underscores and dots removed. */
export function collapse(s: string): string {
  return s.toLowerCase().replace(SEPARATORS, "");
}

/** The query's words, collapsed; separators split words. */
export function queryWords(query: string): string[] {
  return query.toLowerCase().split(SEPARATORS).filter(Boolean);
}

export interface SearchField {
  text: string | undefined | null;
  /** Higher ranks matches in this field first (the name beats the host). */
  weight: number;
}

/** Shortest word that may match as a subsequence; shorter ones match far too much. */
const MIN_FUZZY = 3;

/** Score `fields` against `query`, or null when some word matches nowhere. */
export function scoreFields(query: string, fields: SearchField[]): number | null {
  const words = queryWords(query);
  if (!words.length) return 0;
  const hay = fields
    .filter((f): f is { text: string; weight: number } => !!f.text)
    .map((f) => ({ text: collapse(f.text), weight: f.weight }));

  let total = 0;
  for (const word of words) {
    let best: number | null = null;
    for (const f of hay) {
      const at = f.text.indexOf(word);
      let score: number | null = null;
      if (at >= 0) {
        score = 100 + f.weight + (at === 0 ? 50 : 0) + (f.text === word ? 50 : 0);
      } else if (word.length >= MIN_FUZZY) {
        const m = fuzzyMatch(word, f.text);
        if (m.matched) score = Math.max(1, m.score) + f.weight / 2;
      }
      if (score !== null && (best === null || score > best)) best = score;
    }
    if (best === null) return null;
    total += best;
  }
  // The whole query read as one run ("acme corp" → "acmecorp") is the
  // strongest signal, ahead of the same words found apart.
  const whole = collapse(query);
  if (words.length > 1 && hay.some((f) => f.text.includes(whole))) total += 75;
  return total;
}

/** Items matching `query`, best first; ties keep their original order. */
export function searchRank<T>(items: T[], query: string, fields: (item: T) => SearchField[]): T[] {
  if (!queryWords(query).length) return items;
  return items
    .map((item, i) => ({ item, i, score: scoreFields(query, fields(item)) }))
    .filter((r): r is { item: T; i: number; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.item);
}
