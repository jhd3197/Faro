import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

// Splitters and panels: persisted sizes, drag-to-collapse with hysteresis,
// labelled strips, the 3px dead zone, re-clamping on shrink, and resizable
// file-list columns. Set LAYOUT_SHOTS=<dir> to save screenshots.
const SHOTS = process.env.LAYOUT_SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

test('resizable panels, collapse strips and file-list columns', { timeout: 180000 }, async (t) => {
  const executablePath = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find(p => p && existsSync(p));
  assert.ok(executablePath, 'Install Chrome/Chromium or set CHROME_PATH');
  const server = await createServer({ mode: 'mock', server: { host: '127.0.0.1', port: Number(process.env.LAYOUT_PORT || 0), strictPort: false, hmr: false, watch: { ignored: ['**/*'] } } });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1440, height: 900 } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const url = `http://127.0.0.1:${server.httpServer.address().port}/`;
    const boot = async () => {
      for (let i = 0; i < 5; i++) {
        try {
          await page.waitForFunction(() => window.__demo?.useConnections.getState().activeSessionId
            && window.__demo.usePanelSizes.getState().ready, { timeout: 15000 });
          return;
        } catch { await page.reload(); }
      }
      throw Error('mock app did not boot');
    };
    await page.goto(url);
    await boot();
    const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const shot = async name => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
    const panels = () => page.evaluate(() => window.__demo.usePanelSizes.getState().panels);
    const rect = sel => page.$eval(sel, e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });

    const SPLIT = '[role="separator"][aria-label="Resize file browser panes"]';
    const container = () => page.$eval(SPLIT, el => {
      const r = el.parentElement.parentElement.getBoundingClientRect();
      return { x: r.x, w: r.width, y: r.y + 120 };
    });
    const handleX = async sel => { const r = await rect(sel); return r.x + r.w / 2; };

    await t.test('dual-pane: dead zone, collapse with hysteresis, strip expands', async () => {
      await page.evaluate(() => window.__demo.useSettings.getState().setBrowserLayout('dual'));
      await page.waitForSelector(SPLIT);
      await settle();
      const c = await container();
      const ratio = () => page.evaluate(() => window.__demo.useSession.getState().snapshot.splitRatio);
      const before = await ratio();

      // 2px wiggle is not a drag.
      let hx = await handleX(SPLIT);
      await page.mouse.move(hx, c.y);
      await page.mouse.down();
      await page.mouse.move(hx + 2, c.y);
      await page.mouse.up();
      await settle();
      assert.equal(await ratio(), before, 'moves under 3px must not resize');

      // Drag into the left edge: collapses at < 80px, stays shut at 90px,
      // reopens past 100px.
      await page.mouse.move(hx, c.y);
      await page.mouse.down();
      await page.mouse.move(c.x + 40, c.y, { steps: 8 });
      await settle();
      assert.ok(await page.$('[data-collapsed-strip="Local"]'), 'local collapses near its edge');
      await page.mouse.move(c.x + 90, c.y, { steps: 3 });
      await settle();
      assert.ok(await page.$('[data-collapsed-strip="Local"]'), 'hysteresis: 90px is not enough to reopen');
      await page.mouse.move(c.x + 400, c.y, { steps: 6 });
      await settle();
      assert.equal(await page.$('[data-collapsed-strip="Local"]'), null, 'reopens past 100px');
      await page.mouse.move(c.x + 25, c.y, { steps: 8 });
      await page.mouse.up();
      await wait(250);
      assert.equal((await panels())['dual.local']?.collapsed, true, 'collapsed state persists');
      const strip = await rect('[data-collapsed-strip="Local"]');
      assert.ok(strip.w <= 26, `strip is thin (${strip.w}px)`);
      await shot('collapsed-local-strip');

      // Enter on the strip expands to the remembered ratio.
      const remembered = await ratio();
      await page.focus('[data-collapsed-strip="Local"]');
      await page.keyboard.press('Enter');
      await wait(250);
      assert.equal(await page.$('[data-collapsed-strip="Local"]'), null);
      assert.equal(await ratio(), remembered);

      // Collapse the remote side, then click its strip.
      hx = await handleX(SPLIT);
      await page.mouse.move(hx, c.y);
      await page.mouse.down();
      await page.mouse.move(c.x + c.w - 30, c.y, { steps: 10 });
      await page.mouse.up();
      await wait(250);
      assert.ok(await page.$('[data-collapsed-strip="Remote"]'), 'remote collapses near the right edge');
      await shot('collapsed-remote-strip');
      // Dragging the strip resizes (reopens at the drop point).
      const rs = await rect('[data-collapsed-strip="Remote"]');
      await page.mouse.move(rs.x + rs.w / 2, c.y);
      await page.mouse.down();
      await page.mouse.move(c.x + c.w * 0.6, c.y, { steps: 10 });
      await page.mouse.up();
      await wait(250);
      assert.equal(await page.$('[data-collapsed-strip="Remote"]'), null, 'dragging the strip reopens it');
      assert.ok(Math.abs(await ratio() - 0.6) < 0.03, 'strip drag sets the split');
      // Double-click the divider (above the Sync button) to reset.
      await page.mouse.click(await handleX(SPLIT), c.y, { clickCount: 2 });
      await wait(300); // let the expand animation finish
      assert.equal(await ratio(), 0.5);
    });

    await t.test('file-list columns: drag only the neighbour, min width, reset, persisted', async () => {
      await page.evaluate(() => window.__demo.useSettings.getState().setPaneViewMode('details'));
      const H = '[role="separator"][aria-label="Resize Name column"]';
      await page.waitForSelector(H);
      const header = () => page.$eval(H, el => [...el.parentElement.parentElement.children]
        .map(c => ({ id: c.dataset.col, w: c.getBoundingClientRect().width })));
      const h0 = await header();
      const nameH = await rect(H);
      const y = nameH.y + nameH.h / 2;
      await page.mouse.move(nameH.x + nameH.w / 2, y);
      await page.mouse.down();
      await page.mouse.move(nameH.x + nameH.w / 2 - 60, y, { steps: 8 });
      await settle();
      await shot('column-drag-mid-resize');
      await page.mouse.up();
      await wait(350);
      const h1 = await header();
      const w = id => list => list.find(c => c.id === id).w;
      assert.ok(Math.abs(w('name')(h1) - (w('name')(h0) - 60)) < 3, `name shrinks by the drag ${JSON.stringify(h0)} -> ${JSON.stringify(h1)}`);
      assert.ok(Math.abs(w('modified')(h1) - (w('modified')(h0) + 60)) < 3, 'neighbour grows');
      assert.ok(Math.abs(w('size')(h1) - w('size')(h0)) < 1.5, 'other columns stay put');
      const cols = await page.evaluate(() => window.__demo.usePanelSizes.getState().columns);
      assert.ok(cols && cols.name > 0 && cols.name < 100, 'stored as percentages');
      // Rows follow the header.
      const rowCols = await page.$eval('[data-idx]', r => getComputedStyle(r).gridTemplateColumns);
      assert.ok(rowCols.split(' ').length >= 3, 'rows share the template');

      // Can't drag below the minimum.
      const n2 = await rect(H);
      await page.mouse.move(n2.x + n2.w / 2, y);
      await page.mouse.down();
      await page.mouse.move(n2.x - 600, y, { steps: 8 });
      await page.mouse.up();
      await settle();
      assert.ok(w('name')(await header()) >= 95, 'name keeps its minimum width');

      // Double-click resets to the built-in layout.
      const n3 = await rect(H);
      await page.mouse.click(n3.x + n3.w / 2, y, { clickCount: 2 });
      await settle();
      assert.equal(await page.evaluate(() => window.__demo.usePanelSizes.getState().columns), null);
      assert.ok(Math.abs(w('size')(await header()) - w('size')(h0)) < 1.5, 'reset restores the default layout');

      // Narrow panes still hide columns.
      await page.evaluate(() => window.__demo.useSession.getState().setSplitRatio(0.2));
      await settle();
      await wait(250);
      const narrowIds = (await page.$$eval('[data-col]', els => els.map(e => e.dataset.col)));
      assert.ok(narrowIds.filter(id => id === 'modified').length < 2, 'narrow tier still drops Modified in the small pane');
      await page.evaluate(() => window.__demo.useSession.getState().setSplitRatio(0.5));

      // Set widths again for the persistence check.
      const n4 = await rect(H);
      await page.mouse.move(n4.x + n4.w / 2, y);
      await page.mouse.down();
      await page.mouse.move(n4.x + n4.w / 2 - 40, y, { steps: 6 });
      await page.mouse.up();
      await wait(400);
    });

    await t.test('preview panel: resize, collapse to strip, re-clamp, persist', async () => {
      await page.evaluate(() => {
        const s = window.__demo.useSettings.getState();
        s.setBrowserLayout('single');
        s.setFilePreview(true);
      });
      await settle();
      // Select a file row.
      for (const row of await page.$$('[data-idx]')) {
        await row.click();
        await settle();
        if (await page.$('[data-panel="preview"]')) break;
      }
      const P = '[data-panel="preview"]';
      await page.waitForSelector(P);
      const PH = '[role="separator"][aria-label="Resize Preview"]';
      const p0 = await rect(P);
      const hr = await rect(PH);
      await page.mouse.move(hr.x + hr.w / 2, hr.y + 200);
      await page.mouse.down();
      await page.mouse.move(hr.x + hr.w / 2 - 120, hr.y + 200, { steps: 10 });
      await page.mouse.up();
      await wait(400);
      const p1 = await rect(P);
      assert.ok(Math.abs(p1.w - (p0.w + 120)) < 3, `preview grows with the drag (${p0.w} -> ${p1.w})`);
      assert.equal(Math.round((await panels()).preview.size), Math.round(p1.w));
      await shot('preview-resized');

      // Re-clamp when the window shrinks; the stored size is kept.
      await page.setViewport({ width: 900, height: 700 });
      await wait(400);
      const small = await rect(P);
      const area = await page.$eval(P, e => e.parentElement.getBoundingClientRect().width);
      assert.ok(small.w <= area * 0.6 + 1, 'preview re-clamped to the smaller window');
      await page.setViewport({ width: 1440, height: 900 });
      await wait(400);
      assert.ok(Math.abs((await rect(P)).w - p1.w) < 2, 'stored size returns when the window grows back');

      // Drag the handle to the right edge: collapses into a "Preview" strip.
      const h2 = await rect(PH);
      await page.mouse.move(h2.x + h2.w / 2, h2.y + 200);
      await page.mouse.down();
      await page.mouse.move(h2.x + p1.w - 20, h2.y + 200, { steps: 12 });
      await page.mouse.up();
      await wait(400);
      assert.ok(await page.$('[data-collapsed-strip="Preview"]'), 'preview collapses to a strip');
      assert.equal((await panels()).preview.collapsed, true);
      await shot('preview-collapsed-strip');
      await page.click('[data-collapsed-strip="Preview"]');
      await wait(400);
      assert.ok(Math.abs((await rect(P)).w - p1.w) < 2, 'click reopens at the remembered size');
    });

    await t.test('docks: terminal, console, agent drawer and transfers resize and persist', async () => {
      await page.setViewport({ width: 1440, height: 1300 });
      await page.evaluate(() => {
        const l = window.__demo.useLayout.getState();
        l.setTerminalOpen(true);
        l.setConsoleOpen(true);
        l.setAgentDrawerOpen(true);
        window.__demo.useTransfers.getState().setPanelOpen(true);
      });
      await wait(400);
      const drag = async (id, label, dx, dy) => {
        const H = `[data-panel="${id}"] > [role="separator"][aria-label="Resize ${label}"]`;
        await page.waitForSelector(H);
        const before = await rect(`[data-panel="${id}"]`);
        const h = await rect(H);
        const y = dx ? h.y + 30 : h.y + h.h / 2;
        await page.mouse.move(h.x + h.w / 2, y);
        await page.mouse.down();
        await page.mouse.move(h.x + h.w / 2 + dx, y + dy, { steps: 8 });
        await page.mouse.up();
        await wait(350);
        return { before, after: await rect(`[data-panel="${id}"]`) };
      };
      let r = await drag('terminal', 'Terminal', 0, -60);
      assert.ok(Math.abs(r.after.h - (r.before.h + 60)) < 3, `terminal grows (${r.before.h} -> ${r.after.h})`);
      r = await drag('console', 'Agent console', 0, -40);
      assert.ok(Math.abs(r.after.h - (r.before.h + 40)) < 3, `console grows (${r.before.h} -> ${r.after.h})`);
      r = await drag('agentDrawer', 'Agent', -80, 0);
      assert.ok(Math.abs(r.after.w - (r.before.w + 80)) < 3, `agent drawer grows (${r.before.w} -> ${r.after.w})`);
      r = await drag('transfers', 'Transfers', 0, 40);
      assert.ok(r.after.h <= r.before.h, 'transfers panel shrinks');
      const p = await panels();
      for (const id of ['terminal', 'console', 'agentDrawer', 'transfers']) assert.ok(p[id]?.size > 0, `${id} size stored`);
      // Terminal collapses to a strip but stays mounted.
      const th = await rect('[data-panel="terminal"] > [role="separator"]');
      const tp = await rect('[data-panel="terminal"]');
      await page.mouse.move(th.x + 200, th.y + th.h / 2);
      await page.mouse.down();
      await page.mouse.move(th.x + 200, tp.y + tp.h - 10, { steps: 12 });
      await page.mouse.up();
      await wait(350);
      assert.ok(await page.$('[data-collapsed-strip="Terminal"]'), 'terminal collapses to a strip');
      await shot('docks-terminal-collapsed');
      await page.click('[data-collapsed-strip="Terminal"]');
      await wait(350);
      await shot('docks-resized');
      await page.evaluate(() => {
        const l = window.__demo.useLayout.getState();
        l.setTerminalOpen(false);
        l.setConsoleOpen(false);
        l.setAgentDrawerOpen(false);
        window.__demo.useTransfers.getState().setPanelOpen(false);
      });
      await page.setViewport({ width: 1440, height: 900 });
    });

    await t.test('sizes survive a reload and render at the saved size', async () => {
      const saved = await page.evaluate(() => {
        window.__demo.usePanelSizes.getState().flush();
        return window.__demo.usePanelSizes.getState();
      });
      await wait(200);
      await page.reload();
      await boot();
      await page.evaluate(() => window.__demo.useSettings.getState().setBrowserLayout('single'));
      const after = await page.evaluate(() => window.__demo.usePanelSizes.getState());
      assert.equal(after.panels.preview?.size, saved.panels.preview.size);
      assert.deepEqual(after.columns, saved.columns);
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
