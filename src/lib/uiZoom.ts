import { getCurrentWebview } from "@tauri-apps/api/webview";

// UI zoom (Settings → Appearance) rides the webview's native page zoom rather
// than CSS `zoom`: native zoom scales text, icons and layout together and keeps
// pointer coordinates / getBoundingClientRect consistent, so popovers and drag
// targets stay where they're drawn. Rust applies the saved value to the main
// window before first paint; this keeps it in sync at runtime and covers
// JS-spawned windows (popped-out terminals).
export function applyUiZoom(pct: number) {
  try {
    getCurrentWebview()
      .setZoom(pct / 100)
      .catch(() => {});
  } catch {
    // no Tauri runtime (mock / browser build) — ignore
  }
}
