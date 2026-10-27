// Real-app runtime verification for issue #60 (Windows folder links shown as
// files). Drives a build of Faro over WebView2's DevTools port: the file pane
// opens LINK_DIR, which holds `real folder`, `linked-folder` (a junction to
// it), `junction-folder` (a junction whose target is gone) and `target.txt`.
// Env: LINK_DIR, OUT_DIR. Exit 0 = every check passed.
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import puppeteer from "puppeteer-core";

const { LINK_DIR } = process.env;
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

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().includes("devtools"));
const invoke = (cmd, args = {}) => page.evaluate((c, a) => window.__TAURI_INTERNALS__.invoke(c, a), cmd, args);
// The browser's pane, showing local files when no server is chosen.
const pane = "[data-file-pane]";

/** The pane's rows: name, the lucide icon class, and its position. */
const rows = () =>
  page.evaluate((pane) => {
    const root = document.querySelector(pane);
    return [...(root?.querySelectorAll("[title^='Double-click']") ?? [])].map((r, i) => ({
      i,
      name: r.innerText.split("\n")[0].trim(),
      icon: r.querySelector("svg")?.getAttribute("class") ?? "",
      title: r.getAttribute("title"),
    }));
  }, pane);

try {
  const listing = await invoke("list_directory", { sessionId: "local", path: LINK_DIR }).catch((e) => ({ error: String(e) }));
  const entries = Array.isArray(listing) ? listing : listing.entries;
  const get = (n) => (Array.isArray(entries) ? entries.find((e) => e.name === n) : undefined);
  check("the backend reports the junction as a link to a folder", get("linked-folder")?.kind === "symlink" && get("linked-folder")?.linkDir === true, JSON.stringify(get("linked-folder") ?? listing));
  check("a link whose folder is gone stays a plain link", get("junction-folder")?.kind === "symlink" && !get("junction-folder")?.linkDir);

  await page.waitForSelector('[aria-label="Local files"]', { timeout: 20000 });
  await page.click('[aria-label="Local files"]');
  await waitFor(() => page.evaluate((p) => document.querySelector(p)?.dataset.fileSession === "local", pane));
  await page.click(`${pane} button[title="Edit path"]`);
  await page.keyboard.down("Control");
  await page.keyboard.press("a");
  await page.keyboard.up("Control");
  await page.keyboard.type(LINK_DIR);
  await page.keyboard.press("Enter");
  const shown = await waitFor(async () => ((await rows()).some((r) => r.name === "linked-folder") ? rows() : null));
  const r = (n) => shown?.find((x) => x.name === n);
  check("it shows with a folder-link icon", /folder-symlink/.test(r("linked-folder")?.icon ?? ""), r("linked-folder")?.icon);
  check("it sorts with the folders", r("linked-folder") && r("target.txt") && r("linked-folder").i < r("target.txt").i, JSON.stringify(shown?.map((x) => x.name)));
  check("its tooltip says double-click opens it", /open/.test(r("linked-folder")?.title ?? ""), r("linked-folder")?.title);
  check("the broken link keeps the link icon", /lucide-link/.test(r("junction-folder")?.icon ?? ""), r("junction-folder")?.icon);
  await page.screenshot({ path: path.join(OUT, "links-listing.png") });

  const row = await page.evaluateHandle(
    (pane) => [...document.querySelector(pane).querySelectorAll("[title^='Double-click']")].find((e) => e.innerText.startsWith("linked-folder")),
    pane
  );
  await row.asElement().click({ count: 2 });
  const inside = await waitFor(async () => ((await rows()).some((x) => x.name === "inside.txt") ? "yes" : null));
  check("double-click opens the linked folder", !!inside);
  await page.screenshot({ path: path.join(OUT, "links-inside.png") });
} catch (e) {
  failures++;
  console.log("  ✗ FAIL  script error —", e.message);
  await page.screenshot({ path: path.join(OUT, "links-error.png") }).catch(() => {});
} finally {
  browser.disconnect();
}
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
