// Feedback: repeating toasts dedupe, error toasts offer Copy details, loading
// placeholders wait before showing, a crashing region shows a recover panel
// (and the status bar counts errors), and onboarding only welcomes new users.
// Runs against the mock build; FARO_SHOTS sets the screenshot folder.
import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

process.env.VITE_UI_LOCALE ??= "en";
const shots = process.env.FARO_SHOTS ?? join(process.cwd(), ".shots", "bruno-lessons", "feedback");
mkdirSync(shots, { recursive: true });

test("feedback: toasts, deferred loading, error boundary, onboarding", { timeout: 180000 }, async () => {
  const executablePath = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((p) => p && existsSync(p));
  assert.ok(executablePath, "Install Chrome/Chromium or set CHROME_PATH");

  const server = await createServer({
    mode: "mock",
    // No HMR: edits elsewhere in the checkout must not reload the page mid-test.
    server: { host: "127.0.0.1", port: Number(process.env.FARO_TEST_PORT) || 1440, strictPort: false, hmr: false, watch: null },
  });
  let browser;
  try {
    await server.listen();
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox"],
      defaultViewport: { width: 1280, height: 800 },
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Capture clipboard writes instead of needing a clipboard permission.
    await page.evaluateOnNewDocument(() => {
      window.__copied = [];
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: async (t) => void window.__copied.push(t), readText: async () => "" },
      });
      localStorage.clear();
    });
    for (let i = 0; i < 5; i++) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      try {
        await page.waitForFunction(() => window.__demo?.useToasts && document.body.innerText.includes("Faro"), { timeout: 15000 });
        break;
      } catch (e) {
        if (i === 4) throw e;
      }
    }
    const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    // Close the welcome / what's new if the mock opened one.
    await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());

    // --- 75: a repeating failure replaces its own toast and counts up. ---
    const baseline = await page.evaluate(() => {
      const t = window.__demo.useToasts.getState();
      t.markAllRead();
      return t.history.length;
    });
    await page.evaluate(() => {
      const { push } = window.__demo.useToasts.getState();
      for (let i = 0; i < 3; i++)
        push({ id: "connect:p-api", variant: "error", title: "Couldn't connect to api", message: "Connection refused", detail: "ECONNREFUSED 10.0.0.5:22 (network)" });
    });
    await frames();
    const cards = await page.$$eval('[role="alert"]', (els) => els.filter((e) => e.textContent.includes("Couldn't connect to api")).length);
    assert.equal(cards, 1, "three repeats show one card");
    assert.equal(await page.$eval("[data-toast-repeat]", (e) => e.textContent.trim()), "×3");
    const st = await page.evaluate(() => {
      const s = window.__demo.useToasts.getState();
      return { history: s.history.length, unread: s.unreadCount };
    });
    assert.equal(st.history, baseline + 1, "one history entry for the repeats");
    assert.equal(st.unread, 1, "repeats bump unread once");

    // Ephemeral confirmations (copy/paste) stay out of the notification log.
    await page.evaluate(() =>
      window.__demo.useToasts.getState().push({ variant: "info", title: "Copied 3 items", log: false })
    );
    const quiet = await page.evaluate(() => {
      const s = window.__demo.useToasts.getState();
      return { onScreen: s.toasts.some((t) => t.title === "Copied 3 items"), logged: s.history.some((t) => t.title === "Copied 3 items"), unread: s.unreadCount };
    });
    assert.deepEqual(quiet, { onScreen: true, logged: false, unread: 1 });

    // --- 77: error toasts offer Copy details with the raw error. ---
    await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"] button')].some((b) => b.textContent.includes("Copy details")));
    await page.screenshot({ path: join(shots, "error-toast-copy-details.png") });
    await page.evaluate(() => [...document.querySelectorAll('[role="alert"] button')].find((b) => b.textContent.includes("Copy details")).click());
    await page.waitForFunction(() => window.__copied.length > 0);
    const copied = await page.evaluate(() => window.__copied.at(-1));
    assert.match(copied, /^Couldn't connect to api\nConnection refused/);
    assert.match(copied, /Error: ECONNREFUSED 10\.0\.0\.5:22 \(network\)/);
    assert.match(copied, /Time: \d{4}-\d\d-\d\dT/);
    await page.evaluate(() => {
      const s = window.__demo.useToasts.getState();
      s.toasts.forEach((t) => s.dismiss(t.id));
      s.markAllRead();
    });

    // --- 100: the file-list skeleton waits 200 ms. ---
    await page.evaluate(() => {
      window.__skeletonSeen = false;
      new MutationObserver(() => {
        if (document.querySelector('[data-file-skeleton="shown"]')) window.__skeletonSeen = true;
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    const profiles = await page.evaluate(() => window.__demo.useConnections.getState().profiles.filter((p) => p.protocol === "sftp").map((p) => p.id));
    assert.ok(profiles.length >= 2, "two SFTP demo servers");
    // Fast listing (mock answers at once): no placeholder flash.
    await page.evaluate((id) => window.__demo.focusProfile(id), profiles[0]);
    await page.waitForFunction(() => window.__demo.useConnections.getState().activeSessionId);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal(await page.evaluate(() => window.__skeletonSeen), false, "a fast listing never shows the skeleton");
    // Slow listing: the skeleton appears, but only after the delay.
    await page.evaluate(() => { window.__listDelay = 1500; });
    const t0 = Date.now();
    await page.evaluate((id) => window.__demo.focusProfile(id), profiles[1]);
    await page.waitForSelector('[data-file-skeleton="shown"]', { timeout: 3000 });
    assert.ok(Date.now() - t0 >= 180, "skeleton waited before showing");
    await page.screenshot({ path: join(shots, "deferred-skeleton.png") });
    await page.evaluate(() => { window.__listDelay = 0; });
    await page.waitForFunction(() => !document.querySelector('[data-file-skeleton="shown"]'), { timeout: 4000 });

    // --- 104: a crashing region shows a recover panel; the rest keeps working. ---
    await page.evaluate(() => window.__demo.useCrashTest.getState().crash("File browser"));
    await page.waitForSelector('[data-error-boundary="File browser"]');
    const panel = await page.$eval('[data-error-boundary="File browser"]', (e) => e.textContent);
    assert.match(panel, /File browser stopped working/);
    assert.match(panel, /Test crash in File browser/);
    assert.ok(await page.$('button[title="Notifications"]'), "status bar still rendered");
    // Logged into the notification centre, counted on the error pill.
    await page.waitForSelector("[data-error-pill]");
    assert.match(await page.$eval("[data-error-pill]", (e) => e.textContent), /Error.*1/);
    await page.screenshot({ path: join(shots, "error-boundary-recover.png") });
    // Copy details from the panel.
    await page.evaluate(() => [...document.querySelectorAll('[data-error-boundary] button')].find((b) => b.textContent.includes("Copy details")).click());
    await page.waitForFunction(() => window.__copied.at(-1)?.startsWith("File browser stopped working"));
    // Try again re-mounts just that region.
    await page.evaluate(() => [...document.querySelectorAll('[data-error-boundary] button')].find((b) => b.textContent.includes("Try again")).click());
    await page.waitForFunction(() => !document.querySelector("[data-error-boundary]"));

    // Stray errors land in the same log.
    // (Headless Chrome under CDP doesn't raise real unhandledrejection
    // events, so dispatch one the way the browser would.)
    await page.evaluate(() => {
      window.dispatchEvent(new PromiseRejectionEvent("unhandledrejection", { promise: Promise.resolve(), reason: new Error("background boom") }));
    });
    await page.waitForFunction(() => window.__demo.useToasts.getState().history.some((t) => t.message === "background boom"));
    assert.match(await page.$eval("[data-error-pill]", (e) => e.textContent), /Errors.*2/);
    // The pill opens the notification centre filtered to errors and clears.
    await page.click("[data-error-pill]");
    await page.waitForSelector('[data-notif-filter="errors"][aria-selected="true"]');
    await frames();
    await page.screenshot({ path: join(shots, "status-bar-error-pill.png") });
    const listed = await page.evaluate(() => document.body.innerText);
    assert.match(listed, /File browser stopped working/);
    assert.match(listed, /background boom/);
    assert.equal(await page.$("[data-error-pill]"), null, "pill clears once seen");
    await page.keyboard.press("Escape");

    // --- 84: a dismissed nudge is remembered per item. ---
    const nudges = await page.evaluate(() => {
      const n = window.__demo.useNudges.getState();
      n.reset();
      n.dismiss("ports-root:p-a");
      const d = window.__demo.useNudges.getState().dismissed;
      return { a: d.includes("ports-root:p-a"), b: d.includes("ports-root:p-b"), stored: localStorage.getItem("faro.nudges.dismissed.v1") };
    });
    assert.deepEqual(nudges, { a: true, b: false, stored: '["ports-root:p-a"]' });

    // --- 105/106: welcome only for new installs; What's New never for them. ---
    const plans = await page.evaluate(async () => {
      const { planDiscovery } = await import("/src/stores/discoveryStore.ts");
      const v = "1.4.0";
      return {
        fresh: planDiscovery({ seen: null, version: v, profileCount: 0, priorLaunch: false }),
        priorLaunch: planDiscovery({ seen: null, version: v, profileCount: 0, priorLaunch: true }),
        hasProfiles: planDiscovery({ seen: null, version: v, profileCount: 2, priorLaunch: false }),
        unreadable: planDiscovery({ seen: null, version: v, profileCount: null, priorLaunch: false }),
        same: planDiscovery({ seen: v, version: v, profileCount: 0, priorLaunch: false }),
        patch: planDiscovery({ seen: "1.4.0", version: "1.4.3", profileCount: 0, priorLaunch: false }),
        minor: planDiscovery({ seen: "1.3.9", version: v, profileCount: 0, priorLaunch: false }),
        downgrade: planDiscovery({ seen: "1.5.0", version: v, profileCount: 0, priorLaunch: false }),
      };
    });
    assert.deepEqual(plans, {
      fresh: "welcome",
      priorLaunch: "notice",
      hasProfiles: "notice",
      unreadable: "quiet",
      same: "none",
      patch: "notice",
      minor: "whatsNew",
      downgrade: "quiet",
    });

    // A fresh install records the version as soon as the welcome opens, so a
    // failed or abandoned welcome never loops and What's New never follows.
    await page.evaluate(() => {
      sessionStorage.setItem("faro-mock-discovery", "{}");
      sessionStorage.setItem("faro-mock-fresh", "1");
    });
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__demo?.useLayout?.getState().dialog === "welcome", { timeout: 20000 });
    const seen = await page.evaluate(() => JSON.parse(sessionStorage.getItem("faro-mock-discovery")).discoverySeenVersion);
    assert.ok(seen, "version recorded while the welcome is still open");
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__demo?.useDiscovery?.getState().version);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(await page.evaluate(() => window.__demo.useLayout.getState().dialog), null, "no welcome or What's New on the next launch");

    assert.deepEqual(errors.filter((e) => !/Test crash|background boom/.test(e)), []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
