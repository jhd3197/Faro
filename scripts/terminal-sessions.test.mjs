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

const paste = await load("src/lib/terminalPaste.ts");
const qc = await load("src/lib/quickConnect.ts");

test("a pasted image's path is quoted for the shell it lands in", () => {
  assert.equal(paste.quotePastePath("/home/me/.cache/faro/pastes/paste-1.png"), "/home/me/.cache/faro/pastes/paste-1.png");
  assert.equal(paste.quotePastePath("/home/me/my pics/a'b.png"), `'/home/me/my pics/a'\\''b.png'`);
  assert.equal(paste.quotePastePath("C:\\Temp\\faro-pastes\\p.png"), "C:\\Temp\\faro-pastes\\p.png");
  assert.equal(paste.quotePastePath("C:\\Users\\Jo Doe\\p.png"), `"C:\\Users\\Jo Doe\\p.png"`);
  assert.equal(paste.imageExt("image/jpeg"), "jpg");
  assert.equal(paste.imageExt("image/svg+xml"), "svg");
  assert.equal(paste.imageExt(""), "png");
});

test("quick connect parses addresses and nothing else", () => {
  const p = qc.parseQuickConnect;
  assert.deepEqual(p("deploy@web1.example.com"), { username: "deploy", host: "web1.example.com", port: 22 });
  assert.deepEqual(p("  root@10.0.0.5:2222 "), { username: "root", host: "10.0.0.5", port: 2222 });
  assert.deepEqual(p("ssh deploy@web1 -p 2200"), { username: "deploy", host: "web1", port: 2200 });
  assert.deepEqual(p("ssh -p2200 deploy@web1"), { username: "deploy", host: "web1", port: 2200 });
  assert.deepEqual(p("sftp://me@files.example.com:2022/var/www"), { username: "me", host: "files.example.com", port: 2022 });
  assert.deepEqual(p("me@[2001:db8::1]:2222"), { username: "me", host: "2001:db8::1", port: 2222 });
  for (const no of ["", "toggle terminal", "web1.example.com", "me@", "@host", "me@host:99999", "me@host:abc", "ssh -i key me@host", "me@ho st", "a b@host", "mail me@example.com now"]) {
    assert.equal(p(no), null, JSON.stringify(no));
  }
  assert.equal(qc.quickTargetLabel({ username: "a", host: "h", port: 22 }), "a@h");
  assert.equal(qc.quickTargetLabel({ username: "a", host: "h", port: 2222 }), "a@h:2222");
  const saved = [{ id: "1", protocol: "sftp", host: "Web1.example.com", port: 22, username: "deploy" }, { id: "2", protocol: "ftp", host: "web1.example.com", port: 22, username: "deploy" }];
  assert.equal(qc.findSavedTarget(saved, { username: "deploy", host: "web1.example.com", port: 22 })?.id, "1");
  assert.equal(qc.findSavedTarget(saved, { username: "root", host: "web1.example.com", port: 22 }), undefined);
  assert.deepEqual(qc.quickProfile({ username: "a", host: "h", port: 22 }, "x").auth, { kind: "agent" });
});

const wsCore = await load("src/lib/terminalWorkspaceCore.ts");

test("a workspace round-trips, and anything malformed is refused", () => {
  const tabs = [
    {
      title: "deploy",
      root: { kind: "split", id: "s1", dir: "row", ratio: 0.3, a: { kind: "leaf", paneId: "p-1" }, b: { kind: "leaf", paneId: "p-2" } },
      activePaneId: "p-2",
      pinned: true,
      locked: true,
      persist: true,
      persistNames: { "p-2": "faro-adopted1" },
      zoomedPaneId: "p-1",
      broadcast: true,
      initialCommand: "cd /srv\n",
    },
    { title: "logs", root: { kind: "leaf", paneId: "p-3" }, activePaneId: "p-3", shell: "pwsh", cwd: "C:\\work" },
  ];
  const saved = wsCore.serializeWorkspace(tabs);
  assert.equal(saved.v, 1);
  assert.equal("broadcast" in saved.tabs[0], false, "broadcast is never saved");
  assert.equal("initialCommand" in saved.tabs[0], false, "the start command is not replayed");
  assert.equal("zoomedPaneId" in saved.tabs[0], false);
  const back = wsCore.parseWorkspace(JSON.stringify(saved));
  assert.deepEqual(back, saved, "what is read back is what was stored");
  assert.deepEqual(back.tabs[1], { title: "logs", root: { kind: "leaf", paneId: "p-3" }, activePaneId: "p-3", shell: "pwsh", cwd: "C:\\work" });

  const bad = (v) => wsCore.parseWorkspace(typeof v === "string" ? v : JSON.stringify(v));
  assert.equal(bad(""), null);
  assert.equal(bad("{not json"), null);
  assert.equal(bad({ v: 2, tabs: saved.tabs }), null, "an unknown version");
  assert.equal(bad({ v: 1, tabs: [] }), null, "no tabs");
  assert.equal(bad({ v: 1, tabs: [{ title: "x", root: { kind: "leaf" } }] }), null, "a leaf without an id");
  assert.equal(
    bad({ v: 1, tabs: [{ title: "a", root: { kind: "leaf", paneId: "p" } }, { title: "b", root: { kind: "leaf", paneId: "p" } }] }),
    null,
    "the same pane id twice"
  );
  assert.equal(bad({ v: 1, tabs: [{ title: "a", root: { kind: "split", id: "s", dir: "row", ratio: 1.5, a: { kind: "leaf", paneId: "a" }, b: { kind: "leaf", paneId: "b" } } }] }), null, "a ratio out of range");
  const fixed = bad({ v: 1, tabs: [{ title: "a", root: { kind: "leaf", paneId: "p" }, activePaneId: "gone", persist: true, persistNames: { p: "main; rm -rf /", other: "faro-x" } }] });
  assert.equal(fixed.tabs[0].activePaneId, "p", "an unknown active pane falls back to the first");
  assert.equal(fixed.tabs[0].persistNames, undefined, "a name that isn't a Faro session is dropped");
});

test("session names derive from pane ids and are counted as claimed", () => {
  assert.equal(wsCore.persistNameFor("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), "faro-3f2504e04f8941d39a0c0305");
  assert.match(wsCore.persistNameFor("---"), /^faro-[a-z0-9]+$/);
  const claimed = wsCore.claimedSessionNames([
    { title: "a", persist: true, activePaneId: "aa", root: { kind: "split", id: "s", dir: "col", ratio: 0.5, a: { kind: "leaf", paneId: "aa" }, b: { kind: "leaf", paneId: "bb" } }, persistNames: { bb: "faro-adopted" } },
    { title: "b", activePaneId: "cc", root: { kind: "leaf", paneId: "cc" } },
  ]);
  assert.deepEqual([...claimed].sort(), ["faro-aa", "faro-adopted"]);
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

    await t.test("a locked tab survives close, middle-click and close all", async () => {
      await reset();
      await demo(() => {
        const { useTerminals, useConnections } = window.__demo;
        const sid = useConnections.getState().activeSessionId;
        useTerminals.getState().openTab(sid);
        useTerminals.getState().openTab(sid);
        const first = useTerminals.getState().tabs[0];
        useTerminals.getState().toggleLock(first.id);
      });
      await page.waitForSelector("[data-term-tab-lock]");
      const kept = await demo(() => {
        const t = window.__demo.useTerminals.getState();
        const closedSingle = t.closeTab(t.tabs[0].id);
        const keptCount = t.closeTabs(t.tabs.map((x) => x.id));
        return { closedSingle, keptCount, left: window.__demo.useTerminals.getState().tabs.map((x) => x.title) };
      });
      assert.deepEqual(kept, { closedSingle: false, keptCount: 1, left: ["Shell 1"] });
      // Middle-click on the locked chip leaves it open.
      const chip = await page.$(`${STRIP} [data-term-tab-id]`);
      const box = await chip.boundingBox();
      await page.mouse.move(box.x + 12, box.y + box.height / 2);
      await page.mouse.down({ button: "middle" });
      await page.mouse.up({ button: "middle" });
      await sleep(200);
      assert.deepEqual(await titles(), ["Shell 1"]);
      // Clicking the lock unlocks; then it closes like any tab.
      await page.click("[data-term-tab-lock]");
      await sleep(150);
      assert.equal(await demo(() => !!window.__demo.useTerminals.getState().tabs[0].locked), false);
    });

    await t.test("pinned tabs sort first and stay first through a move", async () => {
      await reset();
      const order = await demo(() => {
        const { useTerminals, useConnections } = window.__demo;
        const sid = useConnections.getState().activeSessionId;
        const names = () => useTerminals.getState().tabs.filter((x) => x.sessionId === sid).map((x) => x.title);
        useTerminals.getState().openTab(sid);
        useTerminals.getState().openTab(sid);
        const third = useTerminals.getState().tabs.find((x) => x.title === "Shell 3");
        useTerminals.getState().togglePin(third.id);
        const afterPin = names();
        const first = useTerminals.getState().tabs.find((x) => x.title === "Shell 1");
        useTerminals.getState().moveTab(first.id, 0);
        const afterMove = names();
        useTerminals.getState().togglePin(third.id);
        return { afterPin, afterMove, afterUnpin: names() };
      });
      assert.deepEqual(order.afterPin, ["Shell 3", "Shell 1", "Shell 2"]);
      assert.deepEqual(order.afterMove, ["Shell 3", "Shell 1", "Shell 2"], "an unpinned tab can't jump the pinned one");
      assert.deepEqual(order.afterUnpin, ["Shell 3", "Shell 1", "Shell 2"]);
    });

    await t.test("duplicate opens a tab on the same connection, next to the original", async () => {
      await reset();
      const out = await demo(() => {
        const { useTerminals, useConnections } = window.__demo;
        const sid = useConnections.getState().activeSessionId;
        useTerminals.getState().openTab(sid);
        const first = useTerminals.getState().tabs.find((x) => x.title === "Shell 1");
        const copy = useTerminals.getState().duplicateTab(first.id);
        return {
          titles: useTerminals.getState().tabs.filter((x) => x.sessionId === sid).map((x) => x.title),
          sameSession: copy.sessionId === first.sessionId,
          newPane: copy.activePaneId !== first.activePaneId,
        };
      });
      assert.deepEqual(out, { titles: ["Shell 1", "Shell 1 copy", "Shell 2"], sameSession: true, newPane: true });
    });

    await t.test("pasting an image uploads it and types its path; text still pastes as text", async () => {
      await reset();
      const result = await demo(async () => {
        const s = window.__demo.useTerminals.getState();
        const tab = s.tabs.find((x) => x.id === s.activeId);
        const el = window.__demo.terminal.getPane(tab.activePaneId).element;
        const target = el.querySelector("textarea");
        const fire = (dt) => {
          const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
          target.dispatchEvent(ev);
          return ev.defaultPrevented;
        };
        const image = new DataTransfer();
        image.items.add(new File([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], "shot.png", { type: "image/png" }));
        const imagePrevented = fire(image);
        await new Promise((r) => setTimeout(r, 300));
        const both = new DataTransfer();
        both.items.add(new File([new Uint8Array([1])], "x.png", { type: "image/png" }));
        both.setData("text/plain", "cell text");
        const bothPrevented = fire(both);
        await new Promise((r) => setTimeout(r, 200));
        window.__demo.useSettings.setState({ terminalPasteImages: false });
        const off = new DataTransfer();
        off.items.add(new File([new Uint8Array([1])], "y.png", { type: "image/png" }));
        const offPrevented = fire(off);
        window.__demo.useSettings.setState({ terminalPasteImages: true });
        await new Promise((r) => setTimeout(r, 200));
        const calls = window.__demo.terminalCalls;
        return {
          imagePrevented,
          bothPrevented,
          offPrevented,
          uploads: calls.filter((c) => c.cmd === "terminal_paste_image").map((c) => [c.args.ext, c.args.data]),
          typed: calls.filter((c) => c.cmd === "terminal_write").map((c) => c.args.data),
        };
      });
      assert.equal(result.imagePrevented, true, "the image paste is handled here");
      assert.equal(result.bothPrevented, false, "text on the clipboard wins");
      assert.equal(result.offPrevented, false, "off: left to the terminal");
      assert.deepEqual(result.uploads, [["png", "12 chars"]], "one upload, the 7 bytes as base64");
      assert.ok(result.typed.includes("/home/deploy/.cache/faro/pastes/paste-1.png "), JSON.stringify(result.typed));
    });

    const opens = () =>
      demo(() => window.__demo.terminalCalls.filter((c) => c.cmd === "open_terminal").map((c) => c.args));
    const closes = () =>
      demo(() => window.__demo.terminalCalls.filter((c) => c.cmd === "close_terminal").map((c) => c.args));

    await t.test("persistent shells: each pane gets its own session; closing ends it, disconnecting does not", async () => {
      await demo(() => window.__demo.useSettings.setState({ terminalPersist: "on" }));
      await reset();
      await demo(() => {
        const s = window.__demo.useTerminals.getState();
        s.splitActivePane(s.activeId, "row");
      });
      await sleep(700);
      const opened = await opens();
      assert.equal(opened.length, 2);
      assert.match(opened[0].persistName, /^faro-[a-z0-9]{8,24}$/);
      assert.match(opened[1].persistName, /^faro-[a-z0-9]{8,24}$/);
      assert.notEqual(opened[0].persistName, opened[1].persistName);
      assert.equal(opened[0].scrollback, 5000);

      // Closing one pane by hand ends its session.
      await demo(() => {
        const s = window.__demo.useTerminals.getState();
        const tab = s.tabs.find((x) => x.id === s.activeId);
        s.closePane(tab.id, tab.activePaneId);
      });
      await sleep(200);
      assert.deepEqual((await closes()).map((c) => c.endSession), [true]);

      // Dropping the connection's tabs only detaches.
      await demo(() => {
        const { useTerminals, useConnections } = window.__demo;
        useTerminals.getState().dropSessionTabs(useConnections.getState().activeSessionId);
      });
      await sleep(200);
      assert.deepEqual((await closes()).map((c) => c.endSession), [true, false]);
      await demo(() => window.__demo.useSettings.setState({ terminalPersist: "off" }));
    });

    await t.test("a connection's choice overrides the global setting, and local shells never persist", async () => {
      await demo(() => {
        const { useSettings, useConnections } = window.__demo;
        const c = useConnections.getState();
        const profileId = c.sessions.find((s) => s.sessionId === c.activeSessionId).profileId;
        useSettings.setState({ terminalPersist: "off", terminalPersistOverrides: { [profileId]: true } });
      });
      await reset();
      await sleep(300);
      assert.match((await opens())[0].persistName, /^faro-/, "override on");
      await demo(() => {
        const { useSettings, useTerminals } = window.__demo;
        useSettings.setState({ terminalPersist: "on", terminalPersistOverrides: {} });
        useTerminals.getState().openTab("local", undefined, { title: "Local", shell: "cmd" });
      });
      await sleep(500);
      const local = (await opens()).find((a) => a.sessionId === "local");
      assert.equal(local.persistName, null, "local shells have nothing to survive");
      await demo(() => window.__demo.useSettings.setState({ terminalPersist: "off" }));
    });

    await t.test("the workspace is saved and comes back after a reconnect, with the same shells", async () => {
      await demo(() => window.__demo.useSettings.setState({ terminalPersist: "on", terminalRestoreWorkspace: true }));
      await reset();
      const before = await demo(() => {
        const { useTerminals, useConnections } = window.__demo;
        const sid = useConnections.getState().activeSessionId;
        const t = useTerminals.getState();
        t.renameTab(t.activeId, "deploy");
        t.splitActivePane(t.activeId, "col");
        const second = useTerminals.getState().openTab(sid);
        useTerminals.getState().renameTab(second.id, "logs");
        useTerminals.getState().toggleLock(second.id);
        useTerminals.getState().togglePin(second.id);
        const c = useConnections.getState();
        return { profileId: c.sessions.find((s) => s.sessionId === sid).profileId, sid };
      });
      await sleep(1200);
      const row = await demo((key) => window.__demo.workspaceRows.get(key), `terminalWorkspace:${before.profileId}`);
      assert.ok(row, "the workspace row was written");
      const names = async () => (await opens()).map((a) => a.persistName).sort();
      const firstNames = await names();
      assert.equal(firstNames.length, 3, "three panes were opened");

      // Disconnect and connect again: a new session id, the same profile.
      await demo(async () => {
        const { useConnections } = window.__demo;
        await useConnections.getState().disconnect();
      });
      await sleep(600);
      assert.equal(await demo(() => window.__demo.useTerminals.getState().tabs.filter((x) => x.sessionId !== "local").length), 0);
      assert.ok(await demo((key) => window.__demo.workspaceRows.has(key), `terminalWorkspace:${before.profileId}`), "a disconnect keeps the saved workspace");
      await demo(async (profileId) => {
        const { useConnections, useLayout } = window.__demo;
        window.__demo.terminalCalls.length = 0;
        await useConnections.getState().connect(profileId);
        useLayout.getState().setTerminalOpen(true);
      }, before.profileId);
      await page.waitForFunction(() => window.__demo.useTerminals.getState().tabs.filter((x) => x.sessionId !== "local").length === 2, { timeout: 10_000 });
      await sleep(900);
      const after = await demo(() => {
        const { useTerminals, useConnections } = window.__demo;
        const sid = useConnections.getState().activeSessionId;
        return {
          sid,
          tabs: useTerminals.getState().tabs.filter((x) => x.sessionId === sid).map((x) => ({
            title: x.title,
            split: x.root.kind,
            pinned: !!x.pinned,
            locked: !!x.locked,
            persist: !!x.persist,
          })),
        };
      });
      assert.deepEqual(after.tabs, [
        { title: "logs", split: "leaf", pinned: true, locked: true, persist: true },
        { title: "deploy", split: "split", pinned: false, locked: false, persist: true },
      ]);
      assert.deepEqual(await names(), firstNames, "every pane reattached to the session it had");
      await demo(() => {
        const t = window.__demo.useTerminals.getState();
        for (const x of t.tabs) if (x.locked) t.toggleLock(x.id);
      });
    });

    await t.test("closing every tab by hand forgets the workspace", async () => {
      const profileId = await demo(() => {
        const { useTerminals, useConnections } = window.__demo;
        const c = useConnections.getState();
        const t = useTerminals.getState();
        t.closeTabs(t.tabs.map((x) => x.id));
        window.__demo.useLayout.getState().setTerminalOpen(false);
        return c.sessions.find((s) => s.sessionId === c.activeSessionId).profileId;
      });
      await sleep(1000);
      assert.equal(await demo((key) => window.__demo.workspaceRows.has(key), `terminalWorkspace:${profileId}`), false);
    });

    await t.test("a shell left running on the server can be attached from the + menu", async () => {
      await reset();
      await demo(() => window.__demo.setPersistedSessions([{ name: "faro-leftover01", attached: 0, lastActivity: Math.floor(Date.now() / 1000) - 7200 }]));
      await page.click("[data-term-new-tab-menu]");
      await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].some((e) => e.textContent.includes("Attach shell left running")));
      const labels = await page.$$eval('[role="menuitem"]', (els) => els.map((e) => e.textContent.trim()));
      assert.ok(labels.some((l) => /Attach shell left running \(2h ago\)/.test(l)), labels.join(" | "));
      assert.ok(labels.includes("Keep shells running after disconnect"));
      for (const h of await page.$$('[role="menuitem"]')) {
        if ((await h.evaluate((e) => e.textContent)).includes("Attach shell left running")) await h.click();
      }
      await sleep(600);
      assert.ok((await opens()).some((a) => a.persistName === "faro-leftover01"), "attached to the leftover session");
      await demo(() => {
        window.__demo.setPersistedSessions([]);
        window.__demo.useSettings.setState({ terminalPersist: "off", terminalPersistOverrides: {} });
      });
    });

    const palette = async (text) => {
      await demo(() => window.__demo.useLayout.getState().setPaletteOpen(true));
      const input = await page.waitForSelector('input[placeholder^="Type a command"]');
      await input.click();
      await page.keyboard.type(text);
      await sleep(250);
    };

    await t.test("quick connect: an address in the palette connects and saves the host", async () => {
      const before = await demo(() => window.__demo.useConnections.getState().profiles.length);
      await palette("newuser@fresh.example.com:2200");
      const first = await page.$eval('[data-idx="0"]', (e) => e.textContent);
      assert.match(first, /Connect to newuser@fresh\.example\.com:2200/);
      await page.keyboard.press("Enter");
      await page.waitForFunction(
        (n) => window.__demo.useConnections.getState().profiles.length === n + 1,
        { timeout: 10_000 },
        before
      );
      const saved = await demo(() => {
        const c = window.__demo.useConnections.getState();
        const p = c.profiles.find((x) => x.host === "fresh.example.com");
        return { p, connected: c.sessions.some((s) => s.profileId === p.id) };
      });
      assert.equal(saved.p.username, "newuser");
      assert.equal(saved.p.port, 2200);
      assert.deepEqual(saved.p.auth, { kind: "agent" });
      assert.equal(saved.connected, true);
    });

    await t.test("quick connect: a host that refuses sign-in is not kept, and the editor opens", async () => {
      const before = await demo(() => window.__demo.useConnections.getState().profiles.length);
      await palette("someone@auth-fail.test");
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => !!window.__demo.useLayout.getState().connectionPrefill, { timeout: 10_000 });
      const after = await demo(() => ({
        count: window.__demo.useConnections.getState().profiles.length,
        prefill: window.__demo.useLayout.getState().connectionPrefill,
      }));
      assert.equal(after.count, before, "nothing left behind");
      assert.equal(after.prefill.host, "auth-fail.test");
      assert.equal(after.prefill.username, "someone");
      assert.equal(after.prefill.auth.kind, "password");
      await demo(() => window.__demo.useLayout.getState().closeDialog?.());
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
