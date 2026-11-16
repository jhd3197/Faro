// The release workflow wraps the user-facing summary (the merged PR's
// Highlights) in these markers; everything else in a release body is download
// tables and install steps that don't belong in the app. Mirrors
// scripts/release-tools.mjs.
const START = "<!-- faro:changes -->";
const END = "<!-- /faro:changes -->";

/** The marked "what changed" text of a release body, or null when it has none. */
export function releaseChanges(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const start = notes.indexOf(START);
  if (start < 0) return null;
  const end = notes.indexOf(END, start + START.length);
  if (end < 0) return null;
  const text = notes.slice(start + START.length, end).trim();
  return text || null;
}
