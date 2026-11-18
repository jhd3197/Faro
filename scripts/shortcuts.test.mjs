// Keyboard shortcuts, inline rename and live menu hints, driven through the
// mock build (no Rust): `node --test scripts/shortcuts.test.mjs`.
//
// Starts `vite --mode mock` on SHORTCUTS_PORT (default 1431) unless FARO_URL
// points at one already running. SHOT_DIR (default .shots/bruno-lessons/
// shortcuts) receives screenshots of the recorder error, the inline renames
// and a context menu with live hints.
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
const PORT = Number(process.env.SHORTCUTS_PORT || 1431);
const URL = process.env.FARO_URL || `http://127.0.0.1:${PORT}/`;
const SHOTS = process.env.SHOT_DIR || path.join(ROOT, ".shots", "bruno-lessons", "shortcuts");
const isWin = process.platform === "win32";

// ---- pure rules (no browser) ----------------------------------------------

async function load(rel) {
  const source = ts.transpileModule(readFileSync(path.join(ROOT, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const keys = await load("packages/file-ui/src/lib/keys.ts");
const rules = await load("src/lib/comboRules.ts");

test("labels are OS-native", () => {
  assert.equal(keys.formatCombo("mod+shift+w", false), "Ctrl+Shift+W");
  assert.equal(keys.formatCombo("mod+alt+shift+w", false), "Ctrl+Alt+Shift+W");
  assert.equal(keys.formatCombo("delete", false), "Delete");
  assert.equal(keys.formatCombo("alt+arrowleft", false), "Alt+←");
  assert.equal(keys.formatCombo("f2", false), "F2");
  // macOS: ⌃⌥⇧⌘ order, no separators.
  assert.equal(keys.formatCombo("mod+shift+w", true), "⇧⌘W");
  assert.equal(keys.formatCombo("mod+alt+shift+k", true), "⌥⇧⌘K");
  assert.equal(keys.formatCombo("mod+\\", false), "Ctrl+\\");
});

test("letters and digits come from the physical key", () => {
  const ev = (o) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...o });
  assert.equal(keys.comboFromEvent(ev({ altKey: true, key: "≈", code: "KeyX" })), "alt+x");
  assert.equal(keys.comboFromEvent(ev({ ctrlKey: true, shiftKey: true, key: "!", code: "Digit1" })), "mod+shift+1");
  assert.equal(keys.comboFromEvent(ev({ ctrlKey: true, key: "\\", code: "Backslash" })), "mod+\\");
  assert.equal(keys.comboFromEvent(ev({ key: "F2", code: "F2" })), "f2");
});

test("the recorder rules", () => {
  const v = (c, o = {}) => rules.validateCombo(c, { mac: false, label: (x) => keys.formatCombo(x, false), ...o });
  assert.equal(v("mod+k"), null);
  assert.equal(v("f5"), null);
  assert.equal(v("delete"), null);
  assert.equal(v("k")?.code, "needs-modifier");
  assert.match(v("k").message, /Add a modifier/);
  assert.equal(v("mod+shift+")?.code, "modifiers-only");
  assert.match(v("mod+shift+").message, /Add a non-modifier key \(e\.g\. Ctrl\+K\)/);
  assert.equal(v("alt+f4")?.code, "reserved");
  assert.match(v("alt+f4").message, /Alt\+F4 is reserved/);
  assert.equal(v("mod+alt+delete")?.code, "reserved");
  assert.equal(v("mod+l", { windowsKey: true })?.code, "reserved");
  assert.equal(v("mod+alt+shift+k")?.code, "too-many-keys");
  const mac = (c) => rules.validateCombo(c, { mac: true, label: (x) => keys.formatCombo(x, true) });
  for (const c of ["mod+h", "mod+m", "mod+q", "mod+space", "mod+tab", "mod+shift+3", "mod+shift+4", "mod+shift+5"]) {
    assert.equal(mac(c)?.code, "reserved", c);
  }
  assert.equal(mac("mod+l"), null);
});

// ---- the running UI --------------------------------------------------------

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

test("shortcuts in the app", { timeout: 300_000, skip: !CHROME && "no Chrome/Edge" }, async (t) => {
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
    const shot = async (name) => {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };
    const demo = (fn, ...args) => page.evaluate(fn, ...args);
    await demo(() => {
      window.__demo.useSettings.getState().setRailExpanded(true);
      window.__demo.useLayout.getState().closeDialog?.();
    });
    await demo(() => window.__demo.focusProfile("p-api"));
    const pane = '[data-file-pane]';
    await page.waitForSelector(`${pane} [data-idx="0"]`);
    const rowText = (i) => page.$eval(`${pane} [data-idx="${i}"]`, (e) => e.textContent);
    const focusRow = async (i) => {
      await page.click(`${pane} [data-idx="${i}"]`);
    };

    await t.test("F2 renames a file row in place", async () => {
      // A file (not a folder): pick the last row.
      const n = await page.$$eval(`${pane} [data-idx]`, (r) => r.length);
      await focusRow(n - 1);
      const name = (await rowText(n - 1)).trim();
      await page.keyboard.press("F2");
      await page.waitForSelector(`${pane} input[data-inline-rename]`);
      const sel = await page.$eval(`${pane} input[data-inline-rename]`, (i) => [i.value, i.selectionStart, i.selectionEnd]);
      assert.equal(sel[0].length > 0, true);
      assert.equal(sel[1], 0, "text starts selected");
      assert.ok(sel[2] > 0 && sel[2] <= sel[0].length, `selection ${sel}`);
      // Invalid name: the error stays inline and the editor stays open.
      await page.keyboard.type("bad/name");
      await page.keyboard.press("Enter");
      await page.waitForSelector(`${pane} [role="alert"]`);
      assert.match(await page.$eval(`${pane} [role="alert"]`, (e) => e.textContent), /can't contain/);
      await shot("inline-rename-file-row");
      // Esc cancels without touching the selection.
      await page.keyboard.press("Escape");
      await page.waitForSelector(`${pane} input[data-inline-rename]`, { hidden: true });
      assert.equal(await page.$$eval(`${pane} [aria-selected="true"]`, (r) => r.length), 1);
      // Unchanged name: Enter is a quiet no-op.
      await page.keyboard.press("F2");
      await page.waitForSelector(`${pane} input[data-inline-rename]`);
      await page.keyboard.press("Enter");
      await page.waitForSelector(`${pane} input[data-inline-rename]`, { hidden: true });
      assert.equal((await rowText(n - 1)).trim(), name);
      assert.equal(await page.$(`${pane} [role="dialog"]`), null, "no rename dialog");
    });

    await t.test("context menus show live hints and run a pressed shortcut", async () => {
      const openMenu = async () => {
        const box = await (await page.waitForSelector(`${pane} [aria-selected="true"]`)).boundingBox();
        await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: "right" });
        await page.waitForSelector('[role="menu"]');
      };
      await openMenu();
      const hintFor = (label) =>
        page.evaluate((label) => {
          const b = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.startsWith(label));
          return b ? b.textContent.slice(label.length).trim() : null;
        }, label);
      assert.equal(await hintFor("Rename"), "F2");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[role="menu"]', { hidden: true });
      // Rebind: the menu follows.
      await demo(() => window.__demo.useBindings.getState().setOverride("fb.rename", "mod+shift+e"));
      await openMenu();
      assert.equal(await hintFor("Rename"), "Ctrl+Shift+E");
      await shot("context-menu-live-hints");
      // Pressing the shortcut while the menu is open runs it and closes it.
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.press("KeyE");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      await page.waitForSelector('[role="menu"]', { hidden: true });
      await page.waitForSelector(`${pane} input[data-inline-rename]`);
      await page.keyboard.press("Escape");
      await demo(() => window.__demo.useBindings.getState().clearOverride("fb.rename"));
    });

    await t.test("the master switch turns every shortcut and hint off", async () => {
      await demo(() => window.__demo.useBindings.getState().setEnabled(false));
      await focusRow(0);
      await page.keyboard.press("F2");
      await sleep(150);
      assert.equal(await page.$(`${pane} input[data-inline-rename]`), null);
      const before = await demo(() => window.__demo.useTransfers.getState().panelOpen);
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyT");
      await page.keyboard.up("Control");
      assert.equal(await demo(() => window.__demo.useTransfers.getState().panelOpen), before);
      const box = await (await page.$(`${pane} [data-idx="0"]`)).boundingBox();
      await page.mouse.click(box.x + 40, box.y + box.height / 2, { button: "right" });
      await page.waitForSelector('[role="menu"]');
      const rename = await page.evaluate(() =>
        [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.startsWith("Rename"))?.textContent.trim()
      );
      assert.equal(rename, "Rename", "no hint while off");
      await page.keyboard.press("Escape");
      await demo(() => window.__demo.useBindings.getState().setEnabled(true));
    });

    await t.test("Alt+←/→, Ctrl+L, Ctrl+F and Esc layers in the file pane", async () => {
      const start = await page.$eval(pane, (e) => e.getAttribute("data-file-path"));
      // Open the first folder.
      await page.click(`${pane} [data-idx="0"]`, { clickCount: 2 });
      await page.waitForFunction((p, s) => document.querySelector(p).getAttribute("data-file-path") !== s, {}, pane, start);
      await page.focus(pane);
      await page.keyboard.down("Alt");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.up("Alt");
      await page.waitForFunction((p, s) => document.querySelector(p).getAttribute("data-file-path") === s, {}, pane, start);
      await page.keyboard.down("Alt");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.up("Alt");
      await page.waitForFunction((p, s) => document.querySelector(p).getAttribute("data-file-path") !== s, {}, pane, start);
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyL");
      await page.keyboard.up("Control");
      await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Folder path");
      await page.keyboard.press("Escape");
      await page.focus(pane);
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyF");
      await page.keyboard.up("Control");
      await page.waitForFunction(() => document.activeElement?.hasAttribute("data-pane-filter"));
      await page.keyboard.type("zz");
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement.value), "", "first Esc clears the text");
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute("data-pane-filter")), true);
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => document.activeElement.hasAttribute("data-file-pane")), true, "second Esc leaves the box");
    });

    await t.test("Ctrl+\\ collapses and expands the rail", async () => {
      const before = await demo(() => window.__demo.useSettings.getState().railExpanded);
      await page.keyboard.down("Control");
      await page.keyboard.press("Backslash");
      await page.keyboard.up("Control");
      assert.equal(await demo(() => window.__demo.useSettings.getState().railExpanded), !before);
      await page.keyboard.down("Control");
      await page.keyboard.press("Backslash");
      await page.keyboard.up("Control");
      assert.equal(await demo(() => window.__demo.useSettings.getState().railExpanded), before);
    });

    await t.test("a key a focused field already handled doesn't fire globally", async () => {
      await page.evaluate(() => {
        const i = document.createElement("input");
        i.id = "prevent-probe";
        i.addEventListener("keydown", (e) => e.preventDefault());
        document.body.appendChild(i);
        i.focus();
      });
      const before = await demo(() => window.__demo.useTransfers.getState().panelOpen);
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyT");
      await page.keyboard.up("Control");
      assert.equal(await demo(() => window.__demo.useTransfers.getState().panelOpen), before);
      await page.evaluate(() => document.getElementById("prevent-probe").remove());
    });

    await t.test("rail: F2 renames a server's name in place; / searches; Esc peels", async () => {
      await demo(() => window.__demo.useSettings.getState().setRailExpanded(true));
      const bubble = '[data-rail-profile-id="p-db"] button';
      await page.waitForSelector(bubble);
      await page.focus(bubble);
      await page.keyboard.press("F2");
      await page.waitForSelector('[data-rail-profile-id="p-db"] input[data-inline-rename]');
      await page.keyboard.type("db-renamed");
      await shot("inline-rename-server-bubble");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        window.__demo.useConnections.getState().profiles.find((p) => p.id === "p-db")?.name === "db-renamed"
      );
      assert.equal(await page.$('[role="dialog"]'), null, "the full editor stayed closed");
      // Menu: Rename carries the live F2 hint, Edit… opens the full editor.
      const box = await (await page.$(bubble)).boundingBox();
      await page.mouse.click(box.x + 20, box.y + 20, { button: "right" });
      await page.waitForSelector('[role="menu"]');
      const items = await page.$$eval('[role="menuitem"]', (b) => b.map((x) => x.textContent.trim()));
      assert.ok(items.includes("RenameF2"), items.join(" | "));
      assert.ok(items.includes("Edit…"), items.join(" | "));
      await page.keyboard.press("Escape");
      // "/" opens search; Esc clears the query, then closes.
      await page.focus(pane);
      await page.keyboard.press("Slash");
      await page.waitForSelector('input[aria-label="Search servers"]');
      await page.keyboard.type("api");
      await page.keyboard.press("Escape");
      assert.equal(await page.$eval('input[aria-label="Search servers"]', (i) => i.value), "");
      await page.keyboard.press("Escape");
      await page.waitForSelector('input[aria-label="Search servers"]', { hidden: true });
    });

    await t.test("F2 renames a group header and a terminal tab in place", async () => {
      await demo(async () => {
        const c = window.__demo.useConnections.getState();
        const p = c.profiles.find((x) => x.id === "p-edge");
        await c.saveProfiles([{ ...p, group: "Web" }]);
      });
      const header = '[data-rail-group="Web"] button';
      await page.waitForSelector(header);
      await page.focus(header);
      await page.keyboard.press("F2");
      await page.waitForSelector('[data-rail-group="Web"] input[data-inline-rename]');
      await page.keyboard.type("Frontends");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() =>
        window.__demo.useConnections.getState().profiles.find((p) => p.id === "p-edge")?.group === "Frontends"
      );
      // Terminal tab chip.
      await demo(() => window.__demo.useLayout.getState().setTerminalOpen(true));
      const chip = 'button[title*="to rename"]';
      await page.waitForSelector(chip);
      await page.focus(chip);
      await page.keyboard.press("F2");
      await page.waitForSelector('input[aria-label^="Rename tab"]');
      await page.keyboard.type("deploy shell");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => window.__demo.useTerminals.getState().tabs.some((t) => t.title === "deploy shell"));
      await demo(() => window.__demo.useLayout.getState().setTerminalOpen(false));
    });

    await t.test("Settings › Keyboard recorder validates, then saves on key release", async () => {
      await demo(() => window.__demo.useLayout.getState().openSettings("keyboard"));
      const field = 'button[aria-label="Shortcut for Toggle Transfer Panel"]';
      await page.waitForSelector(field);
      await page.click(field);
      await page.keyboard.press("KeyK");
      await page.waitForSelector('[data-keybinding-row="toggle-transfers"] [role="alert"]');
      assert.match(await page.$eval('[data-keybinding-row="toggle-transfers"] [role="alert"]', (e) => e.textContent), /Add a modifier/);
      await page.keyboard.down("Alt");
      await page.keyboard.press("F4");
      await page.keyboard.up("Alt");
      assert.match(await page.$eval('[data-keybinding-row="toggle-transfers"] [role="alert"]', (e) => e.textContent), /Alt\+F4 is reserved/);
      await shot("keyboard-recorder-error");
      await page.keyboard.down("Control");
      await page.keyboard.up("Control");
      assert.match(await page.$eval('[data-keybinding-row="toggle-transfers"] [role="alert"]', (e) => e.textContent), /Add a non-modifier key/);
      await page.keyboard.down("Control");
      await page.keyboard.down("Shift");
      await page.keyboard.press("KeyY");
      await page.keyboard.up("Shift");
      await page.keyboard.up("Control");
      await page.waitForSelector('[data-keybinding-row="toggle-transfers"][data-flash]');
      assert.equal(await demo(() => window.__demo.useBindings.getState().overrides["toggle-transfers"]), "mod+shift+y");
      assert.equal(await page.$eval(field, (b) => b.textContent.trim()), "Ctrl+Shift+Y");
      // Blur drops an invalid draft.
      await page.click(field);
      await page.keyboard.press("KeyK");
      await page.click('input[placeholder="Search shortcuts…"]');
      assert.equal(await page.$eval(field, (b) => b.textContent.trim()), "Ctrl+Shift+Y");
      await demo(() => window.__demo.useBindings.getState().resetAll());
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
