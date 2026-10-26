// Real-app runtime verification for Plan 28 (ProxyCommand + Cloudflare
// Access, issue #52). Drives a build of Faro over WebView2's DevTools port
// against scripts/cf-lab.yml, whose sshd has no published port: the only way
// in is a Cloudflare quick tunnel through `cloudflared access ssh`.
//
// Setup:
//   - docker compose -f scripts/cf-lab.yml up -d (and read the tunnel host)
//   - cloudflared on PATH
//   - the app launched with an alt identifier and
//     WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
// Env: FARO_E2E_DATA (that app's data dir), FARO_CF_HOST (the
// *.trycloudflare.com host), SHOT_DIR (screenshots).
// Exit 0 = every check passed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const { FARO_E2E_DATA, FARO_CF_HOST } = process.env;
const OUT = process.env.SHOT_DIR || ".";
if (!FARO_E2E_DATA || !FARO_CF_HOST) {
  console.error("set FARO_E2E_DATA and FARO_CF_HOST");
  process.exit(2);
}

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const pages = await browser.pages();
const page = pages.find((p) => !p.url().includes("devtools")) ?? pages[0];
const invoke = (cmd, args = {}) =>
  page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), cmd, args);

/** The input / select inside the editor Field captioned `label`. */
async function field(label, tag = "input") {
  const handle = await page.evaluateHandle(
    (label, tag) => {
      const dialog = document.querySelector('[role="dialog"]');
      for (const el of dialog.querySelectorAll("label, div.mb-3")) {
        const cap = el.firstElementChild;
        if (cap && cap.tagName === "DIV" && cap.textContent.trim() === label) {
          return el.querySelector(tag);
        }
      }
      return null;
    },
    label,
    tag
  );
  const el = handle.asElement();
  if (!el) throw new Error(`no field "${label}"`);
  return el;
}

async function hasField(label) {
  return field(label).then(
    () => true,
    () => false
  );
}

async function type(label, value) {
  const el = await field(label);
  await el.click({ clickCount: 3 });
  await el.press("Backspace");
  if (value) await el.type(value);
}

async function select(label, value) {
  const el = await field(label, "select");
  await el.select(value);
}

async function clickText(text, root = '[role="dialog"]') {
  const ok = await page.evaluate(
    (text, root) => {
      const scope = document.querySelector(root) ?? document;
      const all = [...scope.querySelectorAll("button")];
      const b =
        all.find((b) => b.textContent.trim() === text) ??
        all.find((b) => b.textContent.trim().startsWith(text));
      if (b) b.click();
      return !!b;
    },
    text,
    root
  );
  if (!ok) throw new Error(`no button "${text}"`);
}

/** Wait for the test result, accepting each SSH host-key prompt once. */
async function testResult() {
  for (let i = 0; i < 240; i++) {
    const state = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once");
      if (btn) {
        btn.click();
        return {};
      }
      const r = document.querySelector('[role="dialog"] [role="status"], [role="dialog"] [role="alert"]');
      return r && !/Testing/.test(r.textContent) ? { result: r.textContent } : {};
    });
    if (state.result) return state.result;
    await sleep(250);
  }
  return "(timed out)";
}

async function runTest() {
  await clickText("Test connection", '[role="dialog"]');
  return testResult();
}

async function openNewConnection() {
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    const b =
      document.querySelector('[aria-label="New connection"]') ??
      document.querySelector('[aria-label="Add a server"]');
    if (b) b.click();
  });
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
}

const created = [];
try {
  // ---- Cloudflare Access, set up in the editor ------------------------------
  await openNewConnection();
  await type("Name", "e2e via cloudflare");
  await type("Host", FARO_CF_HOST);
  await type("Username", "faro");
  await type("Password", "farotest");
  await clickText("Proxy & jump host");
  const options = await (await field("Proxy", "select")).evaluate((s) => [...s.options].map((o) => o.value));
  check("SSH proxy choices include Cloudflare Access and Command", options.includes("cloudflare") && options.includes("command"), options.join(","));
  await select("Proxy", "cloudflare");
  const placeholder = await (await field("Access hostname")).evaluate((e) => e.placeholder);
  check("Access hostname defaults to the server host", placeholder === FARO_CF_HOST, placeholder);
  check("TCP proxy host field is hidden", !(await hasField("Proxy host")));
  await page.screenshot({ path: path.join(OUT, "cf-editor.png") });
  let r = await runTest();
  check("Test connection through Cloudflare Access works", r.includes("Connection works"), r);
  await page.screenshot({ path: path.join(OUT, "cf-test-ok.png") });

  // A wrong Access hostname gets a plain-language error.
  await type("Access hostname", "faro-no-such-tunnel-28.trycloudflare.com");
  r = await runTest();
  check("unknown Access hostname is explained", r.includes("doesn't resolve"), r);
  await page.screenshot({ path: path.join(OUT, "cf-test-bad-host.png") });
  await type("Access hostname", "");

  // ---- Generic command ------------------------------------------------------
  await select("Proxy", "command");
  check("Command field appears", await hasField("Command"));
  await type("Command", "cloudflared access ssh --hostname %h");
  r = await runTest();
  check("Test connection through a typed ProxyCommand works", r.includes("Connection works"), r);
  await type("Command", "faro-no-such-proxy-tool %h %p");
  r = await runTest();
  check("missing program is named", r.includes("not found on PATH"), r);
  await type("Command", "nc %h %p | cat");
  r = await runTest();
  check("shell operators are refused with advice", r.includes("without a shell"), r);
  await page.screenshot({ path: path.join(OUT, "cmd-editor.png") });

  // ---- Save Cloudflare with a service token, check disk + connect ------------
  await select("Proxy", "cloudflare");
  await type("Service token ID (optional)", "e2e-token.access");
  await type("Service token secret", "e2e-token-secret-value");
  await page.evaluate(() => {
    const cb = [...document.querySelectorAll('[role="dialog"] label')]
      .find((l) => l.textContent.includes("Connect after saving"))
      ?.querySelector("input");
    if (cb && cb.checked) cb.click();
  });
  await clickText("Save");
  await sleep(500);
  const profiles = await invoke("list_profiles");
  const cf = profiles.find((p) => p.name === "e2e via cloudflare");
  created.push(cf?.id);
  check(
    "saved profile carries the Cloudflare route",
    cf?.proxyCommand?.kind === "cloudflare" && !cf.proxy && cf.proxyCommand.serviceTokenId === "e2e-token.access",
    JSON.stringify(cf?.proxyCommand)
  );
  const onDisk = readFileSync(path.join(FARO_E2E_DATA, "profiles.json"), "utf8");
  const keychain = (await invoke("settings_get_all"))?.storePasswordsInKeychain;
  check(
    "token secret kept out of profiles.json in keychain mode",
    String(keychain) !== "true" || !onDisk.includes("e2e-token-secret-value"),
    `keychain=${keychain}`
  );

  await page.evaluate((id) => {
    window.__connect = window.__TAURI_INTERNALS__.invoke("connect", { profileId: id }).catch((e) => "ERR " + String(e?.message ?? e));
  }, cf.id);
  for (let i = 0; i < 120; i++) {
    const done = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once");
      if (btn) btn.click();
      return Promise.race([window.__connect.then(() => true), new Promise((r) => setTimeout(() => r(false), 250))]);
    });
    if (done) break;
  }
  const sid = await page.evaluate(() => window.__connect);
  const entries =
    typeof sid === "string" && !sid.startsWith("ERR")
      ? (await invoke("list_directory", { sessionId: sid, path: "/home/faro/data" })).map((e) => e.name)
      : [];
  check("saved Cloudflare profile connects and browses", entries.includes("hello.txt"), entries.join(",") || sid);
  if (typeof sid === "string" && !sid.startsWith("ERR")) await invoke("disconnect", { sessionId: sid }).catch(() => {});

  // ---- The sign-in notice ----------------------------------------------------
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    window.__TAURI_INTERNALS__.invoke("plugin:event|emit", {
      event: "auth://notice",
      payload: {
        host: "ssh.example.com",
        message: "Finish the Cloudflare Access sign-in in your browser",
        url: "https://team.cloudflareaccess.com/cdn-cgi/access/cli?aud=e2e",
      },
    })
  );
  await sleep(600);
  const toast = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[aria-live="polite"] > div')];
    const card = cards.find((c) => c.textContent.includes("Cloudflare Access sign-in"));
    return card ? card.textContent : null;
  });
  check("sign-in notice shows a toast with an Open sign-in page button", !!toast && toast.includes("Open sign-in page"), toast ?? "(none)");
  await page.screenshot({ path: path.join(OUT, "cf-signin-toast.png") });
} catch (e) {
  failures++;
  console.log("  ✗ FAIL  script error —", e.message);
  await page.screenshot({ path: path.join(OUT, "proxy-command-error.png") }).catch(() => {});
} finally {
  for (const id of created.filter(Boolean)) {
    await invoke("delete_profile", { id }).catch(() => {});
  }
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
