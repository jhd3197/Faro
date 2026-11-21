import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { test } from "node:test";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

// Plan 33 UI: Settings › Password managers cards, Bitwarden unlock / lock,
// the vault picker filling a reference plus host and username, the editor's
// Test button (OK and error), the SSH agent select saving identityAgent and
// the rail tooltip naming the manager.
//
// PASSWORD_MANAGERS_PORT picks the mock server port (default 1442);
// PASSWORD_MANAGERS_SHOTS saves screenshots to that folder.

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

const PORT = Number(process.env.PASSWORD_MANAGERS_PORT || 1442);
const SHOTS = process.env.PASSWORD_MANAGERS_SHOTS;

test("password managers", { timeout: 180000 }, async () => {
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
        await page.waitForFunction(
          () => window.__demo?.resetPasswordManagers && document.body.innerText.includes("Faro"),
          { timeout: 20000 },
        );
        break;
      } catch (e) {
        // Vite's first dependency scan can reload the page; try again.
        if (i >= 4) throw e;
      }
    }
    await page.evaluate(() => window.__demo.resetPasswordManagers());

    const shot = async (name) => {
      if (!SHOTS) return;
      mkdirSync(SHOTS, { recursive: true });
      await new Promise((r) => setTimeout(r, 300));
      await page.screenshot({ path: `${SHOTS}/${name}.png` });
    };
    const text = (sel) => page.$eval(sel, (el) => el.textContent.trim());
    const value = (sel) => page.$eval(sel, (el) => el.value);
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
    // Click once the button is enabled: a click on a disabled one (say, a
    // check still running) is silently dropped.
    const clickEnabled = async (sel) => {
      await page.waitForFunction((sel) => {
        const el = document.querySelector(sel);
        return el && !el.disabled;
      }, {}, sel);
      await click(sel);
    };
    const calls = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__demo.passwordCalls)));
    const profile = (id) =>
      page.evaluate((id) => window.__demo.useConnections.getState().profiles.find((p) => p.id === id), id);

    // --- Settings › Password managers: one card per manager.
    await page.evaluate(() => window.__demo.useLayout.getState().openSettings("passwordManagers"));
    await page.waitForSelector("[data-pm-card='1password'][data-pm-state='ready']");
    await page.waitForSelector("[data-pm-card='bitwarden'][data-pm-state='locked']");
    assert.equal(await text("[data-settings-heading]"), "Password managers");
    const op = await text("[data-pm-card='1password']");
    assert.match(op, /Ready/);
    assert.match(op, /demo@example\.com/);
    assert.ok(await page.$("[data-pm-card='1password'] [data-pm-agent='found']"), "1Password SSH agent found");
    assert.match(op, /Check again/);
    assert.match(op, /How to connect/);
    const bw = await text("[data-pm-card='bitwarden']");
    assert.match(bw, /Locked/);
    assert.match(bw, /Not running/);
    await shot("settings-password-managers");

    // --- Bitwarden: an empty password is refused without calling the CLI.
    const pw = "[data-pm-card='bitwarden'] input[type='password']";
    await click("[data-pm-card='bitwarden'] [data-pm-unlock-button]");
    await page.waitForSelector("[data-pm-unlock-error]");
    assert.equal(await text("[data-pm-unlock-error]"), "Enter your master password.");
    assert.equal((await calls()).filter((c) => c.cmd === "password_manager_unlock").length, 0);

    // Enter unlocks, and the field never holds the password afterwards.
    await page.type(pw, "correct horse");
    await page.waitForFunction((sel) => document.querySelector(sel)?.value === "correct horse", {}, pw);
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-pm-card='bitwarden'][data-pm-state='ready']");
    assert.equal(await page.$(pw), null, "no password field once unlocked");
    const unlocks = (await calls()).filter((c) => c.cmd === "password_manager_unlock");
    assert.equal(unlocks.length, 1);
    assert.deepEqual(unlocks[0].args, { provider: "bitwarden" });

    // Lock puts it back.
    await click("[data-pm-card='bitwarden'] [data-pm-lock]");
    await page.waitForSelector("[data-pm-card='bitwarden'][data-pm-state='locked']");
    assert.equal(await value(pw), "");

    // Check again re-reads the state.
    await page.evaluate(() => window.__demo.setPasswordManagers({ "1password": "locked" }));
    await clickEnabled("[data-pm-card='1password'] [data-pm-check]");
    await page.waitForSelector("[data-pm-card='1password'][data-pm-state='locked']");
    await page.evaluate(() => window.__demo.setPasswordManagers({ "1password": "ready" }));
    await clickEnabled("[data-pm-card='1password'] [data-pm-check]");
    await page.waitForSelector("[data-pm-card='1password'][data-pm-state='ready']");

    // --- 1Password without the desktop app: Faro signs in itself.
    await page.evaluate(() => window.__demo.setPasswordManagers({ "1password": "signedOut", opApp: false }));
    await clickEnabled("[data-pm-card='1password'] [data-pm-check]");
    await page.waitForSelector("[data-pm-card='1password'] [data-pm-op-add]");
    assert.equal(await page.$("[data-pm-card='1password'] [data-pm-op-app]"), null, "no app sign-in button without the app");
    assert.match(await text("[data-pm-card='1password']"), /has no account yet/);
    assert.equal(await value("[aria-label='1Password sign-in address']"), "my.1password.com");
    // Empty fields are refused without calling the CLI.
    await click("[data-pm-op-add-button]");
    await page.waitForSelector("[data-pm-op-add-error]");
    assert.equal((await calls()).filter((c) => c.cmd === "password_manager_op_add_account").length, 0);
    await page.type("[aria-label='1Password email']", "demo@example.com");
    await page.type("[aria-label='1Password Secret Key']", "A3-ABCDEF-GHIJKL-MNOPQR-STUVWX-YZ2345-67890");
    await page.type("[aria-label='1Password account password']", "wrong");
    await click("[data-pm-op-add-button]");
    await page.waitForFunction(() => document.querySelector("[data-pm-op-add-error]")?.textContent.includes("didn't accept"));
    assert.equal(await value("[aria-label='1Password account password']"), "", "the password field clears after a try");
    await page.type("[aria-label='1Password account password']", "correct horse");
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-pm-card='1password'][data-pm-state='ready']");
    assert.match(await text("[data-pm-card='1password']"), /demo@example\.com/);
    const adds = (await calls()).filter((c) => c.cmd === "password_manager_op_add_account");
    assert.deepEqual(adds.at(-1).args, { address: "my.1password.com", email: "demo@example.com" }, "no secret in the call log");
    // Sign out, then back in with just the password.
    await click("[data-pm-op-signout]");
    await page.waitForSelector("[data-pm-card='1password'][data-pm-state='locked']");
    await page.waitForSelector("[data-pm-card='1password'] [aria-label='1Password account password']");
    await page.type("[data-pm-card='1password'] [aria-label='1Password account password']", "correct horse");
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-pm-card='1password'][data-pm-state='ready']");
    await shot("op-signed-in-without-app");
    await page.evaluate(() => window.__demo.setPasswordManagers({ opApp: true }));
    await clickEnabled("[data-pm-card='1password'] [data-pm-check]");
    await page.waitForSelector("[data-pm-card='1password'][data-pm-state='ready']");

    // --- The CLIs: version, Check for updates, and Faro's own copy.
    const opCli = "[data-pm-card='1password'] [data-pm-cli='op']";
    await page.waitForSelector(`${opCli} [data-tool-source='path']`);
    assert.match(await text(opCli), /1Password CLI 2\.41\.0 · found on PATH/);
    await clickEnabled(`${opCli} [data-tool-check]`);
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent.includes("2.42.0 is available"), {}, opCli);
    assert.match(await text(`${opCli} [data-tool-install]`), /Install Faro's copy/);
    await clickEnabled(`${opCli} [data-tool-install]`);
    await page.waitForSelector(`${opCli} [data-tool-source='managed']`);
    assert.match(await text(opCli), /1Password CLI 2\.42\.0 · installed by Faro/);
    assert.match(await text(opCli), /Up to date/);

    // A missing Bitwarden CLI offers the install; after it, the sign-in
    // command names Faro's copy, which isn't on PATH.
    await page.evaluate(() => window.__demo.setPasswordManagers({ bitwarden: "missing" }));
    await clickEnabled("[data-pm-card='bitwarden'] [data-pm-check]");
    await page.waitForSelector("[data-pm-card='bitwarden'][data-pm-state='missing']");
    const bwCli = "[data-pm-card='bitwarden'] [data-pm-cli='bw']";
    await clickEnabled(`${bwCli} [data-tool-check]`);
    await page.waitForSelector(`${bwCli} [data-tool-source='missing']`);
    assert.match(await text(bwCli), /Not installed/);
    assert.match(await text(`${bwCli} [data-tool-install]`), /Install Bitwarden CLI/);
    await shot("settings-cli-missing");
    await clickEnabled(`${bwCli} [data-tool-install]`);
    await page.waitForSelector("[data-pm-card='bitwarden'][data-pm-state='signedOut']");
    assert.match(await text(bwCli), /Bitwarden CLI 2026\.11\.0 · installed by Faro/);
    const login = await text("[data-pm-card='bitwarden'] [data-pm-bw-login] code");
    assert.match(login, /^".*com\.juandenis\.faro\/bin\/bw" login$/);
    await shot("settings-cli-installed");
    assert.ok(
      (await calls()).some((c) => c.cmd === "tool_install" && c.args.id === "bw"),
      "installed through tool_install",
    );
    await page.evaluate(() => window.__demo.setPasswordManagers({ bitwarden: "locked" }));
    await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
    await page.waitForFunction(() => !document.querySelector("[data-pm-card]"));

    // --- New SFTP connection: Credential source › 1Password › Choose….
    await page.evaluate(() => window.__demo.useLayout.getState().openNewConnection({ protocol: "sftp" }));
    await page.waitForSelector("input[placeholder='example.com']");
    await page.evaluate(() => {
      const d = [...document.querySelectorAll("details")].find((x) => x.textContent.includes("More options"));
      d.open = true;
    });
    const sourceOptions = await page.$$eval("select[aria-label='Credential source'] option", (os) =>
      os.map((o) => o.textContent.trim()),
    );
    assert.deepEqual(sourceOptions.slice(0, 3), ["Saved in Faro", "1Password", "Bitwarden"]);
    await page.select("select[aria-label='Credential source']", "1password");
    await page.waitForSelector("[data-vault-choose]");
    await click("[data-vault-choose]");
    await page.waitForSelector("[data-testid='vault-picker'] [data-vault-item]");
    assert.equal((await page.$$("[data-vault-item]")).length, 4);

    // Type-to-search narrows the list.
    await page.keyboard.type("prod");
    await page.waitForFunction(() => document.querySelectorAll("[data-vault-item]").length === 1);
    assert.equal(await value("[data-testid='vault-picker'] input"), "prod");
    await click("[data-vault-item='prod-db']");
    // The password field is preselected; values are never shown.
    await page.waitForSelector("[data-vault-field='password'][aria-checked='true']");
    const fieldsText = await text("[role='radiogroup'][aria-label='Fields']");
    assert.match(fieldsText, /username/);
    assert.match(fieldsText, /Password/);
    await shot("vault-picker");
    await click("[data-testid='vault-picker'] [data-dialog-confirm]");
    await page.waitForFunction(() => !document.querySelector("[data-testid='vault-picker']"));
    assert.equal(await value("input[aria-label='Credential reference']"), "op://Infrastructure/prod-db/password");
    assert.equal(await value("input[placeholder='example.com']"), "db.example.com");
    assert.equal(await value("input[placeholder='root']"), "deploy");

    // --- Test: OK for a reference in the vault, the plain error otherwise.
    await click("[data-credential-test]");
    await page.waitForSelector("[data-credential-test-result='ok']");
    assert.equal(await text("[data-credential-test-result]"), "Read OK");
    await page.click("input[aria-label='Credential reference']", { clickCount: 3 });
    await page.keyboard.type("op://Infrastructure/gone/password");
    // An edit clears the old result (after React re-renders).
    await page.waitForFunction(
      () => !document.querySelector("[data-credential-test-result]"),
      { timeout: 5000 },
    );
    assert.equal(await value("input[aria-label='Credential reference']"), "op://Infrastructure/gone/password");
    await click("[data-credential-test]");
    await page.waitForSelector("[data-credential-test-result='error']");
    assert.equal(await text("[data-credential-test-result]"), "That item no longer exists in 1Password.");

    // A picked item never overwrites what was already typed.
    await click("[data-vault-choose]");
    await page.waitForSelector("[data-vault-item='Staging SFTP']");
    await click("[data-vault-item='Staging SFTP']");
    await page.waitForSelector("[data-vault-field='password'][aria-checked='true']");
    await click("[data-testid='vault-picker'] [data-dialog-confirm]");
    await page.waitForFunction(() => !document.querySelector("[data-testid='vault-picker']"));
    assert.equal(await value("input[aria-label='Credential reference']"), "op://Infrastructure/Staging SFTP/password");
    assert.equal(await value("input[placeholder='example.com']"), "db.example.com");
    assert.equal(await value("input[placeholder='root']"), "deploy");

    // --- Bitwarden locked: the picker unlocks inline, then lists items.
    await page.select("select[aria-label='Credential source']", "bitwarden");
    await click("[data-vault-choose]");
    await page.waitForSelector("[data-testid='vault-picker'] [data-pm-unlock] input[type='password']");
    await page.focus("[data-testid='vault-picker'] input[type='password']");
    await page.keyboard.type("correct horse");
    await page.waitForFunction(
      () => document.querySelector("[data-testid='vault-picker'] input[type='password']")?.value === "correct horse",
    );
    await page.keyboard.press("Enter");
    await page.waitForSelector("[data-vault-item='Backup box']");
    await click("[data-vault-item='Backup box']");
    await page.waitForSelector("[data-vault-field='Password'][aria-checked='true']");
    // Escape closes the picker only, not the editor under it.
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("[data-testid='vault-picker']"));
    assert.ok(await page.$("input[aria-label='Credential reference']"), "editor stays open");

    // Save with the 1Password reference; the rail says where the password lives.
    await page.select("select[aria-label='Credential source']", "1password");
    await page.click("input[aria-label='Credential reference']", { clickCount: 3 });
    await page.keyboard.type("op://Infrastructure/prod-db/password");
    await page.evaluate(() => {
      const box = [...document.querySelectorAll("label")].find((l) => l.textContent.trim() === "Connect after saving")?.querySelector("input");
      if (box?.checked) box.click();
    });
    const before = await page.evaluate(() => window.__demo.useConnections.getState().profiles.map((p) => p.id));
    await clickText("button", "Save");
    await page.waitForFunction((n) => window.__demo.useConnections.getState().profiles.length === n + 1, {}, before.length);
    const saved = await page.evaluate(
      (before) => window.__demo.useConnections.getState().profiles.find((p) => !before.includes(p.id)),
      before,
    );
    assert.deepEqual(saved.credentialRef, { provider: "1password", item: "op://Infrastructure/prod-db/password" });
    assert.equal(saved.auth.password, "", "no password saved with a reference");
    assert.equal(saved.identityAgent, undefined);
    await page.waitForFunction(() => !document.querySelector("input[aria-label='Credential reference']"));
    // The full tooltip belongs to the compact rail, which keyboard focus
    // shows (a mouse hover widens the rail to show the name instead).
    await page.evaluate(() => window.__demo.useSettings.getState().setRailExpanded(false));
    await page.mouse.move(900, 500);
    const railRow = `[data-rail-profile-id="${saved.id}"] button`;
    await page.waitForSelector(railRow);
    await page.focus(railRow);
    await page.waitForFunction(() => document.querySelector("[data-rail-vault]")?.textContent === "Password from 1Password");
    await page.evaluate(() => document.activeElement?.blur());

    // --- Agent auth: the SSH agent select, labelled from ssh_agents().
    await page.evaluate(() => window.__demo.useLayout.getState().openEditProfile("p-db"));
    await page.waitForSelector("select[aria-label='SSH agent']");
    await page.waitForFunction(() =>
      [...document.querySelectorAll("select[aria-label='SSH agent'] option")].some((o) => o.textContent.includes("found")),
    );
    const agentOptions = await page.$$eval("select[aria-label='SSH agent'] option", (os) =>
      os.map((o) => o.textContent.trim()),
    );
    assert.deepEqual(agentOptions, [
      "Automatic",
      "System agent · found",
      "1Password · found",
      "Bitwarden · not running",
      "Custom path…",
    ]);
    assert.equal(await value("select[aria-label='SSH agent']"), "");
    await page.select("select[aria-label='SSH agent']", "1password");
    await shot("ssh-agent-select");
    await clickText("button", "Save");
    await page.waitForFunction(() => !document.querySelector("select[aria-label='SSH agent']"));
    assert.equal((await profile("p-db")).identityAgent, "1password");

    // A custom path round-trips; Automatic clears the field.
    await page.evaluate(() => window.__demo.useLayout.getState().openEditProfile("p-db"));
    await page.waitForSelector("select[aria-label='SSH agent']");
    assert.equal(await value("select[aria-label='SSH agent']"), "1password");
    await page.select("select[aria-label='SSH agent']", "custom");
    await page.waitForSelector("input[aria-label='Agent path']");
    await page.type("input[aria-label='Agent path']", "/run/user/1000/agent.sock");
    await clickText("button", "Save");
    await page.waitForFunction(() => !document.querySelector("select[aria-label='SSH agent']"));
    assert.equal((await profile("p-db")).identityAgent, "/run/user/1000/agent.sock");
    await page.evaluate(() => window.__demo.useLayout.getState().openEditProfile("p-db"));
    await page.waitForSelector("input[aria-label='Agent path']");
    assert.equal(await value("input[aria-label='Agent path']"), "/run/user/1000/agent.sock");
    await page.select("select[aria-label='SSH agent']", "");
    await clickText("button", "Save");
    await page.waitForFunction(() => !document.querySelector("select[aria-label='SSH agent']"));
    assert.equal((await profile("p-db")).identityAgent, undefined);

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
