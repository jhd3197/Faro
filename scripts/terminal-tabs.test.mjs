// Terminal tab strip: middle-click close, reopen closed tab, tab jump and
// cycle keys, live drag reorder, overflow chevrons, the tab context menu,
// neighbour focus on close, and the transfer elapsed counter. Driven through
// the mock build (no Rust): `node --test scripts/terminal-tabs.test.mjs`.
//
// Starts `vite --mode mock` on TABS_PORT (default 1436) unless FARO_URL points
// at one already running. SHOT_DIR (default .shots/bruno-lessons/tabs)
// receives screenshots.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.TABS_PORT || 1436);
const URL = process.env.FARO_URL || `http://127.0.0.1:${PORT}/`;
const SHOTS = process.env.SHOT_DIR || path.join(ROOT, ".shots", "bruno-lessons", "tabs");
const isWin = process.platform === "win32";

async function load(rel) {
  const source = ts.transpileModule(readFileSync(path.join(ROOT, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const keys = await load("packages/file-ui/src/lib/keys.ts");

test("bracket chords keep the keycap name under Shift", () => {
  const ev = (o) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(keys.comboFromEvent(ev({ ctrlKey: true, shiftKey: true, key: "{", code: "BracketLeft" })), "mod+shift+[");
  assert.equal(keys.comboFromEvent(ev({ ctrlKey: true, shiftKey: true, key: "}", code: "BracketRight" })), "mod+shift+]");
  assert.equal(keys.comboFromEvent(ev({ ctrlKey: true, key: "9", code: "Digit9" })), "mod+9");
  assert.equal(keys.formatCombo("mod+shift+[", false), "Ctrl+Shift+[");
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

test("terminal tabs in the app", { timeout: 300_000, skip: !CHROME && "no Chrome/Edge" }, async (t) => {
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
    await page.waitForFunction(() => !!window.__demo.useConnections.getState().activeSessionId, { timeout: 15_000 });
    const shot = async (name) => {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };
    const demo = (fn, ...args) => page.evaluate(fn, ...args);
    await demo(() => window.__demo.useLayout.getState().closeDialog?.());

    const STRIP = "[data-term-tab-strip]";
    const titles = () =>
      page.$$eval(`${STRIP} [data-term-tab-id]`, (els) => els.map((e) => e.textContent.trim()));
    const activeTitle = () =>
      demo(() => {
        const s = window.__demo.useTerminals.getState();
        return s.tabs.find((x) => x.id === s.activeId)?.title ?? null;
      });
    const chip = async (title) => {
      const handles = await page.$$(`${STRIP} [data-term-tab-id]`);
      for (const h of handles) if ((await h.evaluate((e) => e.textContent.trim())) === title) return h;
      throw new Error(`no tab ${title}`);
    };
    // Reset to exactly n tabs named A, B, C… on the active session.
    const setup = async (n) => {
      await demo((n) => {
        const { useTerminals, useConnections, useLayout } = window.__demo;
        const sid = useConnections.getState().activeSessionId;
        const t = useTerminals.getState();
        t.closeTabs(t.tabs.filter((x) => x.sessionId === sid).map((x) => x.id));
        useTerminals.setState({ closed: [] });
        for (let i = 0; i < n; i++) {
          const tab = useTerminals.getState().openTab(sid);
          useTerminals.getState().renameTab(tab.id, String.fromCharCode(65 + i));
        }
        const first = useTerminals.getState().tabs.find((x) => x.sessionId === sid);
        useTerminals.getState().setActive(first.id);
        useLayout.getState().setTerminalOpen(true);
      }, n);
      await page.waitForFunction((n) => document.querySelectorAll("[data-term-tab-strip] [data-term-tab-id]").length === n, {}, n);
      await sleep(400);
    };
    const focusShell = async () => {
      await page.evaluate(() => {
        const box = [...document.querySelectorAll(".xterm")].find((x) => !x.closest('[aria-hidden="true"]'));
        box?.querySelector("textarea")?.focus();
      });
      await sleep(100);
    };
    const chord = async (mods, key) => {
      for (const m of mods) await page.keyboard.down(m);
      await page.keyboard.press(key);
      for (const m of [...mods].reverse()) await page.keyboard.up(m);
      await sleep(150);
    };

    await t.test("closing the active tab focuses its neighbour", async () => {
      await setup(4);
      await demo(() => {
        const t = window.__demo.useTerminals.getState();
        const b = t.tabs.find((x) => x.title === "B");
        t.setActive(b.id);
        t.closeTab(b.id);
      });
      assert.equal(await activeTitle(), "C", "right-hand neighbour");
      await demo(() => {
        const t = window.__demo.useTerminals.getState();
        const d = t.tabs.find((x) => x.title === "D");
        t.setActive(d.id);
        t.closeTab(d.id);
      });
      assert.equal(await activeTitle(), "C", "left when there's no right");
    });

    await t.test("middle-click closes a tab; reopen brings it back", async () => {
      await setup(3);
      const b = await (await chip("B")).boundingBox();
      await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
      await page.mouse.down({ button: "middle" });
      await page.mouse.up({ button: "middle" });
      await sleep(200);
      assert.deepEqual(await titles(), ["A", "C"]);
      await focusShell();
      await chord(["Control", "Alt"], "KeyT");
      await page.waitForFunction(() => document.querySelectorAll("[data-term-tab-strip] [data-term-tab-id]").length === 3);
      assert.deepEqual(await titles(), ["A", "C", "B"]);
      assert.equal(await activeTitle(), "B");
      // Stack is per session and empties: a second press finds nothing.
      await chord(["Control", "Alt"], "KeyT");
      assert.equal((await titles()).length, 3);
    });

    await t.test("tab jump, cycle with wrap, and move keys work from the shell", async () => {
      await setup(4);
      await focusShell();
      await chord(["Control"], "Digit3");
      assert.equal(await activeTitle(), "C");
      await chord(["Control"], "Digit9");
      assert.equal(await activeTitle(), "D", "Ctrl+9 = last");
      await chord(["Control", "Shift"], "BracketRight");
      assert.equal(await activeTitle(), "A", "next wraps to the first");
      await chord(["Control", "Shift"], "BracketLeft");
      assert.equal(await activeTitle(), "D", "previous wraps to the last");
      await chord(["Control"], "Digit7");
      assert.equal(await activeTitle(), "D", "a missing tab number is a no-op");
      assert.equal(await demo(() => window.__demo.useSettings.getState().uiZoom), 100, "zoom untouched");
      // Move: no default chord, so bind one and press it.
      await demo(() => window.__demo.useBindings.getState().setOverride("term-tab-move-left", "mod+alt+["));
      await sleep(200);
      await focusShell();
      await chord(["Control", "Alt"], "BracketLeft");
      assert.deepEqual(await titles(), ["A", "B", "D", "C"]);
      await demo(() => window.__demo.useBindings.getState().resetAll());
    });

    await t.test("context menu: close variants, no-ops disabled", async () => {
      await setup(3);
      const open = async (title) => {
        const b = await (await chip(title)).boundingBox();
        await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: "right" });
        await page.waitForSelector('[role="menu"]');
      };
      const state = () =>
        page.$$eval('[role="menuitem"]', (els) =>
          Object.fromEntries(els.map((e) => [e.textContent.replace(/Ctrl.*$/, "").trim(), e.disabled || e.getAttribute("aria-disabled") === "true"]))
        );
      await open("C");
      let s = await state();
      const labels = Object.keys(s);
      assert.deepEqual(labels.slice(-4), ["Close", "Close others", "Close to the right", "Close all"]);
      assert.equal(s["Close to the right"], true, "last tab: nothing to its right");
      assert.equal(s["Close others"], false);
      await sleep(300); // let the menu finish fading in
      await shot("tab-context-menu");
      await page.keyboard.press("Escape");
      await open("A");
      s = await state();
      assert.equal(s["Close to the right"], false);
      await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find((e) => e.textContent.trim() === "Close to the right").click());
      await sleep(200);
      assert.deepEqual(await titles(), ["A"]);
      await open("A");
      s = await state();
      assert.equal(s["Close others"], true, "single tab: no others");
      await page.keyboard.press("Escape");
    });

    await t.test("drag reorders tabs live; Esc puts the tab back", async () => {
      await setup(4);
      const a = await (await chip("A")).boundingBox();
      const c = await (await chip("C")).boundingBox();
      await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(a.x + a.width / 2 + ((c.x + c.width * 0.75 - a.x - a.width / 2) * i) / 10, a.y + a.height / 2);
        await sleep(30);
      }
      await sleep(150);
      assert.deepEqual(await titles(), ["B", "C", "A", "D"], "order changes while dragging");
      assert.ok(await page.$(`${STRIP} [data-dragging]`), "dragged tab is marked");
      await shot("tab-drag");
      await page.mouse.up();
      await sleep(150);
      assert.deepEqual(await titles(), ["B", "C", "A", "D"]);
      assert.equal(await activeTitle(), "A", "a drag isn't a click");
      // Esc cancels mid-drag.
      const d = await (await chip("D")).boundingBox();
      await page.mouse.move(d.x + d.width / 2, d.y + d.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(d.x + d.width / 2 - i * 25, d.y + d.height / 2);
        await sleep(30);
      }
      await sleep(150);
      assert.notDeepEqual(await titles(), ["B", "C", "A", "D"]);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await sleep(150);
      assert.deepEqual(await titles(), ["B", "C", "A", "D"]);
    });

    await t.test("overflow chevrons only when the strip overflows", async () => {
      await setup(3);
      assert.equal(await page.$("[data-strip-chevron]"), null, "no chevrons when everything fits");
      await setup(30);
      await page.waitForSelector('[data-strip-chevron="right"]');
      // Park the pointer away from the rail so its hover overlay folds back.
      await page.mouse.move(900, 300);
      await sleep(600);
      // Jump to the last tab: it scrolls into view.
      await focusShell();
      await chord(["Control"], "Digit9");
      await sleep(300);
      const vis = await page.evaluate(() => {
        const strip = document.querySelector("[data-term-tab-strip]");
        const active = strip.querySelector("[data-active]");
        const s = strip.getBoundingClientRect();
        const c = active.getBoundingClientRect();
        return { inView: c.left >= s.left - 1 && c.right <= s.right + 1, title: active.textContent.trim() };
      });
      assert.ok(vis.inView, "active tab scrolled into view");
      assert.equal(await page.$eval('[data-strip-chevron="right"]', (b) => b.disabled), true, "at the end");
      assert.equal(await page.$eval('[data-strip-chevron="left"]', (b) => b.disabled), false);
      await shot("tab-overflow-chevrons");
      const before = await page.$eval(STRIP, (s) => s.scrollLeft);
      await page.click('[data-strip-chevron="left"]');
      await sleep(800);
      const after = await page.$eval(STRIP, (s) => s.scrollLeft);
      assert.ok(after < before, `chevron scrolls the strip (${before} -> ${after})`);
      assert.equal(await page.$eval('[data-strip-chevron="right"]', (b) => b.disabled), false);
      await setup(2);
      assert.equal(await page.$("[data-strip-chevron]"), null, "chevrons go when it fits again");
    });

    await t.test("transfer elapsed time survives closing the panel", async () => {
      await demo(() => window.__demo.useTransfers.getState().setPanelOpen(true));
      await page.waitForSelector("[data-elapsed]");
      const read = () => page.$eval("[data-elapsed]", (e) => [e.textContent, getComputedStyle(e).fontVariantNumeric]);
      const [first, numeric] = await read();
      assert.match(numeric, /tabular-nums/);
      const secs = (txt) => {
        const m = txt.match(/(?:(\d+)m )?(\d+)s/);
        return Number(m[1] ?? 0) * 60 + Number(m[2]);
      };
      assert.ok(secs(first) >= 20, `counts from the stored start (${first})`);
      await demo(() => window.__demo.useTransfers.getState().setPanelOpen(false));
      await sleep(2200);
      await demo(() => window.__demo.useTransfers.getState().setPanelOpen(true));
      await page.waitForSelector("[data-elapsed]");
      const [again] = await read();
      assert.ok(secs(again) >= secs(first) + 2, `${first} -> ${again}`);
      await shot("transfer-elapsed");
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) {
      if (isWin) spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else try { process.kill(-server.pid, "SIGKILL"); } catch {}
    }
  }
});
