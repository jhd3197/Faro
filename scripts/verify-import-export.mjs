// Real-app runtime verification for issue #58 (import errors, Export, the
// Faro tab in Import, Copy link). Drives a build of Faro over WebView2's
// DevTools port, with throwaway connections in its own data dir:
//   1. Import with no ~/.ssh/config shows the empty state; a bad path names
//      the actual reason.
//   2. Export a group from the rail as a plain .faro file: no secrets, jump
//      host and route kept. Then with Include secrets: encrypted.
//   3. Import the plain file back: duplicates default to Skip, a missing
//      password is badged, Import as copy lands with its jump host linked.
//   4. Import the encrypted file: passphrase prompt, wrong passphrase, then
//      Replace restores the password.
//   5. Export as OpenSSH config and read it back on the OpenSSH tab with the
//      same routes and logins.
//   6. A .faro file dropped on the window opens in Import.
//   7. Copy link, opened as a real faro:// URL, prefills the editor.
// Native file dialogs are answered by stubbing their IPC. Env: OUT_DIR (where
// exports and screenshots go). Exit 0 = every check passed.
import { readFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const OUT = path.resolve(process.env.OUT_DIR || ".");
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().includes("devtools"));
const invoke = (cmd, args = {}) => page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), cmd, args);
const dialogText = () => page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? "");
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}

async function clickText(label, root = "body", tag = "button") {
  const ok = await waitFor(
    () =>
      page.evaluate(
        (label, root, tag) => {
          const el = [...(document.querySelector(root)?.querySelectorAll(tag) ?? [])].find(
            (b) => b.textContent.trim().startsWith(label) && !b.disabled
          );
          if (el) el.click();
          return !!el;
        },
        label,
        root,
        tag
      ),
    10000
  );
  if (!ok) throw new Error(`nothing enabled labelled "${label}" in ${root}`);
}

// Native save/open dialogs: Tauri's IPC hooks are frozen, so their IPC
// request (http://ipc.localhost/plugin%3Adialog%7C…) is answered over CDP.
let answer = null;
const cdp = await page.createCDPSession();
await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*ipc.localhost/plugin%3Adialog*" }] });
cdp.on("Fetch.requestPaused", (e) => {
  const cors = [
    { name: "Access-Control-Allow-Origin", value: "*" },
    { name: "Access-Control-Allow-Headers", value: "*" },
    { name: "Access-Control-Expose-Headers", value: "Tauri-Response" },
  ];
  const preflight = e.request.method === "OPTIONS";
  cdp
    .send("Fetch.fulfillRequest", {
      requestId: e.requestId,
      responseCode: preflight ? 204 : 200,
      responseHeaders: preflight
        ? cors
        : [...cors, { name: "Content-Type", value: "application/json" }, { name: "Tauri-Response", value: "ok" }],
      body: preflight ? undefined : Buffer.from(JSON.stringify(answer)).toString("base64"),
    })
    .catch((err) => console.log("fulfill failed:", err.message));
});
const nextFile = (f) => (answer = f);

/** Capture what Copy link writes to the clipboard. */
async function stubNative() {
  await page.evaluate(() => {
    navigator.clipboard.writeText = (t) => {
      window.__copied = t;
      return Promise.resolve();
    };
  });
}

async function rightClick(selector) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector, { button: "right" });
}

async function closeDialog() {
  await page.keyboard.press("Escape");
  await waitFor(() => page.evaluate(() => !document.querySelector('[role="dialog"]')), 5000);
}

async function openImportTab(tab) {
  await page.evaluate(() => document.querySelector('[aria-label="Import connections…"]')?.click());
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await clickText(tab, '[role="dialog"] [role="tablist"]');
}

/** The visible tab panel's preview rows, as { name, badges, conflict }. */
const rows = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('[role="tabpanel"]:not(.hidden) [data-testid="import-row"]')].map((r) => ({
      name: r.querySelector(".font-medium")?.textContent ?? "",
      text: r.innerText,
      conflict: !!r.querySelector("select"),
    }))
  );

async function resolve(name, value) {
  const sel = `[role="tabpanel"]:not(.hidden) select[aria-label="What to do with ${name}"]`;
  await page.waitForSelector(sel, { timeout: 5000 });
  await page.select(sel, value);
}

const ids = {};
try {
  await stubNative();

  // Throwaway connections: a group "Team" with a bastion, an app behind it
  // with a saved password, and a Cloudflare certificate box.
  const base = { protocol: "sftp", port: 22, group: "Team" };
  const make = async (key, p) => {
    const id = crypto.randomUUID();
    ids[key] = id;
    await invoke("save_profile", { profile: { id, ...base, ...p } });
  };
  await make("bastion", { name: "e2e Bastion", host: "bastion.e2e.test", username: "ops", auth: { kind: "agent" } });
  await make("app", {
    name: "e2e App",
    host: "app.e2e.test",
    username: "deploy",
    auth: { kind: "password", password: "hunter2-e2e" },
    jumpProfile: ids.bastion,
  });
  await make("cf", {
    name: "e2e CF box",
    host: "cf.e2e.test",
    username: "jane.doe",
    auth: { kind: "cloudflarecert" },
    proxyCommand: { kind: "cloudflare" },
  });
  await page.reload();
  await page.waitForSelector('[aria-label="Import connections…"]', { timeout: 30000 });
  await stubNative();

  // ---- 1. Import errors -----------------------------------------------------
  await openImportTab("OpenSSH config");
  const empty = await waitFor(async () => {
    const t = await dialogText();
    return t.includes("No OpenSSH config found at") ? t : null;
  }, 8000);
  check("no ~/.ssh/config is a neutral empty state, not an error", !!empty && !(await page.$('[role="dialog"] [role="alert"]')));
  check("it names where it looked", (empty ?? "").includes(".ssh\\config") || (empty ?? "").includes(".ssh/config"));
  await sleep(400);
  await shot("import-no-config");
  const panel = '[role="tabpanel"]:not(.hidden)';
  await page.click(`${panel} input`, { clickCount: 3 });
  await page.keyboard.type("C:\\no\\such\\dir\\config");
  await page.keyboard.press("Enter");
  const err = await waitFor(() => page.evaluate((p) => document.querySelector(`${p} [role="alert"]`)?.textContent, panel), 8000);
  check(
    "an unreadable file shows the actual reason",
    /^Couldn't read C:\\no\\such\\dir\\config: .*cannot find the path/i.test(err ?? ""),
    err ?? "(no error)"
  );
  await shot("import-bad-path");
  await closeDialog();

  // ---- 2. Export a group ----------------------------------------------------
  await rightClick('[data-rail-group="Team"] button');
  await clickText("Export group…", "body");
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  const count = await waitFor(() => page.evaluate(() => document.querySelector('[data-testid="export-count"]')?.textContent));
  check("Export group ticks the group's connections", (count ?? "").startsWith("3 of"), count ?? "");
  await shot("export-dialog");
  const plain = path.join(OUT, "Team.faro");
  await nextFile(plain);
  await clickText("Export (3)", '[role="dialog"]');
  await waitFor(() => page.evaluate(() => !document.querySelector('[role="dialog"]')), 10000);
  const plainText = readFileSync(plain, "utf8");
  const plainJson = JSON.parse(plainText);
  check("the plain file has no secrets", !plainText.includes("hunter2-e2e"));
  const app = plainJson.connections.find((c) => c.name === "e2e App");
  check(
    "and keeps the route, group and login types",
    plainJson.format === "faro-connections" &&
      app?.jumpProfile === ids.bastion &&
      app?.group === "Team" &&
      plainJson.connections.find((c) => c.name === "e2e CF box")?.auth?.kind === "cloudflarecert",
    JSON.stringify(app)
  );

  await rightClick('[data-rail-group="Team"] button');
  await clickText("Export group…", "body");
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await clickText("Include secrets", '[role="dialog"]', "label");
  await page.type('[aria-label="Passphrase"]', "correct horse e2e");
  await page.type('[aria-label="Confirm passphrase"]', "correct horse e2x");
  const blocked = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.startsWith("Export ("))?.disabled
  );
  check("mismatched passphrases hold Export back", blocked === true);
  await page.click('[aria-label="Confirm passphrase"]', { clickCount: 3 });
  await page.keyboard.type("correct horse e2e");
  await shot("export-secrets");
  const sealed = path.join(OUT, "Team-secrets.faro");
  await nextFile(sealed);
  await clickText("Export (3)", '[role="dialog"]');
  await waitFor(() => page.evaluate(() => !document.querySelector('[role="dialog"]')), 30000);
  const sealedBytes = readFileSync(sealed);
  check(
    "Include secrets writes an encrypted file",
    sealedBytes.subarray(0, 7).toString() === "FAROCON" && !sealedBytes.toString("latin1").includes("hunter2-e2e")
  );

  // ---- 3. Import the plain file -------------------------------------------
  await invoke("delete_profile", { id: ids.app });
  await page.reload();
  await page.waitForSelector('[aria-label="Import connections…"]', { timeout: 30000 });
  await stubNative();
  await nextFile(plain);
  await openImportTab("Faro file");
  await clickText("Browse…", '[role="tabpanel"]:not(.hidden)');
  const got = await waitFor(async () => ((await rows()).length === 3 ? rows() : null), 10000);
  const row = (n) => got?.find((r) => r.name === n);
  check("the Faro tab lists the file's connections", !!got, JSON.stringify(got));
  check("existing ones are flagged as duplicates", row("e2e Bastion")?.conflict && row("e2e CF box")?.conflict);
  check("the deleted one is new and needs its password", !row("e2e App")?.conflict && /needs a password/.test(row("e2e App")?.text ?? ""));
  check("the certificate login needs nothing", !/needs/.test(row("e2e CF box")?.text ?? ""));
  const importLabel = await page.evaluate(
    () => [...document.querySelectorAll('[role="tabpanel"]:not(.hidden) button')].find((b) => b.textContent.trim().startsWith("Import"))?.textContent.trim()
  );
  check("duplicates default to Skip", importLabel === "Import (1)", importLabel ?? "");
  await resolve("e2e CF box", "copy");
  await shot("import-faro-plain");
  await clickText("Import (2)", '[role="tabpanel"]:not(.hidden)');
  await waitFor(() => page.evaluate(() => !document.querySelector('[role="dialog"]')), 10000);
  let all = await invoke("list_profiles");
  const newApp = all.find((p) => p.name === "e2e App");
  check("the imported app goes through the existing bastion", newApp?.jumpProfile === ids.bastion, JSON.stringify(newApp?.jumpProfile));
  check("Import as copy renamed the duplicate", all.some((p) => p.name === "e2e CF box (copy)" && p.auth.kind === "cloudflarecert"));
  ids.app = newApp?.id;
  ids.cfCopy = all.find((p) => p.name === "e2e CF box (copy)")?.id;

  // ---- 4. Import the encrypted file ----------------------------------------
  await nextFile(sealed);
  await openImportTab("Faro file");
  await clickText("Browse…", '[role="tabpanel"]:not(.hidden)');
  await page.waitForSelector('[role="tabpanel"]:not(.hidden) [aria-label="Passphrase"]', { timeout: 10000 });
  check("an encrypted file asks for its passphrase", /this file is encrypted/i.test(await dialogText()));
  await page.type('[role="tabpanel"]:not(.hidden) [aria-label="Passphrase"]', "wrong one");
  await clickText("Unlock", '[role="tabpanel"]:not(.hidden)');
  const wrong = await waitFor(() => page.evaluate(() => document.querySelector('[role="tabpanel"]:not(.hidden) [role="alert"]')?.textContent), 30000);
  check("a wrong passphrase says so", /wrong password/i.test(wrong ?? ""), wrong ?? "");
  await page.click('[role="tabpanel"]:not(.hidden) [aria-label="Passphrase"]', { clickCount: 3 });
  await page.keyboard.type("correct horse e2e");
  await clickText("Unlock", '[role="tabpanel"]:not(.hidden)');
  const unlocked = await waitFor(async () => ((await rows()).length === 3 ? rows() : null), 30000);
  check("the right one shows the connections, with nothing missing", !!unlocked && !unlocked.some((r) => /needs/.test(r.text)), JSON.stringify(unlocked));
  await resolve("e2e App", "replace");
  await shot("import-faro-secrets");
  await clickText("Import (1)", '[role="tabpanel"]:not(.hidden)');
  await waitFor(() => page.evaluate(() => !document.querySelector('[role="dialog"]')), 10000);
  all = await invoke("list_profiles");
  const replaced = all.find((p) => p.id === ids.app);
  check("Replace restored the password from the encrypted file", replaced?.auth?.password === "hunter2-e2e", JSON.stringify(replaced?.auth));
  check("and didn't add another copy", all.filter((p) => p.name === "e2e App").length === 1);

  // ---- 5. OpenSSH config round trip ----------------------------------------
  await rightClick(`[data-rail-profile-id="${ids.cf}"] button`);
  await clickText("Export as OpenSSH config…", "body");
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await page.evaluate(() => document.querySelector('[data-testid="export-count"]')?.closest("label")?.querySelector("input")?.click());
  const sshCfg = path.join(OUT, "team.ssh_config");
  await nextFile(sshCfg);
  await clickText("Export (", '[role="dialog"]');
  await waitFor(() => page.evaluate(() => !document.querySelector('[role="dialog"]')), 10000);
  const cfgText = readFileSync(sshCfg, "utf8");
  check(
    "the OpenSSH export has ProxyJump, cloudflared and the certificate",
    /ProxyJump e2e-Bastion/.test(cfgText) &&
      /ProxyCommand cloudflared access ssh --hostname %h/.test(cfgText) &&
      /CertificateFile ~\/\.cloudflared\/%h-cf_key-cert\.pub/.test(cfgText) &&
      !cfgText.includes("hunter2-e2e"),
    cfgText
  );
  const back = await invoke("import_openssh", { path: sshCfg });
  const b = (n) => back.find((p) => p.name === n);
  check(
    "the OpenSSH tab reads it back with the same logins and routes",
    b("e2e-CF-box")?.cloudflareCert &&
      b("e2e-CF-box")?.proxyCommand?.kind === "cloudflare" &&
      b("e2e-Bastion")?.agent &&
      b("e2e-App")?.jumpName === "e2e-Bastion",
    JSON.stringify(back.map((p) => [p.name, p.cloudflareCert, p.agent, p.jumpName]))
  );

  // ---- 6. A dropped .faro file ---------------------------------------------
  await page.evaluate((f) => {
    const emit = (event, payload) => window.__TAURI_INTERNALS__.invoke("plugin:event|emit", { event, payload });
    return emit("tauri://drag-drop", { paths: [f], position: { x: 900, y: 400 } });
  }, plain);
  const dropped = await waitFor(async () => ((await rows()).length === 3 ? "yes" : null), 10000);
  check("a .faro file dropped on the window opens in Import", !!dropped);
  await shot("import-dropped");
  if (await page.$('[role="dialog"]')) await closeDialog();

  // ---- 7. Copy link -----------------------------------------------------------
  await rightClick(`[data-rail-profile-id="${ids.cf}"] button`);
  await clickText("Copy link", "body");
  const link = await waitFor(() => page.evaluate(() => window.__copied));
  check(
    "Copy link carries the route and login, never a secret",
    /^faro:\/\/connect\?/.test(link ?? "") && /via=cloudflare/.test(link) && /auth=cloudflarecert/.test(link) && /name=e2e%20CF%20box/.test(link),
    link ?? ""
  );
  // Opened the way a teammate would: through the registered handler.
  // (rundll32, not `cmd /c start`, which would split the URL at each "&".)
  execFileSync("rundll32.exe", ["url.dll,FileProtocolHandler", link]);
  const prefilled = await waitFor(
    () =>
      page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]');
        if (!d) return null;
        const v = (label) => {
          for (const el of d.querySelectorAll("label, div.mb-3")) {
            const cap = el.firstElementChild;
            if (cap?.tagName === "DIV" && cap.textContent.trim() === label) return el.querySelector("input, select")?.value;
          }
          return undefined;
        };
        return v("Host") ? { host: v("Host"), user: v("Username"), auth: v("Auth"), name: v("Name") } : null;
      }),
    20000
  );
  check(
    "the link opens a prefilled editor with the certificate login",
    prefilled?.host === "cf.e2e.test" && prefilled?.user === "jane.doe" && prefilled?.auth === "cloudflarecert",
    JSON.stringify(prefilled)
  );
  await shot("link-prefilled");
  if (await page.$('[role="dialog"]')) await closeDialog();
} catch (e) {
  failures++;
  console.log("  ✗ FAIL  script error —", e.message);
  await shot("error").catch(() => {});
} finally {
  const all = await invoke("list_profiles").catch(() => []);
  for (const p of all.filter((p) => p.name.startsWith("e2e"))) await invoke("delete_profile", { id: p.id }).catch(() => {});
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
