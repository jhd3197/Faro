import { memo, useEffect, useMemo, useState, useCallback, useRef, type ReactNode } from "react";
import {
  COLUMN_LABELS,
  columnTemplate,
  resizeColumns,
  type ColumnId,
  type ColumnWidths,
} from "../lib/columns";
import {
  ArrowUp,
  FolderInput,
  ArrowLeft,
  ArrowRight,
  RefreshCw,
  FolderPlus,
  Edit3,
  Trash2,
  Copy,
  CopyPlus,
  ShieldCheck,
  ServerOff,
  ExternalLink,
  TerminalSquare,
  PieChart,
  GitCompareArrows,
  CopyX,
  Info,
  AlertTriangle,
  Search,
  X,
  ChevronUp,
  ChevronDown,
  Pencil,
  Inbox,
  SearchX,
  List,
  Table2,
  AlignJustify,
  LayoutGrid,
  Upload,
  Download,
  Image as ImageIcon,
  BookmarkPlus,
  FolderOpen,
  FileArchive,
  TextCursorInput,
  FolderSearch,
  PanelLeftOpen,
  Wrench,
  PackageOpen,
  Loader2,
  Scissors,
  Files,
  ClipboardPaste,
} from "lucide-react";
import type {
  Capabilities,
  CompressFormat,
  DirEntry,
  PaneDensity,
  PaneViewMode,
  SessionId,
  SortField,
} from "../types";
import { LOCAL_SESSION, opensAsFolder } from "../types";
import { useFileUi } from "../context";
import { usePathHistory } from "../hooks/usePathHistory";
import { cn } from "../lib/cn";
import { fmtSize, fmtMtime, formatMode } from "../lib/format";
import { isImage, type FileIconSpec } from "../lib/fileIcons";
import { materialIconUrl } from "../lib/materialIcons";
import {
  DEFAULT_FILE_BROWSER_KEYBINDINGS,
  comboFromEvent,
  formatCombo,
  isComposing,
  type FileBrowserAction,
} from "../lib/keys";
import {
  baseName,
  caseInsensitiveFor,
  describeItems,
  describeKinds,
  exactBytes,
  isWindowsPath,
  joinPath,
  parentOf,
  pasteProblem,
  renameClash,
  samePath,
  uniqueName,
} from "../lib/fileOps";
import { getFileClipboard, setFileClipboard, useFileClipboard } from "../lib/fileClipboard";
import { endDragPill, setDragPillHint, startDragPill } from "../lib/dragPill";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { InlineRename } from "./InlineRename";
import { PromptModal } from "./PromptModal";
import { ConfirmModal } from "./ConfirmModal";
import { PropertiesModal } from "./PropertiesModal";
import { FileListSkeleton } from "./Skeleton";
import { EmptyState } from "./EmptyState";
import { Thumbnail } from "./Thumbnail";

interface Segment {
  label: string;
  path: string;
}

// Path separators for `path`: on POSIX a backslash is an ordinary filename
// character (`a\b.txt` is one name), so only Windows paths split on it.
function pathSplitter(path: string): RegExp {
  return isWindowsPath(path) ? /[/\\]/ : /\//;
}

// Build clickable breadcrumb segments for the address bar. Windows-style
// paths keep drive/UNC prefix + backslashes, everything else is POSIX "/".
// Relative POSIX paths (e.g. "." or "./public_html" — the SFTP default home
// when the profile has no start dir) must stay relative: turning them
// absolute ("/./...") would point the backend at a nonexistent path.
function parseSegments(path: string): Segment[] {
  if (!path || path === ".") return [{ label: path || "/", path: path || "/" }];
  if (path === "/") return [{ label: "/", path: "/" }];
  const parts = path.split(pathSplitter(path)).filter(Boolean);
  const segs: Segment[] = [];
  if (isWindowsPath(path)) {
    // UNC: \\server\share is the smallest listable root, so it's one crumb.
    const isUnc = path.startsWith("\\\\");
    let acc = isUnc
      ? "\\\\" + parts.slice(0, 2).join("\\")
      : parts[0] + "\\";
    segs.push({ label: isUnc ? acc : parts[0], path: acc });
    for (let i = isUnc ? 2 : 1; i < parts.length; i++) {
      acc = acc.endsWith("\\") ? acc + parts[i] : acc + "\\" + parts[i];
      segs.push({ label: parts[i], path: acc });
    }
  } else if (!path.startsWith("/")) {
    // Relative POSIX path: no root crumb, segments accumulate relatively.
    let acc = "";
    for (const p of parts) {
      acc = acc ? acc + "/" + p : p;
      segs.push({ label: p, path: acc });
    }
  } else {
    segs.push({ label: "/", path: "/" });
    let acc = "";
    for (const p of parts) {
      acc = acc + "/" + p;
      segs.push({ label: p, path: acc });
    }
  }
  return segs;
}

const DRAG_MIME = "application/x-faro";

interface DragPayload {
  paneId: string;
  entries: DirEntry[];
}

// The drag in flight, readable during dragover (the dataTransfer payload is
// hidden until drop), so a folder row can decide whether it's a target.
let activeDrag: DragPayload | null = null;

/** A drop that would copy rather than move: Ctrl (Windows/Linux) or
 *  Alt/Option held. */
const wantsCopy = (e: React.DragEvent) => e.ctrlKey || e.altKey;

interface Props {
  paneId: string;
  title: string;
  sessionId: SessionId | null;
  path: string;
  onPathChange: (path: string) => void;
  onTransfer?: (entries: DirEntry[]) => void;
  /** Optional toolbar Upload action (server view) — opens a native file picker. */
  onUpload?: (e: React.MouseEvent) => void;
  onDrop?: (entries: DirEntry[]) => void;
  transferLabel?: string;
  /** Bump to force a re-listing of the current directory (e.g. after an upload). */
  reloadToken?: number;
  /** Host-provided shortcuts for a remote folder; absent in generic/local panes. */
  onSaveSite?: (path: string) => void;
  /** "Copy to…" another connection (host-provided; absent hides the item). */
  onCopyTo?: (entries: DirEntry[]) => void;
  toolbarActions?: ReactNode;
  /** Called with the selected entries whenever the selection (or listing)
   *  changes — lets the host drive a preview pane. */
  onSelectionChange?: (entries: DirEntry[]) => void;
}

/** Extract a human message from any thrown value. Transport backends may reject
 *  with a structured `{ kind, message }` object (Faro's Tauri commands do); those
 *  would otherwise stringify to "[object Object]" in the error banner. */
function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}

// Archive extensions "Extract" understands, longest first so ".tar.gz" wins
// over ".gz". Mirrors `archive_ops::detect` on the Rust side.
const ARCHIVE_SUFFIXES = [".tar.gz", ".tgz", ".tar.bz2", ".tbz2", ".tbz", ".tar.xz", ".txz", ".tar", ".zip", ".7z"];

/** The name without its archive extension, or null when it isn't an archive. */
function archiveStem(name: string): string | null {
  const lower = name.toLowerCase();
  const suffix = ARCHIVE_SUFFIXES.find((s) => lower.endsWith(s));
  return suffix && name.length > suffix.length ? name.slice(0, -suffix.length) : null;
}

const COMPRESS_FORMATS: Array<{ format: CompressFormat; label: string; ext: string; remoteOnly?: boolean }> = [
  { format: "zip", label: "Zip (.zip)", ext: ".zip" },
  { format: "tar.gz", label: "Tar + gzip (.tar.gz)", ext: ".tar.gz" },
  { format: "tar", label: "Tar (.tar)", ext: ".tar" },
  { format: "7z", label: "7-Zip (.7z)", ext: ".7z", remoteOnly: true },
];

/** The file row (or folder) that has keyboard focus in a pane, announced on
 *  `window` as a "faro:focused-item" CustomEvent so app-level commands can act
 *  on it (e.g. "Open terminal here" on the focused folder). `null` detail =
 *  nothing focused in that pane any more. */
export interface FocusedFileItem {
  paneId: string;
  sessionId: SessionId;
  path: string;
  name: string;
  isDir: boolean;
}

// The pane the user last worked in. Pane shortcuts that have an obvious
// target even with nothing focused (Ctrl+L, Ctrl+F, Alt+←/→) go there.
let lastActivePane: string | null = null;
const GLOBAL_PANE_ACTIONS = new Set<FileBrowserAction>(["back", "forward", "focusPath", "focusFilter"]);

type ModalState =
  | { type: "compress"; entries: DirEntry[]; format: CompressFormat; ext: string }
  | { type: "extractTo"; entry: DirEntry; stem: string }
  | { type: "mkdir"; parent?: string }
  | { type: "chmod"; entry: DirEntry }
  | { type: "delete"; entries: DirEntry[] }
  | { type: "props"; entry: DirEntry }
  | null;

export function FilePane({
  paneId,
  title,
  sessionId,
  path,
  onPathChange,
  onTransfer,
  onUpload,
  onDrop,
  transferLabel = "Transfer",
  reloadToken,
  onSaveSite,
  onCopyTo,
  toolbarActions,
  onSelectionChange,
}: Props) {
  // Everything that used to be a direct Tauri call or a zustand read now comes
  // through the injected adapter + settings. The component is otherwise the
  // same presentational/interaction logic it always was.
  const { fs, settings, iconFor } = useFileUi();
  const {
    showHiddenFiles,
    sortField,
    sortDirection,
    setSortField,
    setSortDirection,
    paneViewMode,
    paneDensity,
    setPaneViewMode,
    setPaneDensity,
    editorLabel,
    remoteImagePreviews,
    setRemoteImagePreviews,
    keyBindings,
    columnWidths: savedColumnWidths,
    setColumnWidths,
  } = settings;
  // Column widths: the host's saved value (or this pane's own when the host
  // doesn't persist them), overridden live while a header handle is dragged.
  const [localColumnWidths, setLocalColumnWidths] = useState<ColumnWidths | null>(null);
  const [liveColumnWidths, setLiveColumnWidths] = useState<ColumnWidths | null>(null);
  const [resizingCol, setResizingCol] = useState<number | null>(null);
  const columnWidths =
    liveColumnWidths ?? (setColumnWidths ? savedColumnWidths ?? null : localColumnWidths);
  const commitColumnWidths = (w: ColumnWidths | null) =>
    setColumnWidths ? setColumnWidths(w) : setLocalColumnWidths(w);
  const headerRef = useRef<HTMLDivElement>(null);

  // Effective in-pane key combos: host overrides layered over the built-in
  // defaults, indexed combo→action so the keydown handler is a single lookup.
  // Memoized on the combo values (not object identity) so a host that rebuilds
  // the settings object each render doesn't thrash the listener.
  const [comboToAction, actionCombo] = useMemo(() => {
    const merged = { ...DEFAULT_FILE_BROWSER_KEYBINDINGS, ...keyBindings };
    const map: Record<string, FileBrowserAction> = {};
    for (const [action, combo] of Object.entries(merged)) {
      if (combo) map[combo] = action as FileBrowserAction;
    }
    return [map, merged as Record<FileBrowserAction, string>] as const;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify({ ...DEFAULT_FILE_BROWSER_KEYBINDINGS, ...keyBindings })]);
  /** A menu item's shortcut, live from the effective bindings: an unbound
   *  action shows no hint and has no key. */
  const keyOf = (action: FileBrowserAction) => {
    const combo = actionCombo[action];
    return combo ? { combo, hint: formatCombo(combo) } : {};
  };

  // Re-key the thumbnail loader whenever the remote-preview toggle flips, so
  // already-mounted Thumbnails re-run their effect the moment the user clicks
  // the toolbar toggle (off→on fetches; on→off falls back to icons) instead of
  // waiting for the next navigation. Wrapping `fs.thumbnail` gives a fresh
  // function identity per toggle state — the dep the Thumbnail effect watches.
  const loadThumb = useMemo(
    () =>
      fs.thumbnail
        ? (sid: SessionId, entry: DirEntry, signal?: AbortSignal) =>
            fs.thumbnail!(sid, entry, signal)
        : undefined,
    [fs, remoteImagePreviews]
  );

  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [draftPath, setDraftPath] = useState(path);
  const [editingPath, setEditingPath] = useState(false);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skippedEntries, setSkippedEntries] = useState(0);
  const loadVersion = useRef(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;
  useEffect(() => {
    onSelectionChangeRef.current?.(entries.filter((e) => selected.has(e.path)));
  }, [selected, entries]);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  // Width tier of THIS pane (not the viewport). Two panes share the window, so
  // a narrow window squeezes each pane; metadata columns yield to the filename
  // before it gets crushed. Driven by a ResizeObserver, see below.
  const [paneTier, setPaneTier] = useState<"wide" | "mid" | "narrow">("wide");
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const [modal, setModal] = useState<ModalState>(null);
  // The row being renamed in place (by path).
  const [renaming, setRenaming] = useState<string | null>(null);
  // The folder row a same-pane drag would drop into (tinted), by path.
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  // A confirmation shown in the pane when the host has no toasts.
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const clipboard = useFileClipboard();
  const dragCounter = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const typeBufRef = useRef("");
  const typeAtRef = useRef(0);

  const history = usePathHistory(path, onPathChange);

  const scrollToIdx = (n: number) => {
    requestAnimationFrame(() => {
      containerRef.current
        ?.querySelector(`[data-idx="${n}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  useEffect(() => {
    setDraftPath(path);
    setEditingPath(false);
    setFilter("");
    setRenaming(null);
  }, [path]);

  const load = useCallback(
    async (p: string) => {
      const version = ++loadVersion.current;
      setEntries([]);
      setSkippedEntries(0);
      setError(null);
      setSelected(new Set());
      setAnchor(null);
      if (!sessionId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const listing = fs.browseDirectory
          ? await fs.browseDirectory(sessionId, p)
          : { entries: await fs.listDirectory(sessionId, p), skippedEntries: 0 };
        if (version !== loadVersion.current) return;
        setEntries(listing.entries);
        setSkippedEntries(listing.skippedEntries);
      } catch (e) {
        if (version === loadVersion.current) setError(errorText(e));
      } finally {
        if (version === loadVersion.current) setLoading(false);
      }
    },
    [sessionId, fs]
  );

  useEffect(() => {
    load(path);
    // A slow response from a previous folder/session must not replace the
    // current entries or attach its warning to a different breadcrumb.
    return () => { ++loadVersion.current; };
  }, [sessionId, path, load, reloadToken]);

  // Pull capabilities once per session so chmod / mkdir / etc. can be hidden
  // for backends that don't support them (notably S3).
  useEffect(() => {
    if (!sessionId) {
      setCaps(null);
      return;
    }
    let cancelled = false;
    fs.capabilities(sessionId).then(
      (c) => {
        if (!cancelled) setCaps(c);
      },
      () => {
        if (!cancelled) setCaps(null);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, fs]);

  // Copy within one connection needs a server-side copy: the local disk, or a
  // shell (cp) on the server. Elsewhere Copy still feeds a cross-pane paste.
  const canServerCopy = !!fs.copy && (sessionId === LOCAL_SESSION || !!caps?.hasShell);

  // Apply hidden-file rule + in-pane name filter + sort from settings. Memoized
  // so a big directory isn't re-filtered and re-sorted on every unrelated render
  // (selection, hover, pane-resize); only the inputs below trigger recompute.
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries
      .filter((e) => showHiddenFiles || !e.name.startsWith("."))
      .filter((e) => q === "" || e.name.toLowerCase().includes(q))
      .slice()
      .sort((a, b) => {
        // Directories (and links to them) always come before files.
        if (opensAsFolder(a) && !opensAsFolder(b)) return -1;
        if (!opensAsFolder(a) && opensAsFolder(b)) return 1;
        let cmp = 0;
        if (sortField === "size") {
          cmp = a.size - b.size;
        } else if (sortField === "modified") {
          cmp = (a.modified ?? 0) - (b.modified ?? 0);
        } else {
          cmp = a.name.localeCompare(b.name);
        }
        return sortDirection === "asc" ? cmp : -cmp;
      });
  }, [entries, showHiddenFiles, filter, sortField, sortDirection]);

  // Pane actions that make sense from anywhere in the pane, a text box included.
  const runGlobalAction = (action: FileBrowserAction, e: KeyboardEvent) => {
    if (!sessionId) return;
    e.preventDefault();
    switch (action) {
      case "back":
        history.back();
        break;
      case "forward":
        history.forward();
        break;
      case "focusPath":
        setDraftPath(path);
        setEditingPath(true);
        break;
      case "focusFilter":
        filterRef.current?.focus();
        filterRef.current?.select();
        break;
    }
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const anchorItem = () =>
      anchor ? visible.find((v) => v.path === anchor) ?? null : null;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      // An inline rename and an open menu own their keys; something that
      // already handled the key (defaultPrevented) wins too.
      if (e.defaultPrevented) return;
      if (target?.closest?.('[data-inline-rename], [role="menu"]')) return;
      const typing =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      const inFilter = !!target?.closest?.("[data-pane-filter]");
      if (e.key === "Escape") {
        // Esc peels one layer at a time: filter text, then the filter box
        // itself, then the selection. Not remappable (the universal cancel).
        if (typing && !inFilter) return; // the path box handles its own Esc
        if (filter) {
          setFilter("");
        } else if (inFilter) {
          containerRef.current?.focus();
        } else {
          setSelected(new Set());
          setAnchor(null);
        }
        return;
      }
      const combo = comboFromEvent(e);
      const action = comboToAction[combo];
      if (typing) {
        // Only the "go somewhere" chords work from a text box, and only with a
        // modifier, so typing is never hijacked.
        const hasMod = e.ctrlKey || e.metaKey || e.altKey;
        if (!hasMod || !action || !GLOBAL_PANE_ACTIONS.has(action)) return;
        runGlobalAction(action, e);
        return;
      }
      // Only run list nav when the pane/list area is focused, not a toolbar btn.
      if (target && target.closest('button, a, [role="button"]')) {
        if (action && GLOBAL_PANE_ACTIONS.has(action)) runGlobalAction(action, e);
        return;
      }

      // Remappable in-pane actions (F2/Enter/Delete/Backspace/mod+A/Space/
      // mod+shift+N/F5, all overridable by the host). One combo → one action.
      if (action) {
        if (GLOBAL_PANE_ACTIONS.has(action)) {
          runGlobalAction(action, e);
          return;
        }
        switch (action) {
          case "selectAll":
            e.preventDefault();
            setSelected(new Set(visible.map((x) => x.path)));
            return;
          case "delete": {
            const items = visible.filter((v) => selected.has(v.path));
            if (items.length > 0) setModal({ type: "delete", entries: items });
            return;
          }
          case "rename": {
            const item = anchorItem();
            if (item) {
              e.preventDefault();
              setRenaming(item.path);
            }
            return;
          }
          case "quickInfo": {
            const item = anchorItem();
            if (item) {
              e.preventDefault();
              setModal({ type: "props", entry: item });
            }
            return;
          }
          case "newFolder":
            if (sessionId && caps?.hasDirectories !== false) {
              e.preventDefault();
              // A focused folder row is where the new folder goes.
              const item = anchorItem();
              setModal({
                type: "mkdir",
                parent: item && opensAsFolder(item) && selected.has(item.path) ? item.path : undefined,
              });
            }
            return;
          case "refresh":
            if (sessionId) {
              e.preventDefault();
              load(path);
            }
            return;
          case "open": {
            const item = anchorItem();
            if (item) {
              e.preventDefault();
              onRowActivate(item);
            }
            return;
          }
          case "parentDir":
            e.preventDefault();
            goUp();
            return;
          case "copy":
          case "cut": {
            const items = visible.filter((v) => selected.has(v.path));
            if (items.length > 0) {
              e.preventDefault();
              clipSelection(action, items);
            }
            return;
          }
          case "paste":
            if (getFileClipboard()) {
              e.preventDefault();
              void doPaste(pasteTargetFor(anchorItem()));
            }
            return;
        }
      }

      if (e.ctrlKey || e.metaKey || e.altKey) return; // leave app shortcuts alone

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (visible.length === 0) return;
        const cur = anchor ? visible.findIndex((v) => v.path === anchor) : -1;
        let next = e.key === "ArrowDown" ? cur + 1 : cur - 1;
        next = Math.max(0, Math.min(visible.length - 1, next));
        const targetItem = visible[next];
        if (targetItem) {
          if (e.shiftKey) setSelected((prev) => new Set(prev).add(targetItem.path));
          else setSelected(new Set([targetItem.path]));
          setAnchor(targetItem.path);
          scrollToIdx(next);
        }
        return;
      }
      // Type-ahead: jump to the first item matching the recently-typed run.
      if (e.key.length === 1) {
        const now = Date.now();
        typeBufRef.current =
          now - typeAtRef.current > 800 ? e.key : typeBufRef.current + e.key;
        typeAtRef.current = now;
        const buf = typeBufRef.current.toLowerCase();
        let idx = visible.findIndex((v) => v.name.toLowerCase().startsWith(buf));
        if (idx < 0) idx = visible.findIndex((v) => v.name.toLowerCase().includes(buf));
        if (idx >= 0) {
          setSelected(new Set([visible[idx].path]));
          setAnchor(visible[idx].path);
          scrollToIdx(idx);
        }
      }
    };
    // Nothing focused at all (focus fell back to <body>): the pane the user
    // last worked in still answers Ctrl+L / Ctrl+F / Alt+←/→.
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || lastActivePane !== paneId) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      const action = comboToAction[comboFromEvent(e)];
      if (action && GLOBAL_PANE_ACTIONS.has(action)) runGlobalAction(action, e);
    };
    const onFocusIn = () => { lastActivePane = paneId; };
    el.addEventListener("keydown", handler);
    el.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onWindowKey);
    return () => {
      el.removeEventListener("keydown", handler);
      el.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onWindowKey);
    };
  }, [visible, selected, filter, anchor, comboToAction, caps, path, sessionId]);

  // Tell the app which row has keyboard focus here, so commands such as
  // "Open terminal here" can act on it.
  const anchorEntry = anchor ? visible.find((v) => v.path === anchor) ?? null : null;
  useEffect(() => {
    const detail: FocusedFileItem | null =
      sessionId && anchorEntry
        ? {
            paneId,
            sessionId,
            path: anchorEntry.path,
            name: anchorEntry.name,
            isDir: opensAsFolder(anchorEntry),
          }
        : null;
    window.dispatchEvent(new CustomEvent("faro:focused-item", { detail: detail ?? { paneId, cleared: true } }));
  }, [paneId, sessionId, anchorEntry]);

  // Watch this pane's width and pick a column tier. Content-driven, not
  // viewport-driven: only re-renders when crossing a threshold, not per pixel.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      const tier = w < 360 ? "narrow" : w < 480 ? "mid" : "wide";
      setPaneTier((prev) => (prev === tier ? prev : tier));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const goUp = () => {
    const isWin = isWindowsPath(path);
    const isUnc = path.startsWith("\\\\");
    // Relative POSIX path (e.g. "." / "./public_html" — the SFTP default
    // home): going up must stay relative, and the relative root itself has
    // no parent to go to.
    const isRelative = !isWin && !path.startsWith("/");
    const parts = path.split(pathSplitter(path)).filter(Boolean);
    const rootParts = isUnc ? 2 : 1; // UNC root is \\server\share
    if (parts.length <= rootParts) {
      onPathChange(isWin || isRelative ? path : "/");
      return;
    }
    parts.pop();
    let next: string;
    if (isUnc) next = "\\\\" + parts.join("\\");
    else if (isWin) next = parts.length === 1 ? parts[0] + "\\" : parts.join("\\");
    else if (isRelative) next = parts.join("/");
    else next = "/" + parts.join("/");
    onPathChange(next || (isRelative ? "." : "/"));
  };

  const onRowClick = (entry: DirEntry, e: React.MouseEvent) => {
    containerRef.current?.focus(); // so arrow / type-ahead nav works after a click
    if (e.shiftKey && anchor) {
      const idxA = visible.findIndex((x) => x.path === anchor);
      const idxB = visible.findIndex((x) => x.path === entry.path);
      if (idxA >= 0 && idxB >= 0) {
        const [lo, hi] = idxA < idxB ? [idxA, idxB] : [idxB, idxA];
        const next = new Set<string>();
        for (let i = lo; i <= hi; i++) next.add(visible[i].path);
        setSelected(next);
      }
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      setAnchor(entry.path);
    } else {
      setSelected(new Set([entry.path]));
      setAnchor(entry.path);
    }
  };

  const onRowActivate = (entry: DirEntry) => {
    if (opensAsFolder(entry)) {
      onPathChange(entry.path);
      return;
    }
    onTransfer?.([entry]);
  };

  const transferSelection = () => {
    const items = visible.filter((e) => selected.has(e.path));
    if (items.length === 0) return;
    onTransfer?.(items);
  };

  // --- Drag & drop ---

  const onRowDragStart = (e: React.DragEvent, entry: DirEntry) => {
    const dragSet = selected.has(entry.path)
      ? visible.filter((x) => selected.has(x.path))
      : [entry];
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      setAnchor(entry.path);
    }
    const payload: DragPayload = { paneId, entries: dragSet };
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    // Copy to the other pane; move (or Ctrl-copy) onto a folder in this one.
    e.dataTransfer.effectAllowed = "copyMove";
    activeDrag = payload;
    startDragPill(e.nativeEvent, describeKinds(dragSet, ", "));
  };

  const endDrag = () => {
    activeDrag = null;
    endDragPill();
    setDropFolder(null);
  };

  /** Why the in-flight drag can't land in folder row `target`, or null. Only
   *  drags that started in this pane are moves; others keep the pane-wide
   *  transfer drop. */
  const folderDropProblem = (drag: DragPayload, target: DirEntry, copy: boolean): string | null => {
    if (drag.entries.some((d) => samePath(d.path, target.path))) return "itself";
    if (pasteProblem(drag.entries, target.path)) return "inside itself";
    if (copy && !canServerCopy) return "no copy";
    if (!copy && caps?.canRename === false) return "no move";
    return null;
  };

  const onRowDragOver = (e: React.DragEvent, target: DirEntry) => {
    const drag = activeDrag;
    if (!drag || drag.paneId !== paneId || !sessionId) return;
    // Everything in this pane is decided here; the pane-wide transfer drop
    // never applies to a drag that started in it.
    e.stopPropagation();
    const copy = wantsCopy(e);
    if (!opensAsFolder(target) || folderDropProblem(drag, target, copy)) {
      // Not a target: no tint, and no preventDefault, so the pointer shows
      // the not-allowed cursor.
      e.dataTransfer.dropEffect = "none";
      if (dropFolder) setDropFolder(null);
      setDragPillHint(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = copy ? "copy" : "move";
    if (dropFolder !== target.path) setDropFolder(target.path);
    setDragPillHint(`${copy ? "Copy" : "Move"} to ${target.name}`);
  };

  const onRowDrop = (e: React.DragEvent, target: DirEntry) => {
    const drag = activeDrag;
    if (!drag || drag.paneId !== paneId) return;
    e.preventDefault();
    e.stopPropagation();
    const copy = wantsCopy(e);
    endDrag();
    dragCounter.current = 0;
    if (!opensAsFolder(target) || folderDropProblem(drag, target, copy)) return;
    void moveOrCopy(drag.entries, target.path, copy ? "copy" : "move");
  };

  const isOurDrag = (e: React.DragEvent) =>
    Array.from(e.dataTransfer.types).includes(DRAG_MIME);
  // A drag that started in this pane can only land on one of its folders.
  const isOwnDrag = () => activeDrag?.paneId === paneId;

  const onPaneDragEnter = (e: React.DragEvent) => {
    if (!isOurDrag(e)) return;
    dragCounter.current++;
    if (isOwnDrag()) return;
    e.preventDefault();
    setIsDropTarget(true);
  };
  const onPaneDragOver = (e: React.DragEvent) => {
    if (!isOurDrag(e)) return;
    if (isOwnDrag()) {
      e.dataTransfer.dropEffect = "none";
      if (dropFolder) setDropFolder(null);
      setDragPillHint(null);
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onPaneDragLeave = (e: React.DragEvent) => {
    if (!isOurDrag(e)) return;
    dragCounter.current = Math.max(0, dragCounter.current - 1);
    if (dragCounter.current === 0) {
      setIsDropTarget(false);
      setDropFolder(null);
    }
  };
  const onPaneDrop = (e: React.DragEvent) => {
    if (!isOurDrag(e)) return;
    e.preventDefault();
    dragCounter.current = 0;
    setIsDropTarget(false);
    setDropFolder(null);
    endDragPill();
    activeDrag = null;
    const raw = e.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    let payload: DragPayload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (payload.paneId === paneId) return;
    if (!payload.entries.length) return;
    onDrop?.(payload.entries);
  };

  // --- Clipboard: copy / cut / paste, and drag-to-move ---

  /** A short confirmation: a host toast when there is one, else the pane's
   *  own status line. */
  const say = (text: string, variant: "info" | "success" | "error" = "success") => {
    if (fs.notify) fs.notify(text, variant);
    else setNotice({ text, error: variant === "error" });
  };

  const clipSelection = (mode: "copy" | "cut", items: DirEntry[]) => {
    if (!sessionId || items.length === 0) return;
    setFileClipboard({ mode, sessionId, paneId, entries: items });
    const what = describeItems(items);
    say(mode === "copy" ? `Copied ${what}` : `Cut ${what}. Paste to move ${items.length === 1 ? "it" : "them"}.`, "info");
  };

  /** Where Paste goes: the focused folder row, unless that folder is itself
   *  on the clipboard (then the folder being shown). */
  const pasteTargetFor = (item: DirEntry | null): string => {
    const clip = getFileClipboard();
    if (
      item &&
      opensAsFolder(item) &&
      selected.has(item.path) &&
      !clip?.entries.some((c) => samePath(c.path, item.path))
    ) {
      return item.path;
    }
    return path;
  };

  /** Move (rename) or copy `items` into `destDir` on this connection, each
   *  under a free name ("notes (2).txt" when the name is taken). */
  const moveOrCopy = async (
    items: DirEntry[],
    destDir: string,
    op: "move" | "copy",
    doneVerb = op === "move" ? "Moved" : "Copied"
  ): Promise<boolean> => {
    if (!sessionId || items.length === 0) return false;
    const problem = pasteProblem(items, destDir);
    if (problem) {
      say(problem, "error");
      return false;
    }
    if (op === "copy" && !canServerCopy) {
      say("This connection can't copy files in place. Paste them into the other pane to transfer them.", "error");
      return false;
    }
    const pending = op === "move" ? items.filter((it) => !samePath(parentOf(it.path), destDir)) : items;
    if (pending.length === 0) {
      say(items.length === 1 ? `${items[0].name} is already in this folder.` : "Those items are already in this folder.", "info");
      return true;
    }
    let taken: string[];
    try {
      taken = samePath(destDir, path)
        ? entries.map((e) => e.name)
        : (await fs.listDirectory(sessionId, destDir)).map((e) => e.name);
    } catch (e) {
      say(`Couldn't open ${baseName(destDir) || destDir}: ${errorText(e)}`, "error");
      return false;
    }
    const caseInsensitive = caseInsensitiveFor(destDir);
    const placed: string[] = [];
    setWorking(`${op === "move" ? "Moving" : "Copying"} ${describeItems(pending)}…`);
    try {
      for (const it of pending) {
        const name = uniqueName(it.name, taken, { isDir: it.kind === "directory", caseInsensitive });
        if (!name) throw new Error(`too many copies of ${it.name} already exist`);
        const to = joinPath(destDir, name);
        if (op === "move") await fs.rename(sessionId, it.path, to);
        else await fs.copy!(sessionId, it.path, to);
        taken.push(name);
        placed.push(to);
      }
    } catch (e) {
      say(`Couldn't ${op} ${describeItems(pending)}: ${errorText(e)}`, "error");
      await load(path);
      return false;
    } finally {
      setWorking(null);
    }
    await load(path);
    if (samePath(destDir, path)) {
      setSelected(new Set(placed));
      setAnchor(placed[placed.length - 1] ?? null);
    }
    const where = samePath(destDir, path) ? "" : ` to ${baseName(destDir) || destDir}`;
    say(`${doneVerb} ${describeItems(pending)}${where}`);
    return true;
  };

  const doPaste = async (destDir: string) => {
    const clip = getFileClipboard();
    if (!clip || !sessionId) return;
    if (clip.sessionId !== sessionId) {
      // Another connection: the other pane's items arrive as a transfer
      // into this folder, the same as dropping them here.
      if (clip.paneId !== paneId && onDrop) {
        onDrop(clip.entries);
        say(`Transferring ${describeItems(clip.entries)}${clip.mode === "cut" ? ". The originals are kept." : ""}`, "info");
      } else {
        say("Those items are on another connection. Paste them in the pane showing it.", "error");
      }
      return;
    }
    const ok = await moveOrCopy(clip.entries, destDir, clip.mode === "cut" ? "move" : "copy", clip.mode === "cut" ? "Moved" : "Pasted");
    if (ok && clip.mode === "cut") setFileClipboard(null);
  };

  /** Whether Paste can do anything with `clip` here. */
  const canPaste = (clip: NonNullable<ReturnType<typeof getFileClipboard>>) =>
    clip.sessionId === sessionId
      ? clip.mode === "cut" || canServerCopy
      : clip.paneId !== paneId && !!onDrop;

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // --- Context menu ---

  const copyPaths =(items: DirEntry[]) => {
    navigator.clipboard.writeText(items.map((e) => e.path).join("\n"));
  };
  const copyNames = (items: DirEntry[]) => {
    navigator.clipboard.writeText(items.map((e) => e.name).join("\n"));
  };

  const openRowMenu = (e: React.MouseEvent, entry: DirEntry) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected.has(entry.path)) {
      setSelected(new Set([entry.path]));
      setAnchor(entry.path);
    }
    const selectedItems = selected.has(entry.path)
      ? visible.filter((v) => selected.has(v.path))
      : [entry];
    const single = selectedItems.length === 1 ? selectedItems[0] : null;

    // A remote (non-local) session that exposes a shell, used to gate
    // server-side actions (archive, terminal) that local browsing can't do.
    const isRemote = !!sessionId && sessionId !== LOCAL_SESSION;

    // Compress / extract run on the server over a shell, or on the local disk.
    const canArchive = sessionId === LOCAL_SESSION || !!caps?.hasShell;
    const compressItem: MenuItem | null =
      fs.compress && canArchive
        ? {
            label: "Compress",
            icon: <FileArchive size={14} />,
            onClick: () => {},
            children: COMPRESS_FORMATS.filter((f) => !(f.remoteOnly && !isRemote)).map((f) => ({
              label: f.label,
              icon: <FileArchive size={14} />,
              onClick: () => setModal({ type: "compress", entries: selectedItems, format: f.format, ext: f.ext }),
            })),
          }
        : null;
    const stem = single?.kind === "file" ? archiveStem(single.name) : null;
    const extractItem: MenuItem | null =
      single && stem && fs.extract && canArchive
        ? {
            label: "Extract",
            icon: <PackageOpen size={14} />,
            onClick: () => {},
            children: [
              { label: "Extract here", icon: <PackageOpen size={14} />, onClick: () => doExtract(single, path) },
              { label: `Extract to “${stem}/”`, icon: <FolderPlus size={14} />, onClick: () => doExtract(single) },
              { label: "Extract to…", icon: <FolderOpen size={14} />, onClick: () => setModal({ type: "extractTo", entry: single, stem }) },
            ],
          }
        : null;

    const items: MenuItem[] = [];
    if (single) {
      items.push({
        label: opensAsFolder(single) ? "Open" : transferLabel,
        hint: opensAsFolder(single) && actionCombo.open ? formatCombo(actionCombo.open) : undefined,
        icon: opensAsFolder(single) ? <FolderOpen size={14} /> : sessionId === LOCAL_SESSION ? <Upload size={14} /> : <Download size={14} />,
        onClick: () => onRowActivate(single),
      });
      if (single.kind === "directory" && isRemote && onSaveSite) {
        items.push({ label: "Save as site…", icon: <BookmarkPlus size={12} />, onClick: () => onSaveSite(single.path) });
      }
      // Edit-in-place sits right under the primary action so it's easy to find
      // (it used to be last, below chmod). Remote files only — local files open
      // in their app via the OS, and there's nothing to upload back.
      if (single.kind === "file" && isRemote && fs.editFile) {
        items.push({
          label: editorLabel ? `Edit with ${editorLabel}…` : "Edit file…",
          icon: <ExternalLink size={12} />,
          onClick: () => {
            fs.editFile!(sessionId!, single.path).catch((e) =>
              setError(errorText(e))
            );
          },
        });
      }
      // Server-side zip/tar of a folder: one command on the host, then download
      // the single archive — no per-file walk. Remote dirs only (needs a shell).
      if (
        single.kind === "directory" &&
        isRemote &&
        caps?.hasShell &&
        fs.archive
      ) {
        items.push({
          label: "Download",
          icon: <Download size={14} />,
          onClick: () => {},
          children: [
            ...(onTransfer ? [{ label: "Folder", icon: <FolderOpen size={14} />, onClick: () => onTransfer([single]) }] : []),
            {
              label: "Compressed .tar.gz",
              icon: <FileArchive size={14} />,
              onClick: () =>
                fs
                  .archive!(sessionId!, single.path, "tar.gz")
                  .catch((e) => setError(errorText(e))),
            },
            {
              label: "Zip archive (.zip)",
              icon: <FileArchive size={14} />,
              onClick: () =>
                fs
                  .archive!(sessionId!, single.path, "zip")
                  .catch((e) => setError(errorText(e))),
            },
          ],
        });
      }
      if (onCopyTo) {
        items.push({ label: "Copy to…", icon: <FolderInput size={12} />, onClick: () => onCopyTo([single]) });
      }
      if (extractItem) items.push(extractItem);
      if (compressItem) items.push(compressItem);
      // Open an SSH terminal already cd'd into this folder.
      if (
        single.kind === "directory" &&
        isRemote &&
        caps?.hasShell &&
        fs.openTerminal
      ) {
        items.push({
          label: "Open terminal here",
          icon: <TerminalSquare size={12} />,
          onClick: () =>
            fs
              .openTerminal!(sessionId!, single.path)
              .catch((e) => setError(errorText(e))),
        });
      }
      // Analyze disk usage under this folder (treemap + size breakdown). Works
      // on every backend — no shell needed, the scan falls back to a walk.
      if (single.kind === "directory" && fs.analyzeDiskUsage) {
        items.push({
          label: "Analyze disk usage",
          icon: <PieChart size={12} />,
          onClick: () =>
            sessionId &&
            fs
              .analyzeDiskUsage!(sessionId, single.path)
              .catch((e) => setError(errorText(e))),
        });
      }
      // Compare this folder against another tree (Meld-style side-by-side diff).
      // Works on every backend, including remote↔remote.
      if (single.kind === "directory" && fs.compareDirectory) {
        items.push({
          label: "Compare with…",
          icon: <GitCompareArrows size={12} />,
          onClick: () =>
            sessionId &&
            fs
              .compareDirectory!(sessionId, single.path)
              .catch((e) => setError(errorText(e))),
        });
      }
      // Find duplicate files in this folder (the `name_1.ext` copies a
      // rename-on-conflict upload leaves behind, or content-hash duplicates).
      if (single.kind === "directory" && fs.findDuplicates) {
        items.push({
          label: "Find duplicates",
          icon: <CopyX size={12} />,
          onClick: () =>
            sessionId &&
            fs
              .findDuplicates!(sessionId, single.path)
              .catch((e) => setError(errorText(e))),
        });
      }
      // Search this folder by name or content (Spotlight/grep over the backend).
      // Works on every backend; content grep uses a server-side fast path on SSH.
      if (single.kind === "directory" && fs.searchDirectory) {
        items.push({
          label: "Search here…",
          icon: <Search size={12} />,
          onClick: () =>
            sessionId &&
            fs
              .searchDirectory!(sessionId, single.path)
              .catch((e) => setError(errorText(e))),
        });
      }
      // Duplicate needs a server-side copy (cp over SSH) or local fs copy; object
      // stores / FTP can't, so hide it there.
      if (fs.duplicate && (sessionId === LOCAL_SESSION || caps?.hasShell)) {
        items.push({
          label: "Duplicate",
          icon: <CopyPlus size={12} />,
          onClick: () => doDuplicate(single),
        });
      }
      items.push({
        label: "Rename",
        icon: <Edit3 size={12} />,
        ...keyOf("rename"),
        onClick: () => setRenaming(single.path),
        separatorAfter: true,
      });
    } else {
      items.push({
        label: `${transferLabel} ${selectedItems.length} items`,
        icon: sessionId === LOCAL_SESSION ? <Upload size={14} /> : <Download size={14} />,
        onClick: () => onTransfer?.(selectedItems),
        separatorAfter: !compressItem && !onCopyTo,
      });
      if (onCopyTo) {
        items.push({
          label: `Copy ${selectedItems.length} items to…`,
          icon: <FolderInput size={12} />,
          onClick: () => onCopyTo(selectedItems),
          separatorAfter: !compressItem,
        });
      }
      if (compressItem) items.push({ ...compressItem, separatorAfter: true });
    }
    // Cut / Copy the selection; Paste into a folder row once something is on
    // the clipboard.
    items.push(
      { label: "Cut", icon: <Scissors size={14} />, ...keyOf("cut"), onClick: () => clipSelection("cut", selectedItems) },
      { label: "Copy", icon: <Files size={14} />, ...keyOf("copy"), onClick: () => clipSelection("copy", selectedItems) }
    );
    const clip = getFileClipboard();
    if (clip && single && opensAsFolder(single) && !clip.entries.some((c) => samePath(c.path, single.path))) {
      items.push({
        label: `Paste into “${single.name}”`,
        icon: <ClipboardPaste size={14} />,
        ...keyOf("paste"),
        disabled: !canPaste(clip),
        onClick: () => void doPaste(single.path),
      });
    }
    items[items.length - 1].separatorAfter = true;
    items.push({
      label: `Delete${selectedItems.length > 1 ? ` (${selectedItems.length})` : ""}`,
      icon: <Trash2 size={12} />,
      destructive: true,
      ...keyOf("delete"),
      onClick: () => setModal({ type: "delete", entries: selectedItems }),
      separatorAfter: true,
    });
    items.push({
      label: `Copy path${selectedItems.length > 1 ? `s (${selectedItems.length})` : ""}`,
      icon: <Copy size={12} />,
      onClick: () => copyPaths(selectedItems),
    });
    items.push({
      label: `Copy name${selectedItems.length > 1 ? `s (${selectedItems.length})` : ""}`,
      icon: <TextCursorInput size={14} />,
      onClick: () => copyNames(selectedItems),
      separatorAfter: !!single,
    });
    if (
      single &&
      sessionId !== LOCAL_SESSION &&
      caps?.canChmod !== false
    ) {
      items.push({
        label: "Change permissions (chmod)…",
        icon: <ShieldCheck size={12} />,
        onClick: () => setModal({ type: "chmod", entry: single }),
      });
    }
    if (single) {
      items.push({
        label: "Properties",
        icon: <Info size={12} />,
        ...keyOf("quickInfo"),
        onClick: () => setModal({ type: "props", entry: single }),
      });
    }
    const toolLabels = new Set(["Save as site…", "Analyze disk usage", "Compare with…", "Find duplicates", "Search here…"]);
    const toolItems = items.filter((item) => toolLabels.has(item.label));
    const copyItems = items.filter((item) => item.label.startsWith("Copy path") || item.label.startsWith("Copy name"));
    const deleteItem = items.find((item) => item.destructive);
    const properties = items.find((item) => item.label === "Properties");
    const organized = items.filter((item) => !toolItems.includes(item) && !copyItems.includes(item) && item !== deleteItem && item !== properties);
    if (copyItems.length) organized.push({ label: "Copy as text", icon: <Copy size={14} />, onClick: () => {}, children: copyItems, separatorAfter: true });
    if (single && sessionId === LOCAL_SESSION && fs.revealLocal) {
      organized.push({ label: navigator.userAgent.includes("Windows") ? "Reveal in File Explorer" : navigator.userAgent.includes("Mac") ? "Reveal in Finder" : "Reveal in file manager", icon: <FolderSearch size={14} />, onClick: () => { fs.revealLocal!(single.path).catch((e) => setError(errorText(e))); } });
    }
    if (single && fs.revealInBrowser) {
      organized.push({ label: "Reveal in Faro", icon: <PanelLeftOpen size={14} />, onClick: () => { fs.revealInBrowser!(sessionId!, opensAsFolder(single) ? single.path : path).catch((e) => setError(errorText(e))); } });
    }
    if (toolItems.length) organized.push({ label: "Tools", icon: <Wrench size={14} />, onClick: () => {}, children: toolItems });
    if (properties) organized.push({ ...properties, separatorAfter: true });
    if (deleteItem) organized.push({ ...deleteItem, separatorAfter: false });
    setMenu({ x: e.clientX, y: e.clientY, items: organized });
  };

  const openPaneMenu = (e: React.MouseEvent) => {
    if (!sessionId) return;
    e.preventDefault();
    const items: MenuItem[] = [];
    const clip = getFileClipboard();
    if (clip) {
      items.push({
        label: "Paste",
        icon: <ClipboardPaste size={14} />,
        ...keyOf("paste"),
        disabled: !canPaste(clip),
        onClick: () => void doPaste(path),
        separatorAfter: true,
      });
    }
    if (sessionId !== LOCAL_SESSION && onSaveSite) {
      items.push({ label: "Save as site…", icon: <BookmarkPlus size={12} />, onClick: () => onSaveSite(path), separatorAfter: true });
    }
    if (caps?.hasDirectories !== false) {
      items.push({
        label: "New folder…",
        icon: <FolderPlus size={12} />,
        ...keyOf("newFolder"),
        onClick: () => setModal({ type: "mkdir" }),
        separatorAfter: true,
      });
    }
    items.push({
      label: "Refresh",
      icon: <RefreshCw size={12} />,
      ...keyOf("refresh"),
      onClick: () => load(path),
    });
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  // --- File op handlers ---

  // Inline rename: a failure is thrown back to the row's editor, which keeps
  // it open with the message, instead of replacing the whole listing.
  const doRename = async (entry: DirEntry, newName: string) => {
    if (!sessionId) return;
    const parentEnd = isWindowsPath(entry.path)
      ? Math.max(entry.path.lastIndexOf("/"), entry.path.lastIndexOf("\\"))
      : entry.path.lastIndexOf("/");
    const parent = entry.path.slice(0, parentEnd);
    const to = joinPath(parent, newName);
    // Never rename over a different entry (a local rename would replace it).
    // On Windows "Notes.txt" → "notes.txt" is the same entry: allowed.
    if (renameClash(entry.name, newName, entries.map((e) => e.name), caseInsensitiveFor(entry.path))) {
      throw new Error(`${newName} already exists in this folder.`);
    }
    try {
      await fs.rename(sessionId, entry.path, to);
    } catch (e) {
      throw new Error(`Couldn't rename ${entry.name}: ${errorText(e)}`);
    }
    await load(path);
    setSelected(new Set([to]));
    setAnchor(to);
  };
  const renameProblem = (name: string) =>
    /[/\\]/.test(name) ? "A name can't contain / or \\." : name === "." || name === ".." ? "That name is reserved." : null;
  const endRename = () => {
    setRenaming(null);
    containerRef.current?.focus();
  };

  const doDelete = async (items: DirEntry[]) => {
    if (!sessionId) return;
    try {
      for (const it of items) {
        await fs.remove(sessionId, it.path, it.kind === "directory");
      }
      await load(path);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const doDuplicate = async (entry: DirEntry) => {
    if (!sessionId || !fs.duplicate) return;
    try {
      await fs.duplicate(sessionId, entry.path, entry.kind);
      await load(path);
    } catch (e) {
      setError(errorText(e));
    }
  };

  // Archive jobs can take a while on a big tree; show what's running in the
  // pane and refresh once it lands.
  const runArchiveJob = async (label: string, job: () => Promise<unknown>) => {
    setWorking(label);
    try {
      await job();
      await load(path);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking(null);
    }
  };

  const doCompress = (entries: DirEntry[], name: string, format: CompressFormat) => {
    if (!sessionId || !fs.compress) return;
    return runArchiveJob(`Compressing to ${name.trim()}…`, () =>
      fs.compress!(sessionId, entries.map((e) => e.path), name.trim(), format)
    );
  };

  const doExtract = (entry: DirEntry, destination?: string) => {
    if (!sessionId || !fs.extract) return;
    return runArchiveJob(`Extracting ${entry.name}…`, () =>
      fs.extract!(sessionId, entry.path, destination?.trim() || undefined)
    );
  };

  const doMkdir = async (name: string, parent = path) => {
    if (!sessionId) return;
    try {
      await fs.mkdir(sessionId, joinPath(parent, name));
      await load(path);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const doChmod = async (entry: DirEntry, modeText: string) => {
    if (!sessionId) return;
    const mode = parseInt(modeText, 8);
    if (Number.isNaN(mode)) {
      setError(`invalid mode "${modeText}" — use octal like 755`);
      return;
    }
    try {
      await fs.chmod(sessionId, entry.path, mode);
      await load(path);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const selectionCount = selected.size;
  const activeIdx = anchor ? visible.findIndex((v) => v.path === anchor) : -1;
  const activeDescId = activeIdx >= 0 ? `${paneId}-row-${activeIdx}` : undefined;
  const segments = parseSegments(path);
  const hasPerms =
    !!sessionId && caps?.canChmod !== false && visible.some((e) => e.mode != null);
  // Columns yield as the pane narrows so the filename never gets crushed:
  // Modified drops below ~360px, Perms shows only when the pane is wide.
  const showModified = paneTier !== "narrow";
  const showPermsCol = hasPerms && paneTier === "wide";
  const visibleCols = (["name", showModified && "modified", "size", showPermsCol && "perms"] as const)
    .filter((c): c is ColumnId => !!c);
  const cols = columnWidths
    ? columnTemplate(visibleCols, columnWidths)
    : [
        "minmax(0,1fr)",
        showModified ? "7.5rem" : null,
        "5.5rem",
        showPermsCol ? "5.5rem" : null,
      ]
        .filter(Boolean)
        .join(" ");

  // Drag the boundary after visible column `index`: only it and its right
  // neighbour change. Moves under 3px don't count; listeners sit on the
  // document so the drag survives leaving the header.
  const startColumnResize = (e: React.PointerEvent, index: number) => {
    if (e.button !== 0 || !e.isPrimary) return;
    e.preventDefault();
    e.stopPropagation();
    const cells = Array.from(headerRef.current?.children ?? []) as HTMLElement[];
    const px = cells.map((c) => c.getBoundingClientRect().width);
    if (px.length !== visibleCols.length) return;
    const startX = e.clientX;
    const base = columnWidths;
    let moved = false;
    let last: ColumnWidths | null = null;
    const body = document.body.style;
    const prev = { cursor: body.cursor, select: body.userSelect };
    const move = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      if (!moved && Math.abs(delta) < 3) return;
      if (!moved) {
        moved = true;
        body.cursor = "col-resize";
        body.userSelect = "none";
        setResizingCol(index);
      }
      last = resizeColumns(visibleCols, px, index, delta, base);
      setLiveColumnWidths(last);
    };
    const end = () => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);
      document.removeEventListener("pointercancel", end);
      body.cursor = prev.cursor;
      body.userSelect = prev.select;
      if (last) commitColumnWidths(last);
      setLiveColumnWidths(null);
      setResizingCol(null);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", end);
    document.addEventListener("pointercancel", end);
  };
  const selectedBytes = visible
    .filter((e) => selected.has(e.path))
    .reduce((a, e) => a + (e.kind === "file" ? e.size : 0), 0);

  const onSort = (f: SortField) => {
    if (sortField === f) {
      setSortDirection(sortDirection === "asc" ? "desc" : "asc");
    } else {
      setSortField(f);
      setSortDirection("asc");
    }
  };

  const commitPath = () => {
    onPathChange(draftPath.trim() || (sessionId === LOCAL_SESSION ? path : "/"));
    setEditingPath(false);
  };
  const cancelPathEdit = () => {
    setDraftPath(path);
    setEditingPath(false);
  };

  const rowHandlers = useRef({ onRowClick, onRowActivate, onRowDragStart, onRowDragOver, onRowDrop, endDrag, openRowMenu, doRename, renameProblem, endRename });
  rowHandlers.current = { onRowClick, onRowActivate, onRowDragStart, onRowDragOver, onRowDrop, endDrag, openRowMenu, doRename, renameProblem, endRename };
  // Rows on the clipboard after Cut are dimmed until they're pasted.
  const cutPaths = useMemo(
    () => (clipboard?.mode === "cut" && clipboard.paneId === paneId ? new Set(clipboard.entries.map((e) => e.path)) : null),
    [clipboard, paneId]
  );

  return (
    <div
      data-file-pane={paneId}
      data-file-session={sessionId ?? undefined}
      data-file-path={path}
      ref={containerRef}
      tabIndex={0}
      role="listbox"
      aria-label={`${title} directory listing`}
      aria-multiselectable="true"
      aria-activedescendant={activeDescId}
      onDragEnter={onPaneDragEnter}
      onDragOver={onPaneDragOver}
      onDragLeave={onPaneDragLeave}
      onDrop={onPaneDrop}
      onContextMenu={openPaneMenu}
      className={cn(
        "group/pane flex h-full min-w-0 flex-1 flex-col bg-bg-panel outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/40",
        isDropTarget && "ring-2 ring-inset ring-accent/60 bg-accent/5"
      )}
    >
      <div className="flex min-w-0 items-center gap-1 border-b border-border bg-bg-subtle px-2 py-1.5">
        <span
          title={title}
          className="min-w-0 truncate text-xs font-semibold uppercase tracking-wider text-text-muted"
        >
          {title}
        </span>
        {selectionCount > 0 && (
          <span className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            {selectionCount} selected
          </span>
        )}
        {isDropTarget && (
          <span className="rounded bg-accent-strong px-1.5 py-0.5 text-[10px] font-medium text-white">
            drop to {transferLabel.toLowerCase()}
          </span>
        )}
        <div className="flex-1" />
        {sessionId && toolbarActions}
        {selectionCount > 0 && onTransfer && (
          <button
            onClick={transferSelection}
            className="flex items-center gap-1 rounded bg-accent-strong px-2 py-0.5 text-[11px] font-medium text-white hover:brightness-110"
            title={`${transferLabel} ${selectionCount} item(s)`}
          >
            {transferLabel === "Upload" ? (
              <Upload size={11} />
            ) : (
              <Download size={11} />
            )}
            {transferLabel} {selectionCount}
          </button>
        )}
        {onUpload && (
          <button
            onClick={onUpload}
            disabled={!sessionId}
            className="flex items-center gap-1 rounded border border-accent/40 bg-accent-soft px-2 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/20 disabled:opacity-40"
            title="Upload files or a folder to this directory"
          >
            <Upload size={11} /> Upload
          </button>
        )}
        {fs.analyzeDiskUsage && (
          <button
            onClick={() =>
              sessionId &&
              fs
                .analyzeDiskUsage!(sessionId, path)
                .catch((e) => setError(errorText(e)))
            }
            disabled={!sessionId}
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-40"
            title="Analyze disk usage in this folder"
          >
            <PieChart size={13} />
          </button>
        )}
        {fs.searchDirectory && (
          <button
            onClick={() =>
              sessionId &&
              fs
                .searchDirectory!(sessionId, path)
                .catch((e) => setError(errorText(e)))
            }
            disabled={!sessionId}
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-40"
            title="Search this folder by name or content"
          >
            <Search size={13} />
          </button>
        )}
        {fs.findDuplicates && (
          <button
            onClick={() =>
              sessionId &&
              fs
                .findDuplicates!(sessionId, path)
                .catch((e) => setError(errorText(e)))
            }
            disabled={!sessionId}
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-40"
            title="Find duplicate files in this folder"
          >
            <CopyX size={13} />
          </button>
        )}
        {caps?.hasDirectories !== false && (
          <button
            onClick={() => setModal({ type: "mkdir" })}
            disabled={!sessionId}
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-40"
            title="New folder"
          >
            <FolderPlus size={13} />
          </button>
        )}
        <button
          onClick={history.back}
          disabled={!sessionId || !history.canBack}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-30"
          title="Back"
        >
          <ArrowLeft size={13} />
        </button>
        <button
          onClick={history.forward}
          disabled={!sessionId || !history.canForward}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-30"
          title="Forward"
        >
          <ArrowRight size={13} />
        </button>
        <button
          onClick={goUp}
          disabled={!sessionId}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-40"
          title="Up (Backspace)"
        >
          <ArrowUp size={13} />
        </button>
        <button
          onClick={() => load(path)}
          disabled={!sessionId}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw size={13} />
        </button>
      </div>

      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1">
        {editingPath ? (
          <input
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Folder path"
            value={draftPath}
            onChange={(e) => setDraftPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !isComposing(e)) commitPath();
              else if (e.key === "Escape") cancelPathEdit();
            }}
            onBlur={commitPath}
            disabled={!sessionId}
            className="min-w-0 flex-1 rounded border border-accent bg-bg-subtle px-2 py-1 font-mono text-xs outline-none disabled:opacity-50"
            placeholder="/"
          />
        ) : (
          <div className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {segments.map((seg, i) => {
              const last = i === segments.length - 1;
              return (
                <span key={seg.path + i} className="flex items-center">
                  {i > 0 && <span className="px-0.5 text-text-dim">/</span>}
                  <button
                    onClick={() => !last && sessionId && onPathChange(seg.path)}
                    disabled={!sessionId || last}
                    className={cn(
                      "max-w-[12rem] truncate rounded px-1 py-0.5 font-mono text-xs",
                      last
                        ? "font-medium text-text"
                        : "text-text-muted hover:bg-bg-hover hover:text-text"
                    )}
                    title={seg.path}
                  >
                    {seg.label}
                  </button>
                </span>
              );
            })}
          </div>
        )}
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            onClick={() => setPaneViewMode("list")}
            className={cn(
              "rounded p-1 hover:bg-bg-hover",
              paneViewMode === "list"
                ? "text-accent"
                : "text-text-dim hover:text-text"
            )}
            title="List view"
          >
            <List size={13} />
          </button>
          <button
            onClick={() => setPaneViewMode("details")}
            className={cn(
              "rounded p-1 hover:bg-bg-hover",
              paneViewMode === "details"
                ? "text-accent"
                : "text-text-dim hover:text-text"
            )}
            title="Details view"
          >
            <Table2 size={13} />
          </button>
          <button
            onClick={() => setPaneViewMode("grid")}
            className={cn(
              "rounded p-1 hover:bg-bg-hover",
              paneViewMode === "grid"
                ? "text-accent"
                : "text-text-dim hover:text-text"
            )}
            title="Grid view"
          >
            <LayoutGrid size={13} />
          </button>
          <button
            onClick={() =>
              setPaneDensity(paneDensity === "compact" ? "comfortable" : "compact")
            }
            className={cn(
              "rounded p-1 hover:bg-bg-hover",
              paneDensity === "compact"
                ? "text-accent"
                : "text-text-dim hover:text-text"
            )}
            title={
              paneDensity === "compact"
                ? "Compact rows — click for comfortable"
                : "Comfortable rows — click for compact"
            }
          >
            <AlignJustify size={13} />
          </button>
          {sessionId &&
            sessionId !== LOCAL_SESSION &&
            setRemoteImagePreviews && (
              <button
                onClick={() => setRemoteImagePreviews(!remoteImagePreviews)}
                className={cn(
                  "rounded p-1 hover:bg-bg-hover",
                  remoteImagePreviews
                    ? "text-accent"
                    : "text-text-dim hover:text-text"
                )}
                title={
                  remoteImagePreviews
                    ? "Image previews on — click to turn off (fetches images to thumbnail them)"
                    : "Image previews off — click to show remote image thumbnails"
                }
              >
                <ImageIcon size={13} />
              </button>
            )}
        </div>
        {!editingPath && (
          <button
            onClick={() => {
              setDraftPath(path);
              setEditingPath(true);
            }}
            disabled={!sessionId}
            className="shrink-0 rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text disabled:opacity-40"
            title="Edit path"
          >
            <Pencil size={12} />
          </button>
        )}
        <div className="relative shrink-0">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-text-dim"
          />
          <input
            ref={filterRef}
            data-pane-filter
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            disabled={!sessionId}
            placeholder="Filter"
            aria-label="Filter this folder"
            className="w-32 rounded border border-border bg-bg-subtle py-1 pl-7 pr-6 text-xs outline-none focus:border-accent disabled:opacity-50"
          />
          {filter && (
            <button
              onClick={() => setFilter("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-text-dim hover:text-text"
              title="Clear filter"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {sessionId && paneViewMode === "details" && (
        <div
          ref={headerRef}
          className="grid items-center gap-2 border-b border-border bg-bg-subtle px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted"
          style={{ gridTemplateColumns: cols }}
        >
          {visibleCols.map((id, i) => (
            <div key={id} data-col={id} className={cn("relative flex min-w-0", id === "name" || id === "modified" ? "justify-start" : "justify-end")}>
              {id === "perms" ? (
                <span className="text-right">Perms</span>
              ) : (
                <SortHeader
                  label={COLUMN_LABELS[id]}
                  field={id}
                  align={id === "size" ? "right" : "left"}
                  sortField={sortField}
                  sortDirection={sortDirection}
                  onSort={onSort}
                />
              )}
              {i < visibleCols.length - 1 && (
                <div
                  role="separator"
                  aria-orientation="vertical"
                  aria-label={`Resize ${COLUMN_LABELS[id]} column`}
                  title="Drag to resize; double-click to reset"
                  onPointerDown={(e) => startColumnResize(e, i)}
                  onDoubleClick={() => { setLiveColumnWidths(null); commitColumnWidths(null); }}
                  onClick={(e) => e.stopPropagation()}
                  className="group/colh absolute -right-[8px] -top-1 -bottom-1 z-[1] flex w-2 cursor-col-resize touch-none justify-center"
                >
                  <span
                    className={cn(
                      "w-px group-hover/colh:bg-accent",
                      resizingCol === i ? "bg-accent" : "bg-border"
                    )}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {working && (
        <div role="status" className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs text-text-muted">
          <Loader2 size={12} aria-hidden="true" className="shrink-0 animate-spin" />
          <span className="truncate">{working}</span>
        </div>
      )}

      {sessionId && !loading && !error && skippedEntries > 0 && (
        <div role="status" className="flex shrink-0 items-start gap-2 border-b border-border px-3 py-2 text-xs text-text-muted">
          <AlertTriangle size={14} aria-hidden="true" className="mt-0.5 shrink-0" />
          <p>
            <strong className="font-medium text-text">Incomplete listing: {skippedEntries} {skippedEntries === 1 ? "entry" : "entries"} hidden.</strong>{" "}
            Their names contain unsupported path separators. Folder operations will report an error instead of silently skipping them.
          </p>
        </div>
      )}

      <div role="presentation" className="flex-1 overflow-y-auto">
        {!sessionId ? (
          <EmptyState
            icon={<ServerOff size={20} />}
            title="No connection"
            hint="Pick a server in the left rail to connect."
          />
        ) : error ? (
          <div className="px-3 py-2 text-xs text-danger">
            {error}{" "}
            <button
              onClick={() => setError(null)}
              className="ml-1 underline opacity-60 hover:opacity-100"
            >
              dismiss
            </button>
          </div>
        ) : loading ? (
          <FileListSkeleton />
        ) : visible.length === 0 ? (
          filter ? (
            <EmptyState
              icon={<SearchX size={20} />}
              title="No matches"
              hint={`Nothing here matches “${filter}”.`}
              action={
                <button
                  onClick={() => setFilter("")}
                  className="rounded-md border border-border bg-bg-subtle px-2.5 py-1 text-xs text-text-muted hover:text-text"
                >
                  Clear filter
                </button>
              }
            />
          ) : (
            <EmptyState icon={<Inbox size={20} />} title={skippedEntries > 0 ? "No supported entries" : "Empty folder"} />
          )
        ) : paneViewMode === "grid" ? (
          <div className="grid [grid-template-columns:repeat(auto-fill,minmax(108px,1fr))] gap-1 p-2">
            {visible.map((entry, i) => (
              <Row
                key={entry.path}
                paneId={paneId}
                entry={entry}
                icon={iconFor(entry)}
                index={i}
                viewMode={paneViewMode}
                density={paneDensity}
                selected={selected.has(entry.path)}
                cols={cols}
                showModified={showModified}
                showPermsCol={showPermsCol}
                sessionId={sessionId}
                loadThumb={loadThumb}
                handlers={rowHandlers}
                renaming={renaming === entry.path}
                focused={anchor === entry.path}
                cut={!!cutPaths?.has(entry.path)}
                dropTarget={dropFolder === entry.path}
              />
            ))}
          </div>
        ) : (
          visible.map((entry, i) => (
            <Row
              key={entry.path}
              paneId={paneId}
              entry={entry}
              icon={iconFor(entry)}
              index={i}
              viewMode={paneViewMode}
              density={paneDensity}
              selected={selected.has(entry.path)}
              cols={cols}
              showModified={showModified}
              showPermsCol={showPermsCol}
              sessionId={sessionId}
              loadThumb={loadThumb}
              handlers={rowHandlers}
              renaming={renaming === entry.path}
              focused={anchor === entry.path}
              cut={!!cutPaths?.has(entry.path)}
              dropTarget={dropFolder === entry.path}
            />
          ))
        )}
      </div>

      {sessionId && (
        <div className="flex shrink-0 items-center gap-1.5 border-t border-border bg-bg-subtle px-2.5 py-1 text-[10px] text-text-dim">
          <span>
            {visible.length} item{visible.length === 1 ? "" : "s"}
            {filter && entries.length !== visible.length
              ? ` of ${entries.length}`
              : ""}
          </span>
          {selectionCount > 0 && (
            <span className="text-text-muted">
              · {selectionCount} selected
              {selectedBytes > 0 && (
                <>
                  {" · "}
                  <span title={exactBytes(selectedBytes)}>{fmtSize(selectedBytes)}</span>
                </>
              )}
            </span>
          )}
          {notice && (
            <span
              role="status"
              data-pane-notice
              className={cn("min-w-0 truncate", notice.error ? "text-danger" : "text-text-muted")}
              title={notice.text}
            >
              · {notice.text}
            </span>
          )}
          <div className="flex-1" />
          <span className="max-w-[55%] truncate font-mono" title={path}>
            {path}
          </span>
        </div>
      )}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}

      {modal?.type === "mkdir" && (
        <PromptModal
          title="New folder"
          label={`In ${modal.parent ?? path}`}
          initialValue=""
          okLabel="Create"
          onClose={() => setModal(null)}
          onSubmit={(v) => doMkdir(v, modal.parent ?? path)}
        />
      )}
      {modal?.type === "chmod" && (
        <PromptModal
          title={`Permissions for ${modal.entry.name}`}
          label="Octal mode (e.g. 755, 644)"
          initialValue={
            modal.entry.mode
              ? (modal.entry.mode & 0o777).toString(8)
              : "644"
          }
          okLabel="Apply"
          onClose={() => setModal(null)}
          onSubmit={(v) => doChmod(modal.entry, v)}
        />
      )}
      {modal?.type === "compress" && (
        <PromptModal
          title={
            modal.entries.length === 1
              ? `Compress ${modal.entries[0].name}`
              : `Compress ${modal.entries.length} items`
          }
          label={`Archive name, saved in ${path}`}
          initialValue={
            (modal.entries.length === 1
              ? modal.entries[0].name
              : path.split(/[\\/]/).filter(Boolean).pop() || "Archive") + modal.ext
          }
          okLabel="Compress"
          onClose={() => setModal(null)}
          onSubmit={(v) => doCompress(modal.entries, v, modal.format)}
        />
      )}
      {modal?.type === "extractTo" && (
        <PromptModal
          title={`Extract ${modal.entry.name}`}
          label="Destination folder (created if missing; existing files are kept)"
          initialValue={joinPath(path, modal.stem)}
          okLabel="Extract"
          onClose={() => setModal(null)}
          onSubmit={(v) => doExtract(modal.entry, v)}
        />
      )}
      {modal?.type === "props" && (
        <PropertiesModal
          entry={modal.entry}
          sessionId={sessionId}
          canChangeOwner={sessionId === LOCAL_SESSION ? caps?.canChmod === true : !!caps?.hasShell}
          onOwnerChanged={() => load(path)}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === "delete" && (
        <ConfirmModal
          title={
            modal.entries.length === 1
              ? `Delete this ${modal.entries[0].kind === "directory" ? "folder" : "file"}?`
              : `Delete ${describeKinds(modal.entries)}?`
          }
          message={
            modal.entries.length === 1 ? (
              <span data-delete-summary>
                <strong className="font-semibold text-text [overflow-wrap:anywhere]">{modal.entries[0].name}</strong>
                {modal.entries[0].kind === "directory"
                  ? " and everything in it will be permanently deleted."
                  : " will be permanently deleted."}
                <span className="mt-1 block font-mono text-xs text-text-dim [overflow-wrap:anywhere]">{modal.entries[0].path}</span>
              </span>
            ) : (
              <span data-delete-summary>
                {modal.entries.some((e) => e.kind === "directory")
                  ? "These items, and everything inside the folders, will be permanently deleted:"
                  : "These items will be permanently deleted:"}
                <span className="mt-1 block font-mono text-xs text-text-dim [overflow-wrap:anywhere]">
                  {modal.entries
                    .slice(0, 5)
                    .map((e) => e.name)
                    .join("\n")}
                  {modal.entries.length > 5 ? `\n…and ${modal.entries.length - 5} more` : ""}
                </span>
              </span>
            )
          }
          destructive
          confirmLabel="Delete"
          onClose={() => setModal(null)}
          onConfirm={() => doDelete(modal.entries)}
        />
      )}
    </div>
  );
}

/// Per-row callbacks, read through a ref that stays the same object for the
/// pane's lifetime, so a memoized row only re-renders when its own props
/// change — not on every click elsewhere in a 10k-entry folder.
type RowHandlers = React.MutableRefObject<{
  onRowClick: (entry: DirEntry, e: React.MouseEvent) => void;
  onRowActivate: (entry: DirEntry) => void;
  onRowDragStart: (e: React.DragEvent, entry: DirEntry) => void;
  onRowDragOver: (e: React.DragEvent, entry: DirEntry) => void;
  onRowDrop: (e: React.DragEvent, entry: DirEntry) => void;
  endDrag: () => void;
  openRowMenu: (e: React.MouseEvent, entry: DirEntry) => void;
  doRename: (entry: DirEntry, name: string) => Promise<void>;
  renameProblem: (name: string) => string | null;
  endRename: () => void;
}>;

const Row = memo(function Row({
  paneId,
  entry,
  icon,
  index,
  viewMode,
  density,
  selected,
  cols,
  showModified,
  showPermsCol,
  sessionId,
  loadThumb,
  handlers,
  renaming,
  focused,
  cut,
  dropTarget,
}: {
  paneId: string;
  entry: DirEntry;
  icon: FileIconSpec;
  index: number;
  viewMode: PaneViewMode;
  density: PaneDensity;
  selected: boolean;
  cols: string;
  showModified: boolean;
  showPermsCol: boolean;
  sessionId: SessionId | null;
  loadThumb?: (
    sessionId: SessionId,
    entry: DirEntry,
    signal?: AbortSignal
  ) => Promise<Blob | null>;
  handlers: RowHandlers;
  renaming: boolean;
  /** The keyboard cursor (anchor) row: ringed while the pane has focus. */
  focused: boolean;
  /** On the clipboard after Cut: dimmed until pasted. */
  cut: boolean;
  /** A same-pane drag would drop into this folder: tinted. */
  dropTarget: boolean;
}) {
  const onClick = (e: React.MouseEvent) => handlers.current.onRowClick(entry, e);
  const onActivate = () => handlers.current.onRowActivate(entry);
  const onDragStart = (e: React.DragEvent) => handlers.current.onRowDragStart(e, entry);
  const onContextMenu = (e: React.MouseEvent) => handlers.current.openRowMenu(e, entry);
  const onDragOver = (e: React.DragEvent) => handlers.current.onRowDragOver(e, entry);
  const onDrop = (e: React.DragEvent) => handlers.current.onRowDrop(e, entry);
  const onDragEnd = () => handlers.current.endDrag();
  // Shared by all three layouts.
  const rowProps = {
    "data-idx": index,
    "data-path": entry.path,
    "data-upload-directory": entry.kind === "directory" ? entry.path : undefined,
    "data-anchor": focused || undefined,
    "data-cut": cut || undefined,
    "data-drop-target": dropTarget || undefined,
    // Spoken, not a hover tooltip: the name alone gets a tooltip, and only
    // when it's cut off.
    "aria-description": opensAsFolder(entry)
      ? "Double-click to open • Right-click for more"
      : "Double-click to transfer • Right-click for more",
    role: "option",
    id: `${paneId}-row-${index}`,
    "aria-selected": selected,
    onClick,
    onDoubleClick: onActivate,
    onContextMenu,
    draggable: !renaming,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
  };
  // Row states: selected rows are tinted, the keyboard cursor row gets a ring
  // while the pane has focus, a drop target gets a stronger tint and ring, and
  // cut rows are dimmed.
  const stateCls = cn(
    focused && "group-focus-within/pane:ring-1 group-focus-within/pane:ring-inset group-focus-within/pane:ring-accent/70",
    dropTarget && "!bg-accent/25 ring-1 ring-inset ring-accent",
    cut && "opacity-50"
  );
  const sizeEl = (cls: string) =>
    entry.kind === "file" ? (
      <span className={cls} title={exactBytes(entry.size)}>
        {fmtSize(entry.size)}
      </span>
    ) : (
      <span className={cls} />
    );
  const { Icon, className: iconColor } = icon;
  const pad = density === "compact" ? "py-0.5 text-xs" : "py-1 text-sm";
  const sel = selected
    ? "bg-accent/15 hover:bg-accent/20"
    : "hover:bg-bg-hover";
  // Prefer a Material Icon Theme SVG for known file types; fall back to the
  // lucide glyph for folders, symlinks, and unmatched files.
  const matUrl = entry.kind === "file" ? materialIconUrl(entry.name) : undefined;
  const glyph = (size: number) =>
    matUrl ? (
      <img
        src={matUrl}
        width={size}
        height={size}
        alt=""
        draggable={false}
        className="shrink-0 select-none"
      />
    ) : (
      <Icon size={size} className={cn("shrink-0", iconColor)} />
    );
  const iconEl = glyph(13);
  // The name, or its inline editor while this row is being renamed.
  const nameEl = (cls: string) =>
    renaming ? (
      <InlineRename
        value={entry.name}
        selectStem={entry.kind === "file"}
        aria-label={`Rename ${entry.name}`}
        validate={(n) => handlers.current.renameProblem(n)}
        onSubmit={(n) => handlers.current.doRename(entry, n)}
        onDone={() => handlers.current.endRename()}
      />
    ) : (
      <span className={cls} onMouseEnter={titleIfTruncated}>
        {entry.name}
      </span>
    );
  // Show a real image preview when the adapter can supply bytes. The adapter
  // gates the (expensive, network) remote kind on the `remoteImagePreviews`
  // setting — when it's off it returns null fast and the icon fallback shows,
  // so mounting Thumbnail here costs nothing extra.
  const canThumb = !!loadThumb && !!sessionId && isImage(entry);
  // Small inline thumbnail for the list / details rows (grid uses its own,
  // larger one below). Reuses the same lazy, cached pipeline.
  const rowThumb =
    canThumb && sessionId ? (
      <Thumbnail
        sessionId={sessionId}
        entry={entry}
        load={loadThumb!}
        size={18}
        fallback={iconEl}
        className="shrink-0"
      />
    ) : (
      iconEl
    );

  if (viewMode === "grid") {
    const bigIcon = glyph(30);
    return (
      <div
        {...rowProps}
        className={cn(
          "flex cursor-default select-none flex-col items-center gap-1.5 rounded-lg border p-2.5 text-center",
          // Containment clips overflow; the rename error must show below.
          !renaming && "[content-visibility:auto] [contain-intrinsic-size:auto_92px]",
          selected
            ? "border-accent/40 bg-accent/15"
            : "border-transparent hover:border-border-subtle hover:bg-bg-hover",
          stateCls
        )}
      >
        {canThumb && sessionId ? (
          <Thumbnail
            sessionId={sessionId}
            entry={entry}
            load={loadThumb!}
            size={56}
            fallback={bigIcon}
          />
        ) : (
          bigIcon
        )}
        {nameEl("line-clamp-2 w-full break-words text-xs leading-tight")}
      </div>
    );
  }

  if (viewMode === "list") {
    return (
      <div
        {...rowProps}
        className={cn(
          "flex cursor-default select-none items-center gap-2 border-b border-border-subtle px-3",
          // Containment clips overflow; the rename error must show below.
          !renaming && "[content-visibility:auto] [contain-intrinsic-size:auto_28px]",
          pad,
          sel,
          stateCls
        )}
      >
        {rowThumb}
        {nameEl("min-w-0 flex-1 truncate")}
        {sizeEl("shrink-0 text-xs tabular-nums text-text-dim")}
      </div>
    );
  }

  return (
    <div
      {...rowProps}
      style={{ gridTemplateColumns: cols }}
      className={cn(
        "grid cursor-default select-none items-center gap-2 border-b border-border-subtle px-3",
        // Containment clips overflow; the rename error must show below.
        !renaming && "[content-visibility:auto] [contain-intrinsic-size:auto_28px]",
        pad,
        sel,
        stateCls
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        {rowThumb}
        {nameEl("truncate")}
      </span>
      {showModified && (
        <span className="truncate text-xs text-text-dim">
          {fmtMtime(entry.modified)}
        </span>
      )}
      {sizeEl("text-right text-xs tabular-nums text-text-dim")}
      {showPermsCol && (
        <span
          className="text-right font-mono text-[10px] text-text-dim"
          title={entry.mode != null ? (entry.mode & 0o777).toString(8) : ""}
        >
          {formatMode(entry.mode)}
        </span>
      )}
    </div>
  );
});

/** Show the full name as a tooltip only when it's cut off on screen. */
function titleIfTruncated(e: React.MouseEvent<HTMLElement>) {
  const el = e.currentTarget;
  const cut = el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
  if (cut) el.title = el.textContent ?? "";
  else el.removeAttribute("title");
}

function SortHeader({
  label,
  field,
  align = "left",
  sortField,
  sortDirection,
  onSort,
}: {
  label: string;
  field: SortField;
  align?: "left" | "right";
  sortField: SortField;
  sortDirection: "asc" | "desc";
  onSort: (f: SortField) => void;
}) {
  const active = sortField === field;
  return (
    <button
      onClick={() => onSort(field)}
      className={cn(
        "flex items-center gap-1 uppercase tracking-wider hover:text-text",
        align === "right" ? "justify-end" : "justify-start text-left",
        active ? "text-text" : "text-text-muted"
      )}
    >
      {label}
      {active &&
        (sortDirection === "asc" ? (
          <ChevronUp size={11} />
        ) : (
          <ChevronDown size={11} />
        ))}
    </button>
  );
}
