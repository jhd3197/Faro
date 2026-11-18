import { ipc } from "@/lib/ipc";

/** Settings row the backend reads when it creates the main window, so the
 * native window paints the last theme's background instead of white. */
export const WINDOW_BACKGROUND_KEY = "windowBackground";

/** `rgb(13, 17, 23)` / `rgba(13, 17, 23, 1)` → `#0d1117`; null for anything
 * else, including transparent colours. */
export function cssColorToHex(css: string): string | null {
  const m = /^rgba?\(\s*(\d+)[,\s]\s*(\d+)[,\s]\s*(\d+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(css.trim());
  if (!m) return null;
  if (m[4] !== undefined) {
    const a = m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    if (!(a >= 1)) return null;
  }
  const parts = [m[1], m[2], m[3]].map(Number);
  if (parts.some((n) => n > 255)) return null;
  return "#" + parts.map((n) => n.toString(16).padStart(2, "0")).join("");
}

function injectedBackground(): string | null {
  const inj = (globalThis as { __FARO_SETTINGS__?: Record<string, unknown> }).__FARO_SETTINGS__;
  const v = inj?.[WINDOW_BACKGROUND_KEY];
  return typeof v === "string" ? v : null;
}

let last: string | null = injectedBackground();

/** Store the page's current background if it changed since the last write. */
export function rememberWindowBackground(): void {
  if (typeof document === "undefined") return;
  const hex = cssColorToHex(getComputedStyle(document.documentElement).backgroundColor);
  if (!hex || hex === last) return;
  last = hex;
  ipc.settingsSet(WINDOW_BACKGROUND_KEY, JSON.stringify(hex)).catch(() => {});
}
