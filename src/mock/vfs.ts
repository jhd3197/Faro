// A small in-memory file tree over the demo listings, so rename, delete, new
// folder, duplicate, copy and move visibly change the panes in mock mode.
// Folders are seeded from data.listDir the first time they're opened; edits
// after that live here until the page reloads.
import { baseName, joinPath, parentOf, samePath, isSameOrInside } from "@faro/file-ui";
import type { DirEntry } from "@faro/file-ui";
import * as data from "./data";

const dirs = new Map<string, DirEntry[]>();
const key = (sessionId: string, path: string) => `${sessionId}|${path}`;

function folder(sessionId: string, path: string): DirEntry[] {
  for (const [k, list] of dirs) {
    const [sid, p] = [k.slice(0, k.indexOf("|")), k.slice(k.indexOf("|") + 1)];
    if (sid === sessionId && samePath(p, path)) return list;
  }
  const list = data.listDir(sessionId, path);
  dirs.set(key(sessionId, path), list);
  return list;
}

export function list(sessionId: string, path: string): DirEntry[] {
  return folder(sessionId, path).map((e) => ({ ...e }));
}

function find(sessionId: string, path: string): { list: DirEntry[]; index: number } {
  const list = folder(sessionId, parentOf(path));
  const index = list.findIndex((e) => samePath(e.path, path));
  if (index < 0) throw new Error(`${path} does not exist`);
  return { list, index };
}

function exists(sessionId: string, path: string): boolean {
  return folder(sessionId, parentOf(path)).some((e) => samePath(e.path, path));
}

/** Copy the cached contents of folder `from` (and below) to `to`. */
function cloneTree(sessionId: string, from: string, to: string, move: boolean) {
  for (const [k, list] of Array.from(dirs)) {
    const sid = k.slice(0, k.indexOf("|"));
    const p = k.slice(k.indexOf("|") + 1);
    if (sid !== sessionId || !isSameOrInside(p, from)) continue;
    const np = to + p.slice(from.length);
    const rebase = (e: DirEntry) => ({ ...e, path: to + e.path.slice(from.length) });
    dirs.set(key(sessionId, np), list.map(rebase));
    if (move) dirs.delete(k);
  }
}

export function rename(sessionId: string, from: string, to: string) {
  const { list, index } = find(sessionId, from);
  const entry = list[index];
  // A case-only rename is the same entry on Windows.
  if (exists(sessionId, to) && !samePath(from, to)) throw new Error(`${baseName(to)} already exists`);
  list.splice(index, 1);
  folder(sessionId, parentOf(to)).push({ ...entry, name: baseName(to), path: to });
  if (entry.kind === "directory") cloneTree(sessionId, from, to, true);
}

export function remove(sessionId: string, path: string) {
  const { list, index } = find(sessionId, path);
  list.splice(index, 1);
}

export function mkdir(sessionId: string, path: string) {
  if (exists(sessionId, path)) throw new Error(`${baseName(path)} already exists`);
  folder(sessionId, parentOf(path)).push({ name: baseName(path), path, kind: "directory", size: 0, modified: Math.floor(Date.now() / 1000) });
  dirs.set(key(sessionId, path), []);
}

export function copy(sessionId: string, from: string, to: string) {
  if (isSameOrInside(to, from)) throw new Error("Can't copy a folder into itself.");
  if (exists(sessionId, to)) throw new Error(`${baseName(to)} already exists`);
  const { list, index } = find(sessionId, from);
  const entry = list[index];
  folder(sessionId, parentOf(to)).push({ ...entry, name: baseName(to), path: to, modified: Math.floor(Date.now() / 1000) });
  if (entry.kind === "directory") cloneTree(sessionId, from, to, false);
}

export function duplicate(sessionId: string, path: string) {
  const parent = parentOf(path);
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n < 1000; n++) {
    const cand = joinPath(parent, `${stem} copy${n > 1 ? ` ${n}` : ""}${ext}`);
    if (!exists(sessionId, cand)) return copy(sessionId, path, cand);
  }
}
