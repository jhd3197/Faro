// Remember the local pane's folder across launches.
//
// The value lives in faro.db under `lastLocalPath` (a JSON string, like every
// other settings row) and rides the pre-paint snapshot on
// `window.__FARO_SETTINGS__`. It is intentionally not a field of the settings
// store: that store re-renders the whole shell, and this path changes as the
// user navigates. A connection's Default local path wins when it applies.
// Site shortcuts are remote paths and are never rewritten from here.

export const LAST_LOCAL_PATH_KEY = "lastLocalPath";

let sessionLocalPath: string | undefined;

/** In-memory path for this process, so switching browser layouts doesn't
 *  fall back to the launch-time injection snapshot. */
export function peekSessionLocalPath(): string | undefined {
  return sessionLocalPath;
}

export function rememberSessionLocalPath(path: string) {
  sessionLocalPath = path;
}

export function forgetSessionLocalPath() {
  sessionLocalPath = undefined;
}

export function osRoot(userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent): string {
  return userAgent.includes("Windows") ? "C:\\" : "/";
}

function readInjected(): { lastLocalPath?: unknown } | null {
  try {
    const injected = (globalThis as { __FARO_SETTINGS__?: { lastLocalPath?: unknown } }).__FARO_SETTINGS__;
    if (injected && typeof injected === "object") return injected;
  } catch {
    // ignore
  }
  return null;
}

export function injectedLastLocalPath(): string | null {
  const value = readInjected()?.lastLocalPath;
  return typeof value === "string" && value.trim() ? value : null;
}

/** First-frame path: the folder already open this session, else the injected
 *  snapshot, else the OS root. Accessibility is checked separately. */
export function initialLocalPath(userAgent?: string): string {
  return peekSessionLocalPath() ?? injectedLastLocalPath() ?? osRoot(userAgent);
}

export function parseStoredLocalPath(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "string" && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** Default local path wins. A missing or unreadable remembered folder falls
 *  back to the OS root. There is no error channel — callers must not toast. */
export function resolveLaunchLocalPath(opts: {
  defaultLocalPath?: string;
  remembered?: string | null;
  rememberedAccessible: boolean;
  osRoot: string;
}): string {
  const preferred = opts.defaultLocalPath?.trim();
  if (preferred) return preferred;
  const remembered = opts.remembered?.trim();
  if (remembered && opts.rememberedAccessible) return remembered;
  return opts.osRoot;
}

/** Remote path at launch. A site shortcut wins over the server's last folder
 *  and the profile default. Local memory never contributes a remote path.
 *  `undefined` means "not set"; an empty string is a real path and is kept. */
export function resolveLaunchRemotePath(opts: {
  sitePath?: string;
  serverPath?: string;
  defaultRemotePath?: string;
}): string {
  if (opts.sitePath !== undefined) return opts.sitePath;
  if (opts.serverPath !== undefined) return opts.serverPath;
  return opts.defaultRemotePath ?? ".";
}

export interface LocalPathMemory {
  update(path: string): void;
  /** Write the pending path now. Resolves once the write settles. */
  flush(): Promise<void>;
  cancel(): void;
}

export function createLocalPathMemory(
  write: (path: string) => void | Promise<unknown>,
  delayMs: number,
  schedule: (fn: () => void, ms: number) => { cancel(): void } = (fn, ms) => {
    const id = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(id) };
  }
): LocalPathMemory {
  let pending: string | undefined;
  let timer: { cancel(): void } | undefined;
  let lastWritten: string | undefined;
  const commit = (): Promise<void> => {
    timer = undefined;
    if (pending === undefined || pending === lastWritten) return Promise.resolve();
    lastWritten = pending;
    return Promise.resolve(write(pending)).then(() => {});
  };
  return {
    update(path: string) {
      pending = path;
      rememberSessionLocalPath(path);
      timer?.cancel();
      timer = schedule(() => {
        void commit();
      }, delayMs);
    },
    flush() {
      timer?.cancel();
      timer = undefined;
      return commit();
    },
    cancel() {
      timer?.cancel();
      timer = undefined;
      pending = undefined;
    },
  };
}
