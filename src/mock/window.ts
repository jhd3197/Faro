// Mock of @tauri-apps/api/window for the demo build — just enough for the custom
// title bar's window controls (no-ops in a plain browser).
export function getCurrentWindow() {
  return {
    async isMaximized() {
      return false;
    },
    // Focus is controllable from tests via `window.__focused` (default: focused).
    // Falls back to the DOM's own notion of focus when the flag is unset.
    async isFocused() {
      const w = window as any;
      return typeof w.__focused === "boolean" ? w.__focused : document.hasFocus();
    },
    async setFocus() {
      (window as any).__focused = true;
    },
    async onResized() {
      return () => {};
    },
    async isFullscreen() {
      return !!(window as any).__fullscreen;
    },
    async setFullscreen(on: boolean) {
      (window as any).__fullscreen = on;
    },
    async minimize() {},
    async toggleMaximize() {},
    async close() {},
    async startDragging() {},
  };
}
