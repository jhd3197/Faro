import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

// The docked agent panel stands in for the approval modal only while it is
// actually visible, and its access control never jumps from Off to Auto.
test('agent drawer approvals and access keys', { timeout: 90000 }, async (t) => {
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
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'], defaultViewport: { width: 1400, height: 900 } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.__demo?.useBridge);
    const flush = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const modalOpen = () => page.evaluate(() =>
      [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
        .some(d => /Agent wants to/.test(d.textContent)));

    // The app's AgentBridgeHost boots the store and its approval listener.
    await page.waitForFunction(() => window.__demo.useBridge.getState().loaded);
    await new Promise(r => setTimeout(r, 300));
    await page.evaluate(() => window.__demo.useLayout.getState().setAgentDrawerOpen(true));
    await page.evaluate(() => window.__demo.emit('bridge://approval', {
      requestId: 'r1', sessionId: 's1', sessionName: 'prod', kind: 'exec', command: 'rm -rf /tmp/x',
    }));
    await page.waitForFunction(() => window.__demo.useBridge.getState().approvals.length === 1);
    await flush();

    await t.test('drawer open, nothing covering it: no duplicate modal', async () => {
      assert.equal(await modalOpen(), false);
    });

    await t.test('a dialog over the drawer brings the approval modal back', async () => {
      await page.evaluate(() => window.__demo.useLayout.getState().openDialog('settings'));
      await flush();
      assert.equal(await modalOpen(), true, 'approval must stay reachable under Settings');
      await page.evaluate(() => window.__demo.useLayout.getState().closeDialog());
      await flush();
      assert.equal(await modalOpen(), false);
    });

    await t.test('arrow keys on Off never wrap to Auto', async () => {
      const group = '[role="radiogroup"][aria-label^="Run commands on"]';
      const hasGroup = await page.evaluate(async (sel) => {
        const { useConnections } = window.__demo;
        const p = useConnections.getState().profiles.find(p => p.protocol === 'sftp' || p.protocol === 'ssh');
        if (p) await useConnections.getState().connect(p.id);
        await new Promise(r => setTimeout(r, 300));
        return !!document.querySelector(sel);
      }, group);
      if (!hasGroup) return t.skip('no SSH profile in the mock world');
      const level = () => page.$eval(`${group} [aria-checked="true"]`, b => b.textContent.trim());
      // Put it on Off, then press ← on the Off button.
      await page.$$eval(`${group} button`, bs => bs.find(b => b.textContent.trim() === 'Off').click());
      await flush();
      assert.equal(await level(), 'Off');
      await page.focus(`${group} [aria-checked="true"]`);
      await page.keyboard.press('ArrowLeft');
      await flush();
      assert.equal(await level(), 'Off', '← on Off stays Off');
      await page.keyboard.press('ArrowRight');
      await flush();
      assert.equal(await level(), 'Ask', '→ still steps up one level');
    });

    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await server.close();
  }
});
