// Real-app runtime verification for Plan 31 (Docker manager). Drives a build
// of Faro over WebView2's DevTools port against scripts/server-lab.yml, whose
// host runs its own Docker daemon with throwaway containers:
//   1. dock (docker group): list with Compose grouping and stats; stop, start
//      and remove a container; the detail drawer; live logs; the container
//      shell; images, volumes, networks; prune.
//   2. admin (passwordless sudo): everything goes through sudo, a followed
//      log is really stopped on the host, restart works.
//   3. ops (sudo with a password): nothing runs before consent; logs are a
//      tail, because a stream can't type the password.
// Start the lab first:
//   docker compose -f scripts/server-lab.yml up -d --build
// (this script runs `lab-docker-up` itself to reset the containers).
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

const lab = (cmd) =>
  execFileSync("docker", ["compose", "-f", "scripts/server-lab.yml", "exec", "-T", "host", "sh", "-c", cmd])
    .toString()
    .trim();
/** Processes on the host matching a pattern (bracket one letter to skip pgrep itself). */
const count = (pattern) => Number(lab(`pgrep -fc '${pattern}' || true`));
const state = (name) => lab(`docker inspect -f '{{.State.Status}}' ${name} 2>/dev/null || echo gone`);
/** The Docker daemon's pid and start time: unchanged unless something killed it. */
const daemon = () => lab("pidof dockerd; systemctl show -p ActiveEnterTimestamp --value docker");

lab("lab-docker-up >/dev/null 2>&1; docker rm -f lab-e2e >/dev/null 2>&1; docker run -d --name lab-e2e busybox sleep infinity >/dev/null");

const daemonAtStart = daemon();

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().includes("devtools"));
const invoke = (cmd, args = {}) => page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), cmd, args);
const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
const panel = () => page.evaluate(() => document.querySelector('[role="tabpanel"]')?.innerText ?? "");
const dialogText = () => page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? "");
const drawerText = () => page.evaluate(() => document.querySelector("aside")?.innerText ?? "");
const logRows = () => page.evaluate(() => document.querySelector('[data-testid="log-view"] .xterm-rows')?.innerText ?? "");
const toasts = () => page.evaluate(() => document.body.innerText);

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(250);
  }
  return null;
}

/** Click the first enabled `tag` under `root` whose text is `label` (or starts with it + space). */
async function clickText(label, root = "body", tag = "button", ms = 10000) {
  const ok = await waitFor(
    () =>
      page.evaluate(
        (label, root, tag) => {
          const el = [...(document.querySelector(root)?.querySelectorAll(tag) ?? [])].find((b) => {
            const t = b.textContent.trim();
            return (t === label || t.startsWith(label + " ")) && !b.disabled;
          });
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

const click = async (selector, ms = 15000) => {
  await page.waitForSelector(selector, { timeout: ms });
  await page.click(selector);
};

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

async function connectAndOpenDocker(id) {
  await page.click(`[data-rail-profile-id="${id}"] button`, { button: "right" });
  await clickText("Connect");
  if (!(await acceptingHostKeys(serverPillEnabled, 60000))) throw new Error("the connection never came up");
  await clickText("Server");
  await page.waitForSelector('[role="tablist"][aria-label="Server view"]', { timeout: 20000 });
  await clickText("Docker", '[role="tablist"][aria-label="Server view"]', '[role="tab"]');
}

async function disconnect(id) {
  await page.click(`[data-rail-profile-id="${id}"] button`, { button: "right" });
  await clickText("Disconnect");
  await sleep(1500);
}

const section = (name) => clickText(name, '[role="tablist"][aria-label="Docker"]', '[role="tab"]');
const waitPanel = (text, ms = 20000) => waitFor(async () => ((await panel()).includes(text) ? panel() : null), ms);

const ids = { dock: crypto.randomUUID(), admin: crypto.randomUUID(), ops: crypto.randomUUID() };
const profile = (user) => ({
  id: ids[user],
  name: `lab docker ${user}`,
  protocol: "sftp",
  host: "127.0.0.1",
  port: 2225,
  username: user,
  auth: { kind: "password", password: "lab-pass" },
});

try {
  for (const p of await invoke("list_profiles")) {
    if (p.name.startsWith("lab docker")) await invoke("delete_profile", { id: p.id });
  }
  for (const user of Object.keys(ids)) await invoke("save_profile", { profile: profile(user) });
  await page.reload();
  await page.waitForSelector(`[data-rail-profile-id="${ids.dock}"]`, { timeout: 30000 });
  for (let i = 0; i < 3 && (await dialogText()); i++) {
    await page.keyboard.press("Escape");
    await sleep(400);
  }
  check("no log follower on the host before we start", count("docker logs --follo[w]") === 0);

  console.log("\n1. docker group — direct access");
  await connectAndOpenDocker(ids.dock);
  let text = await waitPanel("lab-logger");
  check("containers are listed", !!text);
  check("Compose project groups first", /COMPOSE · SHOP[\s\S]*shop-db-1[\s\S]*shop-web-1[\s\S]*NOT IN A COMPOSE PROJECT[\s\S]*lab-logger/.test(text ?? ""));
  check("toolbar names the daemon, no sudo note", /Docker \d+\.\d+/.test(text ?? "") && !/through sudo/.test(text ?? ""));
  check("exited container shows Docker's status", /lab-stopped[\s\S]*Exited \(3\)/.test(text ?? ""));
  const stats = await waitFor(async () => /\d+\.\d%/.test(await panel()), 25000);
  check("stats arrive for running containers", !!stats);
  await shot("docker-live-containers");

  await click('button[aria-label="Stop lab-e2e"]');
  check("Stop really stops the container", !!(await waitFor(() => state("lab-e2e") === "exited", 30000)), state("lab-e2e"));
  await click('button[aria-label="Start lab-e2e"]', 20000);
  check("Start really starts it", !!(await waitFor(() => state("lab-e2e") === "running", 20000)), state("lab-e2e"));
  await click('button[aria-label="More actions for lab-e2e"]');
  await clickText("Remove…", "body", 'button[role="menuitem"]');
  const ask = await waitFor(async () => ((await dialogText()).includes("Remove lab-e2e?") ? dialogText() : null), 5000);
  check("Remove confirms with the exact command", /docker rm -f lab-e2e/.test(ask ?? "") && !/sudo/.test(ask ?? ""), (ask ?? "").replace(/\n+/g, " ").slice(0, 110));
  check("nothing ran before confirming", state("lab-e2e") === "running");
  await clickText("Remove", '[role="dialog"]');
  check("the container is really removed", !!(await waitFor(() => state("lab-e2e") === "gone", 20000)), state("lab-e2e"));

  await clickText("lab-idle", '[role="tabpanel"]', "td span");
  const det = await waitFor(async () => ((await drawerText()).includes("LAB_TOKEN") ? drawerText() : null), 15000);
  check("details: environment listed with the value hidden", !!det && !det.includes("s3cret-value"));
  check("details: volume and read-only bind mount", /lab-data\s*→\s*\/data/.test(det ?? "") && /\/srv\/lab-site\s*→\s*\/site\s*\(read-only\)/.test(det ?? ""));
  check("details: published port and restart policy", /80\/tcp[\s\S]*127\.0\.0\.1:8088/.test(det ?? "") && /unless-stopped/.test(det ?? ""));
  await click('button[aria-label="Show LAB_TOKEN"]');
  check("details: value shows when asked", (await drawerText()).includes("s3cret-value"));
  await shot("docker-live-details");

  await click('button[aria-label="Logs for lab-logger"]');
  const rows = await waitFor(async () => (/tick \d+/.test(await logRows()) && /warn \d+/.test(await logRows()) ? logRows() : null), 20000);
  check("logs: both output streams arrive", !!rows);
  const r1 = await logRows();
  check("logs: new lines keep arriving", !!(await waitFor(async () => (await logRows()) !== r1, 8000)));
  check("logs: one follower on the host", count("docker logs --follo[w]") === 1, `${count("docker logs --follo[w]")} running`);
  await shot("docker-live-logs");
  await click('button[aria-label="Close container panel"]');
  check("logs: closing the panel stops the follower", !!(await waitFor(() => count("docker logs --follo[w]") === 0, 10000)), `${count("docker logs --follo[w]")} running`);

  await click('button[aria-label="Shell in lab-idle"]');
  const inShell = await waitFor(() => count("docker exec -it lab-idl[e]") >= 1, 15000);
  check("shell: a terminal runs docker exec in the container", !!inShell);
  const prompt = await waitFor(
    () => page.evaluate(() => [...document.querySelectorAll(".xterm-rows")].some((r) => /\/ #\s*$/m.test(r.innerText) || r.innerText.includes("/ # "))),
    10000
  );
  check("shell: lands on the container's prompt", !!prompt);

  await section("Images");
  text = await waitPanel("busybox");
  check("images: listed with the containers using them", /busybox:latest[\s\S]*lab-logger/.test(text ?? ""));
  await section("Volumes");
  text = await waitPanel("lab-orphan");
  check("volumes: usage is named", /lab-data[\s\S]*lab-idle/.test(text ?? "") && /lab-orphan[\s\S]*unused/.test(text ?? ""));
  await click('button[aria-label="Remove volume lab-data"]');
  const warn = await waitFor(async () => ((await dialogText()).includes("Remove lab-data?") ? dialogText() : null), 5000);
  check("volumes: the warning names the container and the data loss", /Used by lab-idle/.test(warn ?? "") && /can't be undone/.test(warn ?? ""));
  await clickText("Remove", '[role="dialog"]');
  check("volumes: Docker's refusal is shown", !!(await waitFor(async () => (await toasts()).includes("volume is in use"), 15000)));
  check("volumes: the in-use volume survives", lab("docker volume ls -q").includes("lab-data"));
  await click('button[aria-label="Remove volume lab-orphan"]');
  await waitFor(async () => (await dialogText()).includes("Remove lab-orphan?"), 5000);
  await clickText("Remove", '[role="dialog"]');
  check("volumes: an unused volume is really removed", !!(await waitFor(() => !lab("docker volume ls -q").includes("lab-orphan"), 15000)));
  await section("Networks");
  text = await waitPanel("lab-net");
  check("networks: attached containers are named", /lab-net[\s\S]*lab-idle/.test(text ?? ""));
  check(
    "networks: built-in networks can't be removed",
    await page.$eval(`button[aria-label="bridge comes with Docker and can't be removed"]`, (b) => b.disabled)
  );

  await section("Containers");
  await waitPanel("lab-stopped");
  await clickText("Prune…", '[role="tabpanel"]');
  const pr = await waitFor(async () => ((await dialogText()).includes("Remove all stopped containers?") ? dialogText() : null), 5000);
  check("prune: says what and shows the command", /docker container prune -f/.test(pr ?? "") && /reclaimable/.test(pr ?? ""), (pr ?? "").replace(/\n+/g, " ").slice(0, 120));
  await clickText("Prune", '[role="dialog"]');
  check("prune: the stopped container is gone, running ones stay", !!(await waitFor(() => state("lab-stopped") === "gone", 20000)) && state("lab-logger") === "running");
  await disconnect(ids.dock);
  check("disconnecting ends the container shell", !!(await waitFor(() => count("docker exec -it lab-idl[e]") === 0, 10000)), `${count("docker exec -it lab-idl[e]")} running`);

  console.log("\n2. passwordless sudo");
  await connectAndOpenDocker(ids.admin);
  text = await waitPanel("lab-logger");
  check("lists through sudo, and says so", /through sudo, so lists refresh only when asked/.test(text ?? ""));
  const started = () => lab("docker inspect -f '{{.State.StartedAt}}' shop-web-1");
  const s0 = started();
  await click('button[aria-label="Restart shop-web-1"]');
  check("restart works through sudo", !!(await waitFor(() => started() !== s0, 30000)));
  await click('button[aria-label="Logs for lab-logger"]');
  check("logs follow through sudo", !!(await waitFor(async () => /tick \d+/.test(await logRows()), 20000)));
  check("a root-owned follower is running", count("docker logs --follo[w]") >= 1, `${count("docker logs --follo[w]")} processes`);
  await click('button[aria-label="Close container panel"]');
  check("closing stops the root-owned follower too", !!(await waitFor(() => count("docker logs --follo[w]") === 0, 10000)), `${count("docker logs --follo[w]")} running`);
  // A quiet container's follower can only end by being signalled; that
  // signal once reached every process on the host (see stream_exec.rs).
  await click('button[aria-label="Logs for lab-idle"]');
  check("a quiet container's follower is running", !!(await waitFor(() => count("docker logs --follo[w]") >= 1, 15000)));
  await click('button[aria-label="Close container panel"]');
  check("a quiet follower is killed, not left behind", !!(await waitFor(() => count("docker logs --follo[w]") === 0, 10000)), `${count("docker logs --follo[w]")} running`);
  await sleep(1500);
  check("stopping it left the Docker daemon alone", daemon() === daemonAtStart, daemon().replace(/\n/g, " "));
  check("and the other containers still run", state("lab-logger") === "running" && state("lab-idle") === "running", `${state("lab-logger")} / ${state("lab-idle")}`);
  await click('button[aria-label="Shell in lab-idle"]');
  check("shell goes through sudo", !!(await waitFor(() => count("sudo docker exec -it lab-idl[e]") >= 1, 15000)));
  await disconnect(ids.admin);

  console.log("\n3. sudo that asks for a password");
  await connectAndOpenDocker(ids.ops);
  const gate = await waitPanel("Docker needs root on this host");
  check("nothing is listed before consent", !!gate && !/lab-logger/.test(gate ?? ""));
  await clickText("Use sudo password", '[role="tabpanel"]');
  await waitFor(async () => (await dialogText()).includes("password for sudo"), 5000);
  await clickText("Use password", '[role="dialog"]');
  text = await waitPanel("lab-logger", 30000);
  check("after consent the list loads", !!text);
  await click('button[aria-label="Logs for lab-logger"]');
  const tail = await waitFor(async () => (/tick \d+/.test(await logRows()) ? logRows() : null), 25000);
  check("logs are a tail here", !!tail);
  check("and the panel says why it isn't live", /Not live/.test(await drawerText()));
  check("no follower was started", count("docker logs --follo[w]") === 0);
  await shot("docker-live-password-sudo");
  await disconnect(ids.ops);
  check("nothing left running on the host", count("docker logs --follo[w]") === 0 && count("docker exec -it lab-idl[e]") === 0);
  check("the Docker daemon ran undisturbed throughout", daemon() === daemonAtStart);
} catch (e) {
  failures++;
  console.log(`  ✗ FAIL  ${e?.message ?? e}`);
  await shot("docker-live-failure").catch(() => {});
} finally {
  for (const p of await invoke("list_profiles").catch(() => [])) {
    if (p.name.startsWith("lab docker")) await invoke("delete_profile", { id: p.id }).catch(() => {});
  }
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
