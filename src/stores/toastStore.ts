import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import { useLayout } from "@/stores/layoutStore";

export type ToastVariant = "info" | "success" | "error" | "warning";

/** A link button on a toast. A URL or a settings section — both JSON, so history keeps them. */
export interface ToastAction {
  label: string;
  url?: string;
  /** Open Settings on this section (and scroll to `focus` when set). */
  settings?: { section: string; focus?: string };
  /** Connect a saved server and open a folder or site on it (a deep link's target). */
  connect?: { profileId: string; siteId?: string; path?: string };
}

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  message?: string;
  action?: ToastAction;
  /** The raw error behind an error toast, for "Copy details". */
  detail?: string;
  /** How many times this toast fired in a row (same id, still on screen). */
  repeat?: number;
  createdAt: number;
}

/** Options shared by the `toast.*` helpers. */
export interface ToastOptions {
  /** Fixed id: a repeat replaces the toast on screen instead of stacking. */
  id?: string;
  /** false = an ephemeral confirmation: shown, but kept out of the
   *  notification centre and the unread count. */
  log?: boolean;
  detail?: string;
  duration?: number;
}

interface PushArgs {
  /** Fixed id: a toast with the same id on screen is replaced, not stacked. */
  id?: string;
  variant: ToastVariant;
  title: string;
  message?: string;
  action?: ToastAction;
  duration?: number; // ms; 0 = sticky until dismissed
  /** false keeps it out of history and the unread count (copy confirmations). */
  log?: boolean;
  /** Raw error text included by "Copy details". */
  detail?: string;
}

interface ToastState {
  toasts: Toast[]; // currently on-screen
  history: Toast[]; // bounded, persisted log for the notification center
  unreadCount: number;

  push: (args: PushArgs) => string;
  dismiss: (id: string) => void;
  markAllRead: () => void;
  clearHistory: () => void;
}

const HISTORY_KEY = "faro.notifications.v1";
const MAX_HISTORY = 100;

let _seq = 0;
const nextId = () => `n${Date.now().toString(36)}${++_seq}`;

function loadHistory(): Toast[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as Toast[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(h: Toast[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(h));
  } catch {
    // ignore quota / serialization failures
  }
}

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  history: loadHistory(),
  unreadCount: 0,

  push: ({ id, variant, title, message, action, duration, log = true, detail }) => {
    const key = id ?? nextId();
    // A repeat of a toast still on screen replaces it and counts up; it
    // doesn't stack another card or bump the unread count again.
    const prev = get().toasts.find((t) => t.id === key);
    const repeat = prev ? (prev.repeat ?? 1) + 1 : undefined;
    const item: Toast = { id: key, variant, title, message, action, detail, repeat, createdAt: Date.now() };
    let history = get().history;
    if (log) {
      history = [item, ...history.filter((t) => t.id !== item.id)].slice(0, MAX_HISTORY);
      saveHistory(history);
    }
    set((s) => ({
      toasts: [...s.toasts.filter((t) => t.id !== item.id), item],
      history,
      unreadCount: log && !prev ? s.unreadCount + 1 : s.unreadCount,
    }));
    const ms = duration ?? (variant === "error" ? 8000 : 4000);
    if (ms > 0)
      setTimeout(() => {
        // A replacement with the same id runs its own timer.
        if (get().toasts.some((t) => t === item)) get().dismiss(item.id);
      }, ms);
    return item.id;
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  markAllRead: () => set({ unreadCount: 0 }),
  clearHistory: () => {
    saveHistory([]);
    set({ history: [] });
  },
}));

// Call-from-anywhere helper (stores, ipc handlers, components).
const make =
  (variant: ToastVariant) =>
  (title: string, message?: string, action?: ToastAction, opts?: ToastOptions) =>
    useToasts.getState().push({ variant, title, message, action, ...opts });

export const toast = {
  info: make("info"),
  success: make("success"),
  error: make("error"),
  warning: make("warning"),
};

/** The full text "Copy details" puts on the clipboard: what failed, the
 *  message, the raw error, and when. */
export function toastDetails(t: Pick<Toast, "title" | "message" | "detail" | "createdAt">, version?: string | null): string {
  const lines = [t.title];
  if (t.message) lines.push(t.message);
  if (t.detail && t.detail !== t.message && !t.message?.includes(t.detail)) lines.push("", `Error: ${t.detail}`);
  lines.push("", `Time: ${new Date(t.createdAt).toISOString()}`);
  if (version) lines.push(`Faro ${version}`);
  return lines.join("\n");
}

/** Follow a toast's link: a settings section in-app, or an external URL. */
export function followToastAction(action: ToastAction): void {
  if (action.settings) {
    useLayout.getState().openSettings(action.settings);
    return;
  }
  if (action.connect) {
    // Loaded on demand: the connection stores import this one.
    const target = action.connect;
    void import("@/lib/linkTarget").then((m) => m.connectLinkTarget(target));
    return;
  }
  if (action.url) void ipc.openExternalUrl(action.url);
}
