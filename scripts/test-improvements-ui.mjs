// Run against npm run dev:mock. Exercises the new controls and their IPC inputs.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import puppeteer from "puppeteer-core";
const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find(p => p && existsSync(p));
assert.ok(executablePath);
const browser = await puppeteer.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 800 });
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto("http://127.0.0.1:1425", { waitUntil: "networkidle0" });
  await page.waitForFunction(() => window.__demo?.useConnections.getState().profiles.length);
  const click = async text => {
    const button = await page.evaluateHandle(text => [...document.querySelectorAll("button")].find(b => b.textContent.trim() === text), text);
    assert.ok(button.asElement(), `Missing button: ${text}`);
    await button.asElement().click();
  };
  await page.evaluate(() => window.__demo.useLayout.getState().openExport());
  await page.waitForSelector('input[aria-label="Passphrase"]');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("label")].find(e => e.textContent.includes("Encrypt connection settings"))?.querySelector("input").checked), true);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("label")].find(e => e.textContent.includes("Include secrets"))?.querySelector("input").checked), false);
  await page.evaluate(() => {
    const d = window.__demo;
    d.useLayout.getState().closeDialog();
    d.useLayout.getState().openNewConnection({ ...d.useConnections.getState().profiles[0], notes: "Maintenance runbook", group: "Production" });
  });
  await page.waitForSelector("details summary");
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("summary")].find(e => e.textContent === "More options").parentElement.open), false);
  await page.screenshot({ path: path.join(os.tmpdir(), "faro-connection-simple.png") });
  await page.evaluate(() => [...document.querySelectorAll("summary")].find(e => e.textContent === "More options").click());
  await page.waitForSelector("textarea");
  assert.equal(await page.$eval("textarea", e => e.value), "Maintenance runbook");
  await click("Test connection");
  await page.waitForFunction(() => document.body.textContent.includes("Connection diagnostics"));
  await page.evaluate(() => [...document.querySelectorAll("summary")].find(e => e.textContent === "Connection diagnostics").click());
  assert.ok(await page.evaluate(() => document.body.textContent.includes("Starting folder access")));
  const diagnosticShot = path.join(os.tmpdir(), "faro-diagnostics-ui.png");
  await page.screenshot({ path: diagnosticShot });
  await page.evaluate(async () => {
    const d = window.__demo;
    d.useLayout.getState().closeDialog();
    const profile = d.useConnections.getState().profiles[0];
    window.__beforeGroup = profile.group;
    await d.useConnections.getState().saveProfiles([{ ...profile, group: "Moved group" }]);
  });
  await page.waitForSelector('[aria-label="Undo organization"]');
  await page.click('[aria-label="Undo organization"]');
  await page.waitForFunction(() => window.__demo.useConnections.getState().profiles[0].group === window.__beforeGroup);
  await page.evaluate(async () => {
    const { ipc } = await import("/src/lib/ipc.ts");
    const pair = { id: "review", name: "Project files", profileId: window.__demo.useConnections.getState().profiles[0].id,
      localRoot: "C:/Work/project", remoteRoot: "/srv/project", direction: "localToRemote", twoWay: true, strategy: "mirror",
      mode: "mirror", enabled: true, pollIntervalSecs: 60, exclude: [], mirrorDeleteCap: 100,
      state: "idle", inFlight: 0, lastSynced: Date.now(), lastError: "1 file conflict needs review" };
    ipc.folderSyncList = async () => [pair];
    ipc.folderSyncSyncNow = async () => [pair];
    let conflicts = [{ identity: "test", relative: "src/config.json", revision: 3,
      state: { local: { size: 128, modified: 100, etag: null }, remote: { size: 160, modified: 101, etag: null } } }];
    ipc.folderSyncConflicts = async () => conflicts;
    ipc.folderSyncResolve = async (id, conflict, local) => { window.__choice = { id, conflict, local }; conflicts = []; };
    window.__demo.useLayout.getState().openSettings("sync");
  });
  await page.waitForFunction(() => document.body.textContent.includes("Use local (128 bytes)"));
  const conflictShot = path.join(os.tmpdir(), "faro-conflicts-ui.png");
  await page.screenshot({ path: conflictShot });
  await click("Use local (128 bytes)");
  await page.waitForFunction(() => window.__choice?.local === true);
  assert.equal(await page.evaluate(() => window.__choice.conflict.revision), 3);
  await click("Add folder");
  await page.waitForFunction(() => document.body.textContent.includes("Start syncing"));
  await page.screenshot({ path: path.join(os.tmpdir(), "faro-sync-simple.png") });
  await page.evaluate(() => {
    const select = [...document.querySelectorAll("select")].find(e => [...e.options].some(o => o.value === "both"));
    select.value = "both";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForFunction(() => document.body.textContent.includes("If both copies change"));
  await page.evaluate(async () => {
    const { ipc } = await import("/src/lib/ipc.ts");
    ipc.folderSyncUpsert = async pair => { window.__savedPair = pair; return []; };
  });
  await page.type('input[placeholder="My project"]', "Website");
  const localInput = await page.evaluateHandle(() => [...document.querySelectorAll("input")].find(e => e.placeholder.startsWith("C:")));
  await localInput.asElement().type("C:/Work/website");
  await click("Start syncing");
  await page.waitForFunction(() => window.__savedPair);
  assert.equal(await page.evaluate(() => window.__savedPair.twoWay), true);
  assert.equal(await page.evaluate(() => window.__savedPair.strategy), "additive");
  assert.equal(await page.evaluate(() => window.__savedPair.localRoot), "C:/Work/website");
  await page.evaluate(async () => {
    const { ipc } = await import("/src/lib/ipc.ts");
    const status = { enabled: true, running: true, hostname: "Workstation", os: "windows", fingerprint: "test", port: 8722,
      publicKey: "test-public-key", allowWrite: false, allowExec: false, peers: [], pairing: null,
      relay: { address: "relay.example.com:8723", publicKey: "relay-public-key" }, relayOnline: true };
    ipc.agentHostStatus = async () => status;
    ipc.agentHostSetRelay = async relay => { window.__savedRelay = relay; return { ...status, relay }; };
    window.__demo.useLayout.getState().openSettings("remoteControl");
  });
  await page.waitForSelector('[aria-label="Host relay address"]');
  await page.waitForFunction(() => document.body.textContent.includes("Relay available"));
  const relayShot = path.join(os.tmpdir(), "faro-relay-ui.png");
  await page.screenshot({ path: relayShot });
  await page.click('[aria-label="Host relay address"]', { clickCount: 3 });
  await page.type('[aria-label="Host relay address"]', "new-relay.example.com:8723");
  await new Promise(resolve => setTimeout(resolve, 5200));
  assert.equal(await page.$eval('[aria-label="Host relay address"]', input => input.value), "new-relay.example.com:8723");
  await click("Save relay settings");
  await page.waitForFunction(() => window.__savedRelay?.address === "new-relay.example.com:8723");
  assert.deepEqual(errors, []);
  console.log(`PASS: encrypted settings, notes, diagnostics, organization undo and version-bound conflict choice\n${diagnosticShot}\n${conflictShot}`);
} finally { await browser.close(); }
