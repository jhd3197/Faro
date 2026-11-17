// Headless runtime check for issue #80: with the dual-pane (split) browser
// open, the pane-resize divider and its Sync button must not draw or be
// hoverable over the Agent Bridge page (or the other full-page views). Spins up
// the mock Vite build, drives window.__demo, asserts on the DOM, writes PNGs.
// Exit code 0 = all checks passed.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.SHOT_DIR || ROOT;
const PORT = 1425;
const URL = `http://localhost:${PORT}/`;
const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));
if (!chrome) {
  console.error("No Chrome/Edge found.");
  process.exit(2);
}
const isWin = process.platform === "win32";

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function waitForServer(url, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`mock server never came up at ${url}`);
}
function killTree(child) {
  if (!child || child.killed) return;
  if (isWin) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else try { process.kill(-child.pid, "SIGKILL"); } catch {}
}

/** What sits on top at the divider's centre, and whether the divider is shown. */
const probeDivider = () => {
  const sep = document.querySelector('[aria-label="Resize file browser panes"]');
  if (!sep) return { exists: false };
  const r = sep.getBoundingClientRect();
  const x = r.left + r.width / 2;
  // Above the centred Sync button, which would otherwise be the hit.
  const y = r.top + Math.min(120, r.height / 4);
  const top = document.elementFromPoint(x, y);
  return {
    exists: true,
    visibility: getComputedStyle(sep).visibility,
    hitIsDivider: top === sep || !!top?.closest('[aria-label="Resize file browser panes"]'),
    hitInBridge: !!top?.closest('[aria-label="Agent Bridge"]'),
    x,
  };
};

async function main() {
  console.log("› starting mock Vite server…");
  const server = spawn("npm", ["run", "dev:mock"], { cwd: ROOT, shell: true, stdio: "ignore", detached: !isWin });
  let browser;
  try {
    await waitForServer(URL);
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 1 },
      args: ["--hide-scrollbars"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (e) => {
      console.log("  page error:", e.message);
      failures++;
    });
    for (let i = 0; i < 5; i++) {
      await page.goto(URL, { waitUntil: "networkidle0" });
      if (await page.evaluate(() => !!window.__demo)) break;
      await sleep(1500);
    }

    // Split view on, connected to a server.
    await page.evaluate(async () => {
      window.__demo.useSettings.getState().setBrowserLayout("dual");
      await window.__demo.focusProfile("p-api");
    });
    await sleep(800);
    const before = await page.evaluate(probeDivider);
    check("divider is shown and hoverable in split view", before.exists && before.visibility === "visible" && before.hitIsDivider);

    // Open the Agent Bridge page over it.
    await page.evaluate(() => window.__demo.useLayout.getState().openDialog("agentBridge"));
    await sleep(800);
    const over = await page.evaluate(probeDivider);
    check("divider hidden while Agent Bridge is open", over.visibility === "hidden", JSON.stringify(over));
    check("the page, not the divider, is under the cursor", !over.hitIsDivider && over.hitInBridge);
    const syncHit = await page.evaluate(() => {
      const b = document.querySelector('[aria-label="Sync folders"]');
      if (!b) return "none";
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return top === b || b.contains(top) ? "button" : "page";
    });
    check("swap/sync button not clickable over the page", syncHit !== "button", syncHit);
    await page.mouse.move(over.x, 300);
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, "issue-80-agent-bridge-split.png") });

    // Setup tab: the new "Allow direct CLI access" switch (issue #81).
    await page.evaluate(() => {
      const t = [...document.querySelectorAll('[aria-label="Agent Bridge"] button')].find((b) => b.textContent?.trim() === "Setup & commands");
      t?.click();
    });
    await sleep(600);
    const hasToggle = await page.evaluate(() => document.body.innerText.includes("Allow direct CLI access"));
    check("Setup tab shows 'Allow direct CLI access'", hasToggle);
    await page.evaluate(() => {
      const el = [...document.querySelectorAll("div")].find((d) => d.textContent === "Allow direct CLI access");
      el?.scrollIntoView({ block: "center" });
    });
    await sleep(300);
    await page.screenshot({ path: path.join(OUT, "issue-81-setup-mock.png") });

    // Closing the page brings the divider back.
    await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
    await sleep(500);
    const after = await page.evaluate(probeDivider);
    check("divider back after closing the page", after.visibility === "visible" && after.hitIsDivider);
  } finally {
    await browser?.close();
    killTree(server);
  }
  console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
