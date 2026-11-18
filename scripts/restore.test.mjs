// Restored session + quit gate, driven in the mock build (no Rust).
// - the dual-pane split and last Settings section survive a reload
// - "Restore last session" (Settings › Connections) gates the reconnect
// - closing the window with running transfers / open edits asks first
// Window bounds and the native background colour are covered by the Rust
// tests in src-tauri/src/window_state.rs.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = process.env.SHOT_DIR || path.join(ROOT, ".shots", "bruno-lessons", "restore");
const PORT = Number(process.env.RESTORE_PORT || 1432);
const SEP = '[role="separator"][aria-label="Resize file browser panes"]';

const executablePath = [process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].find(p => p && existsSync(p));

async function boot(page, url) {
  for (let i = 0; i < 5; i++) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(() => window.__demo?.useSession?.getState().restored, { timeout: 20000 });
      return;
    } catch { /* cold optimizer: reload */ }
  }
  throw new Error("app never booted");
}

// Close requests resolve only once the gate is answered, so never await
// them inside page.evaluate; poll a flag instead.
const startClose = page => page.evaluate(() => {
  window.__closeDone = false;
  window.__demo.requestClose().then(() => { window.__closeDone = true; });
});
const closeDone = page => page.waitForFunction(() => window.__closeDone, { timeout: 10000 });
const settle = page => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
const saved = page => page.evaluate(() => {
  const all = JSON.parse(sessionStorage.getItem("faro-mock-discovery") || "{}");
  return all.sessionSnapshot ? JSON.parse(all.sessionSnapshot) : null;
});

test("session restore and quit gate", { timeout: 240000 }, async () => {
  assert.ok(executablePath, "need Chrome or Edge");
  mkdirSync(SHOTS, { recursive: true });
  process.env.VITE_UI_LOCALE = "en";
  const server = await createServer({ root: ROOT, mode: "mock", server: { host: "127.0.0.1", port: PORT, strictPort: true, hmr: false } });
  let browser;
  try {
    await server.listen();
    const url = `http://127.0.0.1:${PORT}/`;
    browser = await puppeteer.launch({ executablePath, headless: true, protocolTimeout: 60000, defaultViewport: { width: 1280, height: 800 } });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await boot(page, url);

    // --- split ratio persists ---
    console.log("step: split ratio persists");
    await page.waitForFunction(() => window.__demo.useConnections.getState().activeSessionId, { timeout: 20000 });
    await page.evaluate(() => window.__demo.useSettings.getState().setBrowserLayout("dual"));
    await page.waitForSelector(SEP);
    await page.focus(SEP);
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await settle(page);
    assert.equal(await page.$eval(SEP, el => el.getAttribute("aria-valuenow")), "75");
    await new Promise(r => setTimeout(r, 700)); // debounce
    let snap = await saved(page);
    assert.ok(snap, "snapshot written after the debounce");
    assert.equal(snap.v, 1);
    assert.equal(snap.splitRatio, 0.75);
    const focused = await page.evaluate(() => window.__demo.useConnections.getState().activeProfileId);
    assert.equal(snap.activeProfileId, focused, "snapshot keys the server by profile id");
    assert.equal(snap.connected, true);

    // --- Settings: Restore last session toggle + last section ---
    console.log("step: Settings: Restore last session toggle + last section");
    await page.evaluate(() => window.__demo.useLayout.getState().openDialog("settings"));
    await page.waitForSelector('[data-settings-section="connections"]');
    await page.click('[data-settings-section="connections"]');
    await page.waitForFunction(() => [...document.querySelectorAll("label, div, span")]
      .some(el => el.textContent?.trim() === "Restore last session"));
    assert.equal(await page.evaluate(() => window.__demo.useSettings.getState().restoreLastSession), true, "on by default");
    await new Promise(r => setTimeout(r, 400)); // nav highlight transition
    await page.screenshot({ path: path.join(SHOTS, "restore-last-session-setting.png") });
    await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
    await new Promise(r => setTimeout(r, 700));
    snap = await saved(page);
    assert.equal(snap.settingsSection, "connections");

    // --- reload: split, section and focused server come back ---
    console.log("step: reload: split, section and focused server come back");
    // Focus a different server first so the restore has something to do.
    const other = await page.evaluate((cur) => {
      const d = window.__demo.useConnections.getState();
      const p = d.profiles.find(x => x.id !== cur && x.protocol === "sftp");
      void d.connect(p.id);
      return p.id;
    }, focused);
    await page.waitForFunction(id => window.__demo.useConnections.getState().activeProfileId === id, { timeout: 20000 }, other);
    await new Promise(r => setTimeout(r, 700));
    assert.equal((await saved(page)).activeProfileId, other);
    await boot(page, url);
    await page.waitForFunction(id => window.__demo.useConnections.getState().activeProfileId === id, { timeout: 25000 }, other);
    await page.evaluate(() => window.__demo.useSettings.getState().setBrowserLayout("dual"));
    await page.waitForSelector(SEP);
    assert.equal(await page.$eval(SEP, el => el.getAttribute("aria-valuenow")), "75", "split restored");
    await page.evaluate(() => window.__demo.useLayout.getState().openDialog("settings"));
    await page.waitForSelector('[data-settings-section="connections"][aria-current="page"]');
    await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());

    // --- "Restore last session" off: no reconnect ---
    console.log("step: restore setting off");
    const page2 = await browser.newPage();
    page2.on("pageerror", e => errors.push(e.message));
    await page2.evaluateOnNewDocument(() => {
      window.__FARO_SETTINGS__ = {
        appTheme: "dark",
        restoreLastSession: false,
        sessionSnapshot: { v: 1, activeProfileId: "p-cf", connected: true, splitRatio: 0.3, settingsSection: "about" },
      };
    });
    await boot(page2, url);
    await new Promise(r => setTimeout(r, 1500));
    const conns = await page2.evaluate(() => window.__demo.useConnections.getState().sessions.map(s => s.profileId));
    assert.ok(!conns.includes("p-cf"), `p-cf must not reconnect with the setting off (got ${conns})`);
    assert.equal(await page2.evaluate(() => window.__demo.useSession.getState().snapshot.splitRatio), 0.3, "injected snapshot read before paint");
    await page2.close();

    // --- quit gate ---
    console.log("step: quit gate");
    // Nothing pending: closes straight away.
    await page.evaluate(() => { window.__destroyed = false; });
    await page.evaluate(() => {
      window.__demo.useTransfers.setState({ byId: {} });
      window.__demo.useEditor.setState({ edits: {} });
    });
    await startClose(page);
    try {
      await closeDone(page);
    } catch {
      const why = await page.evaluate(() => ({
        gate: document.querySelector("[data-quit-gate]")?.textContent ?? null,
        transfers: Object.values(window.__demo.useTransfers.getState().byId).map(t => `${t.id}:${t.status}`),
        edits: Object.keys(window.__demo.useEditor.getState().edits),
      }));
      assert.fail(`idle close never finished: ${JSON.stringify(why)}`);
    }
    assert.equal(await page.evaluate(() => window.__destroyed), true, "idle app closes without asking");
    assert.equal(await page.$("[data-quit-gate]"), null);

    // 7 running transfers + 1 open edit → list of 5 and "…3 more".
    await page.evaluate(() => {
      window.__destroyed = false;
      const byId = {};
      for (let i = 1; i <= 7; i++) {
        byId[`q${i}`] = { id: `q${i}`, kind: i % 2 ? "download" : "upload", source: `/var/www/release-${i}.tar.gz`,
          destination: `C:/Users/demo/Downloads/release-${i}.tar.gz`, size: 1e8, transferred: 2e7 * (i % 5),
          status: i < 6 ? "transferring" : "queued", startedAt: Date.now() };
      }
      byId.done1 = { ...byId.q1, id: "done1", status: "done" };
      window.__demo.useTransfers.setState({ byId });
      window.__demo.useEditor.setState({ edits: { e1: { editId: "e1", sessionId: "s", remotePath: "/etc/nginx/nginx.conf",
        localTempPath: "C:/tmp/nginx.conf", lastSavedAt: 0, lastBytes: null, lastError: null } } });
    });
    await startClose(page);
    await page.waitForSelector("[data-quit-gate]");
    const rows = await page.$$eval("[data-quit-list] li:not([data-quit-more])", els => els.map(e => e.textContent.trim()));
    assert.equal(rows.length, 5);
    assert.equal(await page.$eval("[data-quit-more]", el => el.textContent.trim()), "…3 more");
    assert.match(await page.$eval("[data-quit-gate]", el => el.textContent), /7 transfers still running and 1 file open for editing/);
    await new Promise(r => setTimeout(r, 300));
    await page.screenshot({ path: path.join(SHOTS, "quit-gate.png") });

    // Cancel keeps the window.
    await page.click("[data-quit-gate] button:not([data-quit-anyway])");
    await closeDone(page);
    assert.equal(await page.$("[data-quit-gate]"), null);
    assert.equal(await page.evaluate(() => window.__destroyed), false, "Cancel keeps Faro open");

    // Escape cancels too.
    await startClose(page);
    await page.waitForSelector("[data-quit-gate]");
    // Focus starts on Cancel, so Escape and Enter can't quit by accident.
    await page.waitForFunction(() => document.activeElement?.closest("[data-quit-gate]")
      && !document.activeElement.hasAttribute("data-quit-anyway"), { timeout: 5000 });
    await page.keyboard.press("Escape");
    await closeDone(page);
    assert.equal(await page.evaluate(() => window.__destroyed), false);

    // Quit anyway flushes the snapshot and closes.
    await page.evaluate(() => window.__demo.useSession.getState().setSplitRatio(0.4));
    await startClose(page);
    await page.waitForSelector("[data-quit-anyway]");
    await page.click("[data-quit-anyway]");
    await closeDone(page);
    assert.equal(await page.evaluate(() => window.__destroyed), true, "Quit anyway closes");
    assert.equal((await saved(page)).splitRatio, 0.4, "close flushes the pending snapshot immediately");

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
