// Canonical file-system types for the file browser. The host app re-exports
// these (Faro does so from src/lib/types.ts) so there is a single source of
// truth shared between the package and whatever transport backs it.

export type FileKind = "file" | "directory" | "symlink" | "other";

export interface DirEntry {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  modified?: number; // unix seconds
  mode?: number; // posix mode bits when applicable
  /** Backend's opaque change token (object stores expose an ETag). Absent for
   *  backends that rely on mtime+size. A change *token*, not a content hash. */
  etag?: string;
  /** A symlink whose target is a directory (a Windows directory link or
   *  junction, a link to a folder over SFTP). It opens like a folder; deleting
   *  it removes only the link. */
  linkDir?: boolean;
}

/** Whether double-click opens the entry as a folder: a directory, or a link
 *  to one. */
export function opensAsFolder(e: DirEntry): boolean {
  return e.kind === "directory" || (e.kind === "symlink" && !!e.linkDir);
}

/** Display-only result: hidden entries do not mean those files are absent. */
export interface DirectoryListing {
  entries: DirEntry[];
  skippedEntries: number;
}

export interface Capabilities {
  canChmod: boolean;
  canSymlink: boolean;
  canRename: boolean;
  hasDirectories: boolean; // false for object stores (S3/Azure)
  /** Backend can run shell commands — gates server-side archive + "open
   *  terminal here". Optional so older adapters that omit it just don't get
   *  those actions. */
  hasShell?: boolean;
  /** Backend runs typed, non-shell commands (WordPress REST). Optional;
   *  absent means no. */
  hasCommands?: boolean;
  /** How this backend reports change — drives the sync index's staleness check.
   *  Optional so older adapters that omit it default to mtime+size behaviour. */
  changeSignal?: "mtimeSize" | "etag" | "hash";
}

// A session handle is opaque to the UI — it's whatever your adapter understands
// (an SSH session UUID, an HTTP base, a mount id…). The sentinel below marks the
// host's own local filesystem, which the pane treats with native path rules
// (Windows drive letters + backslashes).
export type SessionId = string;
export const LOCAL_SESSION: SessionId = "local";

// ---- View-state types (mirrored by the host's settings store) ----

export type SortField = "name" | "size" | "modified";
export type SortDirection = "asc" | "desc";
export type PaneViewMode = "list" | "details" | "grid";
export type PaneDensity = "comfortable" | "compact";

// Server-side archive formats offered by the "Download folder as…" action. The
// adapter builds the archive on the remote host (one command) and downloads the
// single file, rather than walking the tree client-side.
export type ArchiveFormat = "tar.gz" | "zip";
