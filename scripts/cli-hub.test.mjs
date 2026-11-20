import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { test } from "node:test";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

// Plan 35 UI: the CLIs page (list order, detail, accounts, consent), the
// links between connections and CLIs in both directions, the status pill on
// an expired login and its Sign in, the connect-time prompt, the Import
// dialog's "From your CLIs" tab (offline peers not preselected, consent for
// imported sign-ins), and the editor's CLI sign-in and AWS SSM route.
//
// CLI_HUB_PORT picks the mock server port (default 1444); CLI_HUB_SHOTS
// saves screenshots to that folder.

const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p) => p && existsSync(p));

const PORT = Number(process.env.CLI_HUB_PORT || 1444);
const SHOTS = process.env.CLI_HUB_SHOTS;

test("CLIs page", { timeout: 240000 }, async () => {
  assert.ok(CHROME, "Install Chrome/Chromium or set CHROME_PATH");
  process.env.VITE_UI_LOCALE = "en";
  const server = await createServer({
    mode: "mock",
    server: { host: "127.0.0.1", port: PORT, strictPort: true, hmr: false, watch: { ignored: ["**/*"] } },
  });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox"],
      defaultViewport: { width: 1400, height: 900 },
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));

    const url = `http://127.0.0.1:${PORT}/`;
    for (let i = 0; ; i++) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      try {
        await page.waitForFunction(() => window.__demo?.expireCli && document.body.innerText.includes("Faro"), { timeout: 20000 });
        break;
      } catch (e) {
        if (i >= 4) throw e;
      }
    }
    await page.evaluate(() => {
      window.__demo.resetClis();
      window.__demo.useLayout.getState().closeDialog();
    });

    const shot = async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: `${SHOTS}/${name}.png` });
    };
    const text = (sel) => page.$eval(sel, (el) => el.textContent.trim());
    const click = (sel) => page.$eval(sel, (el) => el.click());
    const clickText = (sel, label) =>
      page.evaluate(
        (sel, label) => {
          const el = [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === label);
          if (!el) throw new Error(`no ${sel} "${label}"`);
          el.click();
        },
        sel,
        label,
      );
    const calls = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__demo.cliCalls)));
    const layout = (fn) => page.evaluate(fn);

    // --- No problems: no pill.
    await page.waitForFunction(() => Object.keys(window.__demo.useConnections.getState().profiles).length > 0);
    assert.equal(await page.$("[data-cli-pill]"), null, "no pill while every CLI a connection uses is fine");

    // --- The page: used CLIs first, missing unused ones under "More".
    await layout(() => window.__demo.useLayout.getState().openDialog("clis"));
    await page.waitForSelector("[data-testid='cli-hub'] [data-cli='aws']");
    const order = await page.$$eval("[data-testid='cli-list'] [data-cli]", (els) => els.map((e) => e.getAttribute("data-cli")));
    assert.equal(order[0], "aws", "the AWS CLI (used by media-cdn) comes first");
    assert.ok(order.indexOf("cloudflared") < order.indexOf("az"), "used CLIs before unused ones");
    assert.ok(order.indexOf("gcloud") > order.indexOf("shopify"), "a missing, unused CLI is in the More group");
    const listText = await text("[data-testid='cli-list']");
    assert.match(listText, /More CLIs Faro can use/);
    // Opening the page runs each installed CLI's account check.
    await page.waitForFunction(() => window.__demo.cliCalls.some((c) => c.cmd === "cli_check" && c.args.id === "gh"));
    await shot("cli-hub");

    // --- Detail: accounts, consent, and the backlink to the connection.
    await page.waitForSelector("[data-testid='cli-detail'][data-cli='aws']");
    const accounts = await text("[data-testid='cli-accounts']");
    assert.match(accounts, /default \(111122223333\)/);
    assert.match(accounts, /client-a \(444455556666\)/);
    const allowA = "[data-cli-account='client-a'] [data-testid='cli-allow']";
    assert.equal(await page.$eval(allowA, (b) => b.getAttribute("aria-pressed")), "true");
    await click(allowA);
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-pressed") === "false", {}, allowA);
    assert.ok((await calls()).some((c) => c.cmd === "cli_set_allowed" && c.args.account === "client-a" && c.args.allowed === false));
    await click(allowA);
    await page.waitForFunction((sel) => document.querySelector(sel)?.getAttribute("aria-pressed") === "true", {}, allowA);
    const conns = await text("[data-testid='cli-connections']");
    assert.match(conns, /media-cdn/);
    assert.match(conns, /Sign-in · client-a/);

    // Backlink: the connection opens in the editor, whose Uses chip links back.
    await click("[data-cli-connection='p-cdn']");
    await page.waitForSelector("[data-testid='cli-uses'] [data-cli-chip='aws']");
    assert.equal(await page.$eval("[data-cli-chip='aws']", (b) => b.getAttribute("data-cli-chip-state")), "ready");
    // The editor shows "Sign in with: AWS CLI login" and hides the key fields.
    await page.waitForSelector("[data-testid='cli-signin'] select");
    assert.equal(await page.$eval("[data-testid='cli-signin'] select", (s) => s.value), "cli");
    assert.equal(await page.$("input[placeholder='AKIA…']"), null, "no access key field while signing in with the CLI");
    await clickText("[data-testid='cli-signin'] button", "Test");
    await page.waitForSelector("[data-testid='cli-signin-result']");
    assert.match(await text("[data-testid='cli-signin-result']"), /^Signed in\./);
    await shot("editor-cli-signin");
    // The chip goes back to the CLIs page on that CLI.
    await click("[data-cli-chip='aws']");
    await page.waitForFunction(() => window.__demo.useLayout.getState().dialog === "clis" && window.__demo.useLayout.getState().cliSelect === "aws");
    await page.waitForFunction(() => !document.querySelector("[data-testid='cli-uses']"), { timeout: 5000 });

    // --- An expired login: pill, connect prompt, Sign in.
    await layout(() => window.__demo.expireCli("aws", "client-a"));
    await page.waitForSelector("[data-cli-pill]");
    assert.match(await page.$eval("[data-cli-pill]", (b) => b.getAttribute("title")), /AWS CLI: login expired · 1 connection/);
    assert.equal(await page.$eval("[data-cli='aws']", (b) => b.querySelector("[data-status]")?.getAttribute("data-status")), "warn");
    assert.match(await text("[data-cli='aws']"), /Login expired/);
    await shot("cli-pill");

    // Connecting stops with a plain sentence instead of a failed connect.
    await layout(() => window.__demo.useLayout.getState().closeDialog());
    const before = (await calls()).length;
    const err = await page.evaluate(() =>
      window.__demo.useConnections
        .getState()
        .connect("p-cdn")
        .then(() => null, (e) => String(e?.message ?? e))
    );
    assert.equal(err, "Your AWS CLI login for client-a expired.");
    const toastText = await page.evaluate(() => window.__demo.useToasts.getState().toasts.map((t) => `${t.title} — ${t.message} [${t.action?.label}]`).join("\n"));
    assert.match(toastText, /media-cdn needs AWS CLI — Your AWS CLI login for client-a expired\. \[Sign in\]/);
    assert.equal((await calls()).length, before, "no CLI was run to find that out");

    // Sign in from the pill fixes it; the pill goes away.
    await click("[data-cli-pill]");
    await page.waitForSelector("[data-cli-problem='aws']");
    await clickText("[data-cli-problem='aws'] button", "Sign in");
    await page.waitForFunction(() => window.__demo.cliCalls.some((c) => c.cmd === "cli_sign_in" && c.args.id === "aws" && c.args.account === "client-a"));
    await page.waitForFunction(() => !document.querySelector("[data-cli-pill]"), { timeout: 5000 });

    // --- Import from a CLI.
    await layout(() => window.__demo.useLayout.getState().openClis("tailscale"));
    await page.waitForSelector("[data-testid='cli-detail'][data-cli='tailscale']");
    await clickText("[data-testid='cli-detail'] button", "Find connections…");
    await page.waitForFunction(() => window.__demo.useLayout.getState().dialog === "import" && window.__demo.useLayout.getState().importTab === "cli");
    await page.waitForSelector("[data-testid='import-row']");
    const rows = await page.$$eval("[data-testid='import-row']", (els) =>
      els.map((e) => ({ text: e.textContent, checked: e.querySelector("input[type=checkbox]").checked }))
    );
    assert.equal(rows.length, 3);
    assert.ok(rows.find((r) => /nas/.test(r.text)).checked);
    assert.ok(!rows.find((r) => /old-box/.test(r.text)).checked, "an offline peer isn't preselected");
    assert.match(rows.find((r) => /old-box/.test(r.text)).text, /offline/);
    await shot("import-from-cli");
    const profilesBefore = await page.evaluate(() => window.__demo.useConnections.getState().profiles.length);
    await clickText("button", "Import (2)");
    await page.waitForFunction((n) => window.__demo.useConnections.getState().profiles.length === n + 2, {}, profilesBefore);
    // Closing an import started on the CLIs page goes back there.
    await page.waitForFunction(() => window.__demo.useLayout.getState().dialog === "clis", { timeout: 5000 });
    await page.waitForFunction(() => /nas/.test(document.querySelector("[data-testid='cli-connections']")?.textContent ?? ""));
    assert.match(await text("[data-testid='cli-connections']"), /Imported from/);

    // AWS: an imported bucket signs in with the CLI, and its account is allowed.
    await layout(() => window.__demo.useLayout.getState().openImportCli("aws", "default"));
    await page.waitForSelector("[data-testid='import-row']");
    await clickText("button", "Import (2)");
    await page.waitForFunction(() => window.__demo.useConnections.getState().profiles.some((p) => p.name === "invoices"));
    const invoices = await page.evaluate(() => window.__demo.useConnections.getState().profiles.find((p) => p.name === "invoices"));
    assert.deepEqual(invoices.cliAuth, { tool: "aws", account: "default" });
    assert.ok((await calls()).some((c) => c.cmd === "cli_set_allowed" && c.args.id === "aws" && c.args.account === "default" && c.args.allowed === true));
    const web = await page.evaluate(() => window.__demo.useConnections.getState().profiles.find((p) => p.name === "web-1"));
    assert.equal(web.proxyCommand.kind, "awsSsm");

    // The SSM route shows in the editor with its fields.
    await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
    await page.evaluate((id) => window.__demo.useLayout.getState().openEditProfile(id), web.id);
    await page.waitForSelector("[data-testid='cloud-tunnel']");
    const awsChips = await page.$$("[data-testid='cli-uses'] [data-cli-chip='aws']");
    assert.equal(awsChips.length, 1, "one chip per CLI");
    const route = await page.$eval("[role='radiogroup'][aria-label='Connect via'] [aria-checked='true']", (b) => b.textContent.trim());
    assert.equal(route, "AWS SSM");
    assert.equal(await page.$eval("[data-testid='cloud-tunnel'] input", (i) => i.value), "i-0abc123");
    await shot("editor-aws-ssm");

    // --- Settings › CLIs is the same page.
    await page.evaluate(() => window.__demo.useLayout.getState().openEditProfile(null));
    await page.evaluate(() => window.__demo.useLayout.getState().openSettings("clis"));
    await page.waitForSelector("[data-settings-focus='clis'] [data-cli='aws']");

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
