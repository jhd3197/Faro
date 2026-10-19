import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

test('site shortcuts reuse connections and preserve independent navigation', { timeout: 180000 }, async t => {
  const executablePath = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find(p => p && existsSync(p));
  assert.ok(executablePath, 'Install Chrome/Chromium or set CHROME_PATH');
  const server = await createServer({ mode: 'mock', cacheDir: 'node_modules/.vite-site-shortcuts-test', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1280, height: 800 } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/site-shortcuts.html`);
    await page.waitForFunction(() => window.siteTest?.useConnections.getState().activeSessionId && window.siteTest.useSites.getState().loaded);
    const clickText = text => page.evaluate(text => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text && b.getBoundingClientRect().width);
      if (!button) throw Error(`Missing button: ${text}`);
      button.click();
    }, text);
    const clickAria = label => page.click(`button[aria-label=${JSON.stringify(label)}]`);
    const waitSite = name => page.waitForSelector(`button[aria-label=${JSON.stringify(`Open site ${name}`)}]`);
    const nameSite = async name => {
      await page.waitForSelector('[role="dialog"] input');
      await page.$eval('[role="dialog"] input', input => input.select());
      await page.type('[role="dialog"] input', name);
      await clickText('Save site');
      await page.waitForSelector('[role="dialog"]', { hidden: true });
      await waitSite(name);
    };
    const snapshot = () => page.evaluate(() => {
      const s = window.siteTest.useSites.getState();
      const c = window.siteTest.useConnections.getState();
      return { sites: s.sites, active: s.activeByProfile, paths: s.sitePaths, serverPaths: s.serverPaths, sessions: c.sessions, profileId: c.activeProfileId, calls: window.siteTest.connectCalls };
    });
    const shot = async name => {
      if (!process.env.SITE_SCREENSHOTS) return;
      mkdirSync(process.env.SITE_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: join(process.env.SITE_SCREENSHOTS, `${name}.png`) });
    };

    await t.test('save the current folder, and save a child from its context menu', async () => {
      await clickAria('Save as site');
      await shot('save-site');
      await nameSite('API website');
      await page.waitForFunction(() => [...document.querySelectorAll('[data-idx]')].some(e => e.textContent.includes('uploads')));
      await page.evaluate(() => [...document.querySelectorAll('[data-idx]')].find(e => e.textContent.includes('uploads'))
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 430, clientY: 260 })));
      await clickText('Save as site…');
      await nameSite('Media library');
      const state = await snapshot();
      assert.deepEqual(state.sites.map(s => s.path), ['/var/www/api', '/var/www/api/uploads']);
      assert.equal(state.sessions.length, 1);
      assert.equal(state.calls.length, 1);
    });

    await t.test('site navigation is independent; site home, server view, layouts and local view work', async () => {
      await clickAria('Open site API website');
      await page.waitForSelector('button[aria-label="Site home"]');
      await page.evaluate(() => window.siteTest.useSites.getState().navigate('p-api', '/var/www/api/logs'));
      await clickAria('Open site Media library');
      await page.waitForFunction(() => document.querySelector('button[title="/var/www/api/uploads"]'));
      await clickAria('Open site API website');
      await page.waitForFunction(() => document.querySelector('button[title="/var/www/api/logs"]'));
      await clickAria('Site home');
      await page.waitForFunction(() => !document.querySelector('button[title="/var/www/api/logs"]'));
      await page.evaluate(() => window.siteTest.useSettings.getState().setBrowserLayout('dual'));
      await page.waitForSelector('[aria-label="API website directory listing"]');
      assert.equal(await page.$$('button[aria-label="Save as site"]').then(x => x.length), 1);
      await page.evaluate(() => window.siteTest.useSettings.getState().setBrowserLayout('single'));
      await clickAria('Local files');
      assert.equal(await page.$('button[aria-label="Save as site"]'), null);
      await clickAria('Open site Media library');
      await page.waitForSelector('[aria-label="Media library directory listing"]');
      await shot('sites-sidebar');
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.startsWith('api-prod') && !b.getAttribute('aria-label')?.startsWith('api-prod sites')).click());
      await page.waitForSelector('[aria-label="api-prod directory listing"]');
      assert.equal(await page.$('button[aria-label="Site home"]'), null);
    });

    await t.test('rename and remove affect metadata only; save failures stay in the dialog', async () => {
      await clickAria('Options for Media library');
      await clickText('Rename site…');
      await page.waitForSelector('[role="dialog"] input');
      await page.$eval('[role="dialog"] input', e => e.select());
      await page.type('[role="dialog"] input', 'Client media');
      await page.evaluate(() => { window.siteTest.failSave = true; });
      await clickText('Save name');
      await page.waitForSelector('[role="alert"]');
      assert.ok((await snapshot()).sites.some(s => s.name === 'Media library'));
      await page.evaluate(() => { window.siteTest.failSave = false; });
      await clickText('Save name');
      await waitSite('Client media');
      await page.reload();
      await waitSite('Client media');
      assert.equal((await snapshot()).sites.length, 2, 'shortcuts survive reload via the database settings contract');
      await clickAria('Open site API website');
      await clickAria('Save as site');
      await clickText('Save site');
      await page.waitForSelector('[role="alert"]');
      assert.match(await page.$eval('[role="alert"]', e => e.textContent), /already saved/);
      await clickText('Cancel');
      await clickAria('Options for Client media');
      await clickText('Remove shortcut');
      await page.waitForSelector('button[aria-label="Open site Client media"]', { hidden: true });
      assert.equal((await snapshot()).sessions.length, 1);
    });

    await t.test('offline sites reconnect once, failures do not change selection, late connections do not steal focus', async () => {
      await page.evaluate(async () => { await window.siteTest.useConnections.getState().disconnect(); window.siteTest.failConnect = true; });
      await clickAria('Open site API website');
      await page.waitForFunction(() => !window.siteTest.useConnections.getState().connecting);
      assert.equal((await snapshot()).sessions.length, 0);
      await page.evaluate(() => { window.siteTest.failConnect = false; window.siteTest.delayConnect = true; });
      await clickAria('Open site API website');
      await page.waitForFunction(() => window.siteTest.useConnections.getState().connecting);
      const before = (await snapshot()).calls.length;
      await clickAria('Open site API website');
      assert.equal((await snapshot()).calls.length, before, 'double-click shares one pending connection');
      await clickAria('Local files');
      await page.evaluate(() => { window.siteTest.delayConnect = false; window.siteTest.releaseConnect(); });
      await page.waitForFunction(() => !window.siteTest.useConnections.getState().connecting);
      assert.equal(await page.evaluate(() => window.siteTest.useLayout.getState().browseLocal), true);
      await clickAria('Open site API website');
      await page.waitForSelector('[aria-label="API website directory listing"]');
      assert.equal((await snapshot()).sessions.length, 1);
    });

    await t.test('collapsed rail exposes sites on hover and parent deletion removes shortcuts', async () => {
      await page.evaluate(() => window.siteTest.useSettings.getState().setRailExpanded(false));
      await page.mouse.move(700, 300);
      await page.waitForSelector('button[aria-label="Open site API website"]', { hidden: true });
      await page.mouse.move(30, 180);
      await waitSite('API website');
      await page.evaluate(() => window.siteTest.useConnections.getState().deleteProfile('p-api'));
      assert.equal((await snapshot()).sites.length, 0);
      const saved = await page.evaluate(() => JSON.parse(window.siteTest.settings.siteShortcuts));
      assert.deepEqual(saved, []);
    });
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
