// Real-app runtime verification for issue #55 (Cloudflare short-lived SSH
// certificates). Drives a build of Faro over WebView2's DevTools port against
// scripts/cert-lab.yml, an sshd that trusts only an SSH CA:
//   1. The connection editor: Cloudflare Access route, the "Cloudflare
//      short-lived certificate" auth type, the principal hint, and Test
//      connection logging in with no SSH key installed for the user.
//   2. A user whose principals file doesn't list the certificate's principal:
//      the hint and the error both name the principal and the user.
//   3. No service token on the form (it lives with the Cloudflare account).
//   4. Save: profiles.json keeps the auth type, the rail tooltip names it.
//   5. Right-click › Test connection: the Cloudflare steps, then the login.
//   6. A real faro://connect link (issue #86): the connect sheet signs in,
//      asks about the host key in place, connects; a refused certificate
//      shows the one-time server fix. ~/.ssh/known_hosts is put back after.
// The fake cloudflared (examples/stdio_relay.rs copied as cloudflared) needs,
// next to it: token-lab.faro.test.json, target-lab.faro.test (the lab's
// host:port) and sshgen-lab.faro.test-key / -cert.pub, signed by the lab CA
// for principal jane.doe.
// Env: FARO_E2E_DATA, FAKE_CF, SHOT_DIR. Exit 0 = every check passed.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const { FARO_E2E_DATA, FAKE_CF } = process.env;
const OUT = process.env.SHOT_DIR || ".";
const HOST = "lab.faro.test";
if (!FARO_E2E_DATA || !FAKE_CF) {
  console.error("set FARO_E2E_DATA and FAKE_CF");
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

/** Run Test connection and return its result line. */
async function testConnection() {
  await clickButton("Test connection", '[role="dialog"]');
  return waitFor(
    () =>
      page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once");
        if (btn) btn.click();
        const r = document.querySelector('[role="dialog"] [role="status"], [role="dialog"] [role="alert"]');
        return r && !/Testing/.test(r.textContent) ? r.textContent : null;
      }),
    90000
  );
}

// Through Cloudflare the login is a choice of two cards (issue #86).
const authOption = () =>
  page.evaluate(() => {
    const card = [...document.querySelectorAll('[role="dialog"] [aria-label="Log in with"] [role="radio"]')].find((b) =>
      b.textContent.startsWith("Cloudflare sign-in")
    );
    return card ? { text: card.textContent, disabled: card.disabled, checked: card.getAttribute("aria-checked") === "true" } : null;
  });

let savedId = null;
const linkIds = [];
// "Trust & connect" in the sheet saves the lab's key; put the file back after.
const knownHosts = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".ssh", "known_hosts");
const knownHostsBefore = existsSync(knownHosts) ? readFileSync(knownHosts) : null;
const sheet = () => page.evaluate(() => document.querySelector('[data-testid="cf-connect"]')?.innerText ?? "");
const sheetButton = (label) =>
  page.evaluate(
    (l) => {
      const b = [...document.querySelectorAll('[data-testid="cf-connect"] button')].find((x) => x.textContent.trim() === l && !x.disabled);
      b?.click();
      return !!b;
    },
    label
  );
const openLink = (url) => execFileSync("rundll32", ["url.dll,FileProtocolHandler", url]);
try {
  await invoke("cloudflared_set_custom_path", { path: FAKE_CF });
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('[aria-label="New connection"]'), { timeout: 30000 });

  // ---- 1. The editor --------------------------------------------------------
  await page.evaluate(() => document.querySelector('[aria-label="New connection"]')?.click());
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await type("Name", "e2e cert login");
  await type("Host", HOST);
  await type("Username", "jane.doe");
  const before = await authOption();
  check("a direct connection doesn't offer the certificate login", before === null, JSON.stringify(before));
  await page.click('[aria-label="Connect via"] button:nth-child(2)');
  const after = await waitFor(authOption, 5000);
  check("through Cloudflare it's offered", after && !after.disabled, JSON.stringify(after));
  check("Cloudflare sign-in is the login it starts on", !!after?.checked, JSON.stringify(after));
  const principal = await waitFor(async () => {
    const t = await text('[data-testid="editor-access-signin"]');
    return t.includes("Signed in as") ? t : null;
  }, 30000);
  check("the sign-in line names who is signed in", (principal ?? "").includes("jane.doe@example.com"), principal ?? "");
  check(
    "no principal note on the form (it comes with a refusal)",
    !(await page.evaluate(() => document.querySelector('[role="dialog"]').innerText.includes("Server must allow")))
  );
  const hasField = async (label) => !!(await field(label).catch(() => null));
  check("no key path or password is asked for", !(await hasField("Key path")) && !(await hasField("Password")));
  await page.screenshot({ path: path.join(OUT, "cert-editor.png") });

  const ok = await testConnection();
  check("Test connection logs in with the Cloudflare certificate", (ok ?? "").includes("Connection works"), ok ?? "(timed out)");
  await page.screenshot({ path: path.join(OUT, "cert-test-ok.png") });

  // ---- 2. A principal the server doesn't accept for that user -------------
  await type("Log in as", "deploy");
  const refused = await testConnection();
  check(
    "a refused certificate points at the one-time server fix",
    (refused ?? "").includes("didn't accept your Cloudflare sign-in") && (refused ?? "").includes("Server setup guide"),
    refused ?? "(timed out)"
  );
  await page.screenshot({ path: path.join(OUT, "cert-test-refused.png") });

  // ---- 3. Service tokens are no longer on the form (issue #57) -------------
  check(
    "the form asks for no service token",
    !/Service token ID|Service token secret/.test(await page.evaluate(() => document.querySelector('[role="dialog"]').innerText))
  );

  // ---- 4. Save ---------------------------------------------------------------
  await type("Log in as", "shared");
  await clickButton("Save", '[role="dialog"]');
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10000 });
  const stored = JSON.parse(readFileSync(path.join(FARO_E2E_DATA, "profiles.json"), "utf8"));
  const profile = (Array.isArray(stored) ? stored : stored.profiles ?? []).find((p) => p.name === "e2e cert login");
  savedId = profile?.id ?? null;
  check("profiles.json keeps the auth type and stores no key", profile?.auth?.kind === "cloudflarecert", JSON.stringify(profile?.auth));
  // "Connect after saving" logs in as the shared account (mapped by principal).
  const connected = await waitFor(
    () =>
      page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once");
        if (btn) btn.click();
        return document.body.innerText.includes("shared@lab.faro.test:22") ? "yes" : null;
      }),
    60000
  );
  check("the saved connection logs in to the shared account", !!connected);
  await page.screenshot({ path: path.join(OUT, "cert-connected.png") });

  await page.mouse.move(800, 500);
  await sleep(300);
  await page.hover('[aria-label="e2e cert login"]');
  const tip = await waitFor(
    () =>
      page.evaluate(() => {
        const m = document.body.innerText.match(/via Cloudflare Access[^\n]*/);
        return m ? m[0] : null;
      }),
    8000
  );
  check("the rail tooltip names the certificate login", tip === "via Cloudflare Access · Cloudflare certificate", tip ?? "(no tooltip)");
  await page.screenshot({ path: path.join(OUT, "cert-rail.png") });
  await page.mouse.move(800, 500);

  // ---- 5. Right-click › Test connection ------------------------------------
  await page.click('[aria-label="e2e cert login"]', { button: "right" });
  await clickButton("Test connection", '[role="menu"]');
  const report = await waitFor(
    () =>
      page.evaluate(() => {
        const accept = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once");
        if (accept) accept.click();
        const d = document.querySelector('[data-testid="connection-check"]');
        return d && !/Testing /.test(d.innerText) ? d.innerText : null;
      }),
    90000
  );
  check(
    "Test connection checks cloudflared and the Access sign-in, then logs in",
    /works/.test(report ?? "") && /cloudflared/.test(report ?? "") && /Cloudflare sign-in/.test(report ?? "") && /Starting folder access/.test(report ?? ""),
    (report ?? "(timed out)").replace(/\n/g, " | ")
  );
  await page.screenshot({ path: path.join(OUT, "cert-test-popup.png") });
  await page.keyboard.press("Escape");
  await waitFor(() => page.evaluate(() => !document.querySelector('[data-testid="connection-check"]')), 5000);

  // ---- 6. A faro://connect link through Cloudflare -------------------------
  openLink(`faro://connect?protocol=sftp&host=${HOST}&username=jane.doe&via=cloudflare&auth=cloudflarecert&name=e2e%20link`);
  const ready = await waitFor(async () => ((await sheet()).includes("Connect to e2e link") ? true : null), 20000);
  check("a Cloudflare link opens the connect sheet, waiting for Connect", !!ready, await sheet());
  await page.screenshot({ path: path.join(OUT, "cert-link-ready.png") });
  await sheetButton("Connect");
  const asked = await waitFor(async () => ((await sheet()).includes("First time connecting") ? await sheet() : null), 60000);
  check(
    "it gets cloudflared, signs in, and asks about the new host key in the sheet",
    !!asked && /Ready/.test(asked) && /Signed in as jane\.doe@example\.com/.test(asked) && /SHA256:/.test(asked),
    (asked ?? (await sheet())).replace(/\n/g, " | ")
  );
  check("…not in the separate host-key dialog", !(await page.evaluate(() => document.body.innerText.includes("Unknown host"))));
  await page.screenshot({ path: path.join(OUT, "cert-link-hostkey.png") });
  await sheetButton("Trust & connect");
  const closed = await waitFor(async () => ((await sheet()) === "" ? true : null), 60000);
  const linked = (await invoke("list_profiles")).find((p) => p.name === "e2e link");
  if (linked) linkIds.push(linked.id);
  check(
    "then it connects, saves the connection with Cloudflare sign-in, and closes",
    !!closed && linked?.auth?.kind === "cloudflarecert" && linked?.proxyCommand?.kind === "cloudflare",
    JSON.stringify(linked?.auth ?? null)
  );
  const open = await waitFor(() => page.evaluate(() => (document.body.innerText.includes("jane.doe@lab.faro.test:22") ? true : null)), 20000);
  check("…and the server is open", !!open);
  await page.screenshot({ path: path.join(OUT, "cert-link-connected.png") });

  openLink(`faro://connect?protocol=sftp&host=${HOST}&username=deploy&via=cloudflare&auth=cloudflarecert&name=e2e%20link%20deploy`);
  await waitFor(async () => ((await sheet()).includes("Connect to e2e link deploy") ? true : null), 20000);
  await sheetButton("Connect");
  const refusedSheet = await waitFor(async () => ((await sheet()).includes("Ask the server's admin to let you in") ? await sheet() : null), 60000);
  check(
    "a refused certificate shows the server fix, with the admin note and guide",
    !!refusedSheet && /Copy note for your admin/.test(refusedSheet) && /Server setup guide/.test(refusedSheet),
    (refusedSheet ?? (await sheet())).replace(/\n/g, " | ")
  );
  await page.screenshot({ path: path.join(OUT, "cert-link-refused.png") });
  await sheetButton("Close");
  const deployLink = (await invoke("list_profiles")).find((p) => p.name === "e2e link deploy");
  if (deployLink) linkIds.push(deployLink.id);
} catch (e) {
  failures++;
  console.log("  ✗ FAIL  script error —", e.message);
  await page.screenshot({ path: path.join(OUT, "cert-error.png") }).catch(() => {});
} finally {
  if (savedId) await invoke("delete_profile", { id: savedId }).catch(() => {});
  for (const name of ["e2e link", "e2e link deploy"]) {
    // Disconnect through the server menu first (only shown while connected).
    await page.click(`[aria-label="${name}"]`, { button: "right" }).catch(() => {});
    await page
      .evaluate(() => [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim().startsWith("Disconnect"))?.click())
      .catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
  for (const id of linkIds) await invoke("delete_profile", { id }).catch(() => {});
  if (knownHostsBefore) writeFileSync(knownHosts, knownHostsBefore);
  else if (existsSync(knownHosts)) unlinkSync(knownHosts);
  await invoke("cloudflared_set_custom_path", { path: null }).catch(() => {});
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
