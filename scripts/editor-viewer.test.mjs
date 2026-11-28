// Built-in editor and image viewer (Plan 37 Phase 3). The pure parts run in
// node; the rest drives the mock build:
// `node --test scripts/editor-viewer.test.mjs`.
//
// Starts `vite --mode mock` on EDITOR_PORT (default 1449) unless FARO_URL
// points at one already running.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.UI_TEST_PORT || process.env.EDITOR_PORT || 1449);
const URL = process.env.FARO_URL || `http://127.0.0.1:${PORT}/`;
const isWin = process.platform === "win32";

test("file names map to a syntax, an image type, or neither", { timeout: 60_000 }, async () => {
  const { createServer } = await import("vite");
  const server = await createServer({ mode: "mock", cacheDir: "node_modules/.vite-editor-test", server: { middlewareMode: true }, appType: "custom" });
  try {
    const lang = await server.ssrLoadModule("/src/lib/editorLang.ts");
    const label = (n) => lang.languageFor(n).label;
    assert.equal(label("/etc/nginx/nginx.conf"), "nginx");
    assert.equal(label("deploy.sh"), "Shell");
    assert.equal(label("/home/me/.bashrc"), "Shell");
    assert.equal(label(".env"), "Config");
    assert.equal(label(".env.production"), "Config");
    assert.equal(label("app.service"), "Config");
    assert.equal(label("package.json"), "JSON");
    assert.equal(label("index.TSX"), "TypeScript");
    assert.equal(label("docker-compose.yml"), "YAML");
    assert.equal(label("Dockerfile"), "Dockerfile");
    assert.equal(label("C:\\\\site\\\\theme.liquid"), "HTML");
    assert.equal(label("README"), "Plain text");
    assert.equal(label("notes.unknownext"), "Plain text");

    assert.equal(lang.imageMime("photo.JPG"), "image/jpeg");
    assert.equal(lang.imageMime("logo.svg"), "image/svg+xml");
    assert.equal(lang.imageMime("notes.txt"), null);
    assert.equal(lang.imageMime("archive.tar.gz"), null);

    assert.equal(lang.looksEditable("nginx.conf"), true);
    assert.equal(lang.looksEditable("README"), true);
    assert.equal(lang.looksEditable("logo.svg"), true, "an SVG is text too");
    for (const no of ["photo.png", "backup.tar.gz", "app.exe", "report.pdf", "font.woff2", "data.sqlite"]) {
      assert.equal(lang.looksEditable(no), false, no);
    }
    // Every language loads without throwing.
    for (const name of ["a.js", "a.json", "a.html", "a.css", "a.md", "a.py", "a.php", "a.sql", "a.xml", "a.yml", "a.toml", "a.sh", "a.ini", "Dockerfile", "nginx.conf", "a.rb", "a.go", "a.rs", "a.lua", "a.ps1"]) {
      assert.ok(await lang.languageFor(name).load(), name);
    }
  } finally {
    await server.close();
  }
});

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

test("the editor and image viewer in the app", { timeout: 300_000, skip: !CHROME && "no Chrome/Edge" }, async (t) => {
  let server;
  if (!process.env.FARO_URL) {
    server = spawn("npx", ["vite", "--mode", "mock", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
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
    await page.waitForFunction(() => !!window.__demo.useConnections.getState().activeSessionId, { timeout: 15_000 });
    const demo = (fn, ...args) => page.evaluate(fn, ...args);
    await demo(() => window.__demo.useLayout.getState().closeDialog?.());

    const openText = async (file) => {
      await demo((file) => {
        const sid = window.__demo.useConnections.getState().activeSessionId;
        window.__demo.useViewer.getState().close(true);
        window.__demo.useViewer.getState().open({ kind: "text", sessionId: sid, path: file });
      }, file);
      await page.waitForSelector("[data-text-editor] .cm-content", { timeout: 20_000 });
      await sleep(300);
    };
    const editorText = () =>
      page.$$eval("[data-text-editor] [data-text-editor] .cm-line, [data-text-editor] > div .cm-content .cm-line", (els) =>
        els.map((e) => e.textContent).join("\n")
      );
    const typeAtEnd = async (text) => {
      await page.click("[data-text-editor] .cm-content");
      await page.keyboard.down("Control");
      await page.keyboard.press("End");
      await page.keyboard.up("Control");
      await page.keyboard.type(text);
      await sleep(150);
    };
    const writes = () => demo(() => window.__demo.editorWrites.map((w) => ({ ...w })));
    const exists = async (sel) => !!(await page.$(sel));

    await t.test("a text file opens, edits mark it unsaved, and Save writes it", async () => {
      await openText("/etc/nginx/site.conf");
      assert.match(await editorText(), /listen 80;/);
      assert.equal(await exists("[data-editor-dirty]"), false);
      assert.equal(await page.$eval("[data-editor-save]", (b) => b.disabled), true, "nothing to save yet");
      await typeAtEnd("gzip on;");
      assert.equal(await exists("[data-editor-dirty]"), true);
      await page.click("[data-editor-save]");
      await page.waitForSelector('[data-editor-note="ok"]');
      const w = await writes();
      assert.equal(w.length, 1);
      assert.equal(w[0].path, "/etc/nginx/site.conf");
      assert.match(w[0].text, /server_name example\.com;\ngzip on;$/);
      assert.equal(w[0].force, false);
      assert.equal(await exists("[data-editor-dirty]"), false, "saved, so no longer unsaved");
    });

    await t.test("Ctrl+S saves", async () => {
      await typeAtEnd("\n# two");
      await page.keyboard.down("Control");
      await page.keyboard.press("KeyS");
      await page.keyboard.up("Control");
      await page.waitForFunction(() => window.__demo.editorWrites.length === 2);
      assert.match((await writes())[1].text, /# two$/);
    });

    await t.test("a file that changed on the server is not overwritten; both versions are shown", async () => {
      await typeAtEnd("\n# mine");
      await demo(() => window.__demo.setEditorFile("/etc/nginx/site.conf", "# changed by a teammate\nlisten 443;\n"));
      await page.click("[data-editor-save]");
      await page.waitForSelector("[data-editor-conflict]");
      assert.equal((await writes()).length, 2, "nothing was written");
      const merge = await page.$eval("[data-editor-merge]", (e) => e.innerText);
      assert.match(merge, /changed by a teammate/, "their version is on screen");
      assert.match(merge, /# mine/, "and so is mine");

      // Keep editing: still unsaved, nothing lost.
      await page.click("[data-editor-compare-close]");
      assert.equal(await exists("[data-editor-conflict]"), false);
      assert.match(await editorText(), /# mine/);
      assert.equal(await exists("[data-editor-dirty]"), true);
    });

    await t.test("Overwrite saves mine on top, explicitly", async () => {
      await page.click("[data-editor-save]");
      await page.waitForSelector("[data-editor-conflict]");
      await page.click("[data-editor-overwrite]");
      await page.waitForFunction(() => window.__demo.editorWrites.length === 3);
      const w = (await writes())[2];
      assert.equal(w.force, true);
      assert.match(w.text, /# mine$/);
      assert.equal(await exists("[data-editor-conflict]"), false);
      assert.equal(await exists("[data-editor-dirty]"), false);
    });

    await t.test("Reload takes the server's version and drops mine", async () => {
      await typeAtEnd("\n# throwaway");
      await demo(() => window.__demo.setEditorFile("/etc/nginx/site.conf", "# newer on the server\n"));
      await page.click("[data-editor-save]");
      await page.waitForSelector("[data-editor-conflict]");
      await page.click("[data-editor-take-theirs]");
      await sleep(200);
      assert.equal(await editorText(), "# newer on the server\n");
      assert.equal(await exists("[data-editor-dirty]"), false);
      assert.equal((await writes()).length, 3, "reloading writes nothing");
      // The reloaded version is the one a later save is checked against.
      await typeAtEnd("# after reload");
      await page.click("[data-editor-save]");
      await page.waitForFunction(() => window.__demo.editorWrites.length === 4);
      assert.equal((await writes())[3].force, false);
    });

    await t.test("Compare shows the saved file next to the unsaved text", async () => {
      await typeAtEnd("\n# not saved yet");
      await page.click("[data-editor-compare]");
      await page.waitForSelector("[data-editor-comparing]");
      assert.equal(await exists("[data-editor-conflict]"), false, "a comparison is not a conflict");
      assert.match(await page.$eval("[data-editor-merge]", (e) => e.innerText), /# not saved yet/);
      await page.click("[data-editor-compare-close]");
      assert.equal(await exists("[data-editor-comparing]"), false);
    });

    await t.test("closing with unsaved changes asks; Discard closes without writing", async () => {
      const before = (await writes()).length;
      await page.click("[data-editor-close]");
      await page.waitForSelector("[data-editor-ask-close]");
      assert.equal(await exists("[data-file-viewer]"), true, "still open");
      await page.click("[data-editor-discard]");
      await page.waitForFunction(() => !document.querySelector("[data-file-viewer]"));
      assert.equal((await writes()).length, before);
    });

    await t.test("Windows line endings survive an edit", async () => {
      await demo(() => window.__demo.setEditorFile("/srv/site/web.config", "<a>\r\n<b>\r\n"));
      await openText("/srv/site/web.config");
      assert.equal(await editorText(), "<a>\n<b>\n", "shown without the carriage returns");
      await typeAtEnd("<c>");
      const n = (await writes()).length;
      await page.click("[data-editor-save]");
      await page.waitForFunction((n) => window.__demo.editorWrites.length === n + 1, {}, n);
      assert.equal((await writes())[n].text, "<a>\r\n<b>\r\n<c>", "written back with CRLF");
      await demo(() => window.__demo.useViewer.getState().close(true));
    });

    await t.test("auto-save writes a moment after typing stops", async () => {
      await demo(() => window.__demo.useSettings.setState({ editorAutoSave: true }));
      await openText("/etc/hosts.conf");
      const n = (await writes()).length;
      await typeAtEnd("127.0.0.1 demo");
      assert.equal((await writes()).length, n, "not immediately");
      await page.waitForFunction((n) => window.__demo.editorWrites.length === n + 1, { timeout: 6000 }, n);
      assert.match((await writes())[n].text, /127\.0\.0\.1 demo$/);
      await demo(() => {
        window.__demo.useSettings.setState({ editorAutoSave: false });
        window.__demo.useViewer.getState().close(true);
      });
    });

    await t.test("a binary file is refused with a reason", async () => {
      await demo(() => {
        const sid = window.__demo.useConnections.getState().activeSessionId;
        window.__demo.useViewer.getState().open({ kind: "text", sessionId: sid, path: "/usr/bin/tool.bin" });
      });
      await page.waitForSelector("[data-editor-failed]", { timeout: 20_000 });
      assert.match(await page.$eval("[data-editor-failed]", (e) => e.innerText), /binary file/);
      await demo(() => window.__demo.useViewer.getState().close(true));
    });

    await t.test("an image opens fitted, zooms, and returns to fit", async () => {
      await demo(() => {
        const sid = window.__demo.useConnections.getState().activeSessionId;
        window.__demo.useViewer.getState().open({ kind: "image", sessionId: sid, path: "/var/www/img/logo.png" });
      });
      await page.waitForSelector("[data-image-size]", { timeout: 20_000 });
      assert.equal(await page.$eval("[data-image-size]", (e) => e.textContent.trim()), "2 × 1");
      const zoom = () => page.$eval("[data-image-zoom]", (e) => e.textContent.trim());
      assert.equal(await zoom(), "100%", "a small image is shown at its real size, not enlarged");
      await page.click("[data-image-zoom-in]");
      assert.equal(await zoom(), "125%");
      const width = await page.$eval("[data-image]", (e) => e.getBoundingClientRect().width);
      assert.ok(Math.abs(width - 2.5) < 0.01, `2px wide at 125% is 2.5px, got ${width}`);
      await page.click("[data-image-zoom-out]");
      await page.click("[data-image-zoom-out]");
      assert.equal(await zoom(), "80%");
      await page.click("[data-image-fit]");
      assert.equal(await zoom(), "100%");
      assert.match(await page.$eval("[data-image]", (e) => e.getAttribute("src")), /^data:image\/png;base64,/);
      await page.click("[data-image-close]");
      await page.waitForFunction(() => !document.querySelector("[data-file-viewer]"));
    });

    assert.deepEqual(errors, [], "no page errors");
  } finally {
    await browser?.close();
    if (server) {
      if (isWin) spawn("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
      else process.kill(-server.pid, "SIGTERM");
    }
  }
});
