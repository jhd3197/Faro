import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
const browser = await puppeteer.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width: 1100, height: 800 });
  await page.evaluateOnNewDocument(() => {
    if (!sessionStorage.getItem('faro-mock-discovery')) sessionStorage.setItem('faro-mock-discovery', '{}');
  });
  const load = () => page.goto(process.env.FARO_TEST_URL ?? 'http://127.0.0.1:1425', { waitUntil: 'networkidle0' });
  const click = async text => {
    const handle = await page.evaluateHandle(text => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text), text);
    assert.ok(handle.asElement(), `Missing button: ${text}`);
    await handle.asElement().click();
    await handle.dispose();
  };
  await load();
  await page.waitForSelector('[role="dialog"]');
  assert.match(await page.$eval('h1', e => e.textContent), /Welcome to Faro/);
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H1');
  await page.screenshot({ path: process.env.TEMP + '/faro-welcome.png' });
  const sessionsBefore = await page.evaluate(() => window.__demo.useConnections.getState().sessions.length);
  await click('Take a quick tour');
  await page.click('[aria-label="Select demo server"]');
  assert.match(await page.$eval('[role="dialog"]', e => e.textContent), /Demo server selected/);
  await click('Next');
  assert.equal(await page.$eval('[role="dialog"] button:disabled', e => e.textContent.trim()), 'Upload');
  await click('index.html');
  await click('Upload');
  assert.match(await page.$eval('[role="dialog"]', e => e.textContent), /Practice upload complete/);
  assert.equal(await page.evaluate(() => window.__demo.useConnections.getState().sessions.length), sessionsBefore);
  await page.screenshot({ path: process.env.TEMP + '/faro-walkthrough.png' });
  await click('Next');
  await click('Folder Sync');
  assert.match(await page.$eval('[role="dialog"]', e => e.textContent), /Review the pair/);
  await click('Next');
  await click('Add connection');
  await page.waitForFunction(() => window.__demo.useLayout.getState().dialog === 'newConnection');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('faro-mock-discovery')).discoverySeenVersion), '1.3.22');
  await load();
  assert.equal(await page.$('[role="dialog"]'), null, 'dismissed onboarding stays dismissed');
  await click('Help');
  await click('Welcome & walkthrough');
  await page.waitForSelector('[role="dialog"]');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('[role="dialog"]'), null);
  // Simulate the first launch after an update, with cached release notes and no network.
  await page.evaluate(() => sessionStorage.setItem('faro-mock-discovery', JSON.stringify({ discoverySeenVersion: '1.3.21', 'discoveryReleaseNotes:1.3.22': JSON.stringify({ version: '1.3.22', notes: '## Faro v1.3.22\n\n<!-- faro:changes -->\n### Faster browsing\n\n- Faster file browsing with `ls` and **bold** and [a link](https://example.com)\n<!-- /faro:changes -->\n\n### Desktop app\n| File | Size |' }) })));
  await load();
  await page.waitForSelector('[role="dialog"]');
  assert.match(await page.$eval('[role="dialog"]', e => e.textContent), /Faster file browsing/);
  const shown = await page.$eval('[role="dialog"]', e => e.textContent);
  assert.doesNotMatch(shown, /Desktop app|File \| Size|faro:changes|example\.com/, 'only the marked summary is shown');
  assert.equal(await page.$eval('[role="dialog"] code', e => e.textContent), 'ls');
  assert.equal(await page.$eval('[role="dialog"] strong', e => e.textContent), 'bold');
  assert.equal(await page.$('[role="dialog"] .space-y-2 a'), null, 'release prose never becomes a link');
  await page.screenshot({ path: process.env.TEMP + '/faro-whats-new.png' });
  await click('Done');
  await load();
  assert.equal(await page.$('[role="dialog"]'), null, 'release notes shown once per installed version');
  await page.evaluate(async () => {
    window.__mockUpdate = { version: '1.4.0', body: '## Faro v1.4.0\n\n### Desktop app\n| File | Size |\n> SmartScreen: click Run anyway' };
    await window.__demo.useUpdater.getState().check(false);
  });
  await page.waitForSelector("button[aria-expanded]");
  await page.evaluate(() => { const store = window.__demo.useToasts.getState(); store.toasts.forEach(t => store.dismiss(t.id)); });
  await click("What's new");
  await page.waitForSelector('[aria-label="Update release notes"]');
  const updateNotes = await page.$eval('[aria-label="Update release notes"]', e => e.textContent);
  assert.match(updateNotes, /no summary in Faro/, 'an unmarked release body falls back to the full-notes link');
  assert.doesNotMatch(updateNotes, /Desktop app|SmartScreen|Size/);
  await click('Download update');
  await page.waitForFunction(() => window.__demo.useUpdater.getState().status === 'ready');
  assert.equal(await page.evaluate(() => window.__installCalls ?? 0), 0);
  assert.ok(await page.evaluate(() => JSON.parse(sessionStorage.getItem('faro-mock-discovery'))['discoveryReleaseNotes:1.3.22']), 'checking a newer release preserves installed notes');
  await page.evaluate(() => window.__demo.useLayout.getState().openDialog('welcome'));
  await page.setViewport({ width: 520, height: 650 });
  await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getAnimations().every(a => a.playState === 'finished'));
  await page.screenshot({ path: process.env.TEMP + '/faro-welcome-small.png' });
  assert.ok(await page.$eval('[role="dialog"]', e => e.scrollWidth <= e.clientWidth));
  assert.deepEqual(errors, []);
  console.log('Discovery UI passed: first launch, demo interactions, setup handoff, replay, Escape, persistence, post-update notes (marked summary only), update preview (unmarked fallback), narrow layout.');
} finally { await browser.close(); }



