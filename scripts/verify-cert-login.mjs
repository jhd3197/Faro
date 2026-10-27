// Real-app runtime verification for issue #55 (Cloudflare short-lived SSH
// certificates). Drives a build of Faro over WebView2's DevTools port against
// scripts/cert-lab.yml, an sshd that trusts only an SSH CA:
//   1. The connection editor: Cloudflare Access route, the "Cloudflare
//      short-lived certificate" auth type, the principal hint, and Test
//      connection logging in with no SSH key installed for the user.
//   2. A user whose principals file doesn't list the certificate's principal:
//      the hint and the error both name the principal and the user.
//   3. A service token rules the auth type out; Save says why.
//   4. Save: profiles.json keeps the auth type, the rail tooltip names it.
// The fake cloudflared (examples/stdio_relay.rs copied as cloudflared) needs,
// next to it: token-lab.faro.test.json, target-lab.faro.test (the lab's
// host:port) and sshgen-lab.faro.test-key / -cert.pub, signed by the lab CA
// for principal jane.doe.
// Env: FARO_E2E_DATA, FAKE_CF, SHOT_DIR. Exit 0 = every check passed.
import { readFileSync } from "node:fs";
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

const authOption = () =>
  page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const o = dialog.querySelector('option[value="cloudflarecert"]');
    return o ? { text: o.textContent, disabled: o.disabled } : null;
  });

let savedId = null;
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
  check(
    "without the Access route the certificate auth type is unavailable",
    before?.disabled && before.text.includes("set Proxy to Cloudflare Access"),
    JSON.stringify(before)
  );
  await clickButton("Proxy & jump host", '[role="dialog"]');
  await (await field("Proxy", "select")).select("cloudflare");
  const after = await authOption();
  check("with the Access route it can be picked", after && !after.disabled, JSON.stringify(after));
  await (await field("Auth", "select")).select("cloudflarecert");
  const principal = await waitFor(async () => {
    const t = await text('[data-testid="cf-cert-principal"]');
    return t || null;
  }, 30000);
  check("the hint names whose certificate Cloudflare issues", (principal ?? "").includes("Certificate for jane.doe (jane.doe@example.com)"), principal ?? "");
  const hasField = async (label) => !!(await field(label).catch(() => null));
  check("no key path or password is asked for", !(await hasField("Key path")) && !(await hasField("Password")));
  await page.screenshot({ path: path.join(OUT, "cert-editor.png") });

  const ok = await testConnection();
  check("Test connection logs in with the Cloudflare certificate", (ok ?? "").includes("Connection works"), ok ?? "(timed out)");
  await page.screenshot({ path: path.join(OUT, "cert-test-ok.png") });

  // ---- 2. A principal the server doesn't accept for that user -------------
  await type("Username", "deploy");
  const mismatchHint = await waitFor(async () => {
    const t = await text('[data-testid="cf-cert-principal"]');
    return t.includes("deploy") ? t : null;
  }, 10000);
  check(
    "the hint says what the server must accept for another user",
    (mismatchHint ?? "").includes("the server must accept jane.doe for that user"),
    mismatchHint ?? ""
  );
  const refused = await testConnection();
  check(
    "a refused certificate names the principal and the server user",
    (refused ?? "").includes("Cloudflare issued a certificate for `jane.doe`, but the server refused it for user `deploy`"),
    refused ?? "(timed out)"
  );
  await page.screenshot({ path: path.join(OUT, "cert-test-refused.png") });

  // ---- 3. Service tokens rule it out ---------------------------------------
  await type("Service token ID (optional)", "ci.access");
  const blocked = await authOption();
  check("with a service token the auth type says why it can't be used", (blocked?.text ?? "").includes("not with a service token"), JSON.stringify(blocked));
  const saveDisabled = await page.evaluate(() => {
    const b = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Save");
    return b?.disabled ?? null;
  });
  check("Save is held back", saveDisabled === true, String(saveDisabled));
  check(
    "and the dialog says what to change",
    (await page.evaluate(() => document.querySelector('[role="dialog"]').innerText)).includes("service token"),
  );
  await page.screenshot({ path: path.join(OUT, "cert-service-token.png") });
  await type("Service token ID (optional)", "");

  // ---- 4. Save ---------------------------------------------------------------
  await type("Username", "shared");
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
} catch (e) {
  failures++;
  console.log("  ✗ FAIL  script error —", e.message);
  await page.screenshot({ path: path.join(OUT, "cert-error.png") }).catch(() => {});
} finally {
  if (savedId) await invoke("delete_profile", { id: savedId }).catch(() => {});
  await invoke("cloudflared_set_custom_path", { path: null }).catch(() => {});
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
