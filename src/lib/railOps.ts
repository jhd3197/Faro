// Pure helpers behind the server rail: copy naming, the sort cycle, range
// selection and the "this profile can't work as saved" check. No imports
// beyond types, so scripts/rail.test.mjs can load this file on its own.
import type { ConnectionProfile } from "./types";

/** Matches a trailing " copy" or " copy N" (N ≥ 2). */
const COPY_SUFFIX = /\s+copy(?:\s+(\d+))?$/i;

/**
 * The name for a duplicate of `name`: "X copy", then "X copy 2", "X copy 3"…
 * Duplicating a copy never stacks ("X copy" → "X copy 2", not "X copy copy").
 * Names are compared case-insensitively, like the rename check.
 */
export function copyName(name: string, existing: Iterable<string>): string {
  const base = name.replace(COPY_SUFFIX, "").trim() || name.trim();
  const taken = new Set([...existing].map((n) => n.trim().toLowerCase()));
  const first = `${base} copy`;
  if (!taken.has(first.toLowerCase())) return first;
  for (let n = 2; ; n++) {
    const next = `${base} copy ${n}`;
    if (!taken.has(next.toLowerCase())) return next;
  }
}

/** How the rail orders servers. "custom" = the drag-and-drop order. */
export type RailSort = "custom" | "az" | "za";

const SORT_CYCLE: RailSort[] = ["custom", "az", "za"];

/** The state the sort item switches to next. */
export function nextSort(cur: RailSort): RailSort {
  const at = Math.max(0, SORT_CYCLE.indexOf(cur)); // unknown = custom
  return SORT_CYCLE[(at + 1) % SORT_CYCLE.length];
}

/** The sort menu item names the state it switches to. */
export function sortItemLabel(cur: RailSort): string {
  const next = nextSort(cur);
  return next === "az" ? "Sort: A–Z" : next === "za" ? "Sort: Z–A" : "Sort: Custom order";
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Re-order an already custom-ordered list by name. "custom" returns it as is. */
export function applySort<T extends { name: string }>(items: T[], sort: RailSort): T[] {
  if (sort !== "az" && sort !== "za") return items;
  const dir = sort === "az" ? 1 : -1;
  return [...items].sort((a, b) => dir * collator.compare(a.name, b.name));
}

/**
 * Shift-click selection: every id between the anchor and the clicked id, in
 * on-screen order. A missing anchor (or one that scrolled into a closed
 * group) selects just the clicked id.
 */
export function rangeBetween(visible: string[], anchor: string | null, target: string): string[] {
  const b = visible.indexOf(target);
  if (b < 0) return [];
  const a = anchor ? visible.indexOf(anchor) : -1;
  if (a < 0) return [target];
  const [from, to] = a <= b ? [a, b] : [b, a];
  return visible.slice(from, to + 1);
}

/** A failed connect, as the connections store remembers it for this run. */
export interface ConnectFailure {
  kind: string;
  message: string;
}

/**
 * Why a saved profile can't connect as it stands, or null. Only uses what
 * Faro already knows: the saved fields, and how the last connect attempt in
 * this run failed (sign-in rejected, or a key/path that doesn't exist).
 */
export function profileProblem(p: ConnectionProfile, failure?: ConnectFailure | null): string | null {
  if (p.protocol === "faro-agent" && !p.agentKey) return "Not paired yet";
  // Imported or partial profiles may lack auth entirely; that is not a key problem.
  if (p.auth?.kind === "key" && !p.auth.path?.trim()) return "No key file chosen";
  if (failure?.kind === "auth") return "Sign-in failed last time";
  if (failure?.kind === "not-found") return "Key file or path not found last time";
  return null;
}
