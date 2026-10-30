// Synchronized browsing: mirror the relative folder between the two panes.
//
// The base pair is the two directories open when sync is turned on (or when
// the user re-bases, or when the active server changes). Only the relative
// structure is mirrored — local and remote absolute paths are never forced
// to match. This module lists a directory to see if the counterpart exists
// and otherwise has no side effects: no transfer, upload, download, or delete.

export type Side = "local" | "remote";

export interface SyncHint {
  title: string;
  message: string;
}

export type ProbeFailure = "missing" | "denied" | "disconnected" | "other";

export interface SyncBase {
  local: string;
  remote: string;
  sessionId: string;
}

export interface SyncState {
  enabled: boolean;
  base: SyncBase | null;
  generation: number;
  /** A path just applied by sync. The matching navigation is an echo. */
  echo: { side: Side; path: string } | null;
}

export interface NavRequest {
  action: "ignore" | "probe" | "hint";
  generation: number;
  other?: Side;
  counterpart?: string;
  hint?: SyncHint;
}

export interface MirrorResult {
  stale: boolean;
  /** True when a directory listing was issued. */
  listed: boolean;
  apply?: { side: Side; path: string };
  hint?: SyncHint;
}

export function initialSyncState(): SyncState {
  return { enabled: false, base: null, generation: 0, echo: null };
}

function bumped(state: SyncState, patch: Partial<SyncState>): SyncState {
  return { ...state, ...patch, generation: state.generation + 1, echo: null };
}

export function toggleSync(
  state: SyncState,
  on: boolean,
  local: string,
  remote: string,
  sessionId: string
): SyncState {
  if (!on) return bumped(state, { enabled: false, base: null });
  return bumped(state, { enabled: true, base: { local, remote, sessionId } });
}

export function rebaseSync(
  state: SyncState,
  local: string,
  remote: string,
  sessionId: string
): SyncState {
  if (!state.enabled || !sessionId) return state;
  return bumped(state, { base: { local, remote, sessionId } });
}

/** A different server anchors to the folders open now. Disconnecting clears
 *  the base so a stale offset can never be applied later. */
export function retargetSession(
  state: SyncState,
  sessionId: string | null,
  local: string,
  remote: string
): SyncState {
  if (!state.enabled) return bumped(state, {});
  if (!sessionId) return bumped(state, { base: null });
  return bumped(state, { base: { local, remote, sessionId } });
}

type Style = "unc" | "drive" | "posix-abs" | "posix-rel";

interface Norm {
  style: Style;
  rootKey: string;
  root: string;
  parts: string[];
  preferDotSlash: boolean;
}

function resolveDots(segs: string[], absolute: boolean): string[] {
  const out: string[] = [];
  for (const seg of segs) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(seg);
  }
  return out;
}

function normalize(path: string): Norm {
  const trimmed = path.trim() || ".";
  if (trimmed.startsWith("\\\\")) {
    const bits = trimmed.split(/[/\\]/).filter(Boolean);
    const server = bits[0] ?? "";
    const share = bits[1] ?? "";
    const root = `\\\\${server}\\${share}`;
    return {
      style: "unc",
      rootKey: root.toLowerCase(),
      root,
      parts: resolveDots(bits.slice(2), true),
      preferDotSlash: false,
    };
  }
  if (/^[a-zA-Z]:/.test(trimmed)) {
    const bits = trimmed.split(/[/\\]/).filter(Boolean);
    const drive = (bits[0] ?? "C:").slice(0, 2).toUpperCase();
    return {
      style: "drive",
      rootKey: drive.toLowerCase(),
      root: `${drive}\\`,
      parts: resolveDots(bits.slice(1), true),
      preferDotSlash: false,
    };
  }
  if (trimmed.startsWith("/")) {
    return {
      style: "posix-abs",
      rootKey: "/",
      root: "/",
      parts: resolveDots(trimmed.split("/"), true),
      preferDotSlash: false,
    };
  }
  return {
    style: "posix-rel",
    rootKey: "",
    root: "",
    parts: resolveDots(trimmed.split("/"), false),
    preferDotSlash: trimmed === "." || trimmed.startsWith("./"),
  };
}

function samePart(style: Style, a: string, b: string): boolean {
  return style === "drive" || style === "unc"
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function format(n: Norm): string {
  if (n.style === "unc") {
    return n.parts.length ? `${n.root}\\${n.parts.join("\\")}` : n.root;
  }
  if (n.style === "drive") {
    return n.parts.length ? `${n.root}${n.parts.join("\\")}` : n.root;
  }
  if (n.style === "posix-abs") {
    return n.parts.length ? `/${n.parts.join("/")}` : "/";
  }
  if (!n.parts.length) return ".";
  const body = n.parts.join("/");
  return n.preferDotSlash ? `./${body}` : body;
}

export function pathsEqual(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (na.style !== nb.style || na.rootKey !== nb.rootKey || na.parts.length !== nb.parts.length) {
    return false;
  }
  return na.parts.every((part, i) => samePart(na.style, part, nb.parts[i]));
}

/** Relative path from `fromBase` to `fromPath`, applied onto `toBase`.
 *  Returns null when the paths don't share a root, or the walk would climb
 *  above the other side's root. */
export function mapRelative(fromBase: string, fromPath: string, toBase: string): string | null {
  const base = normalize(fromBase);
  const target = normalize(fromPath);
  if (base.style !== target.style || base.rootKey !== target.rootKey) return null;
  let i = 0;
  while (
    i < base.parts.length &&
    i < target.parts.length &&
    samePart(base.style, base.parts[i], target.parts[i])
  ) {
    i++;
  }
  const dest = normalize(toBase);
  const parts = [...dest.parts];
  const ups = base.parts.length - i;
  for (let u = 0; u < ups; u++) {
    if (!parts.length) return null;
    parts.pop();
  }
  for (const seg of target.parts.slice(i)) {
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return format({ ...dest, parts });
}

function messageOf(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return error == null ? "" : String(error);
}

/** `list_directory` still rejects with a string. Prefer a structured kind when
 *  one is present, and otherwise the same phrases the backend already uses. */
export function classifyListingError(error: unknown): ProbeFailure {
  const kind =
    error && typeof error === "object" && typeof (error as { kind?: unknown }).kind === "string"
      ? (error as { kind: string }).kind
      : "";
  const message = messageOf(error).toLowerCase();
  if (kind === "permission" || /permission denied|access is denied|eacces|forbidden/.test(message)) {
    return "denied";
  }
  if (
    kind === "network" ||
    kind === "timeout" ||
    /connection refused|connection reset|connection closed|broken pipe|timed out|timeout|unreachable|network is down|no route to host/.test(message) ||
    /session .+ not found|no connection|disconnected/.test(message)
  ) {
    return "disconnected";
  }
  if (kind === "not-found" || /no such file|not found|does not exist|enoent|cannot find the path/.test(message)) {
    return "missing";
  }
  return "other";
}

function otherSide(side: Side): Side {
  return side === "local" ? "remote" : "local";
}

export function hintFor(failure: ProbeFailure, side: Side): SyncHint {
  const where = side === "local" ? "The local pane" : "The remote pane";
  if (failure === "missing") {
    return {
      title: "No matching folder",
      message: `${where} has no folder at that relative path, so it stayed put.`,
    };
  }
  if (failure === "denied") {
    return {
      title: "Can't open the matching folder",
      message: `${where} can't list that folder (permission denied), so it stayed put.`,
    };
  }
  if (failure === "disconnected") {
    return {
      title: "Connection dropped",
      message: `${where} couldn't be reached, so it stayed put.`,
    };
  }
  return {
    title: "Can't open the matching folder",
    message: `${where} couldn't list that folder, so it stayed put.`,
  };
}

export function hintUnmapped(): SyncHint {
  return {
    title: "Can't mirror that folder",
    message: "That path doesn't share a relative structure with the synchronized base, so the other pane stayed put.",
  };
}

export function beginNavigation(
  state: SyncState,
  side: Side,
  path: string,
  otherPath: string
): { state: SyncState; request: NavRequest } {
  if (state.echo && state.echo.side === side && pathsEqual(state.echo.path, path)) {
    return {
      state: { ...state, echo: null },
      request: { action: "ignore", generation: state.generation },
    };
  }
  if (!state.enabled || !state.base) {
    return {
      state: { ...state, echo: null },
      request: { action: "ignore", generation: state.generation },
    };
  }
  const fromBase = side === "local" ? state.base.local : state.base.remote;
  const toBase = side === "local" ? state.base.remote : state.base.local;
  const mapped = mapRelative(fromBase, path, toBase);
  const generation = state.generation + 1;
  const next: SyncState = { ...state, generation, echo: null };
  if (mapped == null) {
    return {
      state: next,
      request: { action: "hint", generation, other: otherSide(side), hint: hintUnmapped() },
    };
  }
  if (pathsEqual(mapped, otherPath)) {
    return { state: next, request: { action: "ignore", generation, other: otherSide(side) } };
  }
  return {
    state: next,
    request: { action: "probe", generation, other: otherSide(side), counterpart: mapped },
  };
}

export function finishProbe(
  state: SyncState,
  generation: number,
  other: Side,
  counterpart: string,
  failure: ProbeFailure | null
): { state: SyncState; stale: boolean; apply?: { side: Side; path: string }; hint?: SyncHint } {
  if (generation !== state.generation || !state.enabled) {
    return { state, stale: true };
  }
  if (failure) return { state, stale: false, hint: hintFor(failure, other) };
  return {
    state: { ...state, echo: { side: other, path: counterpart } },
    stale: false,
    apply: { side: other, path: counterpart },
  };
}

/** Drop an echo that nothing consumed, without touching a newer one. */
export function clearMatchingEcho(
  state: SyncState,
  echo: { side: Side; path: string } | null
): SyncState {
  if (!echo || !state.echo) return state;
  if (state.echo.side === echo.side && pathsEqual(state.echo.path, echo.path)) {
    return { ...state, echo: null };
  }
  return state;
}

/** Probe the counterpart, then apply it only if this navigation is still the
 *  latest. `listDirectory` is the only operation this function performs. */
export async function runMirror(args: {
  getState: () => SyncState;
  setState: (state: SyncState) => void;
  side: Side;
  path: string;
  otherPath: string;
  listDirectory: (path: string) => Promise<unknown>;
}): Promise<MirrorResult> {
  const begun = beginNavigation(args.getState(), args.side, args.path, args.otherPath);
  args.setState(begun.state);
  if (begun.request.action === "ignore") return { stale: false, listed: false };
  if (begun.request.action === "hint") {
    return { stale: false, listed: false, hint: begun.request.hint };
  }
  let failure: ProbeFailure | null = null;
  try {
    await args.listDirectory(begun.request.counterpart!);
  } catch (error) {
    failure = classifyListingError(error);
  }
  const done = finishProbe(
    args.getState(),
    begun.request.generation,
    begun.request.other!,
    begun.request.counterpart!,
    failure
  );
  if (done.stale) return { stale: true, listed: true };
  args.setState(done.state);
  return { stale: false, listed: true, apply: done.apply, hint: done.hint };
}
