import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

// Issues #83 and #84 in the real UI (mock backend): links reuse saved
// connections and save sites, and the rail search matches loosely.
test('deep links reuse saved connections; rail search is loose', { timeout: 120000 }, async () => {
  const executablePath = [process.env.CHROME_PATH,
    '/usr/local/bin/google-chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
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
    await page.waitForFunction(() => window.__demo?.useConnections.getState().profiles.some(p => p.id === 'p-api')
      && window.__demo.useSites.getState().loaded, { timeout: 60000 });
    // The mock's api-prod auto-connects at launch; start from nothing connected.
    await page.evaluate(async () => {
      await new Promise(r => setTimeout(r, 500));
      const c = window.__demo.useConnections.getState();
      for (const s of c.sessions) await c.disconnect(s.sessionId);
      window.__demo.useLayout.getState().closeDialog();
    });
    await page.waitForFunction(() => window.__demo.useConnections.getState().sessions.length === 0);
    const state = () => page.evaluate(() => ({
      dialog: window.__demo.useLayout.getState().dialog,
      prefill: window.__demo.useLayout.getState().connectionPrefill,
      active: window.__demo.useConnections.getState().activeProfileId,
      sessions: window.__demo.useConnections.getState().sessions.map(s => s.profileId),
      sites: window.__demo.useSites.getState().sites,
      selectedSite: window.__demo.useSites.getState().activeByProfile['p-api'],
      toasts: window.__demo.useToasts.getState().toasts.map(t => ({ title: t.title, action: t.action?.label })),
    }));
    const link = dl => page.evaluate(dl => window.__demo.emit('deep-link://open', dl), dl);
    const settle = () => page.evaluate(() => new Promise(r => setTimeout(r, 300)));

    // #84: loose rail search.
    await page.keyboard.press('/');
    const input = await page.waitForSelector('input[aria-label="Search servers"]');
    const results = async q => {
      await input.click({ clickCount: 3 });
      await input.type(q);
      return page.$$eval('input[aria-label="Search servers"]', ([el]) => [...el.closest('div.anim-modal').querySelectorAll('button .truncate.font-medium')].map(e => e.textContent));
    };
    assert.equal((await results('api prod'))[0], 'api-prod');
    assert.equal((await results('prod api'))[0], 'api-prod');
    assert.equal((await results('apiprod'))[0], 'api-prod');
    assert.ok((await results('db_staging')).includes('db-staging'));
    await page.keyboard.press('Escape');

    // #83.1: a link to a saved, disconnected server selects it and offers Connect.
    await link({ action: 'connect', protocol: 'sftp', host: '10.0.0.12', username: 'root', name: 'Some other name' });
    await settle();
    let s = await state();
    assert.notEqual(s.dialog, 'newConnection', 'no duplicate editor for a saved server');
    assert.deepEqual(s.sessions, [], 'a link never connects on its own');
    assert.ok(s.toasts.some(t => t.title === 'Already saved in Faro' && t.action === 'Connect'));
    const connect = await page.waitForSelector('xpath/.//button[normalize-space()="Connect"]');
    await connect.click();
    await page.waitForFunction(() => window.__demo.useConnections.getState().activeProfileId === 'p-api');
    assert.ok(!(await state()).toasts.some(t => t.action === 'Connect'), 'Connect is not offered twice');

    // #83.3: a site link on the connected server saves the folder as a site and opens it.
    await link({ action: 'site', host: '10.0.0.12', username: 'root', path: '/var/www/shop/', name: 'Shop' });
    await page.waitForFunction(() => window.__demo.useSites.getState().sites.some(x => x.name === 'Shop'));
    await settle();
    s = await state();
    const shop = s.sites.find(x => x.name === 'Shop');
    assert.equal(shop.profileId, 'p-api');
    assert.equal(shop.path, '/var/www/shop', 'saved without the trailing slash');
    assert.equal(s.selectedSite, shop.id);
    // The same link again reuses that site rather than saving a second one.
    await link({ action: 'site', host: '10.0.0.12', username: 'root', path: '/var/www/shop', name: 'Shop' });
    await settle();
    assert.equal((await state()).sites.filter(x => x.name === 'Shop').length, 1);
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/deep-link-site.png` : undefined });

    // #83.2: an unknown server opens the editor prefilled in the link's group.
    await link({ action: 'connect', protocol: 'sftp', host: 'new.example.com', username: 'web', group: 'Acme Panel', name: 'New box' });
    await page.waitForFunction(() => window.__demo.useLayout.getState().dialog === 'newConnection');
    s = await state();
    assert.equal(s.prefill.group, 'Acme Panel');
    assert.equal(s.prefill.host, 'new.example.com');
    const groupValues = await page.$$eval('input', els => els.map(e => e.value));
    assert.ok(groupValues.includes('Acme Panel'), 'the editor shows the group');
    await page.screenshot({ path: process.env.SHOT_DIR ? `${process.env.SHOT_DIR}/deep-link-editor.png` : undefined });

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
