// Headless runtime verification for the fleet-scale UI redesign: title-bar
// search, rail folders + agent badges, the docked agent panel, the Agent
// Bridge access matrix, the file preview pane and Disk Usage. Spins up the
// mock Vite build (no Rust), drives the UI via window.__demo, and asserts on
// the rendered DOM. Writes PNGs to SHOT_DIR. Exit code 0 = all checks passed.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { mkdirSync } from "node:fs";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT =
  process.env.SHOT_DIR ||
  path.join(os.tmpdir(), "faro-verify");
mkdirSync(OUT, { recursive: true });
const PORT = 1425;
const URL = `http://localhost:${PORT}/`;

const CHROME_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
const chrome = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!chrome) {
  console.error("No Chrome/Edge found.");
  process.exit(2);
}
const isWin = process.platform === "win32";

let failures = 0;
function check(name, cond, detail = "") {
  const ok = !!cond;
  if (!ok) failures++;
  console.log(`  ${ok ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function waitForServer(url, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
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

async function main() {
  console.log("› starting mock Vite server…");
  const server = spawn("npm", ["run", "dev:mock"], {
    cwd: ROOT,
    shell: true,
    stdio: "ignore",
    detached: !isWin,
  });
  let browser;
  try {
    await waitForServer(URL);
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
      args: ["--hide-scrollbars"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (e) => {
      console.log("  page error:", e.message);
      failures++;
    });
    await page.goto(URL, { waitUntil: "networkidle0" });

    const D = (fn, ...a) => page.evaluate(fn, ...a);
    const shot = async (name) => {
      await page.screenshot({ path: path.join(OUT, `redesign-${name}.png`) });
      console.log("    · shot", `redesign-${name}.png`);
    };
    const text = () => D(() => document.body.innerText);

    await page.waitForFunction(
      () => !!window.__demo?.useConnections.getState().activeSessionId,
      { timeout: 20_000 }
    );
    await sleep(800);

    // Fleet shape: put the mock servers into folders like a real rail.
    await D(() => {
      const c = window.__demo.useConnections;
      const groups = { "p-api": "production", "p-edge": "production", "p-db": "staging", "p-ftp": "legacy", "p-s3": "storage", "p-cdn": "storage" };
      c.setState({ profiles: c.getState().profiles.map((p) => ({ ...p, group: groups[p.id] ?? p.group })) });
      const s = window.__demo.useSettings.getState();
      if (!s.railCollapsedGroups.includes("storage")) s.toggleRailGroup("storage");
    });
    await sleep(500);

    // ---- 1. Title bar search opens the palette ----
    const hasSearch = await D(() => [...document.querySelectorAll("button")].some((b) => b.innerText.includes("Go to server, path or command")));
    check("title bar shows the centred command search", hasSearch);
    await shot("1-shell");

    // ---- 2. Rail: closed folder tile + agent dot ----
    const rail = await D(() => ({
      folder: !!document.querySelector('[aria-label^="storage group, 2 servers"]'),
      openStrip: !!document.querySelector('[aria-label^="production group"]'),
    }));
    check("closed group renders as a folder tile", rail.folder);
    check("open group header present", rail.openStrip);

    // ---- 3. An approval arrives → red badges + status pill ----
    await D(() => window.__demo.emit("bridge://approval", {
      requestId: "r1", sessionId: window.__demo.useConnections.getState().activeSessionId,
      sessionName: "api-prod", kind: "exec", command: "systemctl restart api.service",
    }));
    await sleep(400);
    const pend = await D(() => ({
      badge: document.querySelectorAll('[aria-label="1 waiting for approval"]').length,
      modal: !!document.querySelector('[aria-modal="true"]'),
      pill: document.body.innerText.includes("Agent waiting"),
    }));
    check("pending badge on the server bubble", pend.badge >= 1, `badges=${pend.badge}`);
    check("approval modal shows when the panel is closed", pend.modal);
    check("status pill says the agent is waiting", pend.pill);
    await shot("2-pending-modal");

    // ---- 4. Agent panel: queue inline, modal suppressed, access controls ----
    await D(() => window.__demo.useLayout.getState().setAgentDrawerOpen(true));
    await sleep(400);
    const drawer = await D(() => {
      const aside = document.querySelector('aside[aria-label="Agent"]');
      return {
        open: !!aside,
        card: !!aside?.innerText.includes("systemctl restart api.service"),
        modal: !!document.querySelector('[aria-modal="true"]'),
        segs: aside ? aside.querySelectorAll('[role="radiogroup"]').length : 0,
      };
    });
    check("agent panel opens", drawer.open);
    check("approval is inline in the panel", drawer.card);
    check("modal suppressed while the panel shows the queue", !drawer.modal);
    check("panel shows access controls for the focused server", drawer.segs >= 3, `segs=${drawer.segs}`);
    await shot("3-agent-panel");

    // ---- 5. Agent Bridge page: matrix, cell edit, bulk bar ----
    await D(() => window.__demo.useLayout.getState().openDialog("agentBridge"));
    await sleep(600);
    const page5 = await D(() => {
      const region = document.querySelector('[role="region"][aria-label="Agent Bridge"]');
      return {
        open: !!region,
        rows: region ? region.querySelectorAll('input[aria-label^="Select "]:not([aria-label^="Select all"])').length : 0,
      };
    });
    check("Agent Bridge page opens over the work area", page5.open);
    check("matrix lists every saved server", page5.rows === 6, `rows=${page5.rows}`);
    await D(() => {
      const g = document.querySelector('[role="radiogroup"][aria-label="Run commands on web-edge"]');
      [...g.querySelectorAll("button")].find((b) => b.innerText === "Ask").click();
    });
    await sleep(300);
    const acc = await D(() => window.__demo.useBridge.getState().status.profileAccess["p-edge"]);
    check("setting a cell grants that server", acc?.exec === "ask", JSON.stringify(acc));
    await D(() => {
      for (const n of ["api-prod", "web-edge"]) document.querySelector(`input[aria-label="Select ${n}"]`).click();
    });
    await sleep(300);
    check("bulk bar appears for a selection", (await text()).includes("2 selected"));
    await shot("4-access-matrix");
    await D(() => [...document.querySelectorAll('[role="tab"]')].find((t) => t.innerText.startsWith("Setup")).click());
    await sleep(400);
    check("setup tab renders the endpoint card", (await text()).toLowerCase().includes("local endpoint"));
    await shot("5-setup-tab");
    await D(() => window.__demo.useLayout.getState().closeDialog());
    await sleep(300);
    // ---- 6. Files: details view by default + text preview of a selection ----
    await D(() => window.__demo.useBridge.getState().respond("r1", "deny"));
    await D(() => window.__demo.useLayout.getState().setAgentDrawerOpen(false));
    await sleep(300);
    const det = await D(() => window.__demo.useSettings.getState().paneViewMode);
    check("details is the default view", det === "details", det);
    await D(() => {
      const pane = document.querySelector("[data-file-pane]");
      const row = [...pane.querySelectorAll("*")].find(
        (el) => el.children.length === 0 && el.textContent === "server.js"
      );
      row.click();
    });
    await sleep(700);
    const prev = await D(() => {
      const aside = document.querySelector('aside[aria-label="File preview"]');
      return { open: !!aside, text: aside?.innerText ?? "" };
    });
    check("selecting a file opens the preview", prev.open);
    check("preview shows the file's lines", prev.text.includes("step 1 ok"), prev.text.slice(0, 80));
    await shot("6-file-preview");

    // ---- 7. Disk Usage opens inside the work area, folder-coloured ----
    await D(() => {
      const sid = window.__demo.useConnections.getState().activeSessionId;
      return window.__demo.useDiskScan.getState().openFor(sid, "/var/www/api");
    });
    await sleep(1200);
    const du = await D(() => ({
      text: document.body.innerText,
      rail: !!document.querySelector('[data-rail-scroll]'),
      mode: window.__demo.useDiskScan.getState().colorMode,
    }));
    check("disk usage shows the space summary", du.text.includes("What's using the space"));
    check("disk usage colours by folder by default", du.mode === "folder", du.mode);
    check("rail stays visible beside disk usage", du.rail);
    await shot("7-disk-usage");
    console.log("");
    if (failures === 0) console.log("✅ all redesign checks passed");
    else console.log(`❌ ${failures} check(s) failed`);
  } finally {
    if (browser) await browser.close();
    killTree(server);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("verify crashed:", e);
  process.exit(3);
});
