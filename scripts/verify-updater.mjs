// Browser regression checks for release-feed fallback, quiet failures, staged
// signed downloads, and recoverable install/restart errors. Real installers
// never run; the native plugin's side effects are recorded by controllable mocks.
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const OUT = process.env.SHOT_DIR || path.join(os.tmpdir(), "faro-updater-verification");
mkdirSync(OUT, { recursive: true });
const PORT = Number(process.env.PORT || 1427);
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
  const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--mode", "mock", "--port", String(PORT), "--strictPort"], {
    cwd: ROOT,
    stdio: "ignore",
    detached: !isWin,
  });
  let browser;
  try {
    await waitForServer(URL);
    browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      defaultViewport: { width: 1440, height: 900 },
      args: ["--hide-scrollbars"],
    });
    const page = await browser.newPage();
    page.on("pageerror", (e) => {
      console.log("  page error:", e.message);
      failures++;
    });

    const drive = (fn, ...a) => page.evaluate(fn, ...a);
    const shot = async (name) => {
      await page.screenshot({ path: path.join(OUT, `verify-updater-${name}.png`) });
      console.log("    · shot", `verify-updater-${name}.png`);
    };
    const clickButton = (label) =>
      drive((l) => {
        const btn = [...document.querySelectorAll("button")].find(
          (b) => b.innerText.trim() === l
        );
        if (btn) btn.click();
        return !!btn;
      }, label);
    const text = () => drive(() => document.body.innerText);

    let booted = false;
    for (let attempt = 0; attempt < 5 && !booted; attempt++) {
      await page.goto(URL, { waitUntil: "networkidle0" });
      try {
        await page.waitForFunction(() => !!window.__demo?.useUpdater, { timeout: 8_000 });
        booted = true;
      } catch {
        console.log(`    · boot attempt ${attempt + 1} missed __demo, reloading…`);
        await sleep(1500);
      }
    }
    if (!booted) throw new Error("app never exposed window.__demo.useUpdater");
    await sleep(400);

    // Open Settings → About.
    await drive(() => window.__demo.useLayout.getState().openDialog("settings"));
    await sleep(300);
    const onTab = await drive(() => {
      const btn = [...document.querySelectorAll("nav button")].find(
        (b) => b.innerText.trim() === "About"
      );
      if (btn) btn.click();
      return !!btn;
    });
    check("opened Settings → About", onTab);
    await sleep(300);

    const status = () => drive(() => window.__demo.useUpdater.getState().status);
    const until = (expected) => page.waitForFunction(
      (s) => window.__demo.useUpdater.getState().status === s, { timeout: 5000 }, expected);
    const fresh = async () => {
      await page.reload();
      await page.waitForFunction(() => window.__demo?.useUpdater);
      await until("current");
      await drive(() => window.__demo.useLayout.getState().openDialog("settings"));
      await sleep(100);
      await drive(() => [...document.querySelectorAll("nav button")].find(b => b.innerText.trim() === "About").click());
    };
    const offer = async (extra = {}) => {
      await drive((extra) => { window.__mockUpdate = { version: "1.4.0", body: "Faster transfers and fixes.", ...extra }; }, extra);
      await drive(() => window.__demo.useUpdater.getState().check(false));
      await until("available");
    };

    // Unchecked is different from a successful check.
    await drive(() => window.__demo.useUpdater.setState({ status: "idle" }));
    check("unchecked state never claims latest", !/latest version/i.test(await text()));
    await clickButton("Check for updates");
    await until("current");
    check("successful check confirms latest", /latest version/i.test(await text()));
    await shot("1-uptodate");

    // Exact production failure: latest.json is missing, but a newer release exists.
    await drive(() => { window.__mockCheckError = "Could not fetch a valid release JSON from the remote"; });
    await clickButton("Check for updates");
    await until("manual");
    check("missing feed offers the newer release", /Faro 1.3.49 is available/.test(await text()));
    check("manual update has a download fallback", /Open Downloads/.test(await text()));
    check("manual fallback never installs", !(await drive(() => window.__installed)));
    await shot("2-manual");
    await drive(() => { window.__mockRelease = { version: "1.3.49", currentVersion: "1.3.49", notes: null, newer: false, url: "https://github.com/jhd3197/Faro/releases/tag/v1.3.49" }; });
    await drive(() => window.__demo.useUpdater.getState().check(false));
    await until("current");
    check("release comparison works without signed metadata", /latest version/i.test(await text()));

    // Failed background checks stay honest, quiet, and eligible for another check.
    await fresh();
    await drive(async () => {
      window.__mockCheckError = "request timed out";
      window.__mockReleaseError = { message: "Couldn't reach GitHub. Check your connection and try again.", detail: "timeout" };
      window.__demo.useUpdater.setState({ lastChecked: null });
      await window.__demo.useUpdater.getState().check(true);
    });
    check("offline check stays in error", await status() === "error");
    check("offline check doesn't claim latest", !/latest version/i.test(await text()));
    check("failed check doesn't record success", await drive(() => window.__demo.useUpdater.getState().lastChecked) === null);
    check("quiet error doesn't produce duplicate toasts", !/Update check failed:/.test(await text()));
    await shot("3-offline");
    await drive(() => { delete window.__mockCheckError; delete window.__mockReleaseError; });
    await clickButton("Try again");
    await until("current");

    // A second check releases the old native Update resource.
    await offer();
    await drive(() => window.__demo.useUpdater.getState().check(false));
    check("rechecking releases old update resource", await drive(() => window.__closedUpdates) === 1);
    await shot("4-available");

    // Download and verification keep Faro running. Guard duplicate clicks.
    await drive(() => { window.__mockUpdate.delay = 500; window.__mockUpdate.verifyDelay = 300; });
    await drive(() => {
      void window.__demo.useUpdater.getState().download();
      void window.__demo.useUpdater.getState().download();
    });
    await until("downloading");
    check("download progress is accessible", await page.$('[role="progressbar"]') !== null);
    await shot("5-downloading");
    await until("verifying");
    check("not installed during verification", !(await drive(() => window.__installed)));
    await until("ready");
    check("double click only downloads once", await drive(() => window.__downloadCalls) === 1);
    check("download does not install or restart", !(await drive(() => window.__installed || window.__relaunched)));
    const checks = await drive(() => window.__updateChecks);
    await drive(() => window.__demo.useUpdater.getState().check(false));
    check("ready package survives another check", await status() === "ready" && await drive(() => window.__updateChecks) === checks);
    await shot("6-ready");

    // Failed installer retries use the already verified download.
    await drive(() => { window.__mockInstallError = "installer unavailable"; });
    await clickButton("Install & restart");
    await until("error");
    check("install failure exposes retry", /Try again/.test(await text()));
    await drive(() => { delete window.__mockInstallError; window.__mockRelaunchError = "restart failed"; });
    await drive(() => window.__demo.useUpdater.getState().retry());
    check("failed relaunch still reports installed", await drive(() => window.__installed) === true && await status() === "error");
    const installs = await drive(() => window.__installCalls);
    await drive(async () => { delete window.__mockRelaunchError; await window.__demo.useUpdater.getState().retry(); });
    check("restart retry doesn't install twice", await drive(() => window.__installCalls) === installs);
    check("restart succeeds", await drive(() => window.__relaunched) === true);
    check("install retry doesn't redownload", await drive(() => window.__downloadCalls) === 1);

    // Bad signatures can never reach ready or install, including after Finished.
    await fresh();
    await offer({ unknownSize: true, delay: 300, verifyDelay: 100 });
    await drive(() => { window.__mockSignatureError = true; void window.__demo.useUpdater.getState().download(); });
    await until("downloading");
    check("unknown size has no fabricated percentage", await page.$('[role="progressbar"][aria-valuenow]') === null);
    await until("error");
    check("invalid signature blocks installation", !(await drive(() => window.__installed)));
    check("signature error is actionable", /couldn't verify this update/.test(await text()));
    await shot("7-signature");
    await drive(() => { delete window.__mockSignatureError; window.__mockDownloadError = "network disconnected"; });
    await clickButton("Retry download");
    await until("error");
    check("interrupted download stays retryable", await drive(() => window.__demo.useUpdater.getState().retryAction) === "download");
    await drive(() => { delete window.__mockDownloadError; });
    await clickButton("Retry download");
    await until("ready");
    check("download retry recovers without rechecking", await drive(() => window.__downloadCalls) === 3);

    console.log(`\n${failures === 0 ? "✓ ALL CHECKS PASSED" : `✗ ${failures} CHECK(S) FAILED`}`);
  } finally {
    if (browser) await browser.close();
    killTree(server);
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
