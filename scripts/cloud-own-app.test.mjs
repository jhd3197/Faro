import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

// A release with no built-in cloud-drive app must still let the user connect
// with their own registered app instead of failing with "no client id".
test('cloud drives accept the user\'s own OAuth app', { timeout: 90000 }, async (t) => {
  const executablePath = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(p => p && existsSync(p));
  assert.ok(executablePath, 'Install Chrome/Chromium or set CHROME_PATH');
  const server = await createServer({ mode: 'mock', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.__demo?.useLayout);
    await page.evaluate(() => window.__demo.useLayout.getState().openDialog('newConnection'));

    const pick = (label) => page.$$eval('nav button', (bs, l) =>
      bs.find(b => b.textContent.startsWith(l)).click(), label);
    const connectBtn = (label) => page.waitForFunction((l) =>
      [...document.querySelectorAll('button')].find(b => b.textContent.trim() === `Connect with ${l}`), {}, label);
    const disabled = (h) => h.evaluate(b => b.disabled);
    const typeInto = async (selector, text) => {
      await page.click(selector, { clickCount: 3 });
      await page.type(selector, text);
    };

    await t.test('drives without a built-in app are tagged in the picker', async () => {
      await page.waitForFunction(() => [...document.querySelectorAll('nav button')]
        .filter(b => /Own app$/.test(b.textContent)).length === 4);
    });

    await t.test('OneDrive: Connect waits for a Client ID, then saves it', async () => {
      await pick('OneDrive');
      const btn = await connectBtn('OneDrive');
      assert.equal(await disabled(btn), true, 'no Client ID yet');
      assert.ok(await page.$('input[placeholder="Client ID"]'));
      await typeInto('input[placeholder="Client ID"]', '  11111111-2222-3333-4444-555555555555 ');
      assert.equal(await disabled(btn), false, 'OneDrive needs no secret');
      await btn.click();
      await page.waitForFunction(() => /Connected as demo@example\.com/.test(document.body.innerText));
      await page.$$eval('button', bs => bs.find(b => b.textContent.trim() === 'Save').click());
      await page.waitForFunction(() => window.__demo.useConnections.getState().profiles
        .some(p => p.protocol === 'onedrive'));
      const saved = await page.evaluate(() => window.__demo.useConnections.getState().profiles
        .find(p => p.protocol === 'onedrive'));
      assert.equal(saved.oauthClientId, '11111111-2222-3333-4444-555555555555');
    });

    await t.test('Google Drive: the secret is required too', async () => {
      await page.evaluate(() => window.__demo.useLayout.getState().openDialog('newConnection'));
      await page.waitForSelector('nav button');
      await pick('Google Drive');
      const btn = await connectBtn('Google Drive');
      await typeInto('input[placeholder="Client ID"]', 'abc.apps.googleusercontent.com');
      assert.equal(await disabled(btn), true, 'Google rejects desktop apps without a secret');
      await typeInto('input[type="password"]', 'GOCSPX-test');
      assert.equal(await disabled(btn), false);
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
