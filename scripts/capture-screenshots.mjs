// Headless screenshot capture for Faro's README.
//
// Spins up the mock/demo Vite build (no Rust backend), drives the UI into each
// state via the window.__demo store handles, and writes PNGs into
// docs/screenshots/. Uses an already-installed Chrome/Edge via puppeteer-core —
// no browser download.
//
//   npm run shots
//
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "docs", "screenshots");
const PORT = 1425;
const URL = `http://localhost:${PORT}/`;

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];
const chrome = CHROME_CANDIDATES.find((p) => p && existsSync(p));
if (!chrome) {
  console.error("No Chrome/Edge found. Install one, set CHROME_PATH, or edit CHROME_CANDIDATES.");
  process.exit(1);
}

const isWin = process.platform === "win32";

async function waitForServer(url, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`Vite mock server never came up at ${url}`);
}

function killTree(child) {
  if (!child || child.killed) return;
  if (isWin) {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
  }
}

async function main() {
  console.log("› starting mock Vite server…");
  const server = spawn(
    "npm",
    ["run", "dev:mock"],
    { cwd: ROOT, shell: true, stdio: "ignore", detached: !isWin }
  );

  let browser;
  try {
    await waitForServer(URL);
    console.log("› server up, launching browser…");

    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
      args: ["--force-color-profile=srgb", "--hide-scrollbars"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (e) => console.warn("  page error:", e.message));
    await page.goto(URL, { waitUntil: "networkidle0" });

    // Drive a store: page.evaluate body has access to window.__demo.
    const drive = (fn, ...args) => page.evaluate(fn, ...args);
    const settle = (ms = 450) => sleep(ms);

    // Wait until the auto-connect (api-prod) has produced an active session.
    await page.waitForFunction(
      () => !!window.__demo?.useConnections.getState().activeSessionId,
      { timeout: 15_000 }
    );
    await settle(700);

    const root = async () => await page.$("#root");
    const shot = async (name, clip) => {
      const file = path.join(OUT, `${name}.png`);
      // captureBeyondViewport would resize the page, which closes open menus.
      if (clip) await page.screenshot({ path: file, clip, captureBeyondViewport: false });
      else await (await root()).screenshot({ path: file });
      console.log("  ✓", `${name}.png`);
    };

    const setLayout = (l) => drive((l) => window.__demo.useSettings.getState().setBrowserLayout(l), l);
    const setRail = (v) => drive((v) => window.__demo.useSettings.getState().setRailExpanded(v), v);
    const openDialog = (d) => drive((d) => window.__demo.useLayout.getState().openDialog(d), d);
    const closeDialog = () => drive(() => window.__demo.useLayout.getState().closeDialog());
    const setTerminal = (v) => drive((v) => window.__demo.useLayout.getState().setTerminalOpen(v), v);
    const setPanel = (v) => drive((v) => window.__demo.useTransfers.getState().setPanelOpen(v), v);
    const focus = (id) => drive((id) => window.__demo.focusProfile(id), id);

    // 1) Overview — dual-pane browser, api-prod connected.
    await setLayout("dual");
    await settle(700);
    await shot("overview");

    // 2) Server rail — expanded labeled mode (clip to the left column).
    await setRail(true);
    await settle(500);
    // Clip is in CSS px; the viewport is 1440×900, rail expands to 224px.
    await shot("server-rail", { x: 0, y: 0, width: 300, height: 900 });
    await setRail(false);

    // 3) Terminal — open the dock; the mock streams a transcript.
    await setTerminal(true);
    await settle(900);
    await shot("terminal");
    await setTerminal(false);

    // 4) File actions — right-click a directory row (single layout).
    await setLayout("single");
    await settle(700);
    const rowBox = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[role="option"]')];
      const el = rows[1] ?? rows[0];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      // Near the name, so the menu opens beside it rather than mid-list.
      return { x: r.x + Math.min(160, r.width / 2), y: r.y + r.height / 2 };
    });
    if (rowBox) {
      await page.mouse.click(rowBox.x, rowBox.y, { button: "right" });
      await settle(900);
      await shot("context-menu", { x: 0, y: 0, width: 1440, height: 900 });
      await page.keyboard.press("Escape");
    }

    // 5) Transfers panel.
    await setPanel(true);
    await settle(450);
    await shot("transfers");
    await setPanel(false);

    // 6) Directory sync — dual layout, open the sync dialog via its button.
    await setLayout("dual");
    await settle(600);
    const syncBtn = await page.$('[aria-label="Sync folders"]');
    if (syncBtn) {
      await syncBtn.click();
      await settle(500);
      // Click "Plan" so the mock returns a diff to display.
      await page.evaluate(() => {
        const b = [...document.querySelectorAll("button")].find(
          (x) => x.textContent.trim() === "Plan"
        );
        b?.click();
      });
      await settle(700);
      await shot("sync");
      await page.keyboard.press("Escape");
      await settle(200);
    }

    // 7) Agent Bridge dialog (two-column panel).
    await openDialog("agentBridge");
    await settle(600);
    await shot("agent-bridge");
    await closeDialog();
    await settle(200);

    // 7b) Agent Bridge approval prompt — emit a mock approval event.
    await drive(() =>
      window.__demo.emit("bridge://approval", {
        requestId: "demo-req-1",
        sessionId: "sess-p-api",
        sessionName: "api-prod",
        kind: "exec",
        command: "systemctl restart api && journalctl -u api -n 50 --no-pager",
      })
    );
    await settle(500);
    await shot("agent-bridge-approve");
    await drive(() =>
      window.__demo.useBridge.getState().respond("demo-req-1", "deny")
    );
    await settle(200);

    // 8) New connection dialog.
    await openDialog("newConnection");
    await settle(500);
    await shot("new-connection");
    await closeDialog();

    // 9) Settings dialog.
    await openDialog("settings");
    await settle(500);
    await shot("settings");
    await closeDialog();

    // 10) Disk Usage explorer — treemap + size-ranked list over a remote tree.
    // A full-screen overlay; drive the store straight into a finished scan.
    // Captured before the bucket step so no stray connect toast lingers over it
    // (api-prod is still connected from boot — sess-p-api is live).
    await drive(() =>
      window.__demo.useDiskScan.getState().openFor("sess-p-api", "/var/www/api")
    );
    await settle(1100); // let the ResizeObserver size the canvas + paint
    await shot("disk-usage");
    await drive(() => window.__demo.useDiskScan.getState().close());
    await settle(200);

    // 11) S3 / object storage — focus a bucket, single layout.
    await setLayout("single");
    await focus("p-s3");
    await settle(800);
    await shot("object-storage");

    console.log("› done. Wrote PNGs to docs/screenshots/");
  } finally {
    if (browser) await browser.close();
    killTree(server);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
