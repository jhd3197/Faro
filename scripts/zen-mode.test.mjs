import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

// F11 toggles full screen; Zen mode keeps only the file panes and puts the
// window back the way it was on the way out.
test('zen mode and full screen', { timeout: 90000 }, async (t) => {
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
    await page.waitForFunction(() => window.__demo?.useLayout && document.querySelector('[data-rail-profile-id]'));
    const flush = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const state = () => page.evaluate(() => ({
      zen: window.__demo.useLayout.getState().zen,
      fullscreen: !!window.__fullscreen,
      rail: !!document.querySelector('[data-rail-profile-id]'),
      menuBar: [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'File'),
      panes: !!document.querySelector('[data-file-pane]'),
    }));
    // Focus the page body so the keys reach the global listener.
    await page.mouse.click(700, 450);

    await t.test('F11 toggles full screen only', async () => {
      await page.keyboard.press('F11');
      await flush();
      assert.deepEqual(await state(), { zen: false, fullscreen: true, rail: true, menuBar: true, panes: true });
      await page.keyboard.press('F11');
      await flush();
      assert.equal((await state()).fullscreen, false);
    });

    await t.test('Ctrl+Alt+Z hides the chrome, keeps the panes', async () => {
      await page.keyboard.down('Control');
      await page.keyboard.down('Alt');
      await page.keyboard.press('z');
      await page.keyboard.up('Alt');
      await page.keyboard.up('Control');
      await page.waitForFunction(() => window.__demo.useLayout.getState().zen && window.__fullscreen);
      await flush();
      assert.deepEqual(await state(), { zen: true, fullscreen: true, rail: false, menuBar: false, panes: true });
    });

    await t.test('the top-edge button leaves Zen and restores the window', async () => {
      await page.mouse.move(700, 2);
      const btn = await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].find(b => b.textContent.startsWith('Leave Zen mode') && b.offsetParent));
      await btn.click();
      await page.waitForFunction(() => !window.__demo.useLayout.getState().zen);
      await flush();
      assert.deepEqual(await state(), { zen: false, fullscreen: false, rail: true, menuBar: true, panes: true });
    });

    await t.test('Zen started from full screen stays full screen on exit', async () => {
      await page.evaluate(() => { window.__fullscreen = true; });
      await page.keyboard.down('Control'); await page.keyboard.down('Alt');
      await page.keyboard.press('z');
      await page.keyboard.up('Alt'); await page.keyboard.up('Control');
      await page.waitForFunction(() => window.__demo.useLayout.getState().zen);
      await page.keyboard.down('Control'); await page.keyboard.down('Alt');
      await page.keyboard.press('z');
      await page.keyboard.up('Alt'); await page.keyboard.up('Control');
      await page.waitForFunction(() => !window.__demo.useLayout.getState().zen);
      assert.equal((await state()).fullscreen, true);
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
