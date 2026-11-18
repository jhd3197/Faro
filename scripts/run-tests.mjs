// Runs the node:test suites in scripts/*.test.mjs, one file at a time.
//
//   node scripts/run-tests.mjs unit   every test that doesn't drive a browser
//   node scripts/run-tests.mjs ui     every puppeteer test, against the mock build
//   node scripts/run-tests.mjs all    both
//   node scripts/run-tests.mjs ui rail palette   only files whose name matches
//
// A file counts as a UI test when it imports puppeteer-core, so new tests are
// picked up without touching this list. Files run serially (they start their
// own mock Vite server, some on a fixed port) with a hard timeout each.
//
// Env:
//   CHROME_PATH       browser to use; found automatically when unset
//   UI_TEST_PORT      overrides every <NAME>_PORT a test reads, so all of
//                     them use one known-free port (handy beside a dev server)
//   TEST_TIMEOUT_MS   per-file limit (default 6 minutes)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "scripts");

// Tests that can't run unattended. Each needs a reason; keep this short.
const MANUAL = {
  // Nothing here yet.
};

const [mode = "all", ...filters] = process.argv.slice(2);
if (!["unit", "ui", "all"].includes(mode)) {
  console.error(`usage: run-tests.mjs [unit|ui|all] [name filter...]`);
  process.exit(2);
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .map((f) => ({ name: f, ui: /from\s+["']puppeteer-core["']/.test(readFileSync(path.join(DIR, f), "utf8")) }))
  .filter((f) => mode === "all" || (mode === "ui") === f.ui)
  .filter((f) => !filters.length || filters.some((q) => f.name.includes(q)));

for (const f of files) if (MANUAL[f.name]) f.skip = MANUAL[f.name];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"]) {
    if (process.platform === "win32") break;
    const which = spawnSync("which", [bin], { encoding: "utf8" });
    if (which.status === 0) candidates.push(which.stdout.trim());
  }
  return candidates.find((p) => p && existsSync(p));
}

const env = { ...process.env, VITE_UI_LOCALE: process.env.VITE_UI_LOCALE || "en" };
if (files.some((f) => f.ui && !f.skip)) {
  const chrome = findChrome();
  if (!chrome) {
    console.error("No Chrome/Chromium/Edge found; install one or set CHROME_PATH.");
    process.exit(1);
  }
  // Every UI test reads CHROME_PATH first, whatever its own fallback list is.
  env.CHROME_PATH = chrome;
  console.log(`browser: ${chrome}`);
}

const timeoutMs = Number(process.env.TEST_TIMEOUT_MS || 6 * 60_000);

function killTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

function run(file) {
  const source = readFileSync(path.join(DIR, file.name), "utf8");
  const fileEnv = { ...env };
  if (process.env.UI_TEST_PORT) {
    for (const [, name] of source.matchAll(/process\.env\.([A-Z0-9_]*PORT)\b/g)) fileEnv[name] = process.env.UI_TEST_PORT;
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ["--test", path.join("scripts", file.name)], {
      cwd: ROOT,
      env: fileEnv,
      stdio: "inherit",
      detached: process.platform !== "win32",
    });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? "timeout" : code, secs: ((Date.now() - started) / 1000).toFixed(1) });
    });
  });
}

const results = [];
for (const file of files) {
  if (file.skip) {
    results.push({ name: file.name, status: "SKIP", note: file.skip });
    continue;
  }
  console.log(`\n=== ${file.name}`);
  const { code, secs } = await run(file);
  const status = code === 0 ? "PASS" : code === "timeout" ? "TIMEOUT" : "FAIL";
  results.push({ name: file.name, status, note: `${secs}s` });
}

console.log("\n--- summary");
for (const r of results) console.log(`${r.status.padEnd(7)} ${r.name}  (${r.note})`);
const failed = results.filter((r) => r.status === "FAIL" || r.status === "TIMEOUT");
if (!results.length) console.log("no matching test files");
console.log(`${results.length - failed.length}/${results.length} ok`);
process.exit(failed.length ? 1 : 0);
