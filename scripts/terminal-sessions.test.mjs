// Terminal sessions (Plan 36): local shells, everyday actions, broadcast
// input, keyword highlighting. The pure parts run in node; the rest drives the
// mock build (no Rust): `node --test scripts/terminal-sessions.test.mjs`.
//
// Starts `vite --mode mock` on TERM36_PORT (default 1447) unless FARO_URL
// points at one already running.
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
const PORT = Number(process.env.UI_TEST_PORT || process.env.TERM36_PORT || 1447);
const URL = process.env.FARO_URL || `http://127.0.0.1:${PORT}/`;
const isWin = process.platform === "win32";

// Type-only imports are erased, so these modules load without a bundler.
async function load(rel) {
  const source = ts.transpileModule(readFileSync(path.join(ROOT, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const hl = await load("src/lib/terminalHighlight.ts");
const bc = await load("src/lib/terminalBroadcast.ts");

test("highlight rules match whole words, case-insensitively, without overlap", () => {
  const { compiled, errors } = hl.compileRules(hl.DEFAULT_HIGHLIGHT_RULES);
  assert.deepEqual(errors, {});
  const m = hl.matchLine("ERROR: build Failed, 2 warnings, tests passed OK", compiled);
  assert.deepEqual(
    m.map((x) => ["ERROR: build Failed, 2 warnings, tests passed OK".slice(x.start, x.start + x.length), x.color]),
    [
      ["ERROR", "red"],
      ["Failed", "red"],
      ["warnings", "yellow"],
      ["passed", "green"],
      ["OK", "green"],
    ]
  );
  assert.deepEqual(hl.matchLine("terror cookie", compiled), [], "no match inside a longer word");
});

test("a bad or empty-matching highlight rule is reported and skipped", () => {
  const rules = [
    { id: "a", pattern: "(", color: "red", enabled: true },
    { id: "b", pattern: "x*", color: "red", enabled: true },
    { id: "c", pattern: "  ", color: "red", enabled: true },
    { id: "d", pattern: "timeout", color: "cyan", enabled: true },
    { id: "e", pattern: "skipped", color: "blue", enabled: false },
  ];
  const { compiled, errors } = hl.compileRules(rules);
  assert.deepEqual(Object.keys(errors).sort(), ["a", "b", "c"]);
  assert.equal(compiled.length, 1, "only the valid, enabled rule compiles");
  assert.equal(hl.matchLine("connection timeout; test skipped", compiled).length, 1);
});

test("earlier rules win an overlap and the match count is capped", () => {
  const { compiled } = hl.compileRules([
    { id: "1", pattern: "disk full", color: "red", enabled: true },
    { id: "2", pattern: "full", color: "green", enabled: true },
  ]);
  const m = hl.matchLine("disk full, cache full", compiled);
  assert.deepEqual(m.map((x) => x.color), ["red", "green"]);
  const many = hl.matchLine("full ".repeat(50), compiled, 5);
  assert.equal(many.length, 5);
});

test("highlight colours follow the background", () => {
  assert.equal(hl.isDarkHex("#0b0d10"), true);
  assert.equal(hl.isDarkHex("#fafafa"), false);
  assert.notEqual(hl.highlightHex("red", true), hl.highlightHex("red", false));
});

test("broadcast copies typing but never the terminal's own replies", () => {
  for (const reply of ["\x1b[12;40R", "\x1b[0n", "\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[I", "\x1b[O", "\x1b]11;rgb:0000/0000/0000\x07", "\x1bP1$r0m\x1b\\"]) {
    assert.equal(bc.isTerminalReply(reply), true, JSON.stringify(reply));
  }
  for (const typed of ["ls -la\r", "a", "\x1b[A", "\x1b[200~pasted\x1b[201~", "\x03", "\x1b"]) {
    assert.equal(bc.isTerminalReply(typed), false, JSON.stringify(typed));
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

test("terminal sessions in the app", { timeout: 300_000, skip: !CHROME && "no Chrome/Edge" }, async (t) => {
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
    const demo = (fn, ...args) => page.evaluate(fn, ...args);
    await demo(() => window.__demo.useLayout.getState().closeDialog?.());

    const STRIP = "[data-term-tab-strip]";
    const titles = () =>
      page.$$eval(`${STRIP} [data-term-tab-id]`, (els) => els.map((e) => e.textContent.trim()));
    // Close every tab, then open one shell on the active server.
    const reset = async () => {
      await demo(() => {
        const { useTerminals, useConnections, useLayout } = window.__demo;
        const t = useTerminals.getState();
        t.closeTabs(t.tabs.map((x) => x.id));
        useTerminals.setState({ closed: [] });
        window.__demo.terminalCalls.length = 0;
        useLayout.getState().setTerminalOpen(true);
        useTerminals.getState().openTab(useConnections.getState().activeSessionId);
      });
      await page.waitForFunction(() => document.querySelectorAll("[data-term-tab-strip] [data-term-tab-id]").length === 1);
      await sleep(500);
    };
    const activePaneText = () =>
      demo(() => {
        const s = window.__demo.useTerminals.getState();
        const tab = s.tabs.find((x) => x.id === s.activeId);
        return window.__demo.terminal.paneText(tab.activePaneId);
      });
    const chord = async (mods, key) => {
      for (const m of mods) await page.keyboard.down(m);
      await page.keyboard.press(key);
      for (const m of [...mods].reverse()) await page.keyboard.up(m);
      await sleep(150);
    };
    const focusShell = async () => {
      await page.evaluate(() => {
        const box = [...document.querySelectorAll(".xterm")].find((x) => !x.closest('[aria-hidden="true"]'));
        box?.querySelector("textarea")?.focus();
      });
      await sleep(100);
    };

    await t.test("the new-tab menu lists local shells and opens one", async () => {
      await reset();
      await page.click("[data-term-new-tab-menu]");
      await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes("PowerShell")));
      const items = await page.$$eval('[role="menuitem"]', (els) => els.map((e) => e.textContent.trim()));
      assert.ok(items.includes("Shell on this server"), items.join(" | "));
      assert.ok(items.includes("Ubuntu (WSL)"), items.join(" | "));
      const handles = await page.$$('[role="menuitem"]');
      for (const h of handles) {
        if ((await h.evaluate((e) => e.textContent.trim())) === "Ubuntu (WSL)") await h.click();
      }
      await page.waitForFunction(() => document.querySelectorAll("[data-term-tab-strip] [data-term-tab-id]").length === 2);
      assert.deepEqual(await titles(), ["Shell 1", "Ubuntu (WSL)"]);
      await sleep(300);
      const open = await demo(() => window.__demo.terminalCalls.filter((c) => c.cmd === "open_terminal").map((c) => c.args));
      const local = open.find((a) => a.sessionId === "local");
      assert.ok(local, "a local terminal was opened");
      assert.equal(local.shell, "wsl:Ubuntu");
    });

    await t.test("local tabs stay in the strip when the server has no shell", async () => {
      const count = await demo(() => {
        const { useTerminals } = window.__demo;
        return useTerminals.getState().tabs.filter((x) => x.sessionId === "local").length;
      });
      assert.equal(count, 1);
    });

    await t.test("clear wipes the output and keeps the shell", async () => {
      await reset();
      assert.ok((await activePaneText()).length > 0, "the transcript is on screen");
      await focusShell();
      await chord(["Control", "Shift"], "KeyK");
      await sleep(200);
      const after = await activePaneText();
      assert.ok(after.split("\n").length <= 1, `cleared, got ${JSON.stringify(after.slice(0, 80))}`);
      await page.keyboard.type("x");
      await sleep(200);
      const writes = await demo(() => window.__demo.terminalCalls.filter((c) => c.cmd === "terminal_write").length);
      assert.ok(writes >= 1, "the shell still takes input");
    });

    await t.test("broadcast writes typing to every pane of the tab, and only then", async () => {
      await reset();
      await demo(() => {
        const s = window.__demo.useTerminals.getState();
        s.splitActivePane(s.activeId, "row");
      });
      await sleep(700);
      const ids = async () =>
        demo(() => window.__demo.terminalCalls.filter((c) => c.cmd === "open_terminal").map((c) => c.args.terminalId));
      assert.equal((await ids()).length, 2);
      const written = async (ch) =>
        demo(
          (ch) => window.__demo.terminalCalls.filter((c) => c.cmd === "terminal_write" && c.args.data === ch).map((c) => c.args.terminalId),
          ch
        );
      await focusShell();
      await page.keyboard.type("q");
      await sleep(200);
      assert.equal((await written("q")).length, 1, "off: only the focused pane");

      await demo(() => {
        const s = window.__demo.useTerminals.getState();
        s.toggleBroadcast(s.activeId);
      });
      await page.waitForSelector("[data-term-broadcast]");
      assert.equal((await page.$$("[data-term-broadcast]")).length, 2, "both panes show the marker");
      await focusShell();
      await page.keyboard.type("z");
      await sleep(200);
      assert.deepEqual((await written("z")).sort(), (await ids()).sort(), "on: both panes");

      await demo(() => {
        const s = window.__demo.useTerminals.getState();
        s.toggleBroadcast(s.activeId);
      });
      await sleep(100);
      assert.equal((await page.$$("[data-term-broadcast]")).length, 0);
    });

    await t.test("double-clicking a split handle resets it to the middle", async () => {
      await demo(() => {
        const s = window.__demo.useTerminals.getState();
        const tab = s.tabs.find((x) => x.id === s.activeId);
        s.setSplitRatio(tab.id, tab.root.id, 0.8);
      });
      const handle = await page.$("[data-split-handle]");
      await handle.click({ count: 2 });
      await sleep(150);
      const ratio = await demo(() => {
        const s = window.__demo.useTerminals.getState();
        return s.tabs.find((x) => x.id === s.activeId).root.ratio;
      });
      assert.equal(ratio, 0.5);
    });

    await t.test("keywords in output are highlighted, and the switch turns it off", async () => {
      await reset();
      const decorate = async (line) =>
        demo(async (line) => {
          const s = window.__demo.useTerminals.getState();
          const tab = s.tabs.find((x) => x.id === s.activeId);
          const term = window.__demo.terminal.getPane(tab.activePaneId).term;
          const seen = [];
          const sub = term.onDecorationRegistered?.(() => {});
          const before = term._core._decorationService?.decorations ? [...term._core._decorationService.decorations].length : -1;
          await new Promise((r) => term.write(line, r));
          await new Promise((r) => setTimeout(r, 200));
          const all = term._core._decorationService?.decorations ? [...term._core._decorationService.decorations] : [];
          sub?.dispose?.();
          return { before, after: all.length, colors: all.map((d) => d.options.foregroundColor), seen };
        }, line);
      const on = await decorate("\r\nbuild failed with 2 warnings\r\n");
      assert.ok(on.after - on.before >= 2, `two new decorations, got ${JSON.stringify(on)}`);
      await demo(() => window.__demo.useSettings.setState({ terminalHighlight: false }));
      const off = await decorate("\r\nanother error here\r\n");
      assert.equal(off.after, off.before, "off: nothing new is decorated");
      await demo(() => window.__demo.useSettings.setState({ terminalHighlight: true }));
    });

    await t.test("cursor and line-height settings apply to open terminals", async () => {
      await demo(() =>
        window.__demo.useSettings.setState({ terminalCursorStyle: "bar", terminalCursorBlink: false, terminalLineHeight: 1.4 })
      );
      await sleep(200);
      const opts = await demo(() => {
        const s = window.__demo.useTerminals.getState();
        const tab = s.tabs.find((x) => x.id === s.activeId);
        const o = window.__demo.terminal.getPane(tab.activePaneId).term.options;
        return { cursorStyle: o.cursorStyle, cursorBlink: o.cursorBlink, lineHeight: o.lineHeight };
      });
      assert.deepEqual(opts, { cursorStyle: "bar", cursorBlink: false, lineHeight: 1.4 });
      await demo(() =>
        window.__demo.useSettings.setState({ terminalCursorStyle: "block", terminalCursorBlink: true, terminalLineHeight: 1 })
      );
    });

    await t.test("OSC 52 sets the clipboard and ignores read requests", async () => {
      const result = await demo(async () => {
        const writes = [];
        const original = navigator.clipboard.writeText;
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: async (t) => void writes.push(t), readText: async () => "secret" },
        });
        const s = window.__demo.useTerminals.getState();
        const tab = s.tabs.find((x) => x.id === s.activeId);
        const term = window.__demo.terminal.getPane(tab.activePaneId).term;
        const b64 = btoa("from the server");
        await new Promise((r) => term.write(`\x1b]52;c;${b64}\x07`, r));
        await new Promise((r) => term.write(`\x1b]52;c;?\x07`, r));
        window.__demo.useSettings.setState({ terminalOsc52: false });
        await new Promise((r) => term.write(`\x1b]52;c;${btoa("blocked")}\x07`, r));
        window.__demo.useSettings.setState({ terminalOsc52: true });
        void original;
        return writes;
      });
      assert.deepEqual(result, ["from the server"]);
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
