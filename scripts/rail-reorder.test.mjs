import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

test('sidebar order works without native browser drag events', { timeout: 120000 }, async t => {
  const executablePath = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find(p => p && existsSync(p));
  assert.ok(executablePath);
  const server = await createServer({ mode: 'mock', cacheDir: 'node_modules/.vite-rail-test', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({ executablePath, headless: true, defaultViewport: { width: 1100, height: 800 } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/rail-reorder.html`);
    await page.waitForSelector('[data-rail-profile-id="p-api"]');
    const order = () => page.$$eval('[data-rail-profile-id]', rows => rows.map(e => e.dataset.railProfileId));
    const box = selector => page.$eval(selector, e => {
      const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const row = id => `[data-rail-profile-id="${id}"]`;
    const drag = async (id, targetSelector, fraction = 0.2, finish = 'up') => {
      const source = await box(row(id));
      await page.mouse.move(source.x + 24, source.y + source.height / 2);
      await page.mouse.down();
      await page.mouse.move(source.x + 24, source.y + source.height / 2 + 9, { steps: 3 });
      const target = await box(targetSelector);
      await page.mouse.move(target.x + Math.min(24, target.width / 2), target.y + target.height * fraction, { steps: 12 });
      if (finish === 'escape') await page.keyboard.press('Escape');
      await page.mouse.up();
      await page.waitForFunction(() => !window.railTest.useConnections.getState().reordering);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    };
    const clickText = text => page.evaluate(text => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text);
      if (!button) throw Error(`Missing button: ${text}`);
      button.click();
    }, text);

    await t.test('actual pointer drag changes protocol/alphabetic order and survives reload', async () => {
      await drag('p-ftp', row('p-api'));
      assert.equal((await order())[0], 'p-ftp');
      assert.equal(await page.evaluate(() => window.railTest.reorderCalls), 1);
      assert.equal(await page.evaluate(() => window.railTest.nativeDragStarts), 0);
      assert.equal(await page.$('[role="menu"]'), null, 'releasing a drag must not click the server');
      await page.reload();
      await page.waitForSelector(row('p-ftp'));
      assert.equal((await order())[0], 'p-ftp');
    });

    await t.test('bottom-half drops, cancellation and dropping outside the rail', async () => {
      await drag('p-ftp', row('p-cdn'), 0.8);
      assert.equal((await order()).at(-1), 'p-ftp');
      const before = await order();
      await drag('p-ftp', row('p-api'), 0.2, 'escape');
      assert.deepEqual(await order(), before);
      await drag('p-ftp', '[aria-label="api-prod directory listing"]', 0.5);
      assert.deepEqual(await order(), before);
    });

    await t.test('group targets, within-group order, and dragging out to the top', async () => {
      await page.evaluate(async () => {
        const c = window.railTest.useConnections.getState();
        await c.saveProfiles(c.profiles.filter(p => ['p-db', 'p-edge'].includes(p.id)).map(p => ({ ...p, group: 'Clients' })));
      });
      await page.waitForSelector('[data-rail-group="Clients"]');
      await drag('p-ftp', '[data-rail-group="Clients"]');
      assert.equal(await page.evaluate(() => window.railTest.useConnections.getState().profiles.find(p => p.id === 'p-ftp').group), 'Clients');
      await drag('p-ftp', row('p-db'));
      assert.ok((await order()).indexOf('p-ftp') < (await order()).indexOf('p-db'));
      await drag('p-ftp', '[data-rail-drop="top"]');
      assert.equal((await order())[0], 'p-ftp');
      assert.equal(await page.evaluate(() => window.railTest.useConnections.getState().profiles.find(p => p.id === 'p-ftp').group), undefined);
    });

    await t.test('failed persistence restores saved order and reports the error', async () => {
      const before = await order();
      await page.evaluate(() => { window.railTest.failReorder = true; });
      await drag('p-ftp', row('p-api'), 0.8);
      assert.deepEqual(await order(), before);
      await page.waitForFunction(() => document.body.innerText.includes("Couldn't save server order"));
      await page.evaluate(() => { window.railTest.failReorder = false; });
    });

    await t.test('move up/down options offer a keyboard alternative', async () => {
      await page.click(`${row('p-ftp')} button`, { button: 'right' });
      await clickText('Move down');
      await page.waitForFunction(() => !window.railTest.useConnections.getState().reordering);
      assert.deepEqual((await order()).slice(0, 2), ['p-api', 'p-ftp']);
    });

    await t.test('collapsed rail expands during pointer drag', async () => {
      await page.evaluate(() => window.railTest.useSettings.getState().setRailExpanded(false));
      await page.mouse.move(650, 400);
      await page.waitForFunction(() => document.querySelector('[data-rail-profile-id]').getBoundingClientRect().width < 100);
      await drag('p-ftp', row('p-api'));
      assert.equal((await order())[0], 'p-ftp');
    });

    await t.test('spaces between rows remain valid insertion targets', async () => {
      await page.evaluate(() => window.railTest.useSettings.getState().setRailExpanded(true));
      const source = await box(row('p-cdn'));
      const previous = await box(row('p-ftp'));
      const next = await box(row('p-api'));
      await page.mouse.move(source.x + 24, source.y + 20);
      await page.mouse.down();
      await page.mouse.move(previous.x + 24, (previous.y + previous.height + next.y) / 2, { steps: 12 });
      await page.mouse.up();
      await page.waitForFunction(() => !window.railTest.useConnections.getState().reordering);
      assert.deepEqual((await order()).slice(0, 3), ['p-ftp', 'p-cdn', 'p-api']);
    });

    await t.test('edge scrolling supports long server lists; pointer cancellation does not save', async () => {
      await page.evaluate(async () => {
        const c = window.railTest.useConnections.getState();
        const template = c.profiles.find(p => p.id === 'p-api');
        await c.saveProfiles(Array.from({ length: 25 }, (_, i) => ({ ...template, id: `extra-${i}`, name: `Server ${i}`, autoConnect: false, sortOrder: 100 + i })));
      });
      await page.$eval('[data-rail-scroll]', e => { e.scrollTop = 0; });
      const before = await page.evaluate(() => window.railTest.reorderCalls);
      const source = await box(row('p-ftp'));
      const area = await box('[data-rail-scroll]');
      await page.mouse.move(source.x + 24, source.y + 20);
      await page.mouse.down();
      await page.mouse.move(area.x + 24, area.y + area.height - 4, { steps: 15 });
      await page.waitForFunction(() => document.querySelector('[data-rail-scroll]').scrollTop > 150);
      await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1 })));
      await page.mouse.up();
      assert.equal(await page.evaluate(() => window.railTest.reorderCalls), before);
      assert.equal(await page.evaluate(() => document.body.style.userSelect), '');
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
