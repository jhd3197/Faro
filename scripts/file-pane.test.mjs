import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

test('file pane partial listings and navigation', { timeout: 90000 }, async (t) => {
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
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1000, height: 700 } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/file-pane.html`);
    const file = (parent, name = 'keep.txt') => ({ name, path: `${parent.replace(/\/$/, '')}/${name}`, kind: 'file', size: 4 });
    const dir = (parent, name) => ({ ...file(parent, name), kind: 'directory' });
    const pending = async (path, session = 'ftp') => {
      await page.waitForFunction((p, s) => window.listingTest?.requests.some(r => !r.done && r.path === p && r.session === s), {}, path, session);
      return page.evaluate((p, s) => window.listingTest.requests.findIndex(r => !r.done && r.path === p && r.session === s), path, session);
    };
    const resolve = async (id, entries, skipped = 0) => {
      await page.evaluate((id, e, n) => window.listingTest.resolve(id, e, n), id, entries, skipped);
      // Flush React commits without assuming a network/animation delay.
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    };
    const body = () => page.evaluate(() => document.body.innerText);
    const navigate = async (path) => { await page.evaluate(p => window.listingTest.setPath(p), path); return pending(path); };
    const clickTitle = title => page.evaluate(title => {
      const button = [...document.querySelectorAll('button')].find(b => b.title === title);
      if (!button || button.disabled) throw Error(`No enabled button: ${title}`);
      button.click();
    }, title);
    const currentPath = () => page.$eval('[data-path]', e => e.dataset.path);

    await t.test('safe entries and persistent warning; child navigation, breadcrumbs and history', async () => {
      await resolve(await pending('/mixed'), [file('/mixed'), dir('/mixed', 'sub')], 1);
      assert.match(await body(), /Incomplete listing: 1 entry hidden/);
      assert.match(await body(), /keep.txt/);
      assert.equal(await page.$$eval('[role="status"] button', b => b.length), 0, 'warning cannot be dismissed');
      if (process.env.FILE_PANE_SCREENSHOT) await page.screenshot({ path: process.env.FILE_PANE_SCREENSHOT });
      await page.evaluate(() => [...document.querySelectorAll('[data-idx]')].find(e => e.textContent.includes('sub'))
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
      await resolve(await pending('/mixed/sub'), [file('/mixed/sub', 'child.txt')]);
      assert.equal(await currentPath(), '/mixed/sub');
      assert.doesNotMatch(await body(), /Incomplete listing|keep.txt/);
      await clickTitle('/mixed');
      await resolve(await pending('/mixed'), [file('/mixed')], 1);
      assert.match(await body(), /Incomplete listing/);
      await clickTitle('Back');
      await resolve(await pending('/mixed/sub'), [file('/mixed/sub', 'child.txt')]);
      assert.equal(await currentPath(), '/mixed/sub');
      await clickTitle('Forward');
      await resolve(await pending('/mixed'), [file('/mixed')], 1);
      assert.equal(await currentPath(), '/mixed');
    });

    await t.test('all hidden entries are not reported as an empty folder; refresh clears warning', async () => {
      await resolve(await navigate('/all-hidden'), [], 2);
      assert.match(await body(), /2 entries hidden/);
      assert.match(await body(), /No supported entries/);
      assert.doesNotMatch(await body(), /Empty folder/);
      await clickTitle('Refresh');
      await resolve(await pending('/all-hidden'), []);
      assert.match(await body(), /Empty folder/);
      assert.doesNotMatch(await body(), /Incomplete listing/);
    });

    await t.test('late responses cannot replace a newer folder or its warning', async () => {
      const old = await navigate('/slow');
      await resolve(await navigate('/fast'), [file('/fast', 'current.txt')]);
      await resolve(old, [file('/slow', 'stale.txt')], 3);
      assert.equal(await currentPath(), '/fast');
      assert.match(await body(), /current.txt/);
      assert.doesNotMatch(await body(), /stale.txt|Incomplete listing/);
    });

    await t.test('late errors and disconnects cannot leak previous session state', async () => {
      const old = await navigate('/old-session');
      await page.evaluate(() => window.listingTest.setSession('other'));
      await resolve(await pending('/old-session', 'other'), [file('/old-session', 'new-session.txt')]);
      await page.evaluate(id => window.listingTest.reject(id, 'old session failed'), old);
      assert.doesNotMatch(await body(), /old session failed/);
      await page.evaluate(() => window.listingTest.setPath('/pending-disconnect'));
      const disconnected = await pending('/pending-disconnect', 'other');
      await page.evaluate(() => window.listingTest.setSession(null));
      await resolve(disconnected, [file('/pending-disconnect', 'stale.txt')], 1);
      assert.match(await body(), /No connection/);
      assert.doesNotMatch(await body(), /stale.txt|Incomplete listing/);
      await page.evaluate(() => window.listingTest.setSession('ftp'));
      await resolve(await pending('/pending-disconnect'), []);
    });

    await t.test('error dismissal never exposes entries from the previous folder', async () => {
      await resolve(await navigate('/good'), [file('/good')], 1);
      const bad = await navigate('/denied');
      await page.evaluate(id => window.listingTest.reject(id, 'Permission denied'), bad);
      await page.waitForFunction(() => document.body.innerText.includes('Permission denied'));
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent === 'dismiss').click());
      assert.doesNotMatch(await body(), /keep.txt|Incomplete listing/);
    });

    await t.test('relative, Unicode, drive-letter and UNC breadcrumbs and parent navigation', async () => {
      for (const [path, crumb] of [
        ['./public_html/café', './public_html'], ['/www/café/sub', '/www/café'],
        ['C:\\Users\\Juan', 'C:\\Users'], ['\\\\server\\share\\folder', '\\\\server\\share'],
      ]) {
        await resolve(await navigate(path), []);
        await clickTitle(crumb);
        await resolve(await pending(crumb), []);
        assert.equal(await currentPath(), crumb);
      }
      await resolve(await navigate('./www/sub'), []);
      await clickTitle('Up (Backspace)');
      await resolve(await pending('./www'), []);
      assert.equal(await currentPath(), './www');
      // On POSIX a backslash is part of a name: `/srv/x\y` is one folder, and
      // Up goes to `/srv`, not `/srv/x`.
      await resolve(await navigate('/srv/x\\y'), []);
      assert.equal(await page.$$eval('button[title="/srv/x"]', b => b.length), 0, 'no fake crumb');
      await clickTitle('Up (Backspace)');
      await resolve(await pending('/srv'), []);
      assert.equal(await currentPath(), '/srv');
      await resolve(await navigate('/'), []);
      assert.equal(await page.$eval('button[title="/"]', b => b.disabled), true);
    });

    await t.test('legacy adapters retain their array listing contract', async () => {
      await page.evaluate(() => window.listingTest.setLegacy(true));
      const id = await pending('/');
      assert.equal(await page.evaluate(id => window.listingTest.requests[id].kind, id), 'strict');
      await resolve(id, [file('/', 'legacy.txt')]);
      assert.match(await body(), /legacy.txt/);
      assert.doesNotMatch(await body(), /Incomplete listing/);
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
