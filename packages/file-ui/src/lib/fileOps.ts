// Pure path and naming rules behind copy / cut / paste, drag-to-move and the
// delete confirmation. No React and no transport, so they're unit-tested on
// their own (scripts/files.test.mjs).

import type { DirEntry } from "../types";

/** A drive-letter (C:\ or C:/) or UNC (\\server\share) path. Inferred from the
 *  path itself: a Faro Agent on a Windows host serves these too. */
export function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.startsWith("\\\\");
}

/** Windows file systems compare names case-insensitively. */
export function caseInsensitiveFor(path: string): boolean {
  return isWindowsPath(path);
}

/** Split into non-empty segments. On POSIX a backslash is an ordinary name
 *  character, so only Windows paths split on it. */
function segments(path: string): string[] {
  return path.split(isWindowsPath(path) ? /[/\\]/ : /\//).filter(Boolean);
}

/** The last segment of a path ("" for a root). */
export function baseName(path: string): string {
  const parts = segments(path);
  return parts[parts.length - 1] ?? "";
}

/** The folder holding `path`, in the path's own style. A root's parent is
 *  itself. */
export function parentOf(path: string): string {
  const win = isWindowsPath(path);
  const unc = path.startsWith("\\\\");
  const parts = segments(path);
  const rootParts = unc ? 2 : win ? 1 : 0;
  if (parts.length <= rootParts) return path;
  parts.pop();
  if (unc) return "\\\\" + parts.join("\\");
  if (win) return parts.length === 1 ? parts[0] + "\\" : parts.join("\\");
  if (!path.startsWith("/")) return parts.length ? parts.join("/") : ".";
  return "/" + parts.join("/");
}

/** `parent` + `name` with the right separator. */
export function joinPath(parent: string, name: string): string {
  const sep = isWindowsPath(parent) ? "\\" : "/";
  if (parent.endsWith(sep) || parent.endsWith("/")) return `${parent}${name}`;
  return `${parent}${sep}${name}`;
}

/** Comparable form: one separator style, no trailing separator, folded case
 *  where the file system ignores it. */
function canonical(path: string): string {
  const win = isWindowsPath(path);
  let p = win ? path.replace(/\//g, "\\") : path;
  const sep = win ? "\\" : "/";
  while (p.length > 1 && p.endsWith(sep) && !(win && /^[a-zA-Z]:\\$/.test(p))) p = p.slice(0, -1);
  return win ? p.toLowerCase() : p;
}

/** The same location, ignoring a trailing separator (and case on Windows). */
export function samePath(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

/** True when `path` is `ancestor` or sits anywhere below it. Separator-aware:
 *  /users-archive is not inside /users. */
export function isSameOrInside(path: string, ancestor: string): boolean {
  const a = canonical(ancestor);
  const p = canonical(path);
  if (p === a) return true;
  const sep = isWindowsPath(ancestor) ? "\\" : "/";
  const prefix = a.endsWith(sep) ? a : a + sep;
  return p.startsWith(prefix);
}

/** Why `entries` can't go into `destDir`, or null when they can. A folder can't
 *  be copied or moved into itself or anything below it. */
export function pasteProblem(entries: Pick<DirEntry, "path" | "name" | "kind">[], destDir: string): string | null {
  for (const e of entries) {
    if (e.kind !== "directory") continue;
    if (isSameOrInside(destDir, e.path)) {
      return canonical(destDir) === canonical(e.path)
        ? `Can't put “${e.name}” inside itself.`
        : `Can't put “${e.name}” inside one of its own folders.`;
    }
  }
  return null;
}

/** Copies past this are refused rather than probing forever. */
export const MAX_NAME_SUFFIX = 999;

/** "report.pdf" → ["report", ".pdf"]; folders and dotfiles keep the whole
 *  name as the stem. ".tar.gz" counts as one extension. */
function splitExt(name: string, isDir: boolean): [string, string] {
  if (isDir) return [name, ""];
  const m = /^(.+?)(\.tar\.(?:gz|bz2|xz)|\.[^.]+)$/i.exec(name);
  return m && m[1] ? [m[1], m[2]] : [name, ""];
}

/** The first free name for `name` among `taken`: the name itself, then
 *  "name (2).ext", "name (3).ext"… An existing " (N)" is replaced, never
 *  stacked. Returns null past MAX_NAME_SUFFIX. */
export function uniqueName(
  name: string,
  taken: Iterable<string>,
  { isDir = false, caseInsensitive = false }: { isDir?: boolean; caseInsensitive?: boolean } = {}
): string | null {
  const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  const used = new Set(Array.from(taken, fold));
  if (!used.has(fold(name))) return name;
  const [stem, ext] = splitExt(name, isDir);
  const base = stem.replace(/ \(\d+\)$/, "") || stem;
  for (let n = 2; n <= MAX_NAME_SUFFIX; n++) {
    const cand = `${base} (${n})${ext}`;
    if (!used.has(fold(cand))) return cand;
  }
  return null;
}

/** "Notes.txt" → "notes.txt": the same entry on a case-insensitive file
 *  system, so it isn't a collision with itself. */
export function isCaseOnlyRename(from: string, to: string): boolean {
  return from !== to && from.toLowerCase() === to.toLowerCase();
}

/** Whether renaming `oldName` to `newName` would land on a different entry
 *  that already exists in the folder. A case-only change on a
 *  case-insensitive file system is the entry itself, not a clash. */
export function renameClash(
  oldName: string,
  newName: string,
  siblings: Iterable<string>,
  caseInsensitive: boolean
): boolean {
  const fold = (s: string) => (caseInsensitive ? s.toLowerCase() : s);
  if (fold(newName) === fold(oldName)) return false;
  for (const s of siblings) if (s !== oldName && fold(s) === fold(newName)) return true;
  return false;
}

/** Folders (anything that isn't a plain file) and files in `entries`. */
export function countKinds(entries: Pick<DirEntry, "kind">[]): { folders: number; files: number } {
  let folders = 0;
  for (const e of entries) if (e.kind === "directory") folders++;
  return { folders, files: entries.length - folders };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "2 folders and 3 files", "1 file", "4 folders". `joiner` ", " gives the
 *  drag pill's "2 folders, 3 files". */
export function describeKinds(entries: Pick<DirEntry, "kind">[], joiner = " and "): string {
  const { folders, files } = countKinds(entries);
  const parts: string[] = [];
  if (folders) parts.push(plural(folders, "folder", "folders"));
  if (files) parts.push(plural(files, "file", "files"));
  return parts.join(joiner) || "nothing";
}

/** A name for a short confirmation: the item itself when it's one, otherwise
 *  the counts. */
export function describeItems(entries: Pick<DirEntry, "kind" | "name">[]): string {
  return entries.length === 1 ? entries[0].name : describeKinds(entries, ", ");
}

/** "1,234,567 bytes" — the exact size behind a rounded one. */
export function exactBytes(n: number): string {
  return `${Math.round(n).toLocaleString("en-US")} ${n === 1 ? "byte" : "bytes"}`;
}
