// Real-app runtime verification for Plan 30 (Server view). Drives a build of
// Faro over WebView2's DevTools port against scripts/server-lab.yml, a Linux
// host with systemd on 127.0.0.1:2225:
//   1. Overview: live samples reach the charts; exactly one sampler loop
//      runs on the host while the tab shows.
//   2. Services: the failed unit sorts first; Restart confirms with the exact
//      command and the unit really restarts (its MainPID changes).
//   3. Ports and Firewall read the host's real state as root.
//   4. Leaving Overview, closing the view and disconnecting each leave no
//      sampler behind on the host.
//   5. A user whose sudo asks for a password: one consent, then it works.
// Start the lab first (`docker compose -f scripts/server-lab.yml up -d --build`)
// and enable its firewall once:
//   docker compose -f scripts/server-lab.yml exec -T host sh -c \
//     'ufw allow 22/tcp && ufw deny 5432/tcp && ufw --force enable'
// Env: CDP_PORT (default 9333), OUT_DIR for screenshots. Exit 0 = all passed.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const OUT = path.resolve(process.env.OUT_DIR || ".");
const PORT = process.env.CDP_PORT || "9333";

let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().includes("devtools"));
const invoke = (cmd, args = {}) => page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), cmd, args);
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const lab = (cmd) =>
  execFileSync("docker", ["compose", "-f", "scripts/server-lab.yml", "exec", "-T", "host", "sh", "-c", cmd])
    .toString()
    .trim();
/** Sampler loops alive on the host. The bracket keeps pgrep from matching itself. */
const loops = () => Number(lab("pgrep -fc 'cat /proc/uptim[e]' || true"));
const mainPid = (unit) => lab(`systemctl show -p MainPID --value ${unit}`);
const panel = () => page.evaluate(() => document.querySelector('[role="tabpanel"]')?.innerText ?? "");
const dialogText = () => page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? "");

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

/** Click the first enabled `tag` under `root` whose text is exactly `label`. */
async function clickText(label, root = "body", tag = "button", ms = 10000) {
  const ok = await waitFor(
    () =>
      page.evaluate(
        (label, root, tag) => {
          const el = [...(document.querySelector(root)?.querySelectorAll(tag) ?? [])].find(
            (b) => b.textContent.trim() === label && !b.disabled
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

/** Keep answering host-key prompts ("Accept once") until `fn` is truthy. */
async function acceptingHostKeys(fn, ms = 60000) {
  return waitFor(async () => {
    await page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once");
      if (b) b.click();
    });
    return fn();
  }, ms);
}

const serverPillEnabled = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Server");
    return !!b && !b.disabled;
  });

async function connect(id) {
  await page.click(`[data-rail-profile-id="${id}"] button`, { button: "right" });
  await clickText("Connect");
  const ok = await acceptingHostKeys(serverPillEnabled, 60000);
  if (!ok) throw new Error("the connection never came up");
}

async function openTab(label) {
  await clickText(label, '[role="tablist"][aria-label="Server view"]', '[role="tab"]');
}

const adminId = crypto.randomUUID();
const opsId = crypto.randomUUID();
const profile = (id, name, username) => ({
  id,
  name,
  protocol: "sftp",
  host: "127.0.0.1",
  port: 2225,
  username,
  auth: { kind: "password", password: "lab-pass" },
});

try {
  for (const p of await invoke("list_profiles")) {
    if (p.name.startsWith("lab server")) await invoke("delete_profile", { id: p.id });
  }
  await invoke("save_profile", { profile: profile(adminId, "lab server admin", "admin") });
  await invoke("save_profile", { profile: profile(opsId, "lab server ops", "ops") });
  await page.reload();
  await page.waitForSelector(`[data-rail-profile-id="${adminId}"]`, { timeout: 30000 });
  // A fresh data dir greets with the walkthrough; it would cover the rail.
  for (let i = 0; i < 3 && (await dialogText()); i++) {
    await page.keyboard.press("Escape");
    await sleep(400);
  }
  check("no sampler on the host before we start", loops() === 0, `${loops()} running`);

  console.log("\n1. Overview — live metrics from the real host");
  await connect(adminId);
  await clickText("Server");
  await page.waitForSelector('[role="tablist"][aria-label="Server view"]', { timeout: 20000 });
  const tabs = await page.$$eval('[role="tab"]', (els) => els.map((e) => e.textContent.trim()));
  check("probe shows all four tabs", tabs.join(",") === "Overview,Services,Ports,Firewall", tabs.join(","));
  const header = await page.evaluate(() => document.querySelector('[role="tablist"]')?.parentElement?.innerText ?? "");
  check("header names the distro", /Ubuntu 24\.04/.test(header), header.replace(/\n/g, " ").slice(0, 80));
  const cpu = await waitFor(async () => (await panel()).match(/CPU\s+(\d+\.\d)%/), 20000);
  check("CPU shows a live percentage", !!cpu, cpu?.[0]?.replace(/\s+/g, " "));
  const text = await panel();
  check("memory shows used and total", /MEMORY\s+[\d.]+ (GB|MB)[\s\S]*% of [\d.]+ GB/i.test(text));
  check("filesystems table has the root mount", /\n\/\s/.test(text) || /\/\t/.test(text), "");
  const line = () => page.$eval('[role="tabpanel"] svg[role="img"] path[stroke]', (el) => el.getAttribute("d"));
  const d1 = await line();
  const moved = await waitFor(async () => (await line()) !== d1, 10000);
  check("the CPU chart keeps drawing new samples", !!moved);
  check("exactly one sampler loop on the host", loops() === 1, `${loops()} running`);
  await shot("server-live-overview");

  console.log("\n2. Services — list, restart with confirmation, logs");
  await openTab("Services");
  const first = await waitFor(
    () =>
      page.evaluate(() => {
        const row = document.querySelector('[role="tabpanel"] tbody tr')?.innerText ?? "";
        return row.includes(".service") ? row : "";
      }),
    20000
  );
  check("failed unit sorts first", /lab-broken\.service[\s\S]*failed \(failed\)/.test(first ?? ""), (first ?? "").replace(/\s+/g, " ").slice(0, 70));
  const gone = await waitFor(() => loops() === 0, 10000);
  check("leaving Overview stops the sampler on the host", !!gone, `${loops()} running`);
  const before = mainPid("lab-web.service");
  await page.click('button[aria-label="Restart lab-web.service"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  const ask = await dialogText();
  check("restart confirms with the exact command", /sudo systemctl restart lab-web\.service/.test(ask), ask.replace(/\n/g, " ").slice(0, 90));
  check("nothing ran before confirming", mainPid("lab-web.service") === before);
  await clickText("Restart", '[role="dialog"]');
  const restarted = await waitFor(() => mainPid("lab-web.service") !== before, 20000);
  check("the unit really restarted", !!restarted, `MainPID ${before} -> ${mainPid("lab-web.service")}`);
  await page.click('button[aria-label="Logs for lab-web.service"]');
  const logs = await waitFor(
    () => page.evaluate(() => document.querySelector('aside[aria-label="Logs for lab-web.service"] pre')?.innerText.includes("Started lab-web.service")),
    15000
  );
  check("journal shows the restart", !!logs);
  await shot("server-live-services");

  console.log("\n3. Ports and firewall — read as root");
  await openTab("Ports");
  const ports = await waitFor(async () => ((await panel()).includes("sshd") ? panel() : null), 15000);
  check("sshd's socket is listed by name", /22\s+tcp[\s\S]*sshd/.test(ports ?? ""));
  await openTab("Firewall");
  const fw = await waitFor(async () => ((await panel()).includes("DENY IN") ? panel() : null), 15000);
  check("ufw rules are parsed", /5432\/tcp\s+DENY IN/.test(fw ?? ""));
  check("firewall shows as active and read-only", /Active/.test(fw ?? "") && /Read-only/.test(fw ?? ""));
  await shot("server-live-firewall");

  console.log("\n4. Sampler lifecycle");
  await openTab("Overview");
  check("back on Overview the sampler runs again", !!(await waitFor(() => loops() === 1, 10000)), `${loops()} running`);
  await page.keyboard.press("Escape");
  await waitFor(() => page.evaluate(() => !document.querySelector('[role="tablist"][aria-label="Server view"]')), 5000);
  check("closing the view stops it", !!(await waitFor(() => loops() === 0, 10000)), `${loops()} running`);
  await clickText("Server");
  check("reopened: one sampler", !!(await waitFor(() => loops() === 1, 15000)), `${loops()} running`);
  await page.click(`[data-rail-profile-id="${adminId}"] button`, { button: "right" });
  await clickText("Disconnect");
  check("disconnecting stops it", !!(await waitFor(() => loops() === 0, 10000)), `${loops()} running`);
  const closed = await waitFor(() => page.evaluate(() => !document.querySelector('[role="tablist"][aria-label="Server view"]')), 5000);
  check("disconnecting closes the view", !!closed);

  console.log("\n5. sudo that asks for a password");
  await connect(opsId);
  await clickText("Server");
  await page.waitForSelector('[role="tablist"][aria-label="Server view"]', { timeout: 20000 });
  await openTab("Services");
  await page.waitForSelector('button[aria-label="Restart lab-web.service"]', { timeout: 20000 });
  const pid2 = mainPid("lab-web.service");
  await page.click('button[aria-label="Restart lab-web.service"]');
  await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
  await clickText("Restart", '[role="dialog"]');
  const consent = await waitFor(async () => ((await dialogText()).includes("password for sudo") ? dialogText() : null), 5000);
  check("asks once before using the login password", !!consent, (consent ?? "").split("\n")[0]);
  check("nothing ran before consent", mainPid("lab-web.service") === pid2);
  await clickText("Use password", '[role="dialog"]');
  const again = await waitFor(() => mainPid("lab-web.service") !== pid2, 25000);
  check("restart works with password sudo", !!again, `MainPID ${pid2} -> ${mainPid("lab-web.service")}`);
  await openTab("Firewall");
  const fw2 = await waitFor(async () => ((await panel()).includes("DENY IN") ? panel() : null), 20000);
  check("firewall reads without asking again", !!fw2 && !(await dialogText()));
  await page.click(`[data-rail-profile-id="${opsId}"] button`, { button: "right" });
  await clickText("Disconnect");
  await sleep(1500);
  check("nothing left running on the host", loops() === 0, `${loops()} running`);
} catch (e) {
  failures++;
  console.log(`  ✗ FAIL  ${e?.message ?? e}`);
  await shot("server-live-failure").catch(() => {});
} finally {
  for (const p of await invoke("list_profiles").catch(() => [])) {
    if (p.name.startsWith("lab server")) await invoke("delete_profile", { id: p.id }).catch(() => {});
  }
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
