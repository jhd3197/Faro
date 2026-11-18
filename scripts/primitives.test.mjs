// Shared UI primitives: Dialog Enter rules, Menu keyboard, Popover hiding with
// its trigger, Show more only on real overflow, and Select all that acts on
// the filtered rows. Runs against the mock build:
//   node --test scripts/primitives.test.mjs   (VITE_UI_LOCALE=en)
// Starts its own mock server unless FARO_TEST_URL points at one (e.g.
// `npx vite --mode mock --port 1439`); FARO_SHOTS sets the screenshot folder.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer-core';
import { createServer } from 'vite';

let URL = process.env.FARO_TEST_URL;
let server;
const SHOTS = process.env.FARO_SHOTS ?? join(process.cwd(), '.shots', 'bruno-lessons', 'primitives');
mkdirSync(SHOTS, { recursive: true });
const executablePath = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((p) => p && existsSync(p));

let browser, page;
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Let React commit the last keystroke (a slower machine lags a frame or two).
const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
const log = () => page.evaluate(() => [...window.__primitives.log]);
const active = () => page.evaluate(() => {
  const a = document.activeElement;
  return a?.dataset.bench ?? a?.getAttribute('aria-label') ?? a?.textContent?.trim() ?? a?.tagName;
});
const shot = (name) => page.screenshot({ path: join(SHOTS, `${name}.png`) });

async function boot() {
  for (let i = 0; i < 5; i++) {
    await page.goto(URL, { waitUntil: 'networkidle0' });
    try {
      await page.waitForFunction(() => window.__demo && window.__primitives, { timeout: 8000 });
      return;
    } catch { /* reload */ }
  }
  throw new Error('mock app never exposed window.__primitives');
}

before(async () => {
  if (!URL) {
    server = await createServer({ mode: 'mock', server: { host: '127.0.0.1', port: 0, strictPort: false } });
    await server.listen();
    URL = `http://127.0.0.1:${server.httpServer.address().port}/`;
  }
  browser = await puppeteer.launch({ executablePath, headless: true });
  page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1180, height: 760 });
  // The mock importers find hosts only when this flag is set.
  await page.evaluateOnNewDocument(() => sessionStorage.setItem('faro-mock-found', '1'));
  await boot();
});

after(async () => {
  await browser?.close();
  await server?.close();
});

// ── Dialog ────────────────────────────────────────────────────────────────
async function openDialog(opts = {}) {
  await page.evaluate((o) => window.__primitives.dialog(o), opts);
  await page.waitForSelector('[data-testid="bench-dialog"]');
  await page.waitForFunction(() => document.activeElement?.dataset.bench === 'name');
}

test('Dialog: bare Enter in a field confirms and reports why it closed', async () => {
  await openDialog();
  await page.keyboard.press('Enter');
  assert.deepEqual(await log(), ['confirm', 'close:confirm']);
});

test('Dialog: Enter with a modifier does nothing', async () => {
  for (const mod of ['Shift', 'Control', 'Alt']) {
    await openDialog();
    await page.keyboard.down(mod);
    await page.keyboard.press('Enter');
    await page.keyboard.up(mod);
    assert.deepEqual(await log(), [], `${mod}+Enter`);
  }
});

test('Dialog: Enter on a focused button is that button, not confirm', async () => {
  await openDialog();
  await page.keyboard.press('Tab'); // → Cancel (the header × comes first in DOM, Tab from the field lands past it)
  const focused = await active();
  await page.keyboard.press('Enter');
  const l = await log();
  assert.ok(!l.includes('confirm'), `Enter on "${focused}" must not confirm (${l})`);
  assert.equal(l.length, 1);
  assert.match(l[0], /^close:(cancel|close-button)$/);
});

test('Dialog: disabled confirm, textarea and IME composition never confirm', async () => {
  await openDialog({ confirmDisabled: true });
  await page.keyboard.press('Enter');
  assert.deepEqual(await log(), []);

  await openDialog({ textarea: true });
  await page.focus('[data-bench="notes"]');
  await page.keyboard.press('Enter');
  assert.deepEqual(await log(), []);

  await openDialog();
  await page.evaluate(() => {
    document.querySelector('[data-bench="name"]').dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true })
    );
  });
  assert.deepEqual(await log(), []);
});

test('Dialog: Esc and the header × report their reason; × keeps the field focused on press', async () => {
  await openDialog();
  await page.keyboard.press('Escape');
  assert.deepEqual(await log(), ['close:escape']);

  await openDialog();
  const x = await page.$('[data-testid="bench-dialog"] button[aria-label="Close"]');
  const box = await x.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  assert.equal(await active(), 'name', 'mousedown on × does not blur the input');
  await page.mouse.up();
  assert.deepEqual(await log(), ['close:close-button']);
});

test('Dialog: screenshot', async () => {
  await openDialog();
  await sleep(250);
  await shot('dialog-bench');
  await page.keyboard.press('Escape');
});

// ── Menu ──────────────────────────────────────────────────────────────────
const activeOption = () => page.evaluate(() => document.querySelector('[data-menu] [role="option"][data-active]')?.textContent);

test('Menu: opens on the current choice; arrows wrap and skip disabled; Home/End', async () => {
  await page.evaluate(() => window.__primitives.menu({ value: 'staging' }));
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'listbox');
  assert.match(await activeOption(), /^staging/);
  const press = async (k, want) => {
    await page.keyboard.press(k);
    assert.match(await activeOption(), want, k);
  };
  await press('ArrowDown', /^build-runner/);
  await press('ArrowDown', /^web-1/); // wraps
  await press('ArrowUp', /^build-runner/); // wraps back
  await press('Home', /^web-1/);
  await press('ArrowDown', /^web-2/);
  await press('ArrowDown', /^staging/); // skips the disabled db-primary
  await press('ArrowUp', /^web-2/);
  await press('End', /^build-runner/);
  await press('s', /^staging/); // typeahead
  await page.keyboard.press('Enter');
  await page.keyboard.press(' ');
  await page.keyboard.press('Escape');
  assert.deepEqual(await log(), ['select:staging', 'select:staging', 'close']);
  // The current choice carries the tick.
  const ticked = await page.$$eval('[data-menu] [role="option"][aria-selected="true"] svg', (s) => s.length);
  assert.equal(ticked, 1);
});

test('Menu: search filters (terms ANDed) and typing from the list goes into it', async () => {
  await page.evaluate(() => window.__primitives.menu({ searchable: true, value: 'web-2' }));
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
  assert.match(await activeOption(), /^web-2/);
  await page.keyboard.type('stag');
  await frames();
  let labels = await page.$$eval('[data-menu] [role="option"]', (o) => o.map((e) => e.textContent));
  assert.deepEqual(labels.map((l) => l.replace(/10\..*/, '')), ['staging']);
  await page.keyboard.press('Enter');
  assert.deepEqual(await log(), ['select:staging']);
  // Type-to-search from the list itself.
  await page.evaluate(() => window.__primitives.menu({ searchable: true }));
  await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'combobox');
  await page.focus('[data-menu] [role="listbox"]');
  await page.keyboard.type('bu');
  assert.equal(await page.$eval('[role="combobox"]', (i) => i.value), 'bu');
  labels = await page.$$eval('[data-menu] [role="option"]', (o) => o.length);
  assert.equal(labels, 1);
  // Groups are labelled.
  await page.evaluate(() => window.__primitives.menu({ searchable: true, value: 'staging' }));
  const text = await page.$eval('[data-menu]', (m) => m.textContent);
  assert.match(text, /Production.*Staging/);
  await sleep(150);
  await shot('menu-search-check');
});

test('Dropdown: matches trigger width, Esc closes only the menu and refocuses the button', async () => {
  await page.evaluate(() => window.__primitives.dropdown());
  await page.click('[data-dropdown]');
  await page.waitForSelector('[data-popover] [role="listbox"]');
  await sleep(50);
  const [bw, pw] = await page.evaluate(() => [
    document.querySelector('[data-dropdown]').getBoundingClientRect().width,
    document.querySelector('[data-popover]').getBoundingClientRect().width,
  ]);
  assert.ok(Math.abs(bw - pw) < 1, `popover ${pw} vs trigger ${bw}`);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.deepEqual(await log(), ['change:build']);
  assert.equal(await page.$('[data-popover]'), null);
  await page.click('[data-dropdown]');
  await page.waitForSelector('[data-popover]');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('[data-popover]'), null);
  assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-dropdown')), true);
});

// ── Popover ───────────────────────────────────────────────────────────────
test('Popover: matches trigger width and hides while the trigger is scrolled away', async () => {
  await page.evaluate(() => window.__primitives.popover());
  await page.waitForSelector('[data-popover]');
  await sleep(50);
  const vis = () => page.$eval('[data-popover]', (p) => getComputedStyle(p).visibility);
  assert.equal(await vis(), 'visible');
  const [aw, pw] = await page.evaluate(() => [
    document.querySelector('[data-bench="anchor"]').getBoundingClientRect().width,
    document.querySelector('[data-popover]').getBoundingClientRect().width,
  ]);
  assert.ok(Math.abs(aw - pw) < 1);
  await page.$eval('[data-bench="scroller"]', (s) => s.scrollTo(0, 300));
  await page.waitForFunction(() => document.querySelector('[data-popover]')?.hasAttribute('data-clipped'));
  assert.equal(await vis(), 'hidden');
  await page.$eval('[data-bench="scroller"]', (s) => s.scrollTo(0, 0));
  await page.waitForFunction(() => !document.querySelector('[data-popover]')?.hasAttribute('data-clipped'));
  assert.equal(await vis(), 'visible');
  await page.keyboard.press('Escape');
  assert.deepEqual(await log(), ['close:escape']);
});

// ── ShowMore ──────────────────────────────────────────────────────────────
test('ShowMore: no toggle for text that fits, toggle only when it really overflows', async () => {
  await page.evaluate(() => window.__primitives.showMore('Connection refused (os error 10061)'));
  await page.waitForSelector('[data-show-more]');
  assert.equal(await page.$eval('[data-show-more]', (e) => e.dataset.showMore), 'plain');
  assert.equal(await page.$('#primitives-bench button'), null);

  // Exactly three lines at this width still fits: no toggle.
  await page.evaluate(() => window.__primitives.showMore('one\ntwo\nthree'));
  await page.waitForSelector('[data-show-more]');
  assert.equal(await page.$('#primitives-bench button'), null, 'three lines fit in three');

  const long = 'ssh: handshake failed: no matching host key type found. Their offer: ssh-rsa,ssh-dss\n'
    + 'Tried: /home/dev/.ssh/id_ed25519, /home/dev/.ssh/id_rsa, agent (2 keys)\n'
    + 'Server said: Permission denied (publickey,password).\n'
    + 'Check the key, the user name, and that the server allows this key type.';
  await page.evaluate((t) => window.__primitives.showMore(t), long);
  await page.waitForSelector('#primitives-bench button');
  assert.equal(await page.$eval('[data-show-more]', (e) => e.dataset.showMore), 'clamped');
  const [h, lh] = await page.$eval('[data-show-more]', (e) => [e.clientHeight, parseFloat(getComputedStyle(e).lineHeight)]);
  assert.ok(Math.abs(h - lh * 3) < 2, `clamped to 3 lines (${h} vs ${lh * 3})`);
  await shot('show-more-collapsed');
  await page.click('#primitives-bench button');
  assert.equal(await page.$eval('[data-show-more]', (e) => e.dataset.showMore), 'expanded');
  assert.equal(await page.$eval('#primitives-bench button', (b) => b.textContent), 'Show less');
  await shot('show-more-expanded');
});

// ── Select all ────────────────────────────────────────────────────────────
test('SelectAll: acts on filtered rows only, mixed when partly ticked', async () => {
  await page.evaluate(() => window.__primitives.selectAll());
  await page.waitForSelector('[data-select-all]');
  const state = () => page.$eval('[data-select-all]', (c) => [c.dataset.selectAll, c.indeterminate, c.checked]);
  assert.deepEqual(await state(), ['some', true, false]);
  await page.type('[data-bench="filter"]', 'web');
  assert.deepEqual(await state(), ['none', false, false]);
  await page.click('[data-select-all]');
  assert.deepEqual(await page.evaluate(() => window.__primitives.selection()), ['db-primary', 'web-1', 'web-2']);
  assert.deepEqual(await state(), ['all', false, true]);
  await page.click('[data-select-all]'); // untick only what's shown
  assert.deepEqual(await page.evaluate(() => window.__primitives.selection()), ['db-primary']);
  await page.click('[data-bench="filter"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  assert.deepEqual(await state(), ['some', true, false]);
  await page.evaluate(() => window.__primitives.unmount());
});

// ── Real call sites ───────────────────────────────────────────────────────
test('Import dialog: filter + Select all shown, indeterminate header', async () => {
  await page.evaluate(() => window.__demo.useLayout.getState().openImport(undefined, 'openssh'));
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="import-row"]').length === 8);
  const head = () => page.$eval('[role="dialog"] [data-select-all]', (c) => [c.dataset.selectAll, c.indeterminate]);
  assert.deepEqual(await head(), ['all', false]);
  await page.type('[aria-label="Filter connections"]', 'web');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="import-row"]').length === 2);
  await page.click('[role="dialog"] [data-select-all]'); // untick the two shown
  assert.match(await page.$eval('[data-testid="import-count"]', (e) => e.textContent), /6 of 8 selected/);
  await page.click('[aria-label="Filter connections"]', { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="import-row"]').length === 8);
  assert.deepEqual(await head(), ['some', true]);
  await sleep(200);
  await shot('import-select-all-indeterminate');
  // Esc in a non-empty filter clears it and leaves the dialog open.
  await page.type('[aria-label="Filter connections"]', 'db');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('[aria-label="Filter connections"]', (i) => i.value), '');
  assert.equal(await page.evaluate(() => window.__demo.useLayout.getState().dialog), 'import');
  await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
});

test('Settings: terminal font is a searchable Dropdown with a tick on the choice', async () => {
  await page.evaluate(() => window.__demo.useLayout.getState().openSettings?.('terminal'));
  const btn = await page.waitForSelector('[data-dropdown][aria-label="Terminal font"]', { timeout: 5000 });
  await btn.evaluate((b) => b.scrollIntoView({ block: 'center' }));
  await btn.click();
  await page.waitForSelector('[data-popover] [role="combobox"]');
  // Focus moves into the search box after the popover mounts.
  await page.waitForFunction(() => document.activeElement?.matches('[data-popover] [role="combobox"]'));
  await page.keyboard.type('code');
  const opts = await page.$$eval('[data-popover] [role="option"]', (o) => o.map((e) => e.textContent));
  assert.deepEqual(opts, ['Fira Code', 'Cascadia Code']);
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await sleep(150);
  await shot('settings-font-dropdown');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('[data-popover]'), null, 'Esc closed the menu');
  assert.ok(await page.$('[data-dropdown][aria-label="Terminal font"]'), 'Settings stayed open');
});

test('ConfirmModal on the shared Dialog: delete a connection', async () => {
  await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
  await page.keyboard.press('Escape');
  const id = await page.evaluate(() => window.__demo.useConnections.getState().profiles[0].id);
  await page.click(`[data-rail-profile-id="${id}"]`, { button: 'right' });
  const del = await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="menuitem"]')].find((b) => /^Delete/.test(b.textContent.trim())));
  await del.asElement().click();
  await page.waitForSelector('[data-testid="confirm-dialog"]');
  // Focus starts on Cancel, so Enter there cancels rather than deletes.
  await page.waitForFunction(() => document.activeElement?.textContent === 'Cancel');
  const confirm = await page.$eval('[data-testid="confirm-dialog"] [data-dialog-confirm]', (b) => [b.textContent, b.className.includes('bg-danger')]);
  assert.equal(confirm[1], true, 'delete confirm is red');
  await sleep(250);
  await shot('confirm-dialog-delete');
  const before = await page.evaluate(() => window.__demo.useConnections.getState().profiles.length);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.querySelector('[data-testid="confirm-dialog"]'));
  assert.equal(await page.evaluate(() => window.__demo.useConnections.getState().profiles.length), before);
});

test('Connection check: a long failure is clamped with Show more', async () => {
  await page.evaluate(() => (window.__diag = 'long'));
  const id = await page.evaluate(() => window.__demo.useConnections.getState().profiles.find((p) => p.protocol === 'sftp' && !p.proxyCommand)?.id);
  await page.click(`[data-rail-profile-id="${id}"]`, { button: 'right' });
  const item = await page.waitForFunction(() =>
    [...document.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.trim().startsWith('Test connection')));
  await item.asElement().click();
  await page.waitForSelector('[data-testid="connection-check"] [data-show-more="clamped"]', { timeout: 8000 });
  const btn = await page.$('[data-testid="connection-check"] [data-show-more] + button');
  assert.equal(await btn.evaluate((b) => b.textContent), 'Show more');
  await sleep(200);
  await shot('show-more-connection-check');
  await btn.click();
  assert.ok(await page.$('[data-testid="connection-check"] [data-show-more="expanded"]'));
  await shot('show-more-connection-check-expanded');
  await page.evaluate(() => { window.__diag = undefined; });
  await page.keyboard.press('Escape');
});

test('Status bar: notifications popover sits above its pill, closes on Esc and outside click', async () => {
  const pill = await page.$('button[title="Notifications"]');
  await pill.click();
  await page.waitForSelector('[data-popover]');
  await sleep(80);
  const [pop, pin] = await page.evaluate(() => [
    document.querySelector('[data-popover]').getBoundingClientRect().toJSON(),
    document.querySelector('button[title="Notifications"]').getBoundingClientRect().toJSON(),
  ]);
  assert.ok(pop.bottom <= pin.top, 'opens above the status bar');
  assert.ok(pop.right >= pin.right - 1 && pop.right - pin.right < 40, 'right-aligned to the pill');
  await page.keyboard.press('Escape');
  assert.equal(await page.$('[data-popover]'), null);
  await pill.click();
  await page.waitForSelector('[data-popover]');
  await page.mouse.click(600, 300);
  assert.equal(await page.$('[data-popover]'), null);
});

test('no page errors', () => {
  assert.deepEqual(errors, []);
});
