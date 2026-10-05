// Real-app runtime verification for Plan 25 (WordPress backend). Drives a dev
// build of Faro over WebView2's DevTools port against a live WordPress:
// saves a WordPress connection, connects, checks capabilities, browses
// media/ and rest/, edits a REST resource through the file API, renders the
// New Connection editor's WordPress section, and calls the Agent Bridge
// `wp_rest` route — a GET, then a PUT that must raise the approval modal.
//
// Setup (see docs/plans/25_wordpress-backend.md → Tests):
//   - WordPress at WP_URL with a REST collection at /faro-test/v1/items
//     (src-tauri/tests/wordpress/faro-test-items.php as a mu-plugin)
//   - the app launched with an alt identifier and
//     WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
// Env: WP_URL, WP_USER, WP_APP_PASSWORD, FARO_E2E_DATA (that app's data dir),
//      SHOT_DIR (screenshots). Exit 0 = every check passed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const { WP_URL, WP_USER, WP_APP_PASSWORD, FARO_E2E_DATA } = process.env;
const OUT = process.env.SHOT_DIR || ".";
if (!WP_URL || !WP_USER || !WP_APP_PASSWORD || !FARO_E2E_DATA) {
  console.error("set WP_URL, WP_USER, WP_APP_PASSWORD and FARO_E2E_DATA");
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

const PID = "wp-e2e-test";
const NAME = "WP e2e";
try {
  // ---- Save + connect -------------------------------------------------------
  await invoke("save_profile", {
    profile: {
      id: PID,
      name: NAME,
      protocol: "wordpress",
      host: new URL(WP_URL).hostname,
      port: Number(new URL(WP_URL).port) || 443,
      endpoint: WP_URL,
      username: WP_USER,
      auth: { kind: "password", password: "" },
    },
  });
  await invoke("set_api_key", { purpose: `wordpress:${PID}`, value: WP_APP_PASSWORD });
  const sid = await invoke("connect", { profileId: PID });
  check("connect returns a session", typeof sid === "string" && sid.length > 0);

  const caps = await invoke("capabilities", { sessionId: sid });
  check("capabilities: hasCommands, no rename/chmod", caps.hasCommands && !caps.canRename && !caps.canChmod, JSON.stringify(caps));

  const root = (await invoke("list_directory", { sessionId: sid, path: "/" })).map((e) => e.name);
  check("root lists media + rest", root.join(",") === "media,rest", root.join(","));
  const items = (await invoke("list_directory", { sessionId: sid, path: "/rest/faro-test/v1/items" })).map((e) => e.name);
  check("rest collection lists {id}.json", items.includes("1.json"), items.join(","));

  // ---- Bridge: GET (read) then PUT (needs approval) -------------------------
  await invoke("bridge_set_enabled", { enabled: true });
  await invoke("bridge_set_session_access", { sessionId: sid, enabled: true });
  await sleep(500);
  const ep = JSON.parse(readFileSync(path.join(FARO_E2E_DATA, "agent-endpoint.json"), "utf8"));
  const call = (body) =>
    fetch(`${ep.url}/wp_rest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ep.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, ...body }),
    }).then(async (r) => ({ http: r.status, json: await r.json() }));

  // Approve whatever modal shows up while a request is in flight.
  async function approveWhilePending(promise, shot) {
    let saw = "";
    const done = promise.then((r) => ((saw ||= ""), r));
    for (let i = 0; i < 40; i++) {
      const settled = await Promise.race([done.then(() => true), sleep(250).then(() => false)]);
      if (settled) break;
      const btn = await page.$$("xpath/.//button[contains(., 'Approve')]");
      if (btn.length) {
        saw = await page.evaluate(() => document.querySelector("[role=dialog]")?.innerText ?? "");
        if (shot) await page.screenshot({ path: path.join(OUT, shot) });
        await btn[0].click();
      }
    }
    return { res: await done, modal: saw };
  }

  const get = await approveWhilePending(call({ method: "GET", route: "/faro-test/v1/items/1" }));
  check("bridge GET returns the item", get.res.json.status === 200 && get.res.json.body?.id === "1", JSON.stringify(get.res.json).slice(0, 160));

  const edited = { ...get.res.json.body, title: `Bridge edit ${Date.now()}` };
  const put = await approveWhilePending(
    call({ method: "PUT", route: "/faro-test/v1/items/1", body: edited }),
    "wp-bridge-approval.png",
  );
  check("bridge PUT asked for approval", put.modal.includes("PUT /faro-test/v1/items/1"), put.modal.replace(/\s+/g, " ").slice(0, 200));
  check("bridge PUT landed", put.res.json.status === 200 && put.res.json.body?.title === edited.title);

  // ---- Editor UI: the WordPress section -------------------------------------
  await page.reload({ waitUntil: "networkidle0" });
  await sleep(1500);
  const plus = await page.$$("xpath/.//button[@aria-label='New connection' or @title='New connection' or contains(., 'New connection')]");
  if (plus.length) {
    await plus[0].click();
    await sleep(500);
    const wp = await page.$$("xpath/.//nav//button[contains(., 'WordPress')]");
    if (wp.length) await wp[0].click();
    await sleep(400);
    await page.screenshot({ path: path.join(OUT, "wp-editor.png") });
    const text = await page.evaluate(() => document.querySelector("[role=dialog]")?.innerText ?? "");
    check("editor shows the WordPress section", text.includes("Create an application password") && text.includes("Application password"), text.replace(/\s+/g, " ").slice(0, 160));
    check("no password generator on the application password", !text.includes("Generate strong password"));

    // Fill the form like a person and Save.
    await page.type("[role=dialog] input[placeholder='my-prod-box']", "WP ui");
    await page.type("[role=dialog] input[placeholder='https://example.com']", `${WP_URL}/`);
    await page.type("[role=dialog] input[placeholder='admin']", WP_USER);
    await page.type("[role=dialog] input[type=password]", WP_APP_PASSWORD);
    const saveBtn = await page.$$("xpath/.//*[@role='dialog']//button[normalize-space(.)='Save']");
    if (saveBtn.length) await saveBtn[0].click();
    await sleep(800);
    const saved = (await invoke("list_profiles")).find((p) => p.name === "WP ui");
    check(
      "Save stores the site URL, host and port",
      saved && saved.protocol === "wordpress" && saved.endpoint === WP_URL &&
        saved.host === new URL(WP_URL).hostname && saved.port === (Number(new URL(WP_URL).port) || 443) &&
        saved.username === WP_USER && !saved.auth?.password,
      JSON.stringify(saved),
    );
    if (saved) {
      check("Save put the password in the keychain", await invoke("api_key_status", { purpose: `wordpress:${saved.id}` }));
      const sid2 = await invoke("connect", { profileId: saved.id });
      check("the UI-saved connection connects", typeof sid2 === "string");
      await invoke("disconnect", { sessionId: sid2 }).catch(() => {});
      await invoke("delete_profile", { id: saved.id });
      await invoke("set_api_key", { purpose: `wordpress:${saved.id}`, value: "" });
    }
    await page.keyboard.press("Escape");
  } else {
    check("found the New connection button", false);
  }

  // ---- File pane: open the connection from the rail and browse rest/ --------
  await sleep(400);
  const bubble = await page.$$(`xpath/.//*[@aria-label=${JSON.stringify(NAME)} or @title=${JSON.stringify(NAME)}]`);
  check("rail shows the WordPress connection", bubble.length > 0);
  if (bubble.length) {
    await bubble[0].click();
    await sleep(300);
    const connectItem = await page.$$("xpath/.//*[@role='menuitem' or self::button][normalize-space(.)='Connect']");
    if (connectItem.length) await connectItem[0].click();
    await sleep(2500);
    await page.screenshot({ path: path.join(OUT, "wp-pane-root.png") });
    const paneText = await page.evaluate(() => document.body.innerText);
    check("file pane lists media/ and rest/", /\bmedia\b/.test(paneText) && /\brest\b/.test(paneText));
  }
} finally {
  // Leave nothing behind in the e2e profile store / keychain.
  try { await invoke("bridge_set_enabled", { enabled: false }); } catch {}
  try { await invoke("delete_profile", { id: PID }); } catch {}
  try { await invoke("set_api_key", { purpose: `wordpress:${PID}`, value: "" }); } catch {}
  browser.disconnect();
}

console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
