// Real-app runtime verification for Plan 29 (issue #53: Cloudflare without
// a terminal). Drives a build of Faro over WebView2's DevTools port:
//   1. Settings → Cloudflare: the PATH cloudflared, Check for updates against
//      GitHub, Install Faro's copy (real download, checksum-verified).
//   2. The connection editor's Cloudflare route against scripts/cf-lab.yml:
//      "No Access sign-in needed" for a quick tunnel, Test connection with the
//      managed copy, the rail tooltip's route.
//   3. A browser sign-in with "Use my own" pointed at the fake cloudflared
//      (examples/stdio_relay.rs copied as cloudflared, with a
//      login-team-ssh.faro.test.json next to it): Log in → sign-in toast →
//      "Signed in as ana@example.com".
// Env: FARO_E2E_DATA, FARO_CF_HOST, FAKE_CF (path to the fake cloudflared),
// SHOT_DIR. Exit 0 = every check passed.
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const { FARO_E2E_DATA, FARO_CF_HOST, FAKE_CF } = process.env;
const OUT = process.env.SHOT_DIR || ".";
if (!FARO_E2E_DATA || !FARO_CF_HOST || !FAKE_CF) {
  console.error("set FARO_E2E_DATA, FARO_CF_HOST and FAKE_CF");
  process.exit(2);
}

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().includes("devtools"));
const invoke = (cmd, args = {}) => page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), cmd, args);
const text = (sel) => page.evaluate((s) => document.querySelector(s)?.textContent ?? "", sel);

async function waitFor(fn, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

/** Click the first enabled button whose label starts with `label` (waits for
 *  it: actions disable their buttons until they finish). */
async function clickButton(label, root = "body") {
  const ok = await waitFor(
    () =>
      page.evaluate(
        (label, root) => {
          const b = [...document.querySelector(root).querySelectorAll("button")].find(
            (b) => b.textContent.trim().startsWith(label) && !b.disabled
          );
          if (b) b.click();
          return !!b;
        },
        label,
        root
      ),
    15000
  );
  if (!ok) throw new Error(`no enabled button "${label}"`);
}

async function openSettings(section) {
  await page.keyboard.press("Escape");
  await page.evaluate(() => document.querySelector('[aria-label="Settings"], [title="Settings"]')?.click());
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await clickButton(section, '[role="dialog"]');
  await sleep(300);
}

async function field(label, tag = "input") {
  const h = await page.evaluateHandle(
    (label, tag) => {
      const dialog = document.querySelector('[role="dialog"]');
      for (const el of dialog.querySelectorAll("label, div.mb-3")) {
        const cap = el.firstElementChild;
        if (cap && cap.tagName === "DIV" && cap.textContent.trim() === label) return el.querySelector(tag);
      }
      return null;
    },
    label,
    tag
  );
  const el = h.asElement();
  if (!el) throw new Error(`no field "${label}"`);
  return el;
}

async function type(label, value) {
  const el = await field(label);
  await el.click({ clickCount: 3 });
  await el.press("Backspace");
  if (value) await el.type(value);
}

const created = [];
try {
  // ---- 1. Settings → Cloudflare ------------------------------------------------
  await openSettings("Cloudflare");
  const before = await waitFor(async () => {
    const t = await text('[data-testid="cloudflared-status"]');
    return t.includes("cloudflared") && !t.includes("Checking") ? t : null;
  });
  check("Settings shows the cloudflared on PATH", /found on PATH/.test(before ?? ""), before);
  await clickButton("Check for updates", '[role="dialog"]');
  const checked = await waitFor(async () => {
    const t = await text('[data-testid="cloudflared-status"]');
    return /is available|Up to date/.test(t) ? t : null;
  });
  check("Check for updates reads the latest release from GitHub", !!checked, checked ?? "(no answer)");
  await page.screenshot({ path: path.join(OUT, "cf-settings-before.png") });

  await clickButton("Install Faro's copy", '[role="dialog"]');
  const installed = await waitFor(async () => {
    const t = await text('[data-testid="cloudflared-status"]');
    return t.includes("installed by Faro") ? t : null;
  }, 180000);
  check("Install Faro's copy downloads, verifies and switches to it", !!installed, installed ?? "(timed out)");
  const managed = path.join(FARO_E2E_DATA, "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  check("the managed copy is in Faro's data folder", existsSync(managed), managed);
  await page.screenshot({ path: path.join(OUT, "cf-settings-installed.png") });

  // ---- 2. Editor: quick tunnel, managed copy ----------------------------------
  const tunnel = {
    id: "e2e-cf-tunnel",
    name: "e2e cf tunnel",
    protocol: "sftp",
    host: FARO_CF_HOST,
    port: 22,
    username: "faro",
    auth: { kind: "password", password: "farotest" },
    proxyCommand: { kind: "cloudflare" },
  };
  await invoke("save_profile", { profile: tunnel });
  created.push(tunnel.id);
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('[aria-label="New connection"]'), { timeout: 30000 });
  // The rail tooltip (shown on hover) names the route.
  await page.hover('[aria-label="e2e cf tunnel"]');
  const routeText = await waitFor(
    () => page.evaluate(() => (document.body.innerText.includes("via Cloudflare Access") ? "via Cloudflare Access" : null)),
    5000
  );
  check("the rail tooltip shows the connection's route", !!routeText, routeText ?? "(no tooltip)");
  await page.screenshot({ path: path.join(OUT, "cf-rail-tooltip.png") });
  await page.mouse.move(800, 500);

  await page.evaluate(() => {
    const b = document.querySelector('[aria-label="New connection"]');
    b?.click();
  });
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await type("Name", "e2e cf editor");
  await type("Host", FARO_CF_HOST);
  await type("Username", "faro");
  await type("Password", "farotest");
  await clickButton("Proxy & jump host", '[role="dialog"]');
  await (await field("Proxy", "select")).select("cloudflare");
  const signin = await waitFor(async () => {
    const t = await text('[data-testid="editor-access-signin"]');
    return t && !t.includes("Checking") ? t : null;
  }, 30000);
  check("a quick tunnel needs no Access sign-in", (signin ?? "").includes("No Access sign-in needed"), signin ?? "");
  await clickButton("Test connection", '[role="dialog"]');
  const result = await waitFor(async () =>
    page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once");
      if (btn) btn.click();
      const r = document.querySelector('[role="dialog"] [role="status"], [role="dialog"] [role="alert"]');
      return r && !/Testing/.test(r.textContent) ? r.textContent : null;
    }),
    90000
  );
  check("Test connection works with Faro's cloudflared", (result ?? "").includes("Connection works"), result ?? "(timed out)");
  await page.screenshot({ path: path.join(OUT, "cf-editor-managed.png") });
  await page.keyboard.press("Escape");

  // ---- 3. Browser sign-in (fake cloudflared) -----------------------------------
  await invoke("cloudflared_set_custom_path", { path: FAKE_CF });
  const access = {
    id: "e2e-cf-access",
    name: "e2e cf access",
    protocol: "sftp",
    host: "team-ssh.faro.test",
    port: 22,
    username: "faro",
    auth: { kind: "password", password: "x" },
    proxyCommand: { kind: "cloudflare", serviceTokenId: "ci.access", serviceTokenSecret: "s" },
  };
  await invoke("save_profile", { profile: access });
  created.push(access.id);
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('[aria-label="New connection"]'), { timeout: 30000 });
  await openSettings("Cloudflare");
  const custom = await waitFor(async () => {
    const t = await text('[data-testid="cloudflared-status"]');
    return t.includes("your own copy") ? t : null;
  });
  check("Use my own: Faro runs the chosen binary", !!custom, custom ?? "");
  const row = await waitFor(async () => {
    const t = await text('[data-testid="access-signins"]');
    return t.includes("team-ssh.faro.test") && t.includes("Not signed in") ? t : null;
  }, 30000);
  check("Settings lists each Access hostname with its sign-in state", !!row, row ?? (await text('[data-testid="access-signins"]')));
  await page.screenshot({ path: path.join(OUT, "cf-settings-signed-out.png") });

  // Log in on the team-ssh row (the tunnel row is the fake's unknown host).
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('[data-testid="access-signins"] > div')].find((r) =>
      r.textContent.includes("team-ssh.faro.test")
    );
    [...row.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Log in"))?.click();
  });
  const toast = await waitFor(async () =>
    page.evaluate(() => {
      const card = [...document.querySelectorAll('[aria-live="polite"] > div')].find((c) =>
        c.textContent.includes("Cloudflare Access sign-in")
      );
      return card?.textContent ?? null;
    }),
    10000
  );
  check("signing in shows the browser sign-in toast", (toast ?? "").includes("Open sign-in page"), toast ?? "(none)");
  await page.screenshot({ path: path.join(OUT, "cf-signin-waiting.png") });
  const signedIn = await waitFor(
    () =>
      page.evaluate(() => {
        const row = [...document.querySelectorAll('[data-testid="access-signins"] > div')].find((r) =>
          r.textContent.includes("team-ssh.faro.test")
        );
        return row?.textContent.includes("Signed in as ana@example.com") ? row.textContent : null;
      }),
    30000
  );
  check("after the sign-in: Signed in as … with its expiry", /Signed in as ana@example\.com · expires in/.test(signedIn ?? ""), signedIn ?? "");
  check("Log in again is offered once signed in", (signedIn ?? "").includes("Log in again"));
  await page.screenshot({ path: path.join(OUT, "cf-settings-signed-in.png") });

  // Back to Faro's own copy.
  await clickButton("Stop using my own", '[role="dialog"]');
  const back = await waitFor(async () => {
    const t = await text('[data-testid="cloudflared-status"]');
    return t.includes("installed by Faro") ? t : null;
  });
  check("Stop using my own returns to Faro's copy", !!back, back ?? "");
} catch (e) {
  failures++;
  console.log("  ✗ FAIL  script error —", e.message);
  await page.screenshot({ path: path.join(OUT, "cf-settings-error.png") }).catch(() => {});
} finally {
  for (const id of created) await invoke("delete_profile", { id }).catch(() => {});
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
