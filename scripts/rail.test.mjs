// Server rail: multi-select and bulk menu, one-click duplicate, broken
// profiles, the sort cycle, auto-reveal and truncation-only tooltips —
// driven through the mock build (no Rust): `node --test scripts/rail.test.mjs`.
//
// Starts `vite --mode mock` on RAIL_PORT (default 1434) unless FARO_URL points
// at one already running. SHOT_DIR (default .shots/bruno-lessons/rail)
// receives screenshots of each feature.
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.RAIL_PORT || 1434);
const URL = process.env.FARO_URL || `http://127.0.0.1:${PORT}/`;
const SHOTS = process.env.SHOT_DIR || path.join(ROOT, ".shots", "bruno-lessons", "rail");
const isWin = process.platform === "win32";

// ---- pure rules (no browser) ----------------------------------------------

async function load(rel) {
  const source = ts.transpileModule(readFileSync(path.join(ROOT, rel), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const ops = await load("src/lib/railOps.ts");

test("copy names never stack", () => {
  assert.equal(ops.copyName("web", ["web"]), "web copy");
  assert.equal(ops.copyName("web", ["web", "web copy"]), "web copy 2");
  assert.equal(ops.copyName("web", ["web", "Web Copy", "web copy 2"]), "web copy 3");
  // Duplicating a copy strips its suffix first.
  assert.equal(ops.copyName("web copy", ["web", "web copy"]), "web copy 2");
  assert.equal(ops.copyName("web copy 2", ["web", "web copy", "web copy 2"]), "web copy 3");
  assert.equal(ops.copyName("web copy 7", ["web copy 7"]), "web copy");
  // A name that is only "copy" keeps a base.
  assert.equal(ops.copyName("copy", ["copy"]), "copy copy");
});

test("sort cycles A-Z, Z-A, custom and the label names the next state", () => {
  assert.equal(ops.nextSort("custom"), "az");
  assert.equal(ops.nextSort("az"), "za");
  assert.equal(ops.nextSort("za"), "custom");
  assert.equal(ops.nextSort("bogus"), "az");
  assert.equal(ops.sortItemLabel("custom"), "Sort: A–Z");
  assert.equal(ops.sortItemLabel("az"), "Sort: Z–A");
  assert.equal(ops.sortItemLabel("za"), "Sort: Custom order");
  const items = [{ name: "b10" }, { name: "B2" }, { name: "a" }];
  assert.deepEqual(ops.applySort(items, "az").map((x) => x.name), ["a", "B2", "b10"]);
  assert.deepEqual(ops.applySort(items, "za").map((x) => x.name), ["b10", "B2", "a"]);
  assert.equal(ops.applySort(items, "custom"), items);
});

test("shift ranges follow the visible order", () => {
  const v = ["a", "b", "c", "d"];
  assert.deepEqual(ops.rangeBetween(v, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(ops.rangeBetween(v, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(ops.rangeBetween(v, null, "c"), ["c"]);
  assert.deepEqual(ops.rangeBetween(v, "hidden", "c"), ["c"]);
  assert.deepEqual(ops.rangeBetween(v, "a", "hidden"), []);
});

test("broken profiles use only what Faro already knows", () => {
  const base = { id: "x", name: "x", protocol: "sftp", host: "h", port: 22, username: "u", auth: { kind: "agent" } };
  assert.equal(ops.profileProblem(base), null);
  assert.equal(ops.profileProblem({ ...base, protocol: "faro-agent" }), "Not paired yet");
  assert.equal(ops.profileProblem({ ...base, protocol: "faro-agent", agentKey: "k" }), null);
  assert.equal(ops.profileProblem({ ...base, auth: { kind: "key", path: " " } }), "No key file chosen");
  assert.equal(ops.profileProblem(base, { kind: "auth", message: "denied" }), "Sign-in failed last time");
  assert.equal(ops.profileProblem(base, { kind: "not-found", message: "no such file" }), "Key file or path not found last time");
  // A network blip is not a broken profile.
  assert.equal(ops.profileProblem(base, { kind: "network", message: "refused" }), null);
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

function stop(server) {
  if (!server?.pid) return;
  try {
    if (isWin) execSync(`taskkill /pid ${server.pid} /T /F`, { stdio: "ignore" });
    else process.kill(-server.pid);
  } catch {}
}

test("the rail in the app", { timeout: 300_000, skip: !CHROME && "no Chrome/Edge" }, async (t) => {
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
    const shot = async (name) => {
      mkdirSync(SHOTS, { recursive: true });
      await sleep(350); // let menus and toasts finish fading in
      await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
    };
    const demo = (fn, ...args) => page.evaluate(fn, ...args);
    await demo(() => {
      window.__demo.useSettings.getState().setRailExpanded(true);
      window.__demo.useLayout.getState().closeDialog?.();
    });
    await demo(() => window.__demo.focusProfile("p-api"));
    const row = (id) => `[data-rail-profile-id="${id}"]`;
    await page.waitForSelector(row("p-api"));
    const click = async (id, opts = {}) => {
      const mods = opts.mods ?? [];
      for (const m of mods) await page.keyboard.down(m);
      await page.click(`${row(id)} button`, { button: opts.button ?? "left" });
      for (const m of mods.reverse()) await page.keyboard.up(m);
    };
    const selectedIds = () => page.$$eval("[data-rail-profile-id][data-selected]", (r) => r.map((e) => e.dataset.railProfileId));
    const railOrder = () => page.$$eval("[data-rail-profile-id]", (r) => r.map((e) => e.dataset.railProfileId));
    const menuItems = () =>
      page.$$eval('[role="menu"]:last-of-type [role="menuitem"]', (r) =>
        r.map((b) => ({ text: b.textContent.trim(), danger: b.className.includes("text-danger"), disabled: b.disabled }))
      );
    const clickItem = (label) =>
      page.evaluate((label) => {
        const b = [...document.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.trim().startsWith(label));
        if (!b) throw new Error(`no menu item ${label}`);
        b.click();
      }, label);
    const closeMenu = async () => {
      await page.keyboard.press("Escape");
      await page.waitForSelector('[role="menu"]', { hidden: true });
    };
    const profile = (id) => demo((id) => window.__demo.useConnections.getState().profiles.find((p) => p.id === id), id);

    await t.test("Ctrl-click, Shift-click, Esc and background click", async () => {
      await click("p-ftp", { mods: ["Control"] });
      await click("p-db", { mods: ["Control"] });
      assert.deepEqual((await selectedIds()).sort(), ["p-db", "p-ftp"]);
      // Ctrl again toggles off.
      await click("p-db", { mods: ["Control"] });
      assert.deepEqual(await selectedIds(), ["p-ftp"]);
      // Shift selects the visible range from the anchor (the last Ctrl-click).
      await click("p-ftp", { mods: ["Control"] });
      await click("p-ftp", { mods: ["Control"] });
      const visible = await railOrder();
      const target = visible[visible.indexOf("p-ftp") + 2];
      await click(target, { mods: ["Shift"] });
      assert.deepEqual(await selectedIds(), visible.slice(visible.indexOf("p-ftp"), visible.indexOf("p-ftp") + 3));
      assert.equal(await page.$('[role="menu"]'), null, "a modifier click doesn't open a menu");
      await page.keyboard.press("Escape");
      assert.deepEqual(await selectedIds(), []);
      // Background click clears too.
      await click("p-ftp", { mods: ["Control"] });
      const box = await (await page.$("[data-rail-scroll]")).boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height - 6);
      assert.deepEqual(await selectedIds(), []);
    });

    await t.test("right-click in a selection opens the bulk menu", async () => {
      await click("p-ftp", { mods: ["Control"] });
      await click("p-s3", { mods: ["Control"] });
      await click("p-api", { mods: ["Control"] });
      await click("p-s3", { button: "right" });
      await page.waitForSelector('[role="menu"]');
      const items = await menuItems();
      const texts = items.map((i) => i.text);
      assert.deepEqual(texts, ["Connect all (2)", "Disconnect all (1)", "Move to group", "Export…", "Delete (3)…"]);
      assert.ok(items.at(-1).danger, "Delete is red");
      assert.ok(!items.slice(0, -1).some((i) => i.danger));
      await shot("multi-select-bulk-menu");
      // Move to group › New group… files all three at once.
      await clickItem("Move to group");
      await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.includes("New group")));
      await clickItem("New group");
      await page.waitForSelector('input[aria-label="Group name"]');
      await page.type('input[aria-label="Group name"]', "Batch");
      await page.keyboard.press("Enter");
      await page.waitForSelector('[data-rail-group="Batch"]');
      for (const id of ["p-ftp", "p-s3", "p-api"]) assert.equal((await profile(id)).group, "Batch");
      // The selection survives the move; Esc drops it.
      await page.keyboard.press("Escape");
      // Right-click outside a selection: the server's own menu, selection gone.
      await click("p-ftp", { mods: ["Control"] });
      await click("p-db", { mods: ["Control"] });
      await click("p-cdn", { button: "right" });
      await page.waitForSelector('[role="menu"]');
      assert.deepEqual(await selectedIds(), []);
      assert.ok((await menuItems()).some((i) => i.text.startsWith("Connect")));
      await closeMenu();
    });

    await t.test("a selected folder counts each server once", async () => {
      const header = '[data-rail-group="Batch"] button';
      await page.keyboard.down("Control");
      await page.click(header);
      await page.keyboard.up("Control");
      assert.deepEqual((await selectedIds()).sort(), ["p-api", "p-ftp", "p-s3"]);
      // A member Ctrl-clicked on top of its folder is still one server; the
      // folder's right-click is the bulk menu.
      await click("p-cdn", { mods: ["Control"] });
      await page.click(header, { button: "right" });
      await page.waitForSelector('[role="menu"]');
      const texts = (await menuItems()).map((i) => i.text);
      assert.equal(texts.at(-1), "Delete (4)…");
      await clickItem("Delete (4)");
      await page.waitForSelector('[role="dialog"]');
      const msg = await page.$eval('[role="dialog"]', (d) => d.textContent);
      assert.match(msg, /Delete 4 connections/);
      await page.keyboard.press("Escape");
      await page.waitForSelector('[role="dialog"]', { hidden: true });
      await page.keyboard.press("Escape");
      assert.deepEqual(await selectedIds(), []);
    });

    await t.test("Duplicate saves a copy with no dialog", async () => {
      const dup = async (id) => {
        await click(id, { button: "right" });
        await page.waitForSelector('[role="menu"]');
        await clickItem("More");
        await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].some((b) => b.textContent.startsWith("Duplicate")));
        await clickItem("Duplicate");
      };
      await dup("p-db");
      await page.waitForFunction(() => window.__demo.useConnections.getState().profiles.some((p) => p.name === "db-staging copy"));
      assert.equal(await page.$('[role="dialog"]'), null, "no dialog");
      await page.waitForFunction(() => document.body.innerText.includes("Duplicated as “db-staging copy”"));
      await shot("duplicate-toast");
      const copy = await demo(() => window.__demo.useConnections.getState().profiles.find((p) => p.name === "db-staging copy"));
      const orig = await profile("p-db");
      assert.notEqual(copy.id, orig.id);
      assert.equal(copy.host, orig.host);
      assert.equal(copy.group, orig.group);
      // Lands right after the original.
      const order = await railOrder();
      assert.equal(order[order.indexOf("p-db") + 1], copy.id);
      // Duplicating the copy never stacks "copy copy".
      await dup(copy.id);
      await page.waitForFunction(() => window.__demo.useConnections.getState().profiles.some((p) => p.name === "db-staging copy 2"));
      assert.ok(!(await demo(() => window.__demo.useConnections.getState().profiles.some((p) => /copy copy/.test(p.name)))));
    });

    await t.test("a broken profile gets a marker and a reduced menu", async () => {
      // "__auth_fail__" makes the mock reject the sign-in, like a real
      // server turning down the password.
      await demo(async () => {
        const c = window.__demo.useConnections.getState();
        const t = c.profiles.find((p) => p.id === "p-db");
        await c.saveProfile({ ...t, id: "__auth_fail__", name: "billing-db", group: undefined, sortOrder: 0 });
      });
      await page.waitForSelector(row("__auth_fail__"));
      assert.equal(await page.$(`${row("__auth_fail__")}[data-broken]`), null, "fine until it fails");
      await demo(() => window.__demo.useConnections.getState().connect("__auth_fail__").catch(() => {}));
      await page.waitForSelector(`${row("__auth_fail__")}[data-broken]`);
      await click("__auth_fail__", { button: "right" });
      await page.waitForSelector('[role="menu"]');
      const items = await menuItems();
      assert.deepEqual(items.map((i) => i.text.replace(/Delete$/, "").replace(/Delete….*/, "Delete…")), ["Edit…", "Test connection…", "Delete…"]);
      assert.ok(items.at(-1).danger);
      await shot("broken-profile-menu");
      await closeMenu();
      // A plain click opens the same menu instead of retrying the sign-in.
      await click("__auth_fail__");
      await page.waitForSelector('[role="menu"]');
      assert.equal((await menuItems()).length, 3);
      await closeMenu();
      // An unpaired Faro Agent entry is broken from the start.
      await demo(async () => {
        await window.__demo.useConnections.getState().saveProfile({
          id: "agent-unpaired", name: "lab-pc", protocol: "faro-agent", host: "10.0.0.9", port: 8722, username: "", auth: { kind: "agent" },
        });
      });
      await page.waitForSelector(`${row("agent-unpaired")}[data-broken]`);
      // Editing a profile clears its last failure.
      await demo(async () => {
        const c = window.__demo.useConnections.getState();
        await c.saveProfile(c.profiles.find((p) => p.id === "__auth_fail__"));
      });
      await page.waitForSelector(`${row("__auth_fail__")}:not([data-broken])`);
    });

    await t.test("Sort cycles A–Z, Z–A, custom without losing the custom order", async () => {
      const before = await railOrder();
      const sortOrders = () => demo(() => Object.fromEntries(window.__demo.useConnections.getState().profiles.map((p) => [p.id, p.sortOrder ?? null])));
      const saved = await sortOrders();
      const names = () => page.$$eval("[data-rail-profile-id] button[aria-label]", (b) => b.map((x) => x.getAttribute("aria-label")));
      const openGroupMenu = async () => {
        await page.click('[data-rail-group="Batch"] button', { button: "right" });
        await page.waitForSelector('[role="menu"]');
      };
      await openGroupMenu();
      assert.ok((await menuItems()).some((i) => i.text === "Sort: A–Z"));
      await shot("sort-menu-item");
      await clickItem("Sort: A–Z");
      const ungrouped = async () => {
        const all = await page.$$eval("[data-rail-connections] > [data-rail-server] [data-rail-profile-id] button[aria-label]", (b) => b.map((x) => x.getAttribute("aria-label").replace(/ \(.*\)$/, "")));
        return all;
      };
      let top = await ungrouped();
      assert.deepEqual(top, [...top].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" })));
      await openGroupMenu();
      assert.ok((await menuItems()).some((i) => i.text === "Sort: Z–A"));
      await clickItem("Sort: Z–A");
      top = await ungrouped();
      assert.deepEqual(top, [...top].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" })));
      // The view never rewrote the saved order.
      assert.deepEqual(await sortOrders(), saved);
      assert.equal(await demo(() => window.__demo.useSettings.getState().railSort), "za");
      await openGroupMenu();
      await clickItem("Sort: Custom order");
      assert.deepEqual(await railOrder(), before);
      assert.ok((await names()).length > 0);
    });

    await t.test("the active server is revealed: folder opened, scrolled into view", async () => {
      // A long rail, then a far-away server in a closed folder.
      await demo(async () => {
        const c = window.__demo.useConnections.getState();
        const t = c.profiles.find((p) => p.id === "p-db");
        for (let i = 0; i < 18; i++) await c.saveProfile({ ...t, id: `filler-${i}`, name: `filler ${String(i).padStart(2, "0")}`, group: undefined, sortOrder: 1 + i });
        await c.saveProfile({ ...t, id: "far-away", name: "far-away", group: "Archive", sortOrder: 500 });
      });
      await page.waitForSelector('[data-rail-group="Archive"]');
      await demo(() => {
        const s = window.__demo.useSettings.getState();
        if (!s.railCollapsedGroups.includes("Archive")) s.toggleRailGroup("Archive");
      });
      await page.$eval("[data-rail-scroll]", (e) => { e.scrollTop = 0; });
      assert.equal(await page.$(row("far-away")), null, "hidden in its closed folder");
      // Focus it the way the palette or a deep link does.
      await demo(() => window.__demo.focusProfile("far-away"));
      await page.waitForSelector(`${row("far-away")}[data-active]`);
      await page.waitForFunction((sel) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const box = document.querySelector("[data-rail-scroll]").getBoundingClientRect();
        const r = el.getBoundingClientRect();
        return r.top >= box.top - 1 && r.bottom <= box.bottom + 1;
      }, {}, row("far-away"));
      assert.equal(await demo(() => window.__demo.useSettings.getState().railCollapsedGroups.includes("Archive")), false);
      // Already visible: focusing another visible server doesn't scroll.
      const top = await page.$eval("[data-rail-scroll]", (e) => e.scrollTop);
      const visibleId = await page.evaluate(() => {
        const box = document.querySelector("[data-rail-scroll]").getBoundingClientRect();
        return [...document.querySelectorAll("[data-rail-profile-id]")].find((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= box.top && r.bottom <= box.bottom && el.dataset.railProfileId.startsWith("filler");
        })?.dataset.railProfileId;
      });
      await demo((id) => window.__demo.focusProfile(id), visibleId);
      await page.waitForSelector(`${row(visibleId)}[data-active]`);
      await sleep(150);
      assert.equal(await page.$eval("[data-rail-scroll]", (e) => e.scrollTop), top);
    });

    await t.test("three distinct row states", async () => {
      await click("filler-1", { mods: ["Control"] });
      const active = await page.$eval("[data-rail-profile-id][data-active]", (e) => e.dataset.railProfileId);
      const look = (id) =>
        page.$eval(`${row(id)}`, (el) => {
          const btn = el.querySelector("button");
          return { bg: getComputedStyle(btn).backgroundColor, outline: getComputedStyle(btn).outlineStyle, pill: el.querySelector("span[aria-hidden]").className.includes("bg-accent") };
        });
      // The tint animates in (transition-colors), so read it once it settles.
      await page.waitForFunction((sel) => getComputedStyle(document.querySelector(sel)).backgroundColor !== "rgba(0, 0, 0, 0)", {}, `${row("filler-1")} button`);
      await sleep(250);
      const sel = await look("filler-1");
      const act = await look(active);
      assert.notEqual(sel.bg, act.bg, "selection is a tint");
      assert.ok(act.pill && !sel.pill, "the active server has the accent pill");
      // Keyboard focus is an outline, on whatever row has it.
      await page.focus(`${row("filler-2")} button`);
      await page.keyboard.press("Shift");
      const focused = await page.$eval(`${row("filler-2")} button`, (b) => b.matches(":focus-visible") ? getComputedStyle(b).outlineStyle : "none");
      assert.equal(focused, "solid");
      await shot("row-states");
      await page.keyboard.press("Escape");
    });

    await t.test("rail labels get a tooltip only when cut off", async () => {
      await demo(async () => {
        const c = window.__demo.useConnections.getState();
        const t = c.profiles.find((p) => p.id === "filler-3");
        await c.saveProfile({ ...t, name: "a-very-long-server-name-that-cannot-possibly-fit-in-the-rail" });
      });
      const tip = () => page.$$eval(".z-tooltip", (t) => t.map((x) => x.textContent));
      await page.hover(`${row("filler-4")} button`);
      await sleep(250);
      assert.deepEqual(await tip(), [], "short name: no tooltip");
      await page.hover(`${row("filler-3")} button`);
      await page.waitForFunction(() => [...document.querySelectorAll(".z-tooltip")].some((t) => t.textContent.includes("a-very-long-server-name")));
      await shot("truncated-name-tooltip");
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    stop(server);
  }
});
