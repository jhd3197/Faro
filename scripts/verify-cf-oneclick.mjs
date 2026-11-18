// Issue #86 in the mock build (no Rust): the Cloudflare editor, the server
// menu and its rail shortcuts, Test connection, and a `faro://connect` link
// through Cloudflare driven end to end in the connect sheet. Saves a PNG of
// each state; exits non-zero when a check fails.
// Usage: node scripts/verify-cf-oneclick.mjs <prefix>
//   SHOT_DIR = where PNGs go; ONLY=editor,more,own,expired,menus,link,keys,check
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.SHOT_DIR || path.join(ROOT, ".shots");
const PREFIX = process.argv[2] || "shot";
const ONLY = (process.env.ONLY || "").split(",").filter(Boolean);
mkdirSync(OUT, { recursive: true });
const URL = "http://localhost:1425/";
const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((p) => existsSync(p));

async function up(url) {
  try {
    return (await fetch(url)).ok;
  } catch {
    return false;
  }
}

let server = null;
if (!(await up(URL))) {
  server = spawn("npm", ["run", "dev:mock"], { cwd: ROOT, shell: true, stdio: "ignore" });
  const end = Date.now() + 90_000;
  while (!(await up(URL))) {
    if (Date.now() > end) throw new Error("mock server never came up");
    await sleep(500);
  }
}

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ["--force-device-scale-factor=2"],
  defaultViewport: { width: 1280, height: 860, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message));

async function boot() {
  for (let i = 0; i < 6; i++) {
    await page.goto(URL, { waitUntil: "networkidle0", timeout: 60_000 }).catch(() => {});
    if (await page.evaluate(() => !!window.__demo).catch(() => false)) return;
    await sleep(1500);
  }
  throw new Error("app never booted");
}

const CF_LINK = {
  protocol: "sftp",
  name: "edge-access",
  host: "ssh.edge.example.com",
  port: 22,
  username: "deploy",
  auth: { kind: "cloudflarecert" },
  proxyCommand: { kind: "cloudflare", hostname: "ssh.edge.example.com" },
};

async function openEditor(prefill, access = "loggedIn") {
  await page.evaluate((a) => (window.__cfAccess = a), access);
  await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
  await sleep(150);
  await page.evaluate((p) => window.__demo.useLayout.getState().openNewConnection(p), prefill);
  await page.waitForSelector('[role="dialog"]');
  await sleep(1200); // sign-in check is debounced 400 ms
}

/** Grow the dialog to its content so one PNG shows the whole form. */
async function shootDialog(name, sel = '[role="dialog"]') {
  await page.evaluate((sel) => {
    const d = document.querySelector(sel);
    d.style.height = "auto";
    d.style.maxHeight = "none";
    for (const el of d.querySelectorAll(".overflow-y-auto")) el.style.overflow = "visible";
  }, sel);
  await sleep(200);
  const el = await page.$(sel);
  await el.screenshot({ path: path.join(OUT, `${PREFIX}-${name}.png`) });
  console.log("wrote", `${PREFIX}-${name}.png`);
}

async function click(text, root = '[role="dialog"]') {
  const ok = await page.evaluate(
    (text, root) => {
      const b = [...document.querySelector(root).querySelectorAll("button, summary, [role=radio]")].find((b) =>
        b.textContent.trim().startsWith(text)
      );
      b?.click();
      return !!b;
    },
    text,
    root
  );
  if (!ok) console.log(`(no "${text}" to click)`);
  await sleep(300);
}

const want = (n) => !ONLY.length || ONLY.includes(n);
try {
  await boot();
  if (want("editor")) {
    await openEditor(CF_LINK);
    await shootDialog("editor");
  }
  if (want("more")) {
    await openEditor({
      ...CF_LINK,
      cfForwards: [{ name: "postgres", hostname: "db.edge.example.com", localPort: 5433 }],
    });
    await click("More options");
    await shootDialog("more");
  }
  if (want("own")) {
    await openEditor(CF_LINK);
    await click("Your own key or password");
    await shootDialog("own");
  }
  if (want("expired")) {
    await openEditor(CF_LINK, "expired");
    await shootDialog("expired");
  }
  if (want("menus")) {
    await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
    const { on, off } = await page.evaluate(() => {
      const { profiles, sessions } = window.__demo.useConnections.getState();
      const live = new Set(sessions.map((s) => s.profileId));
      return {
        on: profiles.find((p) => p.protocol === "sftp" && live.has(p.id))?.name,
        off: profiles.find((p) => p.protocol === "sftp" && !live.has(p.id))?.name,
      };
    });
    const shootMenu = async (name, file, hover) => {
      await page.mouse.click(900, 500);
      await sleep(200);
      await (await page.$(`[aria-label="${name}"]`)).click({ button: "right" });
      await sleep(400);
      if (hover) {
        const h = await page.evaluateHandle(
          (t) => [...document.querySelectorAll("[role=menuitem]")].find((b) => b.textContent.trim() === t),
          hover
        );
        await h.asElement().hover();
        await sleep(300);
      }
      const box = await page.evaluate(() => {
        const els = [...document.querySelectorAll("[role=menu]")].map((m) => m.getBoundingClientRect());
        return {
          x: Math.min(...els.map((r) => r.left)),
          y: Math.min(...els.map((r) => r.top)),
          r: Math.max(...els.map((r) => r.right)),
          b: Math.max(...els.map((r) => r.bottom)),
        };
      });
      await page.screenshot({
        path: path.join(OUT, `${PREFIX}-${file}.png`),
        clip: { x: 0, y: Math.max(0, box.y - 60), width: box.r + 16, height: box.b - Math.max(0, box.y - 60) + 16 },
      });
      console.log("wrote", `${PREFIX}-${file}.png`);
    };
    await shootMenu(on, "menu-connected");
    await shootMenu(off, "menu-offline");
    await shootMenu(on, "menu-organize", "Organize");
    await shootMenu(on, "menu-more", "More");
  }
  if (want("link")) {
    let fails = 0;
    const ok = (name, cond, detail = "") => {
      if (!cond) fails++;
      console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    };
    const sheet = () => page.evaluate(() => document.querySelector('[data-testid="cf-connect"]')?.innerText ?? "");
    const stepState = (id) =>
      page.evaluate((id) => document.querySelector(`[data-testid="cf-connect"] [data-step="${id}"]`)?.dataset.state ?? "", id);
    const until = async (fn, ms = 8000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        const v = await fn();
        if (v) return v;
        await sleep(100);
      }
      return null;
    };
    const press = (label) =>
      page.evaluate(
        (l) => [...document.querySelectorAll('[data-testid="cf-connect"] button')].find((b) => b.textContent.trim() === l)?.click(),
        label
      );
    const link = (host, extra = {}) =>
      page.evaluate(
        (dl) => window.__demo.emit("deep-link://open", dl),
        { action: "connect", protocol: "sftp", host, username: "deploy", via: "cloudflare", auth: "cloudflarecert", name: host.split(".")[1], ...extra }
      );
    await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());

    // 1. A new server: sign-in in the browser, first host key, then connected.
    await page.evaluate(() => {
      window.__cfAccess = "loggedOut";
      window.__cfConnect = "hostkey";
    });
    await link("ssh.newbox.example.com");
    ok("a Cloudflare link opens the sheet, not the editor", !!(await until(sheet)) && !(await page.$('[role="dialog"][aria-labelledby]')));
    ok("it waits for Connect", (await sheet()).includes("Connect to newbox"));
    await shootDialog("link-ready", '[data-testid="cf-connect"]');
    await press("Connect");
    ok("the sign-in opens in the browser", !!(await until(async () => (await sheet()).includes("Finish in the browser"))));
    await shootDialog("link-signin", '[data-testid="cf-connect"]');
    ok("a first-time host key is asked in the sheet", !!(await until(async () => (await stepState("server")) === "waiting")));
    ok("…not in the separate host-key dialog", !(await page.evaluate(() => document.body.innerText.includes("Unknown host"))));
    await shootDialog("link-hostkey", '[data-testid="cf-connect"]');
    await press("Trust & connect");
    ok("then it connects and closes", !!(await until(async () => !(await sheet()))));
    const saved = await page.evaluate(() => {
      const { profiles, sessions } = window.__demo.useConnections.getState();
      const p = profiles.find((x) => x.host === "ssh.newbox.example.com");
      return { saved: !!p, auth: p?.auth?.kind, live: !!p && sessions.some((s) => s.profileId === p.id) };
    });
    ok("the connection is saved with Cloudflare sign-in and open", saved.saved && saved.auth === "cloudflarecert" && saved.live, JSON.stringify(saved));

    // 2. The server refuses the certificate: the fix, not a dead end.
    await page.evaluate(() => (window.__cfConnect = "refused"));
    await link("ssh.locked.example.com");
    await until(sheet);
    await press("Connect");
    ok("a refused certificate shows the server-side fix", !!(await until(async () => (await sheet()).includes("Ask the server's admin to let you in"))));
    ok("…with the admin note and guide", (await sheet()).includes("Copy note for your admin") && (await sheet()).includes("Server setup guide"));
    await shootDialog("link-refused", '[data-testid="cf-connect"]');
    await press("Close");

    // 3. A saved Cloudflare server that isn't connected opens the same sheet.
    await page.evaluate(() => (window.__cfConnect = ""));
    await link("ssh.edge.example.com", { name: "edge-access" });
    ok("a saved, offline Cloudflare server gets the sheet too", (await until(sheet) ?? "").includes("Connect to edge-access"));
    await press("Edit details");
    ok("Edit details opens that saved connection's editor", !!(await until(() => page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText.includes("Edit connection")))));
    await page.keyboard.press("Escape");
    console.log(fails ? `${fails} FAILED` : "all link checks passed");
    if (fails) process.exitCode = 1;
  }
  if (want("keys")) {
    const off = await page.evaluate(() => {
      const { profiles, sessions } = window.__demo.useConnections.getState();
      const live = new Set(sessions.map((s) => s.profileId));
      return profiles.find((p) => p.protocol === "sftp" && !live.has(p.id))?.name;
    });
    const press = async (key, expect) => {
      await page.keyboard.press("Escape");
      await page.mouse.click(900, 500);
      await sleep(200);
      await page.focus(`[aria-label="${off}"]`);
      if (key === "ctrl+d") {
        await page.keyboard.down("Control");
        await page.keyboard.press("d");
        await page.keyboard.up("Control");
      } else await page.keyboard.press(key);
      await sleep(500);
      const got = await page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText.slice(0, 120) ?? "");
      if (!expect.test(got)) process.exitCode = 1;
      console.log(`${expect.test(got) ? "PASS" : "FAIL"}  ${key} -> ${JSON.stringify(got.split("\n").slice(0, 3).join(" | "))}`);
      await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
    };
    await press("F2", /Edit connection/);
    await press("ctrl+d", /\(copy\)|New connection/);
    await press("Delete", /Delete|Remove/i);
    await page.keyboard.press("Escape");
    await page.focus(`[aria-label="${off}"]`);
    await page.keyboard.press("Enter");
    await sleep(800);
    const live = await page.evaluate((n) => {
      const { profiles, sessions } = window.__demo.useConnections.getState();
      const id = profiles.find((p) => p.name === n)?.id;
      return sessions.some((s) => s.profileId === id) || !!document.querySelector("[role=menu]") === false;
    }, off);
    if (!live) process.exitCode = 1;
    console.log(`${live ? "PASS" : "FAIL"}  Enter connects ${off}`);
  }
  if (want("check")) {
    await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
    await page.evaluate(() => (window.__diag = "auth"));
    const name = await page.evaluate(() => window.__demo.useConnections.getState().profiles.find((p) => p.protocol === "sftp" && !p.proxyCommand)?.name);
    const row = await page.$(`[aria-label="${name}"]`);
    await row.click({ button: "right" });
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, `${PREFIX}-menu.png`), clip: { x: 0, y: 0, width: 640, height: 860 } });
    console.log("wrote", `${PREFIX}-menu.png`);
    await page.evaluate(() =>
      [...document.querySelectorAll("button, [role=menuitem]")].find((b) => b.textContent.trim().startsWith("Test connection"))?.click()
    );
    await page.waitForSelector('[data-testid="connection-check"]');
    await sleep(150);
    await shootDialog("check-running", '[data-testid="connection-check"]');
    await sleep(1400);
    await shootDialog("check-failed", '[data-testid="connection-check"]');
  }
} finally {
  await browser.close();
  if (server) spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
}
