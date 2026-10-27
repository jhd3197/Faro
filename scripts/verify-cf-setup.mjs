// Real-app runtime verification for issue #57 (Cloudflare as a way to reach a
// server). Drives a build of Faro over WebView2's DevTools port against:
//   - examples/fake_cloudflare.rs on 127.0.0.1:8787 (FARO_CF_API points the
//     app at it), seeded with account "labacc" and zone example.test, and
//     returning the lab CA (`--ca-pub`) as each Access app's SSH CA;
//   - scripts/cf-setup-lab.yml, a plain sshd on 127.0.0.1:2224 whose
//     cloudflared stand-in reports the tunnel up to the fake API;
//   - the fake cloudflared (examples/stdio_relay.rs copied as cloudflared),
//     relaying web-N-ssh.example.test to the lab and handing out a
//     certificate for jane.doe signed by the lab CA.
// Steps:
//   1. Settings › Cloudflare: connect the account, create its service token.
//   2. The editor: "Through Cloudflare" reshapes the form; no service token.
//   3. Move a direct connection behind Cloudflare: API side, sudo script,
//      tunnel turns healthy, new connection tested, open ports listed.
//   4. The new connection's editor: tunnel health, certificate login ready.
//   5. Invite and remove a teammate, with the root step run over sudo.
//   6. faro-cli reaches the Cloudflare connection with the account token.
//   7. A second setup, then Undo all.
// Env: FAKE_CF (fake cloudflared), FAKE_STATE (fake API state file),
// FARO_E2E_DATA (the app's data dir), FARO_CLI, OUT_DIR. Exit 0 = all passed.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const { FAKE_CF, FAKE_STATE, FARO_E2E_DATA, FARO_CLI } = process.env;
const OUT = path.resolve(process.env.OUT_DIR || ".");
const ACCOUNT = "labacc";

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().includes("devtools"));
const invoke = (cmd, args = {}) => page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), cmd, args);
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const dialogText = () => page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? "");
const fake = () => JSON.parse(readFileSync(FAKE_STATE, "utf8"));
const lab = (cmd) => execFileSync("docker", ["compose", "-f", "scripts/cf-setup-lab.yml", "exec", "-T", "sshd", "sh", "-c", cmd]).toString();

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

/** Click the first enabled `tag` under `root` whose text starts with `label`;
 *  also answers a host-key prompt along the way ("Accept once"). */
async function clickText(label, root = "body", tag = "button", ms = 10000) {
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
    ms
  );
  if (!ok) throw new Error(`nothing enabled labelled "${label}" in ${root}`);
}

/** Keep clicking "Accept once" on host-key prompts until `fn` is truthy. */
async function acceptingHostKeys(fn, ms = 60000) {
  return waitFor(async () => {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once");
      if (b) b.click();
    });
    return fn();
  }, ms);
}

/** clickText that answers host-key prompts while it waits. */
async function clickAccepting(label, root) {
  const ok = await acceptingHostKeys(
    () =>
      page.evaluate(
        (label, root) => {
          const el = [...(document.querySelector(root)?.querySelectorAll("button") ?? [])].find(
            (b) => b.textContent.trim().startsWith(label) && !b.disabled
          );
          if (el) el.click();
          return !!el;
        },
        label,
        root
      ),
    60000
  );
  if (!ok) throw new Error(`nothing enabled labelled "${label}" in ${root}`);
}

async function rightClick(selector) {
  await page.waitForSelector(selector, { timeout: 10000 });
  await page.click(selector, { button: "right" });
}

async function closeDialog() {
  await page.keyboard.press("Escape");
  const gone = () => page.evaluate(() => !document.querySelector('[role="dialog"]'));
  if (await waitFor(gone, 1500)) return;
  // Escape only reaches a dialog that has focus; its Close button always works.
  await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const b = [...(d?.querySelectorAll("button") ?? [])].find(
      (b) => b.getAttribute("aria-label") === "Close" || b.textContent.trim().startsWith("Close")
    );
    b?.click();
  });
  await waitFor(gone, 5000);
}

async function type(selector, value) {
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.type(selector, value);
}

const profileNamed = async (name) => (await invoke("list_profiles")).find((p) => p.name === name);
const directId = crypto.randomUUID();

/** Run the Move dialog for `name` up to the ports step. */
async function moveBehindCloudflare(name) {
  await rightClick(`[data-rail-profile-id="${directId}"] button`);
  await clickText("Move behind Cloudflare…");
  await page.waitForSelector('[role="dialog"] [aria-label="Name"]', { timeout: 10000 });
  await waitFor(() => page.evaluate(() => document.querySelector('[aria-label="Domain"]')?.value));
  await type('[aria-label="Name"]', name);
  await type('[aria-label="Who gets in"]', "jane.doe@example.test");
  await clickText("Set it up", '[role="dialog"]');
  await page.waitForSelector('[data-testid="setup-created"]', { timeout: 30000 });
  await clickText("Run with sudo over", '[role="dialog"]');
  return acceptingHostKeys(() => page.evaluate(() => document.querySelector('[data-testid="open-ports"]')?.innerText), 120000);
}

try {
  // Leftovers from an interrupted run.
  for (const p of await invoke("list_profiles")) {
    if (p.name.startsWith("lab web")) await invoke("delete_profile", { id: p.id });
  }
  await invoke("cf_account_disconnect").catch(() => {});
  await invoke("cloudflared_set_custom_path", { path: FAKE_CF });
  await invoke("save_profile", {
    profile: {
      id: directId,
      name: "lab web-1",
      protocol: "sftp",
      host: "127.0.0.1",
      port: 2224,
      username: "deploy",
      auth: { kind: "password", password: "lab-pass" },
    },
  });
  await page.reload();
  await page.waitForSelector('[aria-label="Import connections…"]', { timeout: 30000 });

  // ---- 1. Connect the account ---------------------------------------------
  await clickText("Edit", "body", "button[aria-haspopup]");
  await clickText("Preferences…", '[role="menu"]');
  await clickText("Cloudflare", '[role="dialog"]');
  await page.waitForSelector('[aria-label="Cloudflare API token"]', { timeout: 10000 });
  await page.type('[aria-label="Cloudflare API token"]', "lab-token");
  await clickText("Connect account", '[data-testid="cf-account"]');
  const account = await waitFor(async () => {
    const t = await page.evaluate(() => document.querySelector('[data-testid="cf-account"]')?.innerText ?? "");
    return t.includes("Lab Co") ? t : null;
  });
  check("the account connects with a pasted API token", !!account, account ?? "");
  await clickText("Create", '[data-testid="cf-account"]');
  const token = await waitFor(() => page.evaluate(() => document.querySelector('[data-testid="cf-service-token"]')?.textContent));
  check("the account holds one service token", /\.access$/.test(token ?? ""), token ?? "");
  await shot("settings-account");
  await clickText("Done", '[role="dialog"]');
  await waitFor(() => page.evaluate(() => !document.querySelector('[role="dialog"]')), 5000);

  // ---- 2. The editor --------------------------------------------------------
  await page.evaluate(() => document.querySelector('[aria-label="New connection"]')?.click());
  await clickText("Through Cloudflare", '[role="dialog"] [role="radiogroup"]');
  const form = (await waitFor(async () => {
    const t = await dialogText();
    return t.includes("Log in as") ? t : null;
  }, 5000)) ?? (await dialogText());
  const auth = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    for (const el of d.querySelectorAll("label, div.mb-3")) {
      const cap = el.firstElementChild;
      if (cap?.tagName === "DIV" && cap.textContent.trim() === "Auth") return el.querySelector("select")?.value;
    }
  });
  check(
    "Through Cloudflare asks for the server and who to log in as",
    form.includes("Server") && form.includes("Log in as") && form.includes("How do you reach this server?"),
  );
  check("it defaults to the Cloudflare identity login", auth === "cloudflarecert", auth);
  check("no form asks for a service token", !/service token id|service token secret/i.test(form));
  await shot("editor-through-cloudflare");
  // Back to Direct: the Cloudflare login isn't offered at all, and the
  // chosen login moves off it.
  await clickText("Direct", '[role="dialog"] [role="radiogroup"]');
  const direct = await waitFor(() =>
    page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      const select = [...d.querySelectorAll("select")].find((s) => s.querySelector('option[value="agent"]'));
      if (!select || d.innerText.includes("Log in as")) return null;
      return { value: select.value, offered: !!select.querySelector('option[value="cloudflarecert"]') };
    })
  );
  check("Direct doesn't offer the Cloudflare login", direct && !direct.offered && direct.value === "password", JSON.stringify(direct));
  await shot("editor-direct");
  await closeDialog();

  // ---- 3. Move behind Cloudflare ------------------------------------------
  const ports = await moveBehindCloudflare("web-1");
  const text = await dialogText();
  check("setup lists what it created", /tunnel faro-web-1/.test(text) && /DNS record web-1-ssh\.example\.test/.test(text) && /Access application/.test(text));
  check("the new connection was tested and the open ports listed", /2224/.test(ports ?? ""), ports ?? "(no ports step)");
  await shot("move-ports");
  await clickText("Done", '[role="dialog"]');
  await closeDialog();

  const st = fake();
  const apps = st[`accounts/${ACCOUNT}/access/apps`] ?? [];
  const app = apps.find((a) => a.domain === "web-1-ssh.example.test");
  const policies = app ? st[`accounts/${ACCOUNT}/access/apps/${app.id}/policies`] : [];
  check(
    "the API side: tunnel, DNS, app, people and service token policies",
    (st[`accounts/${ACCOUNT}/cfd_tunnel`] ?? []).some((t) => t.name === "faro-web-1" && t.status === "healthy") &&
      (st["zones/zlab/dns_records"] ?? []).some((r) => r.name === "web-1-ssh.example.test" && r.proxied) &&
      policies?.[0]?.include?.[0]?.email?.email === "jane.doe@example.test" &&
      policies?.[1]?.decision === "non_identity",
    JSON.stringify(policies)
  );
  const conf = lab("cat /etc/ssh/sshd_config");
  check(
    "the server trusts the CA and lists jane.doe for deploy",
    conf.startsWith("# BEGIN faro-cloudflare\nTrustedUserCAKeys /etc/ssh/faro_cloudflare_ca.pub") &&
      lab("cat /etc/ssh/faro_principals/deploy").trim() === "jane.doe" &&
      lab("cat /etc/ssh/faro_cloudflare_ca.pub").trim() === readFileSync(path.join(path.dirname(FAKE_CF), "..", "ca.pub"), "utf8").trim(),
    conf.split("\n").slice(0, 4).join(" | ")
  );

  // ---- 4. The new connection -------------------------------------------------
  const cf = await profileNamed("lab web-1 via Cloudflare");
  check(
    "the new connection goes through Cloudflare with a certificate login",
    cf?.host === "web-1-ssh.example.test" && cf?.auth?.kind === "cloudflarecert" && cf?.proxyCommand?.kind === "cloudflare",
    JSON.stringify(cf)
  );
  await rightClick(`[data-rail-profile-id="${cf.id}"] button`);
  await clickText("Properties / Edit…");
  const status = await waitFor(async () => {
    const t = await page.evaluate(() => document.querySelector('[data-testid="editor-access-signin"]')?.innerText ?? "");
    return /tunnel healthy/.test(t) && /certificate login ready/.test(t) ? t : null;
  }, 20000);
  check("its editor shows sign-in, tunnel health and the certificate login", !!status, status ?? "");
  const reachChecked = await page.evaluate(
    () => document.querySelector('[role="radio"][aria-checked="true"]')?.textContent ?? ""
  );
  check("and opens on Through Cloudflare", reachChecked.startsWith("Through Cloudflare"), reachChecked);
  await shot("editor-new-connection");
  await closeDialog();

  // ---- 5. Invite and remove a teammate -------------------------------------
  await rightClick(`[data-rail-profile-id="${cf.id}"] button`);
  await clickText("Connect");
  await rightClick(`[data-rail-profile-id="${cf.id}"] button`);
  await clickText("Invite…");
  await page.waitForSelector('[aria-label="Email to invite"]', { timeout: 10000 });
  await page.type('[aria-label="Email to invite"]', "bob@example.test");
  await clickText("Invite", '[role="dialog"] form');
  await page.waitForSelector('[data-testid="invite-result"]', { timeout: 15000 });
  await clickAccepting("Run with sudo", '[data-testid="invite-root-step"]');
  await page.waitForSelector('[data-testid="root-done"]', { timeout: 20000 });
  const people = await waitFor(() => page.evaluate(() => document.querySelector('[data-testid="access-people"]')?.innerText));
  check("an invite adds the email to the Access policy", /bob@example\.test/.test(people ?? ""), people ?? "");
  check("and bob to deploy's principals", lab("cat /etc/ssh/faro_principals/deploy").split("\n").includes("bob"));
  await shot("invite");
  await clickText("Remove", '[data-testid="access-people"]');
  await waitFor(() => page.evaluate(() => /Removed/.test(document.querySelector('[data-testid="invite-result"]')?.innerText ?? "")), 15000);
  await clickAccepting("Run with sudo", '[data-testid="invite-root-step"]');
  await page.waitForSelector('[data-testid="root-done"]', { timeout: 20000 });
  const after = fake()[`accounts/${ACCOUNT}/access/apps/${app.id}/policies`];
  check(
    "Remove takes bob out of the policy and the principals file",
    !JSON.stringify(after).includes("bob@") && !lab("cat /etc/ssh/faro_principals/deploy").split("\n").includes("bob")
  );
  await closeDialog();

  // ---- 6. faro-cli with the account's service token ------------------------
  const envlog = path.join(path.dirname(FAKE_CF), "envlog-web-1-ssh.example.test");
  let cli = "";
  try {
    cli = execFileSync(FARO_CLI, ["ls", `${cf.name}:/`], {
      env: { ...process.env, FARO_DATA_DIR: FARO_E2E_DATA },
      timeout: 60000,
    }).toString();
  } catch (e) {
    cli = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  // faro-cli trusts a new host key on first use, in the user's own
  // ~/.ssh/known_hosts: take the lab's line back out.
  const kh = path.join(process.env.USERPROFILE ?? "", ".ssh", "known_hosts");
  if (existsSync(kh)) {
    const lines = readFileSync(kh, "utf8").split("\n");
    writeFileSync(kh, lines.filter((l) => !/^web-\d-ssh\.example\.test /.test(l)).join("\n"));
  }
  const used = existsSync(envlog) ? readFileSync(envlog, "utf8") : "";
  check("faro-cli hands cloudflared the account's service token", used === token, `${used} | ${cli.trim().split("\n").slice(-2).join(" ")}`);

  // ---- 7. A second setup, then Undo all -------------------------------------
  const ports2 = await moveBehindCloudflare("web-2");
  check("a second server name sets up too", !!ports2);
  await clickText("Undo all", '[role="dialog"]');
  await waitFor(() => page.evaluate(() => /Close$/.test([...document.querySelectorAll('[role="dialog"] button')].pop()?.textContent ?? "")), 30000);
  await sleep(1000);
  const st2 = fake();
  check(
    "Undo all deletes the second setup's tunnel, DNS and app, and keeps the first",
    !JSON.stringify(st2).includes("web-2-ssh") &&
      !(st2[`accounts/${ACCOUNT}/cfd_tunnel`] ?? []).some((t) => t.name === "faro-web-2") &&
      (st2[`accounts/${ACCOUNT}/cfd_tunnel`] ?? []).some((t) => t.name === "faro-web-1")
  );
  check("and its connection", (await invoke("list_profiles")).filter((p) => p.name === "lab web-1 via Cloudflare").length === 1);
  check("and reverts the server", !lab("cat /etc/ssh/sshd_config").includes("faro-cloudflare") && lab("ls /etc/ssh").indexOf("faro_cloudflare_ca.pub") < 0);
  await shot("undo");
  await closeDialog();
} catch (e) {
  failures++;
  console.log("  ✗ FAIL  script error —", e.message);
  await shot("error").catch(() => {});
} finally {
  for (const p of await invoke("list_profiles").catch(() => [])) {
    if (p.name.startsWith("lab web")) await invoke("delete_profile", { id: p.id }).catch(() => {});
  }
  await invoke("cf_account_disconnect").catch(() => {});
  await invoke("cloudflared_set_custom_path", { path: null }).catch(() => {});
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
