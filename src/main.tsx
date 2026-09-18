import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TerminalWindow } from "./components/TerminalWindow";
import { useSettings } from "./stores/settingsStore";
import { applyAccent } from "./lib/accent";
import { startChineseTranslation } from "./lib/i18n";
import { sweepStalePopoutBuffers } from "./lib/popout";
import "./styles.css";

// This fork ships a Chinese UI while preserving Faro's original protocol and
// data behaviour. Translation runs at the DOM boundary because upstream UI
// copy is currently inline rather than extracted into locale files.
startChineseTranslation();

// Demo/screenshot build: expose the stores on window.__demo so the headless
// capture script can drive the UI. Stripped from normal builds.
if (import.meta.env.VITE_MOCK) {
  await import("./mock/demo");
}

// The main window's theme is set pre-paint by Rust's initialization script,
// which reads faro.db and sets `data-theme` before this bundle even loads
// (Plan 12 Phase 2) — so there's no FOUC. This is only a deterministic
// safety net: windows spawned from JS (popped-out terminals) get no injection,
// so set `data-theme` from the seeded store if it isn't already present.
if (!document.documentElement.getAttribute("data-theme")) {
  document.documentElement.setAttribute(
    "data-theme",
    useSettings.getState().appTheme
  );
}
// Apply any saved accent override on top of the theme's own accent. (Accent
// isn't part of the pre-paint injection; the store seeds it synchronously.)
applyAccent(useSettings.getState().accentColor || null);

// Keep the html data-theme in sync with the setting store. On an actual theme
// change, add `.theming` so the (otherwise dormant) crossfade transition runs,
// then drop it once the transition is done.
let prevTheme = useSettings.getState().appTheme;
let prevAccent = useSettings.getState().accentColor;
let themingTimer: ReturnType<typeof setTimeout> | undefined;
useSettings.subscribe((s) => {
  if (s.accentColor !== prevAccent) {
    prevAccent = s.accentColor;
    applyAccent(s.accentColor || null);
  }
  if (s.appTheme === prevTheme) return;
  prevTheme = s.appTheme;
  const el = document.documentElement;
  el.classList.add("theming");
  el.setAttribute("data-theme", s.appTheme);
  if (themingTimer) clearTimeout(themingTimer);
  themingTimer = setTimeout(() => el.classList.remove("theming"), 260);
});

// Secondary windows load this same SPA with `?view=…` (see lib/popout.ts):
// a popped-out terminal renders just the terminal view, not the app shell.
// No StrictMode there — its dev double-mount would close the adopted PTY.
const view = new URLSearchParams(window.location.search).get("view");
// Reap handoff buffers a crashed popout left behind — deferred so it stays off
// the first-paint path and so a reload during an in-flight handoff can't eat
// a buffer its popout hasn't read yet.
if (view !== "terminal") window.setTimeout(sweepStalePopoutBuffers, 10_000);

ReactDOM.createRoot(document.getElementById("root")!).render(
  view === "terminal" ? (
    <TerminalWindow />
  ) : (
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
);
