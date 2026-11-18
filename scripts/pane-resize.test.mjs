import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

test('file panes resize with pointer and keyboard without disrupting Sync', { timeout: 120000 }, async () => {
  const executablePath = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find(p => p && existsSync(p));
  assert.ok(executablePath);
  const server = await createServer({ mode: 'mock', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({ executablePath, headless: true, defaultViewport: { width: 1440, height: 900 } });
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.__demo?.useConnections.getState().activeSessionId);
    await page.evaluate(() => window.__demo.useSettings.getState().setBrowserLayout('dual'));
    const selector = '[role="separator"][aria-label="Resize file browser panes"]';
    await page.waitForSelector(selector);
    const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = () => page.$eval(selector, el => {
      const container = el.parentElement.parentElement;
      const r = container.getBoundingClientRect();
      const handle = el.getBoundingClientRect();
      return { x: r.x, width: r.width, handleX: handle.x + handle.width / 2, y: handle.y + 50,
        left: container.firstElementChild.getBoundingClientRect().width,
        ratio: Number(el.getAttribute('aria-valuenow')) };
    });
    const dragTo = async fraction => {
      const g = await geometry();
      await page.mouse.move(g.handleX, g.y);
      await page.mouse.down();
      await page.mouse.move(g.x + g.width * fraction, g.y, { steps: 10 });
      await page.mouse.up();
      await settle();
    };
    await dragTo(0.65);
    let g = await geometry();
    assert.ok(Math.abs(g.left / (g.width - 1) - 0.65) < 0.01, 'drag must change actual pane width');
    await page.mouse.move(g.x + 20, g.y);
    await settle();
    assert.equal((await geometry()).left, g.left, 'released pointer must stop resizing');
    await dragTo(0.9);
    assert.equal((await geometry()).ratio, 80);
    await dragTo(0.1);
    assert.equal((await geometry()).ratio, 20);
    await page.focus(selector);
    await page.keyboard.press('ArrowRight');
    await settle();
    assert.equal((await geometry()).ratio, 25);
    await page.keyboard.press('End');
    await settle();
    assert.equal((await geometry()).ratio, 80);
    await page.keyboard.press('Enter');
    await settle();
    assert.equal((await geometry()).ratio, 50);
    await dragTo(0.6);
    g = await geometry();
    await page.mouse.click(g.handleX, g.y, { clickCount: 2 });
    await settle();
    assert.equal((await geometry()).ratio, 50);
    await page.setViewport({ width: 1000, height: 700 });
    await settle();
    g = await geometry();
    assert.ok(Math.abs(g.left / (g.width - 1) - 0.5) < 0.01);
    await page.click('[aria-label="Sync folders"]');
    await page.waitForSelector('[role="dialog"]');
    assert.equal((await geometry()).ratio, 50, 'Sync must not start a resize');
  } finally {
    await browser?.close();
    await server.close();
  }
});
