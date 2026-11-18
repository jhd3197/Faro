import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { test } from "node:test";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

// Settings UX: Light/Dark/System mode with its own pick per side, theme
// preview cards, a fallback for unknown themes, the zoom reset, nav dots,
// blur-time validation, dependent settings, debounced text, Storage cache
// cards and the "Change in Settings" links.
//
// SETTINGS_UX_PORT picks the mock server port (default 1435);
// SETTINGS_UX_SHOTS saves screenshots to that folder.

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p) => p && existsSync(p));

const PORT = Number(process.env.SETTINGS_UX_PORT || 1435);
const SHOTS = process.env.SETTINGS_UX_SHOTS;

test("settings ux", { timeout: 180000 }, async () => {
  assert.ok(CHROME, "Install Chrome/Chromium or set CHROME_PATH");
  process.env.VITE_UI_LOCALE = "en";
  const server = await createServer({
    mode: "mock",
    // No HMR or file watching: edits elsewhere in the checkout must not
    // reload the page mid-test.
    server: { host: "127.0.0.1", port: PORT, strictPort: true, hmr: false, watch: { ignored: ["**/*"] } },
  });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox"],
      defaultViewport: { width: 1400, height: 900 },
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);

    const url = `http://127.0.0.1:${PORT}/`;
    const boot = async () => {
      for (let i = 0; i < 5; i++) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
        try {
          await page.waitForFunction(
            () => window.__demo?.useSettings && document.body.innerText.includes("Faro"),
            { timeout: 20000 },
          );
          return;
        } catch {
          // Vite's first dependency scan can reload the page; try again.
        }
      }
      throw new Error("demo never booted");
    };
    const shot = async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      // Let the theme crossfade finish so the capture isn't mid-fade.
      await page.waitForFunction(() => !document.documentElement.classList.contains("theming"));
      await new Promise((r) => setTimeout(r, 350));
      await page.screenshot({ path: `${SHOTS}/${name}.png` });
    };
    const settings = () => page.evaluate(() => {
      const s = window.__demo.useSettings.getState();
      return {
        appTheme: s.appTheme,
        themeMode: s.themeMode,
        lightTheme: s.lightTheme,
        darkTheme: s.darkTheme,
        uiZoom: s.uiZoom,
        transferConcurrency: s.transferConcurrency,
        transferThrottleKbps: s.transferThrottleKbps,
        defaultDownloadFolder: s.defaultDownloadFolder,
      };
    });
    const htmlTheme = () => page.evaluate(() => document.documentElement.dataset.theme);
    const waitTheme = (t) =>
      page.waitForFunction((t) => document.documentElement.dataset.theme === t, { timeout: 5000 }, t);
    const openSection = async (section) => {
      await page.evaluate((s) => window.__demo.useLayout.getState().openSettings(s), section);
      await page.waitForFunction(
        (s) => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === s,
        {},
        section,
      );
    };
    const clickText = (sel, text) =>
      page.evaluate(
        (sel, text) => {
          const el = [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === text);
          if (!el) throw new Error(`no ${sel} "${text}"`);
          el.click();
        },
        sel,
        text,
      );
    const dots = () =>
      page.$$eval("[data-settings-section]", (els) =>
        els.filter((e) => e.querySelector("[data-settings-changed]")).map((e) => e.dataset.settingsSection),
      );

    await boot();

    // --- Mode: Dark shows only the dark picks; System shows both and follows the OS.
    assert.equal((await settings()).themeMode, "dark");
    assert.equal(await htmlTheme(), "dark");
    await openSection("appearance");
    assert.deepEqual(
      await page.$$eval("[role=radiogroup]", (els) => els.map((e) => e.getAttribute("aria-label"))),
      ["Dark theme"],
    );
    // (The demo's Agent Bridge policy auto-approves reads, so that one is on.)
    assert.deepEqual(await dots(), ["bridge"], "untouched settings show no dots");

    await clickText("[data-settings-focus='settings-theme-mode'] button", "System");
    await waitTheme("light");
    assert.deepEqual(
      await page.$$eval("[role=radiogroup]", (els) => els.map((e) => e.getAttribute("aria-label"))),
      ["Light theme", "Dark theme"],
    );
    // Cards are drawn in their own theme's colors.
    const previewBg = await page.$$eval("[data-theme-card] [data-theme]", (els) =>
      Object.fromEntries(els.map((e) => [e.dataset.theme, getComputedStyle(e).backgroundColor])),
    );
    assert.notEqual(previewBg.nord, previewBg.light);
    assert.notEqual(previewBg.dracula, previewBg.dark);

    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await waitTheme("dark");
    assert.equal((await settings()).appTheme, "dark");

    // --- Keyboard: arrows move the selection inside the Dark theme cards.
    await page.focus("[aria-label='Dark theme'] [aria-checked='true']");
    await page.keyboard.press("ArrowRight");
    await waitTheme("tokyo");
    assert.equal((await settings()).darkTheme, "tokyo");
    assert.equal(
      await page.$eval("[aria-label='Dark theme'] [aria-checked='true']", (e) => e.dataset.themeCard),
      "tokyo",
    );
    assert.equal(
      await page.evaluate(() => document.activeElement?.dataset.themeCard),
      "tokyo",
      "focus follows the selection",
    );
    await page.keyboard.press("End");
    await waitTheme("github-dark");
    await page.keyboard.press("Home");
    await waitTheme("dark");
    await page.keyboard.press("ArrowRight");
    await waitTheme("tokyo");
    // The OS going light switches to the light pick; dark comes back to tokyo.
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await waitTheme("light");
    await page.evaluate(() =>
      document.querySelector("[data-theme-card='github-light']").click(),
    );
    await waitTheme("github-light");
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await waitTheme("tokyo");
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await waitTheme("github-light");
    await page.evaluate(() => document.querySelector("[data-settings-heading]")
      ?.closest(".flex-col")?.querySelector(".overflow-y-auto")?.scrollTo(0, 0));
    await shot("theme-cards-system");

    // The title-bar toggle flips sides and leaves System.
    await page.evaluate(() => window.__demo.useSettings.getState().toggleLightDark());
    await waitTheme("tokyo");
    assert.equal((await settings()).themeMode, "dark");
    assert.ok((await dots()).includes("appearance"), "changed theme puts a dot on Appearance");

    // --- Zoom reset only when zoom != 100%.
    assert.equal(await page.$("[data-zoom-reset]"), null);
    await page.evaluate(() => window.__demo.useSettings.getState().setUiZoom(125));
    await page.waitForSelector("[data-zoom-reset]");
    await page.click("[data-zoom-reset]");
    await page.waitForFunction(() => !document.querySelector("[data-zoom-reset]"));
    assert.equal((await settings()).uiZoom, 100);

    // --- Validation only after blur, naming the field.
    await page.click("[data-settings-section='transfers']");
    const conc = "[data-settings-focus='settings-transfer-concurrency'] input";
    await page.click(conc, { clickCount: 3 });
    await page.keyboard.type("40");
    assert.equal(await page.$("[data-settings-error]"), null, "no error while typing");
    assert.equal((await settings()).transferConcurrency, 3, "invalid value isn't saved");
    await page.click("[data-settings-heading]"); // leave the field
    await page.waitForSelector("[data-settings-error]");
    assert.equal(
      await page.$eval("[data-settings-error]", (e) => e.textContent),
      "Concurrent transfers must be 1–32",
    );
    assert.equal(await page.$eval(conc, (e) => e.getAttribute("aria-invalid")), "true");
    await shot("blur-validation");
    await page.click(conc, { clickCount: 3 });
    await page.keyboard.type("5");
    await page.waitForFunction(() => !document.querySelector("[data-settings-error]"));
    // Saved after a short pause, without leaving the field.
    await page.waitForFunction(
      () => window.__demo.useSettings.getState().transferConcurrency === 5,
      { timeout: 3000 },
    );
    assert.ok((await dots()).includes("transfers"));

    // --- Dependent setting: the limit is indented under its switch, off until on.
    const limitInput = "[data-settings-dependent] input[aria-label='Bandwidth limit']";
    assert.equal(await page.$eval(limitInput, (e) => e.disabled), true);
    await page.evaluate(() =>
      document.querySelector("button[role=switch][aria-label='Limit bandwidth']").click(),
    );
    await page.waitForFunction((sel) => !document.querySelector(sel).disabled, {}, limitInput);
    assert.equal((await settings()).transferThrottleKbps, 1024);

    // --- Debounced text: saved after a pause, and at once when leaving.
    const folder = "[data-settings-focus='settings-download-folder']";
    await page.click(folder);
    await page.keyboard.type("D:/dl");
    assert.equal((await settings()).defaultDownloadFolder, "", "not saved per keystroke");
    await page.waitForFunction(
      () => window.__demo.useSettings.getState().defaultDownloadFolder === "D:/dl",
      { timeout: 3000 },
    );
    await page.click(folder);
    await page.keyboard.type("/x");
    await page.click("[data-settings-section='connections']");
    assert.equal((await settings()).defaultDownloadFolder, "D:/dl/x", "leaving flushes");

    const port = "input[aria-label='Default port']";
    await page.click(port, { clickCount: 3 });
    await page.keyboard.type("70000");
    await page.keyboard.press("Tab");
    await page.waitForSelector("[data-settings-error]");
    assert.equal(
      await page.$eval("[data-settings-error]", (e) => e.textContent),
      "Default port must be 1–65535",
    );
    await shot("nav-dots");

    // --- Storage: live sizes, Clear frees one and toasts.
    await page.click("[data-settings-section='storage']");
    await page.waitForFunction(
      () => document.querySelectorAll("[data-cache-card] [data-cache-size]").length === 3 &&
        ![...document.querySelectorAll("[data-cache-size]")].some((e) => e.textContent === "…"),
    );
    const sizes = await page.$$eval("[data-cache-card]", (els) =>
      Object.fromEntries(els.map((e) => [e.dataset.cacheCard, e.querySelector("[data-cache-size]").textContent])),
    );
    assert.match(sizes.thumbnails, /MB · 1,204 files/);
    assert.match(sizes.transferResume, /2 transfers/);
    await shot("cache-cards");
    await page.evaluate(() => {
      const b = document.querySelector("[data-cache-card='thumbnails'] button");
      b.click();
    });
    await page.waitForFunction(
      () => document.querySelector("[data-cache-card='thumbnails'] [data-cache-size]").textContent === "Empty",
    );
    assert.equal(
      await page.$eval("[data-cache-card='thumbnails'] button", (b) => b.disabled),
      true,
    );
    const toasts = await page.evaluate(() =>
      window.__demo.useToasts.getState().toasts.map((t) => `${t.title}|${t.message ?? ""}`),
    );
    assert.ok(toasts.some((t) => /^Thumbnails cleared\|Freed /.test(t)), toasts.join(", "));
    await shot("cache-cleared");

    // --- "Change in Settings" from the transfer panel lands on the field.
    await clickText("button", "Done");
    await page.waitForFunction(() => !window.__demo.useLayout.getState().dialog);
    await page.evaluate(() => window.__demo.useTransfers.getState().setPanelOpen(true));
    await page.waitForSelector("[data-transfer-settings-link]");
    await page.click("[data-transfer-settings-link]");
    await page.waitForFunction(
      () => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === "transfers",
    );
    await page.waitForFunction(
      () => document.activeElement?.closest("[data-settings-focus='settings-transfer-concurrency']"),
    );
    await clickText("button", "Done");
    await page.waitForFunction(() => !window.__demo.useLayout.getState().dialog);

    // --- An unknown saved theme falls back with exactly one toast.
    await page.evaluate(() => {
      const raw = JSON.parse(sessionStorage.getItem("faro-mock-discovery") ?? "{}");
      raw.appTheme = JSON.stringify("neon-dreams");
      sessionStorage.setItem("faro-mock-discovery", JSON.stringify(raw));
    });
    await boot();
    await page.waitForFunction(
      () => window.__demo.useToasts.getState().toasts.some((t) => t.title === "Theme not found"),
      { timeout: 5000 },
    );
    await new Promise((r) => setTimeout(r, 500));
    const fallback = await page.evaluate(() =>
      window.__demo.useToasts.getState().toasts.filter((t) => t.title === "Theme not found"),
    );
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].id, "settings-theme-fallback");
    assert.match(fallback[0].message, /neon-dreams/);
    assert.equal(await htmlTheme(), "dark");
    await shot("theme-fallback-toast");
    await page.evaluate(() => {
      const raw = JSON.parse(sessionStorage.getItem("faro-mock-discovery") ?? "{}");
      delete raw.appTheme;
      sessionStorage.setItem("faro-mock-discovery", JSON.stringify(raw));
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
