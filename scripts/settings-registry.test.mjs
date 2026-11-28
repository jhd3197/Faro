// Settings registry, Changed view, typo-tolerant search and palette access
// (Plan 37 Phase 1). The pure parts run in node; the rest drives the mock
// build: `node --test scripts/settings-registry.test.mjs`.
//
// Starts `vite --mode mock` on SETTINGS_REG_PORT (default 1448) unless
// FARO_URL points at one already running.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.UI_TEST_PORT || process.env.SETTINGS_REG_PORT || 1448);
const URL = process.env.FARO_URL || `http://127.0.0.1:${PORT}/`;
const isWin = process.platform === "win32";

async function load(rel) {
  const source = ts.transpileModule(readFileSync(path.join(ROOT, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const reg = await load("src/lib/settingsRegistry.ts");

test("every persisted setting is registered or marked internal", () => {
  const store = readFileSync(path.join(ROOT, "src/stores/settingsStore.ts"), "utf8");
  const block = /const DEFAULTS: Persisted = \{([\s\S]*?)\n\};/.exec(store);
  assert.ok(block, "found the DEFAULTS block");
  const keys = [...block[1].matchAll(/^  (\w+):/gm)].map((m) => m[1]);
  assert.ok(keys.length > 40, `parsed ${keys.length} keys`);
  const registered = new Set(reg.SETTINGS_REGISTRY.map((e) => e.key));
  const internal = new Set(reg.INTERNAL_SETTINGS);
  const missing = keys.filter((k) => !registered.has(k) && !internal.has(k));
  assert.deepEqual(missing, [], "add these to SETTINGS_REGISTRY or INTERNAL_SETTINGS");
  const unknown = [...registered, ...internal].filter((k) => !keys.includes(k));
  assert.deepEqual(unknown, [], "registered keys that are not settings");
  const both = [...registered].filter((k) => internal.has(k));
  assert.deepEqual(both, [], "a key is either a setting or internal");
  assert.equal(registered.size, reg.SETTINGS_REGISTRY.length, "no key is registered twice");
});

test("registry entries are well formed", () => {
  const nav = readFileSync(path.join(ROOT, "src/lib/settingsNav.ts"), "utf8");
  const sections = [...nav.matchAll(/\{ id: "(\w+)", group:/g)].map((m) => m[1]);
  for (const e of reg.SETTINGS_REGISTRY) {
    assert.ok(sections.includes(e.section), `${e.key}: unknown section ${e.section}`);
    assert.ok(e.label.length > 0, e.key);
    if (e.kind === "choice") assert.ok(e.options?.length >= 2, `${e.key}: a choice needs options`);
  }
});

test("search forgives one typo, but not short or unrelated queries", () => {
  const m = reg.looseMatch;
  assert.equal(m("Scrollback", "scroll"), true);
  assert.equal(m("Scrollback", "scrolback"), true, "a missing letter");
  assert.equal(m("Scrollback", "scrolllback"), true, "an extra letter");
  assert.equal(m("Scrollback", "scrollbark"), true, "a wrong letter");
  assert.equal(m("Copy on select", "selct"), true);
  assert.equal(m("Scrollback", "scrlbck"), false, "three letters off");
  assert.equal(m("Font", "fnt"), false, "short queries must match exactly");
  assert.equal(m("Font", "fon"), true);
  assert.equal(m("Bandwidth limit", "terminal"), false);
  assert.equal(m("anything", ""), true);
});

test("values read back as short labels, and 'changed' respects extra defaults", () => {
  const by = (k) => reg.settingEntry(k);
  assert.equal(reg.settingValueLabel(by("showHiddenFiles"), false), "Off");
  assert.equal(reg.settingValueLabel(by("overwritePolicy"), "rename"), "Keep both");
  assert.equal(reg.settingValueLabel(by("uiZoom"), 125), "125%");
  assert.equal(reg.settingValueLabel(by("defaultDownloadFolder"), ""), "System Downloads");
  assert.equal(reg.settingValueLabel(by("terminalHighlightRules"), [1, 2, 3]), "3 items");
  assert.equal(reg.isChangedValue("dark", "dark"), false);
  assert.equal(reg.isChangedValue("system", "dark", ["system"]), false);
  assert.equal(reg.isChangedValue("light", "dark", ["system"]), true);
  assert.equal(reg.isChangedValue([1], [1]), false, "compared by value");
});

test("times follow the Time format setting", { timeout: 60_000 }, async () => {
  const { createServer } = await import("vite");
  const server = await createServer({ mode: "mock", cacheDir: "node_modules/.vite-time-test", server: { middlewareMode: true }, appType: "custom" });
  try {
    const time = await server.ssrLoadModule("/src/lib/time.ts");
    const fmt = await server.ssrLoadModule("/src/lib/format.ts");
    const ui = await server.ssrLoadModule("/packages/file-ui/src/lib/format.ts");
    assert.equal(time.resolveHour12("12h", "de"), true, "forced 12-hour wins over the language");
    assert.equal(time.resolveHour12("24h", "en-US"), false);
    assert.equal(time.resolveHour12("auto", "en-US"), true, "US English writes AM/PM");
    assert.equal(time.resolveHour12("auto", "de"), false, "German uses the 24-hour clock");

    const afternoon = new Date(2024, 4, 21, 14, 5, 9);
    const midnight = new Date(2024, 4, 21, 0, 7, 0);
    const noon = new Date(2024, 4, 21, 12, 0, 0);
    time.setClock(false);
    assert.equal(time.fmtClock(afternoon), "14:05");
    assert.equal(time.fmtClock(afternoon, { seconds: true }), "14:05:09");
    assert.equal(time.fmtDateTime(afternoon.getTime()), "2024-05-21 14:05");
    assert.equal(fmt.fmtMtime(afternoon.getTime() / 1000), "2024-05-21 14:05");
    assert.equal(ui.fmtMtime(afternoon.getTime() / 1000), "2024-05-21 14:05");

    time.setClock(true);
    assert.equal(time.fmtClock(afternoon), "2:05 PM");
    assert.equal(time.fmtClock(midnight), "12:07 AM");
    assert.equal(time.fmtClock(noon), "12:00 PM");
    assert.equal(fmt.fmtMtime(afternoon.getTime() / 1000), "2024-05-21 2:05 PM");
    assert.equal(ui.fmtMtime(afternoon.getTime() / 1000), "2024-05-21 2:05 PM", "the file list follows too");
    assert.equal(time.fmtDateTime(0), "", "an unknown time is blank");
    assert.equal(fmt.fmtMtime(undefined), "");
    time.setClock(false);
  } finally {
    await server.close();
  }
});

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));

async function waitForServer(url, ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`mock server never came up at ${url}`);
}

test("changed settings, search and palette in the app", { timeout: 300_000, skip: !CHROME && "no Chrome/Edge" }, async (t) => {
  let server;
  if (!process.env.FARO_URL) {
    server = spawn("npx", ["vite", "--mode", "mock", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
      cwd: ROOT,
      shell: true,
      stdio: "ignore",
      detached: !isWin,
      env: { ...process.env, VITE_UI_LOCALE: "en" },
    });
  }
  let browser;
  try {
    await waitForServer(URL);
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      defaultViewport: { width: 1440, height: 900 },
      args: ["--hide-scrollbars", "--no-sandbox"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (let i = 0; i < 5; i++) {
      await page.goto(URL, { waitUntil: "networkidle0" });
      if (await page.waitForFunction(() => !!window.__demo, { timeout: 15_000 }).then(() => true, () => false)) break;
    }
    const demo = (fn, ...args) => page.evaluate(fn, ...args);
    await demo(() => window.__demo.useLayout.getState().closeDialog?.());
    const setting = (key) => demo((key) => window.__demo.useSettings.getState()[key], key);
    const openSettings = async () => {
      await demo(() => window.__demo.useLayout.getState().openSettings("appearance"));
      await page.waitForSelector("[data-settings-dialog]");
    };
    const closeSettings = async () => {
      await demo(() => window.__demo.useLayout.getState().closeDialog());
      await sleep(150);
    };
    const palette = async (text) => {
      await demo(() => window.__demo.useLayout.getState().setPaletteOpen(true));
      const input = await page.waitForSelector('input[placeholder^="Type a command"]');
      await input.click();
      await page.keyboard.type(text);
      await sleep(250);
    };

    // The mock starts with a few values already off their defaults; work from
    // whatever the count is.
    await openSettings();
    const countNow = async () => {
      const el = await page.$("[data-settings-changed-count]");
      return el ? Number(await el.evaluate((e) => e.textContent)) : 0;
    };
    const base = await countNow();

    await t.test("Changed lists a setting once it leaves its default, with a live control", async () => {
      await demo(() => {
        const s = window.__demo.useSettings.getState();
        s.setShowHiddenFiles(false);
        s.setOverwritePolicy("skip");
        s.setTerminalScrollback(10000);
      });
      await sleep(150);
      assert.equal(await countNow(), base + 3);
      await page.click("[data-settings-changed-view]");
      await page.waitForSelector("[data-changed-settings]");
      const keys = await page.$$eval("[data-changed-row]", (els) => els.map((e) => e.dataset.changedRow));
      for (const k of ["showHiddenFiles", "overwritePolicy", "terminalScrollback"]) assert.ok(keys.includes(k), `${k} in ${keys}`);
      // The toggle works from here.
      await page.click('[data-changed-row="showHiddenFiles"] [role="checkbox"]');
      await sleep(150);
      assert.equal(await setting("showHiddenFiles"), true, "back at its default");
      assert.equal(await page.$('[data-changed-row="showHiddenFiles"]'), null, "and gone from the list");
    });

    await t.test("Reset puts a value back to default, and Undo restores it", async () => {
      await page.click('[data-changed-reset="terminalScrollback"]');
      await sleep(150);
      assert.equal(await setting("terminalScrollback"), 5000);
      assert.ok(await page.$('[data-changed-undo="terminalScrollback"]'), "the row stays, with Undo");
      await page.click('[data-changed-undo="terminalScrollback"]');
      await sleep(150);
      assert.equal(await setting("terminalScrollback"), 10000);
      assert.ok(await page.$('[data-changed-reset="terminalScrollback"]'));
    });

    await t.test("Reset all asks first, then resets everything listed", async () => {
      await page.click("[data-changed-reset-all]");
      assert.equal(await setting("overwritePolicy"), "skip", "nothing happens before confirming");
      await page.click("[data-changed-reset-all-confirm]");
      await sleep(200);
      assert.equal(await setting("overwritePolicy"), "overwrite");
      assert.equal(await setting("terminalScrollback"), 5000);
      assert.equal(await countNow(), 0);
      // Each reset can still be undone.
      await page.click('[data-changed-undo="overwritePolicy"]');
      await sleep(150);
      assert.equal(await setting("overwritePolicy"), "skip");
      await demo(() => window.__demo.useSettings.getState().setOverwritePolicy("overwrite"));
    });

    await t.test("a setter with side effects is used when a setting is changed by key", async () => {
      // Theme mode resolves the theme as well: going through the setter is
      // what keeps the two in step.
      await demo(() => window.__demo.useSettings.getState().setThemeMode("light"));
      await sleep(150);
      await page.click("[data-settings-changed-view]");
      await page.waitForSelector('[data-changed-row="themeMode"]');
      await page.click('[data-changed-reset="themeMode"]');
      await sleep(200);
      const s = await demo(() => {
        const st = window.__demo.useSettings.getState();
        return { mode: st.themeMode, theme: st.appTheme, dark: st.darkTheme };
      });
      assert.equal(s.mode, "dark");
      assert.equal(s.theme, s.dark, "the resolved theme followed the mode");
    });

    await t.test("settings search finds a row despite a typo", async () => {
      await page.click("[data-settings-search]");
      await page.keyboard.type("scrolback");
      await sleep(300);
      const text = await page.$eval("[data-search-results]", (e) => e.innerText);
      assert.match(text, /Scrollback/);
      assert.doesNotMatch(text, /No settings match/);
      await page.click("[data-settings-search]", { count: 3 });
      await page.keyboard.type("zzqqxx");
      await sleep(300);
      assert.match(await page.$eval("[data-search-results]", (e) => e.innerText), /No settings match/);
      await closeSettings();
    });

    await t.test("the palette flips an on/off setting in place", async () => {
      assert.equal(await setting("terminalCopyOnSelect"), true);
      await palette("copy on select");
      const first = await page.$eval('[data-idx="0"]', (e) => e.textContent);
      assert.match(first, /Copy on select: turn off/);
      await page.keyboard.press("Enter");
      await sleep(250);
      assert.equal(await setting("terminalCopyOnSelect"), false);
      await palette("copy on select");
      assert.match(await page.$eval('[data-idx="0"]', (e) => e.textContent), /Copy on select: turn on/);
      await page.keyboard.press("Enter");
      await sleep(250);
      assert.equal(await setting("terminalCopyOnSelect"), true);
    });

    await t.test("the palette opens Settings searching for any other setting", async () => {
      await palette("setting scrollback");
      const rows = await page.$$eval("[data-idx]", (els) => els.map((e) => e.textContent));
      const at = rows.findIndex((r) => /Setting: Scrollback/.test(r));
      assert.ok(at >= 0, rows.slice(0, 5).join(" | "));
      for (let i = 0; i < at; i++) await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await page.waitForSelector("[data-settings-dialog]");
      await sleep(300);
      assert.equal(await page.$eval("[data-settings-search]", (e) => e.value), "Scrollback");
      assert.match(await page.$eval("[data-search-results]", (e) => e.innerText), /Scrollback/);
      await closeSettings();
    });

    await t.test("an empty palette doesn't list one entry per setting", async () => {
      // The two settings just run from the palette are in Recent; that is the
      // one place a setting may show without a query.
      await demo(() => {
        window.__demo.usePalette.setState({ recent: [] });
        window.__demo.useLayout.getState().setPaletteOpen(true);
      });
      await page.waitForSelector('input[placeholder^="Type a command"]');
      await sleep(200);
      const rows = await page.$$eval("[data-idx]", (els) => els.map((e) => e.textContent));
      assert.equal(rows.filter((r) => /^Setting: |: turn (on|off)/.test(r)).length, 0);
      await page.keyboard.press("Escape");
    });

    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await browser?.close();
    if (server) {
      if (isWin) spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-server.pid, "SIGTERM");
    }
  }
});
