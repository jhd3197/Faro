import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { createServer } from "vite";
import puppeteer from "puppeteer-core";

// Clicking a control that names a settings section opens Settings on that
// section (and focuses the field, when the jump names one). The gear and
// Preferences stay on Appearance.
test("settings deep links", { timeout: 120000 }, async () => {
  const executablePath = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find((p) => p && existsSync(p));
  assert.ok(executablePath, "Install Chrome/Chromium or set CHROME_PATH");

  const server = await createServer({
    mode: "mock",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ["--no-sandbox"],
      defaultViewport: { width: 1400, height: 900 },
    });
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(
      () =>
        window.__demo?.useLayout &&
        window.__demo.useConnections.getState().profiles.some((p) => p.id === "p-api") &&
        document.body.innerText.includes("Faro"),
    );

    const section = () =>
      page.$eval("[data-settings-heading]", (el) => el.dataset.settingsHeading);
    const closeSettings = async () => {
      await page.evaluate(() => {
        const done = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Done");
        if (!done) throw new Error("Settings Done button missing");
        done.click();
      });
      await page.waitForFunction(() => !window.__demo.useLayout.getState().dialog);
    };
    const openAndRead = async (target) => {
      await page.evaluate((t) => window.__demo.useLayout.getState().openSettings(t), target);
      await page.waitForSelector("[data-settings-heading]");
      return section();
    };

    await page.click('[data-settings-link="statusBarSync"]');
    await page.waitForSelector("[data-settings-heading]");
    assert.equal(await section(), "sync");
    assert.equal(
      await page.$eval("[data-settings-section][aria-current='page']", (el) => el.dataset.settingsSection),
      "sync",
    );

    await page.click("[data-settings-section='appearance']");
    assert.equal(await section(), "appearance");

    await page.evaluate(() =>
      window.__demo.useLayout.getState().openSettings({ section: "remoteControl" }),
    );
    await page.waitForFunction(
      () => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === "remoteControl",
    );
    assert.match(await page.$eval("[data-settings-heading]", (el) => el.textContent), /Remote control/);
    await closeSettings();

    await page.click('button[title="Settings"]');
    await page.waitForSelector("[data-settings-heading]");
    assert.equal(await section(), "appearance");
    await closeSettings();

    const runPalette = async (query, id) => {
      await page.click('button[title="Command palette"]');
      await page.waitForSelector('[role="combobox"]');
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      await page.click('[role="combobox"]', { clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.keyboard.type(query);
      try {
        await page.waitForSelector(`[data-command-id="${id}"]`, { timeout: 4000 });
      } catch (err) {
        const info = await page.evaluate(() => ({
          query: document.querySelector('[role="combobox"]')?.value,
          ids: [...document.querySelectorAll("[data-command-id]")].slice(0, 15).map((el) => el.getAttribute("data-command-id")),
          palette: window.__demo.useLayout.getState().paletteOpen,
        }));
        throw new Error(`${id} not listed for query ${JSON.stringify(info)} (${err.message})`);
      }
      const first = await page.$eval("[data-command-id]", (el) => el.dataset.commandId);
      assert.equal(first, id, `top hit for ${query}`);
      await page.click(`[data-command-id="${id}"]`);
    };

    await runPalette("Remote control", "settings:remoteControl");
    await page.waitForFunction(
      () => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === "remoteControl",
    );
    await closeSettings();

    await runPalette("Folder Sync", "settings:sync");
    await page.waitForFunction(
      () => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === "sync",
    );
    await closeSettings();

    await page.evaluate(() => {
      const { useConnections, useLayout } = window.__demo;
      const id = "p-cf-deep-link";
      useConnections.setState({
        profiles: [
          ...useConnections.getState().profiles,
          {
            id,
            name: "cf-box",
            protocol: "sftp",
            host: "ssh.example.com",
            port: 22,
            username: "jane",
            auth: { kind: "agent" },
            proxyCommand: { kind: "cloudflare", hostname: "ssh.example.com" },
          },
        ],
      });
      useLayout.getState().openInvite([id]);
    });
    await page.waitForSelector('[data-settings-link="inviteCloudflare"]');
    await page.click('[data-settings-link="inviteCloudflare"]');
    await page.waitForFunction(
      () => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === "cloudflare",
    );
    await page.waitForFunction(() =>
      document.querySelector("[data-settings-focus='settings-cloudflare-account']"),
    );
    const accountFocused = await page.evaluate(() => {
      const card = document.querySelector("[data-settings-focus='settings-cloudflare-account']");
      return !!card && card.contains(document.activeElement);
    });
    assert.equal(accountFocused, true);
    await closeSettings();

    await page.evaluate(() => window.__demo.useLayout.getState().openMoveToCloudflare("p-api"));
    await page.waitForSelector('[data-settings-link="moveToCloudflare"]');
    await page.click('[data-settings-link="moveToCloudflare"]');
    await page.waitForFunction(
      () => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === "cloudflare",
    );
    await closeSettings();

    await page.evaluate(() => window.__demo.useLayout.getState().setShortcutsOpen(true));
    await page.waitForSelector('[data-settings-link="keyboardCustomize"]');
    await page.click('[data-settings-link="keyboardCustomize"]');
    await page.waitForFunction(
      () => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === "keyboard",
    );
    await page.waitForFunction(
      () => document.activeElement?.dataset.settingsFocus === "settings-keyboard-search",
    );
    await closeSettings();

    await page.evaluate(() => {
      window.__demo.useToasts.getState().push({
        variant: "error",
        title: "No download folder",
        message: "Set a default download folder in Settings.",
        action: {
          label: "Open download folder settings",
          settings: { section: "transfers", focus: "settings-download-folder" },
        },
        duration: 0,
      });
    });
    await page.waitForFunction(() =>
      [...document.querySelectorAll("button")].some((b) =>
        b.textContent.includes("Open download folder settings"),
      ),
    );
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        b.textContent.includes("Open download folder settings"),
      );
      btn.click();
    });
    await page.waitForFunction(
      () => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === "transfers",
    );
    await page.waitForFunction(
      () => document.activeElement?.dataset.settingsFocus === "settings-download-folder",
    );
    const inView = await page.evaluate(() => {
      const el = document.activeElement.getBoundingClientRect();
      return el.top >= 0 && el.bottom <= window.innerHeight;
    });
    assert.equal(inView, true);
    await closeSettings();

    await page.evaluate(() => window.__demo.useLayout.getState().openNewConnection());
    await page.waitForSelector('[role="dialog"]');
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.includes("Faro Agent"));
      if (!btn) throw new Error("Faro Agent protocol missing");
      btn.click();
    });
    await page.waitForSelector('[data-settings-link="pairingRemoteControl"]');
    await page.click('[data-settings-link="pairingRemoteControl"]');
    await page.waitForFunction(
      () => document.querySelector("[data-settings-heading]")?.dataset.settingsHeading === "remoteControl",
    );
    await page.waitForFunction(
      () => document.activeElement?.dataset.settingsFocus === "settings-show-pairing-code",
    );
    await closeSettings();

    assert.equal(await openAndRead("sync"), "sync");
    await closeSettings();
    await page.evaluate(() => window.__demo.useLayout.getState().openSettings("not-a-section"));
    assert.equal(await page.evaluate(() => window.__demo.useLayout.getState().dialog), null);

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
