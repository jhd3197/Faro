// File clipboard, drag-to-move, delete confirmation and size tooltips, driven
// through the mock build (no Rust): `node --test scripts/files.test.mjs`.
//
// Starts `vite --mode mock` on FILES_PORT (default 1433) unless FARO_URL
// points at one already running. SHOT_DIR (default .shots/bruno-lessons/
// files) receives screenshots of a paste, the drag pill over a folder, the
// delete confirmation and the exact-size properties.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.FILES_PORT || 1433);
const URL = process.env.FARO_URL || `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOT_DIR || path.join(ROOT, ".shots", "bruno-lessons", "files");
const isWin = process.platform === "win32";

// ---- pure rules (no browser) ----------------------------------------------

async function load(rel) {
  const source = ts.transpileModule(readFileSync(path.join(ROOT, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const ops = await load("packages/file-ui/src/lib/fileOps.ts");

test("free names on paste: name (2).ext, never stacked, capped", () => {
  const u = ops.uniqueName;
  assert.equal(u("notes.txt", []), "notes.txt");
  assert.equal(u("notes.txt", ["notes.txt"]), "notes (2).txt");
  assert.equal(u("notes.txt", ["notes.txt", "notes (2).txt"]), "notes (3).txt");
  assert.equal(u("notes (2).txt", ["notes.txt", "notes (2).txt"]), "notes (3).txt", "an existing (N) is replaced");
  assert.equal(u("src", ["src"], { isDir: true }), "src (2)");
  assert.equal(u("v1.2", ["v1.2"], { isDir: true }), "v1.2 (2)", "a folder's dot isn't an extension");
  assert.equal(u("site.tar.gz", ["site.tar.gz"]), "site (2).tar.gz");
  assert.equal(u(".env", [".env"]), ".env (2)");
  assert.equal(u("Notes.TXT", ["notes.txt"]), "Notes.TXT", "POSIX: different case is a different name");
  assert.equal(u("Notes.TXT", ["notes.txt"], { caseInsensitive: true }), "Notes (2).TXT");
  const all = ["a.txt", ...Array.from({ length: ops.MAX_NAME_SUFFIX - 1 }, (_, i) => `a (${i + 2}).txt`)];
  assert.equal(u("a.txt", all), null, "gives up past the cap");
});

test("ancestry is separator-aware", () => {
  const inside = ops.isSameOrInside;
  assert.equal(inside("/users", "/users"), true);
  assert.equal(inside("/users/a/b", "/users"), true);
  assert.equal(inside("/users/a", "/users/"), true);
  assert.equal(inside("/users-archive", "/users"), false);
  assert.equal(inside("/users-archive/x", "/users"), false);
  assert.equal(inside("C:\\Data\\Sub", "c:/data"), true);
  assert.equal(inside("C:\\Database", "C:\\Data"), false);
  const dir = (p) => ({ path: p, name: ops.baseName(p), kind: "directory" });
  assert.match(ops.pasteProblem([dir("/srv/app")], "/srv/app"), /inside itself/);
  assert.match(ops.pasteProblem([dir("/srv/app")], "/srv/app/releases/1"), /its own folders/);
  assert.equal(ops.pasteProblem([dir("/srv/app")], "/srv/app-old"), null);
  assert.equal(ops.pasteProblem([{ path: "/srv/a.txt", name: "a.txt", kind: "file" }], "/srv"), null);
});

test("paths, case-only renames and counts", () => {
  assert.equal(ops.parentOf("/var/www/api"), "/var/www");
  assert.equal(ops.parentOf("/var"), "/");
  assert.equal(ops.parentOf("C:\\Users\\demo"), "C:\\Users");
  assert.equal(ops.parentOf("C:\\Users"), "C:\\");
  assert.equal(ops.joinPath("C:\\", "x"), "C:\\x");
  assert.equal(ops.joinPath("/", "x"), "/x");
  // Windows: Notes.txt → notes.txt is the same entry, not a clash.
  assert.equal(ops.renameClash("Notes.txt", "notes.txt", ["Notes.txt"], true), false);
  assert.equal(ops.renameClash("a.txt", "B.txt", ["a.txt", "b.txt"], true), true);
  // POSIX: two names that differ by case are two files.
  assert.equal(ops.renameClash("Notes.txt", "notes.txt", ["Notes.txt", "notes.txt"], false), true);
  assert.equal(ops.isCaseOnlyRename("Notes.txt", "notes.txt"), true);
  const k = (kind) => ({ kind });
  assert.equal(ops.describeKinds([k("directory"), k("directory"), k("file"), k("file"), k("file")]), "2 folders and 3 files");
  assert.equal(ops.describeKinds([k("directory"), k("directory"), k("file"), k("file"), k("file")], ", "), "2 folders, 3 files");
  assert.equal(ops.describeKinds([k("file")]), "1 file");
  assert.equal(ops.describeKinds([k("directory")]), "1 folder");
  assert.equal(ops.exactBytes(284117), "284,117 bytes");
  assert.equal(ops.exactBytes(1), "1 byte");
});

// ---- the running UI --------------------------------------------------------

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));

async function waitForServer(url, ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error(`mock server never came up at ${url}`);
}

test("file clipboard, drag-to-move and delete in the app", { timeout: 300_000, skip: !CHROME && "no Chrome/Edge" }, async (t) => {
  let server;
  if (!process.env.FARO_URL) {
    server = spawn("npx", ["vite", "--mode", "mock", "--port", String(PORT), "--strictPort"], {
      cwd: ROOT,
      shell: true,
      stdio: "ignore",
      detached: !isWin,
      env: { ...process.env, VITE_UI_LOCALE: "en" },
    });
  }
  let browser;
  try {
    await waitForServer(URL);
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      defaultViewport: { width: 1440, height: 900 },
      args: ["--hide-scrollbars", "--no-sandbox"],
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (let i = 0; i < 5; i++) {
      await page.goto(URL, { waitUntil: "networkidle0" });
      if (await page.waitForFunction(() => !!window.__demo, { timeout: 15_000 }).then(() => true, () => false)) break;
    }
    const shot = async (name) => {
      mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };
    const demo = (fn, ...args) => page.evaluate(fn, ...args);
    await demo(() => {
      window.__demo.useSettings.getState().setRailExpanded(true);
      window.__demo.useLayout.getState().closeDialog?.();
      window.__demo.useSettings.getState().setPaneViewMode?.("details");
    });
    await demo(() => window.__demo.focusProfile("p-api"));
    const pane = '[data-file-pane][data-file-path="/var/www/api"]';
    await page.waitForSelector(`${pane} [data-idx="0"]`);
    const DIR = "/var/www/api";
    const row = (name, dir = DIR) => `${pane} [data-path="${dir}/${name}"]`;
    const names = () => page.$$eval(`${pane} [data-path]`, (rows) => rows.map((r) => r.getAttribute("data-path").split("/").pop()));
    const select = async (...list) => {
      await demo(() => window.__demo.useToasts.setState({ toasts: [] }));
      await page.click(row(list[0]));
      await page.keyboard.down("Control");
      for (const n of list.slice(1)) await page.click(row(n));
      await page.keyboard.up("Control");
    };
    const chord = async (key) => {
      await page.keyboard.down("Control");
      await page.keyboard.press(key);
      await page.keyboard.up("Control");
    };
    const toast = (text) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout: 5000 }, text);

    const menuLabels = () => page.$$eval('[role="menu"] [role="menuitem"]', (b) => b.map((x) => x.textContent));

    await t.test("the row menu: Cut / Copy with live hints, Delete last and red, no Paste yet", async () => {
      await page.click(row("logs"), { button: "right" });
      await page.waitForSelector('[role="menu"]');
      const labels = await menuLabels();
      assert.ok(!labels.some((l) => l.startsWith("Paste")), "no Paste with an empty clipboard");
      assert.ok(labels.includes("CutCtrl+X") && labels.includes("CopyCtrl+C"), labels.join("|"));
      assert.match(labels[labels.length - 1], /^Delete/, "Delete is last");
      const last = await page.$$eval('[role="menu"] [role="menuitem"]', (b) => b[b.length - 1].className);
      assert.match(last, /text-danger/);
      await page.keyboard.press("Escape");
      await page.waitForSelector('[role="menu"]', { hidden: true });
    });

    await t.test("Ctrl+C / Ctrl+V copies under a free name, with a toast", async () => {
      await select("server.js");
      await chord("KeyC");
      await toast("Copied server.js");
      await chord("KeyV");
      await page.waitForSelector(row("server (2).js"));
      assert.equal(await page.$eval(row("server (2).js"), (r) => r.getAttribute("aria-selected")), "true", "the pasted row is selected");
      await toast("Pasted server.js");
      // Several at once: the toast names the counts.
      await select("package.json", "README.md");
      await chord("KeyC");
      await toast("Copied 2 files");
      await chord("KeyV");
      await page.waitForSelector(row("package (2).json"));
      await page.waitForSelector(row("README (2).md"));
      await toast("Pasted 2 files");
      assert.equal(await page.$$eval(`${pane} [aria-selected="true"]`, (r) => r.length), 2);
      await shot("paste-toast-and-new-rows");
    });

    await t.test("Cut, then Paste into a folder row moves it there", async () => {
      await select("Dockerfile");
      await chord("KeyX");
      await toast("Cut Dockerfile");
      await page.waitForSelector(`${row("Dockerfile")}[data-cut]`);
      await page.click(row("logs"), { button: "right" });
      await page.waitForSelector('[role="menu"]');
      const labels = await menuLabels();
      const paste = labels.find((l) => l.startsWith("Paste into"));
      assert.equal(paste, "Paste into “logs”Ctrl+V");
      const items = await page.$$('[role="menu"] [role="menuitem"]');
      await items[labels.indexOf(paste)].click();
      await page.waitForSelector(row("Dockerfile"), { hidden: true });
      await toast("Moved Dockerfile to logs");
      await page.click(row("logs"), { clickCount: 2 });
      await page.waitForSelector(`[data-file-pane] [data-path="${DIR}/logs/Dockerfile"]`);
      await page.keyboard.down("Alt");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.up("Alt");
      await page.waitForSelector(row("src"));
    });

    await t.test("a folder can't be pasted into itself", async () => {
      await select("src");
      await chord("KeyC");
      await page.click(row("src"), { clickCount: 2 });
      const inner = `[data-file-pane][data-file-path="${DIR}/src"]`;
      await page.waitForSelector(inner);
      await page.focus(inner);
      await chord("KeyV");
      await toast("Can't put “src” inside itself.");
      await page.keyboard.down("Alt");
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.up("Alt");
      await page.waitForSelector(row("src"));
    });

    // Synthetic HTML5 drag events: the same handlers a real drag runs.
    const drag = (type, name, opts = {}) =>
      page.evaluate(
        (sel, type, opts) => {
          const el = document.querySelector(sel);
          if (type === "dragstart") window.__dt = new DataTransfer();
          const r = el.getBoundingClientRect();
          const ev = new DragEvent(type, {
            bubbles: true,
            cancelable: true,
            dataTransfer: window.__dt,
            clientX: r.left + 60,
            clientY: r.top + r.height / 2,
            ...opts,
          });
          el.dispatchEvent(ev);
          return { prevented: ev.defaultPrevented, effect: window.__dt.dropEffect };
        },
        row(name),
        type,
        opts
      );

    await t.test("dragging onto a folder row moves, with a pill and a tint", async () => {
      await select("dist", "logs", "server.js", ".env", "ecosystem.config.js");
      await drag("dragstart", "server.js");
      await page.waitForSelector("[data-drag-pill]");
      assert.match(await page.$eval("[data-drag-pill]", (e) => e.textContent), /^2 folders, 3 files/);
      // The dragged folders themselves are not targets: no tint, not-allowed.
      const self = await drag("dragover", "dist");
      assert.equal(self.prevented, false);
      assert.equal(await page.$(`${row("dist")}[data-drop-target]`), null);
      // Neither is a file row.
      assert.equal((await drag("dragover", "package.json")).prevented, false);
      // A sibling folder is.
      const over = await drag("dragover", "uploads");
      assert.equal(over.prevented, true);
      await page.waitForSelector(`${row("uploads")}[data-drop-target]`);
      assert.match(await page.$eval("[data-drag-pill]", (e) => e.textContent), /Move to uploads$/);
      await shot("drag-pill-over-folder");
      const copy = await drag("dragover", "uploads", { ctrlKey: true });
      assert.equal(copy.prevented, true);
      assert.match(await page.$eval("[data-drag-pill]", (e) => e.textContent), /Copy to uploads$/);
      await drag("drop", "uploads");
      await page.waitForSelector("[data-drag-pill]", { hidden: true });
      await page.waitForSelector(row("server.js"), { hidden: true });
      const left = await names();
      for (const n of ["dist", "logs", "server.js", ".env", "ecosystem.config.js"]) assert.ok(!left.includes(n), n);
      await toast("Moved 2 folders, 3 files to uploads");
      assert.equal(await page.$(`${pane} [data-drop-target]`), null);
    });

    await t.test("delete confirmation counts by type, names a single item in bold", async () => {
      await select("src", "uploads", "server (2).js", "package (2).json", "README (2).md");
      await page.keyboard.press("Delete");
      await page.waitForSelector('[role="dialog"]');
      assert.equal(await page.$eval('[role="dialog"] [id]', (e) => e.textContent), "Delete 2 folders and 3 files?");
      const btn = await page.$$eval('[role="dialog"] button', (b) => b.map((x) => [x.textContent, x.className]));
      assert.match(btn.find(([t]) => t === "Delete")[1], /bg-danger/, "red Delete button");
      await shot("delete-confirm-counts");
      await page.keyboard.press("Escape");
      await page.waitForSelector('[role="dialog"]', { hidden: true });

      await select("package-lock.json");
      await page.keyboard.press("Delete");
      await page.waitForSelector('[role="dialog"]');
      assert.equal(await page.$eval('[role="dialog"] [id]', (e) => e.textContent), "Delete this file?");
      assert.equal(await page.$eval('[role="dialog"] [data-delete-summary] strong', (e) => e.textContent), "package-lock.json");
      await shot("delete-confirm-single");
      const del = await page.$$('[role="dialog"] button');
      for (const b of del) if ((await b.evaluate((x) => x.textContent)) === "Delete") await b.click();
      await page.waitForSelector(row("package-lock.json"), { hidden: true });
    });

    await t.test("rounded sizes show exact bytes; names get a tooltip only when cut off", async () => {
      await select("README.md");
      const sizeTitle = await page.$eval(`${row("README.md")} span[title$="bytes"]`, (e) => [e.textContent, e.title]);
      assert.deepEqual(sizeTitle, ["4.4 KB", "4,517 bytes"]);
      // A short name: hovering adds no tooltip.
      const nameSel = `${row("README.md")} span.truncate`;
      await page.hover(nameSel);
      assert.equal(await page.$eval(nameSel, (e) => e.getAttribute("title")), null);
      // A long one: rename it so it's cut off, then hover.
      await page.keyboard.press("F2");
      await page.waitForSelector(`${pane} input[data-inline-rename]`);
      const long = "README-with-a-very-long-name-that-cannot-possibly-fit-in-this-column-at-all-even-on-a-wide-screen-with-the-pane-stretched-out.md";
      await page.$eval(`${pane} input[data-inline-rename]`, (i) => i.select());
      await page.keyboard.type(long);
      await page.keyboard.press("Enter");
      await page.waitForSelector(row(long));
      await page.hover(`${row(long)} span.truncate`);
      assert.equal(await page.$eval(`${row(long)} span.truncate`, (e) => e.title), long);
      // Renaming onto an existing name is refused inline instead of replacing it.
      await page.click(row(long));
      await page.keyboard.press("F2");
      await page.waitForSelector(`${pane} input[data-inline-rename]`);
      await page.$eval(`${pane} input[data-inline-rename]`, (i) => i.select());
      await page.keyboard.type("package.json");
      await page.keyboard.press("Enter");
      await page.waitForSelector(`${pane} [role="alert"]`);
      assert.match(await page.$eval(`${pane} [role="alert"]`, (e) => e.textContent), /package\.json already exists/);
      await page.keyboard.press("Escape");
      // Properties spells the size out too.
      await page.click(row("package.json"));
      await page.keyboard.press("Space");
      await page.waitForSelector('[role="dialog"]');
      assert.match(await page.$eval('[role="dialog"]', (e) => e.textContent), /1,842 bytes/);
      await shot("properties-exact-bytes");
      await page.keyboard.press("Escape");
    });

    await t.test("Paste in the other pane becomes a transfer", async () => {
      await demo(() => window.__demo.useSettings.getState().setBrowserLayout("dual"));
      const local = '[data-file-pane][data-file-session="local"]';
      const notes = `${local} [data-path$="notes.txt"]`;
      await page.waitForSelector(`${local} [data-idx="0"]`);
      // The demo's drive root has only folders; any folder below has files.
      if (!(await page.$(notes))) await page.click(`${local} [data-idx="0"]`, { clickCount: 2 });
      await page.waitForSelector(notes);
      await demo(() => window.__demo.useToasts.setState({ toasts: [] }));
      await page.click(notes);
      await chord("KeyC");
      await toast("Copied notes.txt");
      await page.click(row("package.json"));
      await chord("KeyV");
      await toast("Transferring notes.txt");
      await page.waitForFunction(() =>
        Object.values(window.__demo.useTransfers.getState().byId).some((t) => t.kind === "upload" && t.source.endsWith("notes.txt"))
      );
      await shot("cross-pane-paste-transfer");
      await demo(() => window.__demo.useSettings.getState().setBrowserLayout("single"));
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) {
      if (isWin) spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else try { process.kill(-server.pid, "SIGKILL"); } catch {}
    }
  }
});
