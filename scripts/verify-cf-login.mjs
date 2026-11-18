// Real-app runtime verification for "Cloudflare login" on a server (issue
// #86 follow-up): an admin connected with a password sets the server up so
// people log in with their Cloudflare sign-in. Drives a build of Faro over
// WebView2's DevTools port against scripts/cf-setup-lab.yml, reached through
// the fake cloudflared. The admin logs in as `admin` (password, sudo; the
// script adds that user to the lab), people log in as `deploy`:
//   1. The editor of a Cloudflare connection finds the admin's own login to
//      the same server, connects it, and shows the state: not set up.
//   2. Setup with no Cloudflare account asks for the CA key. A wrong key
//      fails the test login, and everything is put back.
//   3. With an account, the CA comes from the API; setup lists the signed-in
//      person, applies, tests a certificate login: "Only listed people".
//   4. Removing a person shows the command first, then runs it.
//   5. A refused faro:// link offers "Allow jane.doe to log in as deploy"
//      and connects after one click.
//   6. The opt-in "anyone the Access policy allows" warns first, applies,
//      tests; turning it off and removing the setup go back.
// The fake cloudflared (examples/stdio_relay.rs copied as cloudflared.exe)
// needs, next to it, for web-1-ssh.example.test: token-H.json, target-H
// (127.0.0.1:2224), sshgen-H-key / -cert.pub signed by the cert lab CA for
// jane.doe. The fake API (examples/fake_cloudflare.rs on :8787 with
// --token lab-token --ca-pub <cert lab ca.pub>, app launched with FARO_CF_API)
// is seeded with an Access app for that hostname.
// Env: FAKE_CF (the cloudflared.exe), WRONG_CA (some other public key file),
// CDP (default 9335), SHOT_DIR. Exit 0 = every check passed.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const { FAKE_CF, WRONG_CA } = process.env;
const OUT = process.env.SHOT_DIR || ".";
const CDP = process.env.CDP || "9335";
const H = "web-1-ssh.example.test";
if (!FAKE_CF || !WRONG_CA) {
  console.error("set FAKE_CF and WRONG_CA");
  process.exit(2);
}

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + String(detail).replace(/\n/g, " | ").slice(0, 400) : ""}`);
}

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP}`, defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().includes("devtools"));
const invoke = (cmd, args = {}) => page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), cmd, args);
const shot = (name) => page.screenshot({ path: path.join(OUT, `cf-login-${name}.png`) }).catch(() => {});

async function waitFor(fn, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

async function clickButton(label, root = "body", exact = false) {
  const ok = await waitFor(
    () =>
      page.evaluate(
        (label, root, exact) => {
          const scope = document.querySelector(root);
          if (!scope) return false;
          const b = [...scope.querySelectorAll("button")].find(
            (b) => (exact ? b.textContent.trim() === label : b.textContent.trim().startsWith(label)) && !b.disabled
          );
          if (b) b.click();
          return !!b;
        },
        label,
        root,
        exact
      ),
    15000
  );
  if (!ok) throw new Error(`no enabled button "${label}" in ${root}`);
}

// The first-time SSH host key: "Accept once" (never writes known_hosts).
const acceptOnce = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Accept once");
    b?.click();
    return !!b;
  });
const SEC = '[data-testid="cf-server-login"]';
const DLG = '[data-testid="cf-login-dialog"]';
const inner = (sel) => page.evaluate((s) => document.querySelector(s)?.innerText ?? "", sel);
const mode = () => page.evaluate((s) => document.querySelector(s)?.dataset.mode ?? "", SEC);
const waitMode = (m) =>
  waitFor(async () => {
    await acceptOnce();
    return (await mode()) === m ? true : null;
  }, 60000);
const waitText = (sel, re, ms = 60000) =>
  waitFor(async () => {
    await acceptOnce();
    const t = await inner(sel);
    return re.test(t) ? t : null;
  }, ms);

async function openEditor(name) {
  await page.mouse.move(900, 500);
  await page.click(`[aria-label="${name}"]`, { button: "right" });
  await clickButton("Edit…", '[role="menu"]');
  await page.waitForSelector(SEC, { timeout: 10000 });
}
async function closeEditor() {
  await page.evaluate(() => {
    const d = [...document.querySelectorAll('[role="dialog"]')].find((x) => !x.matches('[data-testid="cf-login-dialog"]'));
    [...(d?.querySelectorAll("button") ?? [])].find((b) => b.textContent.trim() === "Cancel")?.click();
  });
  await waitFor(() => page.evaluate((s) => !document.querySelector(s), SEC), 5000);
}
async function setInput(sel, value) {
  await page.evaluate(
    (sel, value) => {
      const el = document.querySelector(sel);
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    sel,
    value
  );
}
/** Remove `who` from the section's list: the command shows, then runs. */
async function removePerson(who) {
  await page.click(`${SEC} [aria-label="Remove ${who}"]`);
  const cmd = await waitText(`${SEC} [data-testid="cf-login-command"]`, /sed -i/, 10000);
  check(`removing ${who} shows the root command first`, !!cmd && cmd.includes(`/etc/ssh/faro_principals/deploy`), cmd ?? "");
  await clickButton("Run with sudo", SEC);
  const gone = await waitText(SEC, /Nobody yet/, 20000);
  check(`…and ${who} is off the list`, !!gone, await inner(SEC));
}
/** Through the change dialog: Apply, then wait for done or failed. */
async function applyChange() {
  await clickButton("Apply", DLG, true);
  return waitFor(async () => {
    await acceptOnce();
    return page.evaluate((d) => {
      const el = document.querySelector(d);
      if (el?.querySelector('[data-testid="cf-login-done"]')) return "done";
      if (el?.querySelector('[data-testid="cf-login-failed"]')) return "failed";
      return null;
    }, DLG);
  }, 120000);
}
const closeDialog = async () => {
  await clickButton(await page.evaluate((d) => ([...document.querySelectorAll(`${d} button`)].some((b) => b.textContent.trim() === "Close") ? "Close" : "Cancel"), DLG), DLG, true);
  await waitFor(() => page.evaluate((d) => !document.querySelector(d), DLG), 5000);
};

const ADMIN = {
  id: "e2e-cflogin-admin",
  name: "web-1 admin",
  protocol: "sftp",
  host: H,
  port: 22,
  username: "admin",
  auth: { kind: "password", password: "lab-pass" },
  proxyCommand: { kind: "cloudflare", hostname: H },
};
const CERT = { ...ADMIN, id: "e2e-cflogin-cert", name: "web-1", username: "deploy", auth: { kind: "cloudflarecert" } };
const knownHosts = path.join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".ssh", "known_hosts");
const knownHostsBefore = existsSync(knownHosts) ? readFileSync(knownHosts) : null;
const sheet = () => inner('[data-testid="cf-connect"]');
const openLink = (url) => execFileSync("rundll32", ["url.dll,FileProtocolHandler", url]);
const extraIds = [];

try {
  // The admin's own account on the lab server.
  execFileSync("docker", [
    "compose", "-f", "scripts/cf-setup-lab.yml", "exec", "-T", "sshd", "sh", "-c",
    "id admin >/dev/null 2>&1 || { adduser -D -s /bin/sh admin && echo admin:lab-pass | chpasswd && echo 'admin ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/admin; }",
  ]);
  await invoke("cloudflared_set_custom_path", { path: FAKE_CF });
  await invoke("cf_account_disconnect").catch(() => {});
  await invoke("save_profile", { profile: ADMIN });
  await invoke("save_profile", { profile: CERT });
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('[aria-label="New connection"]'), { timeout: 30000 });
  await page.evaluate(() => document.querySelector('[aria-label="Close welcome"]')?.click());
  await page.waitForSelector('[aria-label="web-1"]', { timeout: 10000 });

  // ---- 1. The editor finds the admin login and reads the state -----------
  await openEditor("web-1");
  const offer = await waitText(SEC, /Connect web-1 admin/, 10000);
  check("the editor offers the admin's own login to the same server", !!offer, await inner(SEC));
  await clickButton("Connect web-1 admin", SEC);
  check("…which connects and shows: not set up", !!(await waitMode("notSetUp")), await inner(SEC));
  check("…with the badge and the setup button", /Not set up/.test(await inner(SEC)) && /Set up Cloudflare login/.test(await inner(SEC)), await inner(SEC));
  await shot("1-not-set-up");

  // ---- 2. No account: paste the CA. A wrong key is put back -------------
  await clickButton("Set up Cloudflare login", SEC);
  await page.waitForSelector(DLG, { timeout: 5000 });
  const paste = await waitFor(() => page.evaluate((d) => !!document.querySelector(`${d} textarea[aria-label="Access CA public key"]`), DLG), 15000);
  check("with no Cloudflare account it asks for the CA key", !!paste, await inner(DLG));
  const you = await waitText(`${DLG} [data-testid="cf-login-setup-people"]`, /jane\.doe/, 15000);
  check("the signed-in person is listed by default", !!you && /you/.test(you), you ?? "");
  check("the opt-in starts off", !(await page.evaluate((d) => document.querySelector(`${d} input[type=checkbox]`)?.checked, DLG)));
  await setInput(`${DLG} textarea`, readFileSync(WRONG_CA, "utf8").trim());
  await clickButton("Review changes", DLG);
  const plan = await waitText(`${DLG} [data-testid="cf-login-plan"]`, /Commands, run as root/, 20000);
  check(
    "the plan shows the files and the exact commands first",
    !!plan &&
      ["/etc/ssh/sshd_config", "/etc/ssh/faro_cloudflare_ca.pub", "/etc/ssh/faro_principals/deploy"].every((f) => plan.includes(f)) &&
      /-t -f "\$new"/.test(plan) &&
      /Allow jane\.doe to log in as deploy/.test(plan) &&
      !/restart/.test(plan),
    plan ?? ""
  );
  check("…and says a certificate login is tried after", /Then Faro logs in as deploy/.test(plan ?? ""), plan ?? "");
  await shot("2-plan");
  const bad = await applyChange();
  const failed = await inner(DLG);
  check("a wrong CA fails the test login", bad === "failed" && /test login failed/i.test(failed), failed);
  check("…and the old settings are back", /old settings are back/.test(failed), failed);
  await shot("2-restored");
  await closeDialog();
  check("…so the server still reads: not set up", !!(await waitMode("notSetUp")), await inner(SEC));

  // ---- 3. With an account the CA comes from the API ---------------------
  await invoke("cf_account_connect", { token: "lab-token" });
  await clickButton("Set up Cloudflare login", SEC);
  await page.waitForSelector(DLG, { timeout: 5000 });
  const fromApi = await waitText(DLG, /Access CA public key\s*\n\s*ssh-/, 20000);
  check(
    "with an account the CA key comes from Cloudflare",
    !!fromApi && !(await page.evaluate((d) => !!document.querySelector(`${d} textarea`), DLG)),
    fromApi ?? (await inner(DLG))
  );
  await waitText(`${DLG} [data-testid="cf-login-setup-people"]`, /jane\.doe/, 15000);
  await clickButton("Review changes", DLG);
  await waitText(`${DLG} [data-testid="cf-login-plan"]`, /Commands, run as root/, 20000);
  const good = await applyChange();
  check("setup applies and a Cloudflare login works", good === "done" && /a Cloudflare login worked/.test(await inner(DLG)), await inner(DLG));
  await shot("3-done");
  await closeDialog();
  check("the editor shows: only listed people", !!(await waitMode("listed")) && /Only listed people/.test(await inner(SEC)), await inner(SEC));
  check("…with jane.doe on the list", /jane\.doe/.test(await inner(`${SEC} [data-testid="cf-login-people"]`)), await inner(SEC));
  await shot("3-listed");

  // ---- 4. Remove a person -------------------------------------------------
  await removePerson("jane.doe");
  await closeEditor();

  // ---- 5. A refused link: allow in one click ------------------------------
  openLink(`faro://connect?protocol=sftp&host=${H}&username=deploy&via=cloudflare&auth=cloudflarecert&name=web-1%20link`);
  await waitFor(async () => ((await sheet()).includes("Connect to") ? true : null), 20000);
  await clickButton("Connect", '[data-testid="cf-connect"]', true);
  const refused = await waitFor(async () => {
    const t = await sheet();
    if (t.includes("First time connecting")) await clickButton("Trust & connect", '[data-testid="cf-connect"]', true).catch(() => {});
    return /Allow jane\.doe to log in as deploy/.test(t) ? t : null;
  }, 90000);
  check("a refused certificate offers: Allow jane.doe to log in as deploy", !!refused, refused ?? (await sheet()));
  check(
    "…showing the command it runs first",
    /echo jane\.doe >> \/etc\/ssh\/faro_principals\/deploy/.test(refused ?? ""),
    refused ?? ""
  );
  await shot("5-refused-allow");
  await clickButton("Allow jane.doe to log in as deploy", '[data-testid="cf-allow"]');
  const closed = await waitFor(async () => {
    await acceptOnce();
    return (await sheet()) === "" ? true : null;
  }, 90000);
  check("one click lets them in: the sheet connects and closes", !!closed, await sheet());
  for (const p of await invoke("list_profiles")) if (p.name === "web-1 link") extraIds.push(p.id);
  await shot("5-connected");

  // ---- 6. Opt in: anyone the Access policy allows -------------------------
  await openEditor("web-1");
  await waitMode("listed");
  check("the editor shows jane.doe listed again", /jane\.doe/.test(await inner(`${SEC} [data-testid="cf-login-people"]`)), await inner(SEC));
  await removePerson("jane.doe"); // so only the policy can let her in
  await page.click(`${SEC} input[aria-label="Anyone the Access policy allows"]`);
  await page.waitForSelector(DLG, { timeout: 5000 });
  const warn = await waitText(`${DLG} [data-testid="cf-login-policy-warning"]`, /only way to take someone's access away/, 10000);
  check("turning it on warns first", !!warn, warn ?? "");
  const policyPlan = await waitText(`${DLG} [data-testid="cf-login-plan"]`, /Match User deploy/, 20000);
  check("…and shows the Match block and command", !!policyPlan && /AuthorizedPrincipalsCommand \/usr\/local\/sbin\/faro-access-principals %t %k/.test(policyPlan), policyPlan ?? "");
  await shot("6-policy-warning");
  const on = await applyChange();
  check("it applies, and a login through the policy works", on === "done" && /a Cloudflare login worked/.test(await inner(DLG)), await inner(DLG));
  await closeDialog();
  check("the editor shows: anyone the Access policy allows", !!(await waitMode("policy")) && /Anyone the Access policy allows/.test(await inner(SEC)), await inner(SEC));
  await shot("6-policy");

  await page.click(`${SEC} input[aria-label="Anyone the Access policy allows"]`);
  await page.waitForSelector(DLG, { timeout: 5000 });
  const offNote = await waitText(`${DLG} [data-testid="cf-login-test-note"]`, /only takes access away/, 20000);
  check("turning it off needs no warning and no test login", !!offNote && !(await inner(DLG)).includes("only way to take"), await inner(DLG));
  check("…turning it off applies", (await applyChange()) === "done", await inner(DLG));
  await closeDialog();
  check("back to: only listed people", !!(await waitMode("listed")), await inner(SEC));

  await clickButton("Remove Cloudflare login", SEC);
  await page.waitForSelector(DLG, { timeout: 5000 });
  await waitText(`${DLG} [data-testid="cf-login-plan"]`, /Stop trusting/, 20000);
  check("removing the setup applies", (await applyChange()) === "done", await inner(DLG));
  await closeDialog();
  check("…and it reads: not set up", !!(await waitMode("notSetUp")), await inner(SEC));
  await closeEditor();
} catch (e) {
  failures++;
  console.log("  ✗ FAIL  script error —", e.message);
  await shot("error");
} finally {
  for (const name of ["web-1 link", "web-1", "web-1 admin"]) {
    await page.click(`[aria-label="${name}"]`, { button: "right" }).catch(() => {});
    await page
      .evaluate(() => [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim().startsWith("Disconnect"))?.click())
      .catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
  }
  for (const id of [ADMIN.id, CERT.id, ...extraIds]) await invoke("delete_profile", { id }).catch(() => {});
  if (knownHostsBefore) writeFileSync(knownHosts, knownHostsBefore);
  else if (existsSync(knownHosts)) unlinkSync(knownHosts);
  await invoke("cf_account_disconnect").catch(() => {});
  await invoke("cloudflared_set_custom_path", { path: null }).catch(() => {});
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
