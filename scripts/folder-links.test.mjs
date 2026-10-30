import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

test('folder links: icon, sort, open, copy and delete', { timeout: 90000 }, async () => {
  const executablePath = [process.env.CHROME_PATH,
    '/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find(p => p && existsSync(p));
  assert.ok(executablePath, 'Install Chrome/Chromium or set CHROME_PATH');
  const server = await createServer({ mode: 'mock', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({
      executablePath, headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1000, height: 700 },
    });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/folder-links.html`);

    const entry = (parent, name, kind, extra = {}) => ({
      name, path: `${parent}/${name}`, kind, size: 4, ...extra,
    });
    const listing = [
      entry('/links', 'notes.txt', 'file'),
      entry('/links', 'real', 'directory'),
      entry('/links', 'linked-folder', 'symlink', { linkDir: true }),
      entry('/links', 'file-link', 'symlink', { linkDir: false }),
      entry('/links', 'broken', 'symlink'),
    ];
    const pending = async (path) => {
      await page.waitForFunction(p => window.listingTest?.requests.some(r => !r.done && r.path === p), {}, path);
      return page.evaluate(p => window.listingTest.requests.findIndex(r => !r.done && r.path === p), path);
    };
    const resolve = async (id, entries) => {
      await page.evaluate((id, e) => window.listingTest.resolve(id, e), id, entries);
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    };
    const rows = () => page.evaluate(() => [...document.querySelectorAll('[data-idx]')].map(r => ({
      name: r.innerText.split('\n')[0].trim(),
      icon: r.querySelector('svg')?.getAttribute('class') ?? '',
      title: r.getAttribute('title') ?? '',
    })));
    const openMenu = (name) => page.evaluate(name => {
      const row = [...document.querySelectorAll('[data-idx]')].find(e => e.innerText.startsWith(name));
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 }));
    }, name);
    const menuLabels = () => page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].map(b => b.textContent.trim()));

    await resolve(await pending('/links'), listing);
    assert.deepEqual(errors, [], errors.join('\n'));

    const shown = await rows();
    const names = shown.map(r => r.name);
    assert.deepEqual(names, ['linked-folder', 'real', 'broken', 'file-link', 'notes.txt'],
      'folder links sort with folders, ahead of file links and broken links');

    const icon = (name) => shown.find(r => r.name === name).icon;
    assert.match(icon('linked-folder'), /folder-symlink/, icon('linked-folder'));
    assert.match(icon('real'), /lucide-folder/, icon('real'));
    assert.doesNotMatch(icon('real'), /folder-symlink/);
    assert.match(icon('file-link'), /lucide-link/, icon('file-link'));
    assert.doesNotMatch(icon('file-link'), /folder-symlink/);
    assert.match(icon('broken'), /lucide-link/, icon('broken'));
    assert.match(shown.find(r => r.name === 'linked-folder').title, /Double-click to open/);
    assert.match(shown.find(r => r.name === 'broken').title, /Double-click to transfer/);
    assert.match(shown.find(r => r.name === 'file-link').title, /Double-click to transfer/);

    const mapped = await page.evaluate(() => ({
      folder: window.listingTest.toTransferItem({ path: '/links/linked-folder', kind: 'symlink', linkDir: true, size: 4 }),
      file: window.listingTest.toTransferItem({ path: '/links/file-link', kind: 'symlink', linkDir: false, size: 4 }),
      broken: window.listingTest.toTransferItem({ path: '/links/broken', kind: 'symlink', size: 4 }),
      dir: window.listingTest.toTransferItem({ path: '/links/real', kind: 'directory', size: 0 }),
    }));
    assert.equal(mapped.folder.kind, 'directory', 'copying a folder link copies the folder');
    assert.equal(mapped.file.kind, 'file');
    assert.equal(mapped.broken.kind, 'file');
    assert.equal(mapped.dir.kind, 'directory');

    await openMenu('linked-folder');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].some(b => b.textContent.trim() === 'Open'));
    assert.ok((await menuLabels()).includes('Duplicate'));
    assert.ok(!(await menuLabels()).includes('Upload'));
    await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.trim() === 'Duplicate').click());
    await page.waitForFunction(() => window.listingTest.ops.some(o => o.op === 'duplicate'));
    const duplicated = await page.evaluate(() => window.listingTest.ops.find(o => o.op === 'duplicate'));
    assert.equal(duplicated.path, '/links/linked-folder');
    assert.equal(duplicated.kind, 'symlink');
    await resolve(await pending('/links'), listing);

    await page.evaluate(() => document.body.click());
    await openMenu('linked-folder');
    await page.waitForFunction(() => [...document.querySelectorAll('[role="menuitem"]')].some(b => b.textContent.trim() === 'Delete'));
    await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find(b => b.textContent.trim() === 'Delete').click());
    await page.waitForSelector('[role="dialog"]');
    const dialog = await page.$eval('[role="dialog"]', e => e.innerText);
    assert.match(dialog, /Delete linked-folder/);
    assert.doesNotMatch(dialog, /all its contents/, 'deleting a link does not offer to remove the folder');
    await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] button')].find(b => b.textContent.trim() === 'Delete').click());
    await page.waitForFunction(() => window.listingTest.ops.some(o => o.op === 'remove'));
    const removed = await page.evaluate(() => window.listingTest.ops.find(o => o.op === 'remove'));
    assert.equal(removed.path, '/links/linked-folder');
    assert.equal(removed.recursive, false, 'delete removes only the link');
    await resolve(await pending('/links'), listing.filter(e => e.name !== 'linked-folder'));

    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-idx]')].find(e => e.innerText.startsWith('broken'));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    assert.equal(await page.$eval('[data-path]', e => e.dataset.path), '/links', 'a broken link does not open');

    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-idx]')].find(e => e.innerText.startsWith('file-link'));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    assert.equal(await page.$eval('[data-path]', e => e.dataset.path), '/links', 'a file link does not open as a folder');

    // Re-list with the folder link so double-click can open it.
    await page.evaluate(() => window.listingTest.setPath('/links-again'));
    await resolve(await pending('/links-again'), listing.map(e => ({ ...e, path: e.path.replace('/links/', '/links-again/') })));
    await page.evaluate(() => {
      const row = [...document.querySelectorAll('[data-idx]')].find(e => e.innerText.startsWith('linked-folder'));
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    const opened = '/links-again/linked-folder';
    await resolve(await pending(opened), [entry(opened, 'inside.txt', 'file')]);
    assert.equal(await page.$eval('[data-path]', e => e.dataset.path), opened);
    assert.match(await page.evaluate(() => document.body.innerText), /inside.txt/);
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await server.close();
  }
});
