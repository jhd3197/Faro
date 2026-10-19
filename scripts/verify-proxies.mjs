// Real-app runtime verification for Plan 27 (connection proxies + jump
// hosts). Drives a dev build of Faro over WebView2's DevTools port against
// scripts/proxy-lab.yml: fills the New Connection editor's "Proxy & jump
// host" section by hand, runs Test connection through the SOCKS5 proxy and
// through a bastion profile, saves, and checks what reached profiles.json.
//
// Setup:
//   - docker compose -f scripts/proxy-lab.yml up -d
//   - the app launched with an alt identifier and
//     WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
// Env: FARO_E2E_DATA (that app's data dir), SHOT_DIR (screenshots).
// Exit 0 = every check passed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const { FARO_E2E_DATA } = process.env;
const OUT = process.env.SHOT_DIR || ".";
if (!FARO_E2E_DATA) {
  console.error("set FARO_E2E_DATA");
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

async function type(label, value) {
  const el = await field(label);
  await el.click({ clickCount: 3 });
  await el.press("Backspace");
  await el.type(value);
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
async function testResult(prompts) {
  let accepted = 0;
  for (let i = 0; i < 120; i++) {
    const state = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once");
      if (btn) {
        btn.click();
        return { accepted: true };
      }
      const r = document.querySelector('[role="dialog"] [role="status"], [role="dialog"] [role="alert"]');
      return r ? { result: r.textContent } : {};
    });
    if (state.accepted) accepted++;
    if (state.result) return { text: state.result, accepted };
    await sleep(250);
  }
  return { text: "(timed out)", accepted };
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
  // ---- SFTP through the SOCKS5 proxy, set up in the editor ------------------
  await openNewConnection();
  await type("Name", "e2e via socks");
  await type("Host", "target");
  await type("Username", "faro");
  await type("Password", "farotest");
  await clickText("Proxy & jump host");
  await select("Proxy", "socks5");
  await type("Proxy host", "127.0.0.1");
  const ports = await page.$$('[role="dialog"] input[type="number"]');
  const proxyPort = ports[ports.length - 1];
  check("SOCKS5 default port is 1080", (await proxyPort.evaluate((e) => e.value)) === "1080");
  await proxyPort.click({ clickCount: 3 });
  await proxyPort.type("11080");
  await type("Proxy username (optional)", "faro");
  await type("Proxy password", "p@ss:word");
  await page.screenshot({ path: path.join(OUT, "proxy-editor.png") });
  await clickText("Test connection", '[role="dialog"]');
  let r = await testResult();
  check("Test connection through SOCKS5 works", r.text.includes("Connection works"), r.text);
  await page.screenshot({ path: path.join(OUT, "proxy-test-ok.png") });

  // Wrong proxy password surfaces the proxy's refusal.
  await type("Proxy password", "nope");
  await clickText("Test connection", '[role="dialog"]');
  r = await testResult();
  check("bad proxy password is reported", r.text.includes("rejected the username or password"), r.text);
  await type("Proxy password", "p@ss:word");

  // Save (without auto-connect) and check what landed on disk.
  await page.evaluate(() => {
    const cb = [...document.querySelectorAll('[role="dialog"] label')]
      .find((l) => l.textContent.includes("Connect after saving"))
      ?.querySelector("input");
    if (cb && cb.checked) cb.click();
  });
  await clickText("Save");
  await sleep(500);
  let profiles = await invoke("list_profiles");
  const socks = profiles.find((p) => p.name === "e2e via socks");
  created.push(socks?.id);
  check(
    "saved profile carries the proxy",
    socks?.proxy?.kind === "socks5" && socks.proxy.port === 11080 && socks.proxy.username === "faro",
    JSON.stringify(socks?.proxy)
  );
  const onDisk = readFileSync(path.join(FARO_E2E_DATA, "profiles.json"), "utf8");
  const keychain = (await invoke("settings_get_all"))?.storePasswordsInKeychain;
  check(
    "proxy password kept out of profiles.json in keychain mode",
    String(keychain) !== "true" || !onDisk.includes("p@ss:word"),
    `keychain=${keychain}`
  );
  // Connect without blocking the page on the host-key prompt, accept it, then
  // collect the session id.
  await page.evaluate((id) => {
    window.__connect = window.__TAURI_INTERNALS__.invoke("connect", { profileId: id }).catch((e) => String(e?.message ?? e));
  }, socks.id);
  for (let i = 0; i < 40; i++) {
    const done = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once");
      if (btn) btn.click();
      return Promise.race([window.__connect.then(() => true), new Promise((r) => setTimeout(() => r(false), 200))]);
    });
    if (done) break;
  }
  const sid = await page.evaluate(() => window.__connect);
  const entries = typeof sid === "string" && !sid.includes(" ")
    ? (await invoke("list_directory", { sessionId: sid, path: "/home/faro/data" })).map((e) => e.name)
    : [];
  check("saved proxied profile connects and browses", entries.includes("hello.txt"), entries.join(",") || sid);

  // ---- Jump host: another profile as bastion -------------------------------
  const bastion = {
    id: "e2e-bastion",
    name: "e2e bastion",
    protocol: "sftp",
    host: "127.0.0.1",
    port: 12222,
    username: "jump",
    auth: { kind: "password", password: "jumptest" },
  };
  await invoke("save_profile", { profile: bastion });
  created.push(bastion.id);
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('[aria-label="New connection"]'), { timeout: 30000 });
  await openNewConnection();
  await type("Name", "e2e via bastion");
  await type("Host", "target");
  await type("Username", "faro");
  await type("Password", "farotest");
  await clickText("Proxy & jump host");
  await select("Jump host", "e2e-bastion");
  const proxyHidden = await page.evaluate(
    () => ![...document.querySelectorAll('[role="dialog"] div')].some((d) => d.textContent.trim() === "Proxy host")
  );
  check("proxy fields give way to the jump host's own", proxyHidden);
  await page.screenshot({ path: path.join(OUT, "jump-editor.png") });
  await clickText("Test connection", '[role="dialog"]');
  r = await testResult();
  check("Test connection through the bastion works", r.text.includes("Connection works"), `${r.text} (prompts accepted: ${r.accepted})`);
  await clickText("Save");
  await sleep(500);
  profiles = await invoke("list_profiles");
  const jumped = profiles.find((p) => p.name === "e2e via bastion");
  created.push(jumped?.id);
  check("saved profile references the bastion", jumped?.jumpProfile === "e2e-bastion" && !jumped.proxy, JSON.stringify(jumped));
} catch (e) {
  failures++;
  console.log("  ✗ FAIL  script error —", e.message);
  await page.screenshot({ path: path.join(OUT, "proxy-error.png") }).catch(() => {});
} finally {
  for (const id of created.filter(Boolean)) {
    await invoke("delete_profile", { id }).catch(() => {});
  }
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
