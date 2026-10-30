// Real-app runtime verification for issue #62 (compress / extract archives and
// change owner / group). Drives a build of Faro over WebView2's DevTools port
// against an SSH lab whose /srv/lab holds `my site/` and `notes.txt`, logging in
// as root so chown works. Server state is checked with `docker exec`.
// Env: LAB_PORT (default 12322), LAB_CONTAINER (default faro-archive-lab),
// LOCAL_DIR (an empty local folder), OUT_DIR. Exit 0 = every check passed.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const PORT = Number(process.env.LAB_PORT || 12322);
const CONTAINER = process.env.LAB_CONTAINER || "faro-archive-lab";
const { LOCAL_DIR } = process.env;
const OUT = path.resolve(process.env.OUT_DIR || ".");
let failures = 0;
function check(name, cond, detail = "") {
  if (!cond) failures++;
  console.log(`  ${cond ? "✓ PASS" : "✗ FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(200);
  }
  return null;
}
const lab = (cmd) => {
  try {
    return execFileSync("docker", ["exec", CONTAINER, "sh", "-c", cmd], { encoding: "utf8" }).trim();
  } catch (e) {
    return `ERR ${e.stderr || e.message}`.trim();
  }
};

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().includes("devtools"));
const invoke = (cmd, args = {}) =>
  page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a).catch((e) => ({ error: String(e?.message ?? e) })), cmd, args);

const profile = {
  id: "e2e-archive",
  name: "e2e archive",
  protocol: "sftp",
  host: "127.0.0.1",
  port: PORT,
  username: "root",
  auth: { kind: "password", password: "farotest" },
  defaultRemotePath: "/srv/lab",
  // A rail click connects straight away instead of opening the bubble menu.
  autoConnect: true,
};

const remotePane = () =>
  page.evaluate(() => {
    const p = [...document.querySelectorAll("[data-file-pane]")].find((el) => el.dataset.fileSession && el.dataset.fileSession !== "local");
    return p ? `[data-file-pane="${p.dataset.filePane}"]` : null;
  });
const rowNames = (pane) =>
  page.evaluate(
    (pane) => [...(document.querySelector(pane)?.querySelectorAll("[title^='Double-click']") ?? [])].map((r) => r.innerText.split("\n")[0].trim()),
    pane
  );
async function rowHandle(pane, name) {
  const h = await page.evaluateHandle(
    (pane, name) => [...document.querySelector(pane).querySelectorAll("[title^='Double-click']")].find((r) => r.innerText.split("\n")[0].trim() === name),
    pane,
    name
  );
  const el = h.asElement();
  if (!el) throw new Error(`no row "${name}"`);
  return el;
}
/** Click a menu item by its label; a submenu parent opens its submenu. */
async function menuClick(label) {
  const ok = await waitFor(() =>
    page.evaluate((label) => {
      const b = [...document.querySelectorAll('[role="menu"] button')].find((b) => b.textContent.trim() === label);
      if (b) b.click();
      return !!b;
    }, label),
    5000
  );
  if (!ok) throw new Error(`no menu item "${label}"`);
  await sleep(150);
}
const menuLabels = () => page.evaluate(() => [...document.querySelectorAll('[role="menu"] button')].map((b) => b.textContent.trim()));
async function dialogSubmit(label, value) {
  await page.waitForSelector('[role="dialog"] input', { timeout: 5000 });
  const initial = await page.$eval('[role="dialog"] input', (i) => i.value);
  if (value != null) {
    await page.click('[role="dialog"] input', { clickCount: 3 });
    await page.keyboard.type(value);
  }
  await page.evaluate((label) => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === label)?.click(), label);
  return initial;
}
const paneText = (pane) => page.evaluate((pane) => document.querySelector(pane)?.innerText ?? "", pane);

try {
  await page.waitForFunction(() => !!document.querySelector('[aria-label="New connection"]'), { timeout: 30000 });
  await invoke("save_profile", { profile });
  await page.reload();
  await page.waitForFunction(() => !!document.querySelector('[aria-label="e2e archive"]'), { timeout: 30000 });
  await page.click('[aria-label="e2e archive"]');
  const pane = await waitFor(async () => {
    await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Accept once")?.click());
    const p = await remotePane();
    return p && (await rowNames(p)).includes("notes.txt") ? p : null;
  }, 40000);
  check("the SSH connection opens /srv/lab", !!pane);
  if (!pane) throw new Error("no remote pane");
  const sid = await page.$eval(pane, (el) => el.dataset.fileSession);

  // ---- Compress a folder to .zip from the context menu --------------------
  await (await rowHandle(pane, "my site")).click({ button: "right" });
  await menuClick("Compress");
  const formats = await menuLabels();
  check("Compress offers zip, tar.gz, tar and 7z on a server", ["Zip (.zip)", "Tar + gzip (.tar.gz)", "Tar (.tar)", "7-Zip (.7z)"].every((f) => formats.includes(f)), formats.join(" | "));
  await page.screenshot({ path: path.join(OUT, "archive-compress-menu.png") });
  await menuClick("Zip (.zip)");
  const zipName = await dialogSubmit("Compress");
  check("the archive name defaults to the folder name", zipName === "my site.zip", zipName);
  check("the zip appears in the listing", !!(await waitFor(async () => (await rowNames(pane)).includes("my site.zip"))));
  const zipList = lab("unzip -Z1 '/srv/lab/my site.zip' | tr '\n' ' '");
  check("the zip holds the folder's files under their relative paths", zipList.includes("my site/css/app.css") && !zipList.includes("/srv/"), zipList.split("\n").slice(-4).join(" / "));

  // ---- Extract it to a fresh folder ("my site" exists, so "my site 2") -----
  await (await rowHandle(pane, "my site.zip")).click({ button: "right" });
  await menuClick("Extract");
  const extractItems = await menuLabels();
  check("Extract offers here, a new folder, and a chosen destination", ["Extract here", "Extract to “my site/”", "Extract to…"].every((f) => extractItems.includes(f)), extractItems.join(" | "));
  await page.screenshot({ path: path.join(OUT, "archive-extract-menu.png") });
  await menuClick("Extract to “my site/”");
  check("extracting next to an existing folder makes \"my site 2\"", !!(await waitFor(async () => (await rowNames(pane)).includes("my site 2"))));
  check("the extracted files match", lab("cat '/srv/lab/my site 2/my site/css/app.css'") === "body{}");

  // ---- Multi-select → tar.gz, then "Extract here" keeps existing files ------
  lab("echo original > /srv/lab/notes.txt");
  await (await rowHandle(pane, "my site")).click();
  await page.keyboard.down("Control");
  await (await rowHandle(pane, "notes.txt")).click();
  await page.keyboard.up("Control");
  await (await rowHandle(pane, "notes.txt")).click({ button: "right" });
  await menuClick("Compress");
  await menuClick("Tar + gzip (.tar.gz)");
  const tgzName = await dialogSubmit("Compress", "bundle.tar.gz");
  check("a multi-item archive defaults to the folder's name", tgzName === "lab.tar.gz", tgzName);
  check("bundle.tar.gz appears", !!(await waitFor(async () => (await rowNames(pane)).includes("bundle.tar.gz"))));
  const tgzList = lab("tar -tzf /srv/lab/bundle.tar.gz | sort | tr '\\n' ' '");
  check("bundle.tar.gz holds both items", tgzList.includes("./notes.txt") && tgzList.includes("./my site/index.html"), tgzList);
  lab("echo changed > /srv/lab/notes.txt");
  await (await rowHandle(pane, "bundle.tar.gz")).click({ button: "right" });
  await menuClick("Extract");
  await menuClick("Extract here");
  const keptMsg = await waitFor(async () => {
    const t = await paneText(pane);
    return /kept, not overwritten/.test(t) ? t : null;
  });
  check("Extract here refuses to overwrite and says so", !!keptMsg, (keptMsg ?? (await paneText(pane))).split("\n").find((l) => /Extract failed/.test(l)) ?? "");
  check("the existing file was not overwritten", lab("cat /srv/lab/notes.txt") === "changed");
  await page.screenshot({ path: path.join(OUT, "archive-kept.png") });
  await page.evaluate((pane) => [...document.querySelector(pane).querySelectorAll("button")].find((b) => b.textContent.trim() === "dismiss")?.click(), pane);

  // ---- 7z via Compress, then "Extract to…" a chosen folder ------------------
  await waitFor(async () => (await rowNames(pane)).includes("notes.txt"));
  await (await rowHandle(pane, "notes.txt")).click({ button: "right" });
  await menuClick("Compress");
  await menuClick("7-Zip (.7z)");
  await dialogSubmit("Compress");
  check("notes.txt.7z appears", !!(await waitFor(async () => (await rowNames(pane)).includes("notes.txt.7z"))));
  await (await rowHandle(pane, "notes.txt.7z")).click({ button: "right" });
  await menuClick("Extract");
  await menuClick("Extract to…");
  const dest = await dialogSubmit("Extract", "/srv/lab/out/seven");
  check("Extract to… suggests a folder named after the archive", dest === "/srv/lab/notes.txt", dest);
  await waitFor(async () => lab("cat /srv/lab/out/seven/notes.txt") === "changed", 15000);
  check("the 7z extracted into the chosen folder", lab("cat /srv/lab/out/seven/notes.txt") === "changed");

  // ---- Compress refuses to replace an existing archive ---------------------
  const dup = await invoke("compress_paths", { sessionId: sid, paths: ["/srv/lab/notes.txt"], archiveName: "bundle.tar.gz", format: "tar.gz" });
  check("compressing onto an existing name is refused", /already exists/.test(dup?.error ?? ""), dup?.error);
  check("and the existing archive is untouched", lab("tar -tzf /srv/lab/bundle.tar.gz | grep -c index.html") === "1");

  // ---- Properties: owner / group, recursive ---------------------------------
  await (await rowHandle(pane, "my site")).click({ button: "right" });
  await menuClick("Properties");
  const loaded = await waitFor(() =>
    page.evaluate(() => {
      const o = document.querySelector('[role="dialog"] input[aria-label="Owner"]');
      const g = document.querySelector('[role="dialog"] input[aria-label="Group"]');
      return o && !o.disabled && o.value ? `${o.value}:${g.value}` : null;
    })
  );
  check("Properties shows the current owner and group", loaded === "root:root", loaded ?? "(nothing loaded)");
  await page.click('[role="dialog"] input[aria-label="Owner"]', { clickCount: 3 });
  await page.keyboard.type("web");
  await page.click('[role="dialog"] input[aria-label="Group"]', { clickCount: 3 });
  await page.keyboard.type("web");
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] label')].find((l) => l.textContent.includes("everything inside"))?.querySelector("input")?.click());
  await page.screenshot({ path: path.join(OUT, "archive-owner-edit.png") });
  await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === "Apply owner")?.click());
  const saved = await waitFor(() => page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText.includes("Owner updated")));
  check("Apply owner reports success", !!saved);
  check("the folder and everything inside now belong to web:web",
    lab("stat -c '%U:%G' '/srv/lab/my site' '/srv/lab/my site/css/app.css' | sort -u") === "web:web",
    lab("stat -c '%U:%G %n' '/srv/lab/my site' '/srv/lab/my site/css/app.css'"));
  await page.screenshot({ path: path.join(OUT, "archive-owner-saved.png") });
  await page.keyboard.press("Escape");

  const groupOnly = await invoke("chown_path", { sessionId: sid, path: "/srv/lab/notes.txt", owner: "", group: "web", recursive: false });
  check("a group-only change leaves the owner alone", !groupOnly?.error && lab("stat -c '%U:%G' /srv/lab/notes.txt") === "root:web", groupOnly?.error ?? lab("stat -c '%U:%G' /srv/lab/notes.txt"));
  const badName = await invoke("chown_path", { sessionId: sid, path: "/srv/lab/notes.txt", owner: "root;touch /tmp/pwned", group: "", recursive: false });
  check("a shell-looking owner name is rejected", /isn't a valid owner/.test(badName?.error ?? "") && lab("test -e /tmp/pwned && echo yes || echo no") === "no", badName?.error);
  const noUser = await invoke("chown_path", { sessionId: sid, path: "/srv/lab/notes.txt", owner: "nosuchuser", group: "", recursive: false });
  check("an unknown user explains itself", /doesn't exist/.test(noUser?.error ?? ""), noUser?.error);

  // ---- Local files: round trip through the app's own zip/tar code -----------
  if (LOCAL_DIR) {
    mkdirSync(path.join(LOCAL_DIR, "proj", "src"), { recursive: true });
    writeFileSync(path.join(LOCAL_DIR, "proj", "src", "main.txt"), "local body");
    for (const [format, ext] of [["zip", "zip"], ["tar.gz", "tar.gz"], ["tar", "tar"]]) {
      const made = await invoke("compress_paths", { sessionId: "local", paths: [path.join(LOCAL_DIR, "proj")], archiveName: `proj.${ext}`, format });
      const out = await invoke("extract_archive", { sessionId: "local", path: made, destination: null });
      let body = "";
      try { body = readFileSync(path.join(out, "proj", "src", "main.txt"), "utf8"); } catch {}
      check(`local ${ext} compresses and extracts to a new folder`, typeof out === "string" && body === "local body", typeof out === "string" ? out : JSON.stringify(out ?? made));
    }
    const seven = await invoke("compress_paths", { sessionId: "local", paths: [path.join(LOCAL_DIR, "proj")], archiveName: "proj.7z", format: "7z" });
    check("local 7z creation explains it's server-only", /only be created on a server/.test(seven?.error ?? ""), seven?.error);
  }
} catch (e) {
  failures++;
  console.log("  ✗ FAIL  script error —", e.message);
  await page.screenshot({ path: path.join(OUT, "archive-error.png") }).catch(() => {});
} finally {
  await invoke("delete_profile", { id: profile.id }).catch(() => {});
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
