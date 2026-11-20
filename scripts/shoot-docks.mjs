// Screenshot the Agent console dock and the update bars, wide and narrow.
//   node scripts/shoot-docks.mjs <out-dir> [port]
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

const OUT = process.argv[2];
const PORT = Number(process.argv[3] || 1446);
if (!OUT) {
  console.error("usage: node scripts/shoot-docks.mjs <out-dir> [port]");
  process.exit(2);
}
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].find((p) => p && existsSync(p));

process.env.VITE_UI_LOCALE = "en";
mkdirSync(OUT, { recursive: true });
const server = await createServer({
  mode: "mock",
  logLevel: "error",
  server: { host: "127.0.0.1", port: PORT, strictPort: true, hmr: false, watch: { ignored: ["**/*"] } },
});
let browser;
let failures = 0;
try {
  await server.listen();
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  page.on("pageerror", (e) => {
    failures++;
    console.log("pageerror:", e.message);
  });
  await page.setViewport({ width: 1440, height: 900 });
  for (let i = 0; i < 5; i++) {
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(() => window.__demo?.useBridge && document.body.innerText.includes("Faro"), { timeout: 20000 });
      break;
    } catch {
      if (i === 4) throw new Error("demo never booted");
    }
  }

  await page.evaluate(() => {
    const d = window.__demo;
    const sid = d.useConnections.getState().sessions[0]?.sessionId ?? "s1";
    const now = Date.now();
    d.useBridge.setState({
      console: [
        { id: "c1", sessionId: sid, kind: "read", command: "list /var/www/api", output: "", status: "done", ok: true, at: now - 240000 },
        { id: "c2", sessionId: sid, kind: "exec", command: "systemctl status nginx --no-pager", output: "● nginx.service - A high performance web server\n     Loaded: loaded (/lib/systemd/system/nginx.service; enabled)\n     Active: active (running) since Tue 2026-11-18 09:12:01 UTC; 1 day ago\n   Main PID: 812 (nginx)\n      Tasks: 3 (limit: 2287)", status: "done", ok: true, at: now - 180000 },
        { id: "c3", sessionId: sid, kind: "exec", command: "cat /etc/nginx/sites-enabled/missing.conf", output: "cat: /etc/nginx/sites-enabled/missing.conf: No such file or directory", status: "done", ok: false, at: now - 120000 },
        { id: "c4", sessionId: sid, kind: "download", command: "download /var/log/nginx/error.log → Downloads", output: "", status: "done", ok: true, at: now - 60000 },
        { id: "c5", sessionId: sid, kind: "denied", command: "rm -rf /var/www/api/uploads", output: "", status: "done", ok: false, at: now - 30000 },
        { id: "c6", sessionId: sid, kind: "exec", command: "npm run build", output: "> api@1.0.0 build\n> tsc -p .\n\nCompiling 214 files…", status: "running", at: now - 4000 },
      ],
    });
    d.useLayout.getState().setConsoleOpen(true);
    d.useUpdater.setState({
      status: "available",
      version: "1.4.7",
      dismissed: false,
      notes: "### Highlights\n- Settings: search, a cleaner layout\n- Local crash log",
    });
  });
  await new Promise((r) => setTimeout(r, 700));
  // Expand the failed entry so its output shows.
  await page.evaluate(() => {
    const row = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("missing.conf"));
    row?.click();
  });
  await new Promise((r) => setTimeout(r, 300));

  for (const [name, w, h] of [["wide", 1440, 900], ["narrow", 760, 720]]) {
    await page.setViewport({ width: w, height: h });
    await new Promise((r) => setTimeout(r, 500));
    await page.screenshot({ path: `${OUT}/${name}.png` });
  }

  // The update chip's popover, wide and narrow.
  for (const [name, w, h] of [["update-open", 1440, 900], ["update-open-narrow", 760, 720]]) {
    await page.setViewport({ width: w, height: h });
    await new Promise((r) => setTimeout(r, 300));
    await page.click("[data-update-chip]");
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: `${OUT}/${name}.png` });
    await page.keyboard.press("Escape");
  }

  // Downloading state too.
  await page.evaluate(() => window.__demo.useUpdater.setState({ status: "downloading", downloaded: 18_400_000, total: 41_000_000 }));
  await page.setViewport({ width: 1440, height: 900 });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${OUT}/downloading.png` });
  await page.setViewport({ width: 760, height: 720 });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${OUT}/downloading-narrow.png` });
  await page.evaluate(() => window.__demo.useLayout.getState().setConsoleOpen(false));
  await page.evaluate(() => {
    window.__demo.useBridge.setState({ console: [] });
    window.__demo.useLayout.getState().setConsoleOpen(true);
  });
  await page.setViewport({ width: 1440, height: 900 });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: `${OUT}/empty.png` });
  console.log(`shots: ${OUT}`);
} finally {
  await browser?.close();
  await server.close();
}
process.exit(failures ? 1 : 0);
