// Plan 32: first run, update notices, release notes and tips, against the mock build.
// Starts its own mock server unless FARO_TEST_URL points at one (e.g. a running
// `npm run dev:mock`); FARO_SHOTS sets the screenshot folder (default: temp).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(p => p && existsSync(p));
const shots = process.env.FARO_SHOTS ?? tmpdir();
const shot = (page, name) => page.screenshot({ path: join(shots, `faro-${name}.png`) });
const marked = (title, ...items) => `## Faro\n\n<!-- faro:changes -->\n### ${title}\n\n${items.map(i => `- ${i}`).join('\n')}\n<!-- /faro:changes -->\n\n### Desktop app\n| File | Size |`;
const server = process.env.FARO_TEST_URL ? null
  : await createServer({ mode: 'mock', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server?.listen();
const url = process.env.FARO_TEST_URL ?? `http://127.0.0.1:${server.httpServer.address().port}/`;
const browser = await puppeteer.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setViewport({ width: 1180, height: 760 });
  // First boot only: a fresh install with no settings and no saved connections,
  // on a machine where OpenSSH and FileZilla already have hosts.
  await page.evaluateOnNewDocument(() => {
    if (sessionStorage.getItem('faro-test-init')) return;
    sessionStorage.setItem('faro-test-init', '1');
    sessionStorage.setItem('faro-mock-discovery', '{}');
    sessionStorage.setItem('faro-mock-fresh', '1');
    sessionStorage.setItem('faro-mock-found', '1');
  });
  const load = async () => {
    await page.goto(url, { waitUntil: 'networkidle0' });
    await page.waitForFunction(() => window.__demo?.useDiscovery);
  };
  const state = (settings, extra = {}) => page.evaluate((settings, extra) => {
    sessionStorage.setItem('faro-mock-discovery', JSON.stringify(settings));
    for (const [k, v] of Object.entries(extra)) v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v);
  }, settings, extra);
  const click = async (text, scope = 'body') => {
    const handle = await page.evaluateHandle((text, scope) => [...document.querySelector(scope).querySelectorAll('button')].find(b => b.textContent.trim().startsWith(text)), text, scope);
    assert.ok(handle.asElement(), `Missing button: ${text}`);
    await handle.asElement().click();
    await handle.dispose();
  };
  const dialogText = () => page.$eval('[role="dialog"]', e => e.textContent);
  const settled = () => page.waitForFunction(() => document.querySelector('[role="dialog"]')?.getAnimations().every(a => a.playState === 'finished'));

  // 1. Fresh install: one "Get connected" screen, not a tour.
  await load();
  await page.waitForSelector('[role="dialog"]');
  assert.equal(await page.$eval('[role="dialog"] h1', e => e.textContent), 'Get connected');
  assert.equal(await page.evaluate(() => document.activeElement.tagName), 'H1');
  const ring = await page.$eval('[role="dialog"] h1', e => { const s = getComputedStyle(e); return `${s.outlineStyle} ${s.outlineColor}`; });
  assert.match(ring, /^none |rgba\(0, 0, 0, 0\)|transparent/, `the focused heading draws no ring (${ring})`);
  await page.waitForFunction(() => document.querySelector('[role="dialog"]').textContent.includes('8 connections'));
  const welcome = await dialogText();
  assert.match(welcome, /OpenSSH config.*8 connections/);
  assert.match(welcome, /FileZilla.*3 connections/);
  assert.doesNotMatch(welcome, /PuTTY.*connection|Take a quick tour|Practice/);
  await settled();
  await shot(page, 'get-connected');

  // Import goes straight to that source's tab and records the welcome as seen.
  const rows = await page.$$('[role="dialog"] li');
  await (await rows[0].$('button')).click();
  await page.waitForFunction(() => window.__demo.useLayout.getState().dialog === 'import');
  assert.equal(await page.evaluate(() => window.__demo.useLayout.getState().importTab), 'openssh');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('faro-mock-discovery')).discoverySeenVersion), '1.3.22');
  await page.keyboard.press('Escape');

  // 2. Still no connections: the remote pane offers the same two ways in.
  await load();
  assert.equal(await page.$('[role="dialog"]'), null, 'the welcome shows once');
  await page.waitForFunction(() => document.querySelector('[data-no-connections]')?.textContent.includes('Import 11 found'));
  await shot(page, 'no-connections');
  assert.doesNotMatch(await page.evaluate(() => document.body.textContent), /Pick a server in the left rail/, 'no contradictory pane message');
  // Browsing local files keeps the listing, with a strip above it.
  await page.evaluate(() => document.querySelector('[aria-label="Local files"]')?.click());
  await page.waitForFunction(() => document.querySelector('[data-no-connections]')?.className.includes('border-b'));
  await shot(page, 'no-connections-local');
  await click('New connection', '[data-no-connections]');
  await page.waitForFunction(() => window.__demo.useLayout.getState().dialog === 'newConnection');
  await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());

  // The welcome is replayable, and a protocol tile seeds the editor.
  await click('Help');
  await click('Welcome');
  await page.waitForSelector('[role="dialog"]');
  await click('S3-compatible', '[role="dialog"]');
  await page.waitForFunction(() => window.__demo.useLayout.getState().dialog === 'newConnection');
  assert.equal(await page.evaluate(() => window.__demo.useLayout.getState().connectionPrefill?.protocol), 's3');
  await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());

  // 3. A long-time user upgrading from a build that never recorded a version:
  // saved connections mean no beginner screen, just the quiet pill.
  await state({}, { 'faro-mock-fresh': null });
  await load();
  await page.waitForSelector('[data-update-notice]');
  assert.equal(await page.$('[role="dialog"]'), null, 'no welcome over existing connections');
  assert.match(await page.$eval('[data-update-notice]', e => e.textContent), /Updated to 1\.3\.22/);
  await page.click('[aria-label="Dismiss update notice"]');
  assert.equal(await page.$('[data-update-notice]'), null);
  await load();
  assert.equal(await page.$('[data-update-notice]'), null, 'dismissed stays dismissed');

  // 4. Patch update, offline, with the notes the updater cached before install.
  await state({ discoverySeenVersion: '1.3.21', 'discoveryReleaseNotes:1.3.22': JSON.stringify({ version: '1.3.22', notes: marked('Faster browsing', 'Faster file browsing with `ls` and **bold** and [a link](https://example.com)') }) });
  await load();
  await page.waitForSelector('[data-update-notice]');
  assert.equal(await page.$('[role="dialog"]'), null, 'a patch release never opens a dialog');
  await shot(page, 'update-pill');
  await page.click('[data-update-notice] button');
  await page.waitForSelector('[role="dialog"]');
  const patchNotes = await dialogText();
  assert.match(patchNotes, /Faster file browsing/);
  assert.doesNotMatch(patchNotes, /Desktop app|File \| Size|faro:changes|example\.com/, 'only the marked summary is shown');
  assert.equal(await page.$eval('[role="dialog"] code', e => e.textContent), 'ls');
  assert.equal(await page.$eval('[role="dialog"] strong', e => e.textContent), 'bold');
  assert.equal(await page.$('[role="dialog"] .space-y-2 a'), null, 'release prose never becomes a link');
  await click('Done', '[role="dialog"]');
  await load();
  assert.equal(await page.$('[data-update-notice]'), null, 'acknowledged once');

  // 5. A minor update after skipping versions: the notes open once, all of them.
  await state({ discoverySeenVersion: '1.2.9' }, { 'faro-mock-releases': JSON.stringify([
    { version: '1.3.22', notes: marked('Server view with Docker manager', 'A Server view for any SSH connection: live CPU, memory and network.', 'Docker containers with logs, stats and a one-click shell.') },
    { version: '1.3.5', notes: '## Faro v1.3.5\n\n### Desktop app\n| File | Size |' },
    { version: '1.3.0', notes: marked('Folder sync exclusions', 'Exclude patterns for folder sync.', 'Mirror-delete now asks first.') },
  ]) });
  await load();
  await page.waitForSelector('[role="dialog"]');
  const since = await dialogText();
  assert.match(since, /Everything since 1\.2\.9/);
  assert.match(since, /1\.3\.22 · installed.*Server view.*1\.3\.5.*No summary for this release.*1\.3\.0.*Folder sync exclusions/s);
  assert.doesNotMatch(since, /Desktop app/);
  await settled();
  await shot(page, 'whats-new-since');
  await click('Done', '[role="dialog"]');
  assert.equal(await page.$('[data-update-notice]'), null);

  // A minor update whose releases carry no summary falls back to the pill.
  await state({ discoverySeenVersion: '1.2.9' }, { 'faro-mock-releases': JSON.stringify([{ version: '1.3.22', notes: '## Faro v1.3.22' }]) });
  await load();
  await page.waitForSelector('[data-update-notice]');
  assert.equal(await page.$('[role="dialog"]'), null);

  // 6. Tips are for people starting out. Someone who already had connections
  // when tips first loaded never sees them.
  await state({ discoverySeenVersion: '1.3.22' }, { 'faro-mock-releases': null });
  await load();
  await page.evaluate(() => window.__demo.focusProfile('p-api'));
  await new Promise(r => setTimeout(r, 500));
  assert.equal(await page.$('[data-tip]'), null, 'a long-time user gets no beginner tips');

  // Someone who started fresh (tips record began empty): one at a time, once each.
  await state({ discoverySeenVersion: '1.3.22', discoveryTipsSeen: '[]' });
  await load();
  await page.evaluate(() => window.__demo.focusProfile('p-api'));
  await page.waitForSelector('[data-tip="first-connect"]');
  await shot(page, 'tip-first-connect');
  await page.click('[aria-label="Dismiss tip"]');
  await page.waitForSelector('[data-tip="first-ssh"]');
  await page.click('[aria-label="Dismiss tip"]');
  await page.waitForFunction(() => !document.querySelector('[data-tip]'));
  await page.evaluate(() => window.__demo.useTips.getState().trigger('first-transfer'));
  await page.waitForSelector('[data-tip="first-transfer"]');
  await page.click('[aria-label="Dismiss tip"]');
  await page.waitForFunction(() => !document.querySelector('[data-tip]'));
  await load();
  await page.evaluate(() => window.__demo.focusProfile('p-api'));
  await new Promise(r => setTimeout(r, 400));
  assert.equal(await page.$('[data-tip]'), null, 'seen tips stay gone after a restart');
  await page.evaluate(() => window.__demo.useTips.getState().reset());
  await page.waitForSelector('[data-tip="first-connect"]');
  await click('Turn off tips');
  await page.waitForFunction(() => !document.querySelector('[data-tip]'));
  await page.evaluate(() => window.__demo.useTips.getState().reset());

  // 7. Update chip: an unmarked release body falls back to the full-notes link.
  await page.evaluate(async () => {
    window.__mockUpdate = { version: '1.4.0', body: '## Faro v1.4.0\n\n### Desktop app\n| File | Size |\n> SmartScreen: click Run anyway' };
    await window.__demo.useUpdater.getState().check(false);
  });
  await page.waitForSelector('[data-update-chip]');
  await page.evaluate(() => { const store = window.__demo.useToasts.getState(); store.toasts.forEach(t => store.dismiss(t.id)); });
  await page.click('[data-update-chip]');
  await click("What's new");
  await page.waitForSelector('[aria-label="Update release notes"]');
  const updateNotes = await page.$eval('[aria-label="Update release notes"]', e => e.textContent);
  assert.match(updateNotes, /no summary in Faro/);
  assert.doesNotMatch(updateNotes, /Desktop app|SmartScreen|Size/);

  // 8. Narrow window: the welcome fits without sideways scrolling.
  await page.evaluate(() => window.__demo.useLayout.getState().openDialog('welcome'));
  await page.setViewport({ width: 520, height: 700 });
  await page.waitForSelector('[role="dialog"]');
  await settled();
  assert.ok(await page.$eval('[role="dialog"]', e => e.scrollWidth <= e.clientWidth));
  await shot(page, 'get-connected-narrow');
  assert.deepEqual(errors, []);
  console.log('Discovery UI passed: fresh install, detected imports, empty state, replay, upgrade without a record, patch pill, minor notes across skipped versions, tips, update-bar fallback, narrow layout.');
} finally { await browser.close(); await server?.close(); }
