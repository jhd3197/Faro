// Command palette and search boxes: recent commands + servers on an empty
// query, ANDed terms, keyword "why it matched", PageUp/PageDown/Home/End,
// footer keycaps, Esc clears then closes, the no-results server search, IME
// Enter, type-to-search in the snippets panel and icon picker, and real key
// hints in the no-connections state. Driven through the mock build (no Rust):
// `node --test scripts/palette.test.mjs`.
//
// Starts `vite --mode mock` on PALETTE_PORT (default 1437) unless FARO_URL
// points at one already running. SHOT_DIR (default
// .shots/bruno-lessons/palette) receives screenshots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PALETTE_PORT || 1437);
const URL = process.env.FARO_URL || `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOT_DIR || path.join(ROOT, ".shots", "bruno-lessons", "palette");
const isWin = process.platform === "win32";

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

test("palette and search boxes in the app", { timeout: 300_000, skip: !CHROME && "no Chrome/Edge" }, async (t) => {
  let server;
  if (!process.env.FARO_URL) {
    server = spawn("npx", ["vite", "--mode", "mock", "--port", String(PORT), "--strictPort"], {
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
    const boot = async () => {
      for (let i = 0; i < 5; i++) {
        await page.goto(URL, { waitUntil: "networkidle0" });
        if (await page.waitForFunction(() => !!window.__demo, { timeout: 15_000 }).then(() => true, () => false)) break;
      }
      await page.waitForFunction(() => !!window.__demo.useConnections.getState().activeSessionId, { timeout: 15_000 });
      await page.evaluate(() => window.__demo.useLayout.getState().closeDialog?.());
    };
    await boot();
    const shot = async (name) => {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };
    const demo = (fn, ...args) => page.evaluate(fn, ...args);
    const COMBO = '[aria-label="Command palette"] [role="combobox"]';
    const OPT = '[aria-label="Command palette"] [role="option"]';
    const openPalette = async () => {
      await demo(() => window.__demo.useLayout.getState().setPaletteOpen(true));
      await page.waitForSelector(COMBO);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.focus(COMBO);
    };
    const isOpen = () => demo(() => window.__demo.useLayout.getState().paletteOpen);
    const sections = () => page.$$eval("[data-palette-section]", (els) => els.map((e) => e.dataset.paletteSection));
    const ids = () => page.$$eval(OPT, (els) => els.map((e) => e.dataset.commandId ?? e.dataset.serverId ?? e.dataset.paletteSuggest));
    const activeIdx = () => page.$$eval(OPT, (els) => els.findIndex((e) => e.getAttribute("aria-selected") === "true"));
    const type = async (q) => {
      await page.click(COMBO, { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.keyboard.type(q);
      await sleep(100);
    };

    await t.test("empty query lists Recent, then Servers, with footer keys", async () => {
      await demo(() => window.__demo.usePalette?.getState().clearRecent());
      await openPalette();
      await type("Zoom In");
      await page.keyboard.press("Enter");
      await sleep(200);
      await openPalette();
      await type("Toggle Transfer Panel");
      await page.keyboard.press("Enter");
      await sleep(200);
      await demo(() => window.__demo.useTransfers.getState().togglePanel());
      await openPalette();
      assert.deepEqual((await sections()).slice(0, 2), ["Recent", "Servers"]);
      const list = await ids();
      assert.deepEqual(list.slice(0, 2), ["toggle-transfers", "zoom-in"], "most recent first");
      assert.ok(list[2].startsWith("connect:"), "servers follow");
      const footer = await page.$eval("[data-palette-footer]", (e) => e.textContent);
      for (const w of ["navigate", "jump", "run", "close"]) assert.ok(footer.includes(w), `footer has ${w}`);
      await shot("empty-query-recent-servers");
      // Persisted: survives a reload.
      await page.keyboard.press("Escape");
      await boot();
      await openPalette();
      assert.deepEqual((await ids()).slice(0, 2), ["toggle-transfers", "zoom-in"], "recent persisted");
      await demo(() => window.__demo.useSettings.getState().setUiZoom(100));
    });

    await t.test("disabled commands drop out of Recent", async () => {
      // Actual Size is disabled at 100% zoom.
      await demo(() => window.__demo.usePalette.getState().record("zoom-reset"));
      await page.keyboard.press("Escape");
      await openPalette();
      assert.ok(!(await ids()).slice(0, 3).includes("zoom-reset"));
    });

    await t.test("PageDown / PageUp / Home / End move the selection", async () => {
      assert.equal(await activeIdx(), 0);
      await page.keyboard.press("PageDown");
      assert.equal(await activeIdx(), 5);
      await page.keyboard.press("PageDown");
      assert.equal(await activeIdx(), 10);
      await page.keyboard.press("PageUp");
      assert.equal(await activeIdx(), 5);
      await page.keyboard.press("End");
      assert.equal(await activeIdx(), (await ids()).length - 1);
      await page.keyboard.press("ArrowDown");
      assert.equal(await activeIdx(), 0, "down wraps");
      await page.keyboard.press("End");
      await page.keyboard.press("Home");
      assert.equal(await activeIdx(), 0);
    });

    await t.test("terms are ANDed in any order", async () => {
      await type("panel transfer");
      assert.equal((await ids())[0], "toggle-transfers");
      await type("panel zzzz");
      assert.ok(!(await ids()).includes("toggle-transfers"));
    });

    await t.test("keyword matches say why", async () => {
      await type("systemd");
      const row = await page.$('[data-command-id="server-view"], [data-command-id^="settings:"]');
      assert.ok(row, "a keyword-only hit is listed");
      const why = await page.$$eval("[data-palette-why]", (els) => els.map((e) => e.textContent));
      assert.ok(why.some((w) => w.includes("matches: systemd")), JSON.stringify(why));
      await type("zoom bigger");
      const zoomRow = await page.$eval('[data-command-id="zoom-in"]', (e) => ({
        marks: [...e.querySelectorAll("mark")].map((m) => m.textContent).join(""),
        why: e.querySelector("[data-palette-why]")?.textContent,
      }));
      assert.equal(zoomRow.marks.toLowerCase(), "zoom", "title part highlighted");
      assert.equal(zoomRow.why, "matches: bigger");
      await shot("keyword-match");
    });

    await t.test("Esc clears the query first, then closes", async () => {
      await type("theme");
      await page.keyboard.press("Escape");
      assert.equal(await page.$eval(COMBO, (e) => e.value), "");
      assert.equal(await isOpen(), true);
      await page.keyboard.press("Escape");
      assert.equal(await isOpen(), false);
    });

    await t.test("no results offers a server search", async () => {
      await openPalette();
      const name = await demo(() => window.__demo.useConnections.getState().profiles[0].name);
      // A query no command carries but the loose server search finds.
      const host = await demo(() => window.__demo.useConnections.getState().profiles[0].host);
      const q = `${host.split(".")[0]}`;
      await type(`zq ${q}`);
      await page.waitForSelector("[data-palette-empty]");
      assert.deepEqual(await ids(), ["searchServers"]);
      const text = await page.$eval('[data-palette-suggest="searchServers"]', (e) => e.textContent);
      assert.ok(text.includes(`Search servers for “zq ${q}”`), text);
      await shot("no-results-suggestion");
      await page.keyboard.press("Enter");
      await sleep(100);
      assert.equal(await page.$eval(COMBO, (e) => e.getAttribute("aria-label")), "Search servers");
      await type(q);
      const servers = await ids();
      assert.ok(servers.length >= 1, `servers listed for ${q}`);
      assert.ok(await page.$eval("[data-server-id]", (e) => e.textContent).then((t) => t.length > 0));
      await shot("server-search");
      await page.keyboard.press("Escape");
      assert.equal(await page.$eval(COMBO, (e) => e.getAttribute("aria-label")), "Search commands", "Esc goes back");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
      assert.equal(await isOpen(), false);
      void name;
    });

    await t.test("Enter while an IME is composing does nothing", async () => {
      await openPalette();
      await type("Zoom In");
      await page.$eval(COMBO, (el) => {
        el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true, keyCode: 229 }));
      });
      await sleep(150);
      assert.equal(await isOpen(), true, "palette stayed open");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    });

    await t.test("snippets panel: type to search and two empty states", async () => {
      await demo(() => window.__demo.useSnippets.getState().openPanel());
      await page.waitForSelector('input[aria-label="Search snippets"]');
      await page.evaluate(() => document.activeElement?.blur());
      await page.keyboard.type("zzqq");
      await sleep(100);
      assert.equal(await page.$eval('input[aria-label="Search snippets"]', (e) => e.value), "zzqq");
      const msg = await page.$eval("[data-snippets-no-match]", (e) => e.textContent);
      assert.ok(msg.includes("No snippets match “zzqq”"), msg);
      await shot("snippets-no-match");
      await page.keyboard.press("Escape");
      assert.equal(await page.$eval('input[aria-label="Search snippets"]', (e) => e.value), "", "first Esc clears");
      await page.keyboard.press("Escape");
      await sleep(100);
      assert.equal(await demo(() => window.__demo.useSnippets.getState().open), false);
    });

    await t.test("icon picker: type to search from a cell, Esc clears first", async () => {
      await demo(() => window.__demo.useLayout.getState().openNewConnection());
      await page.waitForSelector('button[aria-label="Choose connection icon"]');
      await page.click('button[aria-label="Choose connection icon"]');
      const SEARCH = '[aria-label="Pick a bubble icon"] input';
      await page.waitForSelector(SEARCH);
      await page.focus('[aria-label="Pick a bubble icon"] button[aria-label="Close"]');
      await page.keyboard.type("lin");
      await sleep(100);
      assert.equal(await page.$eval(SEARCH, (e) => e.value), "lin");
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), "INPUT");
      await page.keyboard.press("Escape");
      assert.equal(await page.$eval(SEARCH, (e) => e.value), "", "first Esc clears");
      await page.keyboard.press("Escape");
      await sleep(100);
      assert.equal(await page.$(SEARCH), null, "second Esc closes");
      await demo(() => window.__demo.useLayout.getState().closeDialog?.());
      await sleep(200);
    });

    await t.test("no connections shows the real keys", async () => {
      await demo(() => window.__demo.useBindings.getState().setOverride("new-connection", "mod+shift+n"));
      await demo(() => {
        const c = window.__demo.useConnections;
        c.setState({ profiles: [], sessions: [], activeSessionId: null, activeProfileId: null });
      });
      await page.waitForSelector("[data-no-connections] [data-key-hint]");
      const hint = await page.$eval("[data-no-connections] [data-key-hint]", (e) => e.textContent);
      assert.equal(hint, "Ctrl+Shift+N", "follows the override");
      const pal = await page.$eval("[data-palette-hint]", (e) => e.textContent);
      assert.ok(pal.includes("Ctrl+K"), pal);
      await demo(() => window.__demo.useBindings.getState().resetAll());
      await sleep(100);
      assert.equal(await page.$eval("[data-no-connections] [data-key-hint]", (e) => e.textContent), "Ctrl+N");
      await shot("no-connections-keys");
      await demo(() => window.__demo.useBindings.getState().setEnabled(false));
      await sleep(100);
      assert.equal(await page.$("[data-no-connections] [data-key-hint]"), null, "no hints with shortcuts off");
      await demo(() => window.__demo.useBindings.getState().setEnabled(true));
    });

    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await browser?.close();
    if (server) {
      if (isWin) spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-server.pid);
    }
  }
});
