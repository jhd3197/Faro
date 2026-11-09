// Run with npm run dev:mock serving localhost:1425.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";

const executablePath = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  process.env.CHROME_PATH,
].find(p => p && existsSync(p));
assert.ok(executablePath, "Set CHROME_PATH to an installed Chromium browser");
const browser = await puppeteer.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("http://localhost:1425", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__demo?.useConnections.getState().activeSessionId);
  await page.evaluate(async () => {
    window.__demo.useSettings.getState().setBrowserLayout("dual");
    const { ipc } = await import("/src/lib/ipc.ts");
    window.__syncPlans = [];
    ipc.syncExecute = async (_sessionId, plan) => { window.__syncPlans.push(plan); return []; };
    window.__versions = [{ batch: "1794000000-demo", relative: "dist/old.js", size: 120,
      state: { size: 120, modified: 1794000000, etag: null } }];
    ipc.syncRecoveryList = async () => window.__versions;
    ipc.syncRecoveryRestore = async (_id, root) => {
      window.__versions = [];
      return `${root}/dist/old.js.restored-demo`;
    };
  });
  const clickText = async text => {
    await page.evaluate(text => {
      const button = [...document.querySelectorAll('[role="dialog"] button')]
        .find(b => b.textContent.trim() === text);
      if (!button || button.disabled) throw new Error(`Missing or disabled button: ${text}`);
      button.click();
    }, text);
  };
  await page.click('[aria-label="Sync folders"]');
  await clickText("Plan");
  await page.waitForSelector('input[aria-label="Copy dist/app.js"]');
  await page.click('input[aria-label="Copy dist/app.js"]');
  await page.screenshot({ path: path.join(os.tmpdir(), "faro-sync-preview.png") });
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.startsWith("Execute")).click());
  await page.waitForFunction(() => window.__syncPlans.length === 1);
  const copies = await page.evaluate(() => window.__syncPlans[0].copies.map(c => c.relative));
  assert.equal(copies.length, 2);
  assert.ok(!copies.includes("dist/app.js"));

  await page.click('[aria-label="Sync folders"]');
  await clickText("Plan");
  await page.waitForSelector('input[aria-label="Copy dist/app.js"]');
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.includes("Remote → Local")).click());
  await page.waitForFunction(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.startsWith("Execute"))?.disabled);
  assert.equal(await page.$('input[aria-label="Copy dist/app.js"]'), null);
  await clickText("Recover files");
  await page.waitForSelector('[aria-label="Restore dist/old.js"]');
  await page.screenshot({ path: path.join(os.tmpdir(), "faro-sync-recovery.png") });
  await page.click('[aria-label="Restore dist/old.js"]');
  await page.waitForFunction(() => document.body.textContent.includes("Restored to") && document.body.textContent.includes("No saved versions"));
  assert.deepEqual(errors, []);
  console.log("PASS: skipped copies excluded, direction invalidates preview, recovery renders and restores");
} finally {
  await browser.close();
}
