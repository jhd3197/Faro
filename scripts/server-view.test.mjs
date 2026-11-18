// Server view (Plan 30) against the mock backend: the charts move, tabs follow
// the host probe, the sampler runs only while Overview is showing, and service
// actions go through their confirmations with the right elevation.
//
//   node --test scripts/server-view.test.mjs
//
// Set SERVER_VIEW_SHOTS=<dir> to also save a screenshot of each tab.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

test('Server view: live charts, probe-driven tabs, sampler lifecycle, confirmed actions', { timeout: 180000 }, async () => {
  const executablePath = [process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find(p => p && existsSync(p));
  assert.ok(executablePath);
  const shots = process.env.SERVER_VIEW_SHOTS;
  const server = await createServer({ mode: 'mock', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({ executablePath, headless: true, defaultViewport: { width: 1440, height: 900 } });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.__demo?.useConnections.getState().activeSessionId);

    const view = () => page.evaluate(() => {
      const s = window.__demo.useServerView.getState();
      return { open: s.open, tab: s.tab, samples: s.samples.length, sampler: s.sampler, sessionId: s.sessionId };
    });
    const calls = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__demo.sysmonCalls)));
    const clickText = async (selector, text) => {
      const ok = await page.evaluate((selector, text) => {
        const el = [...document.querySelectorAll(selector)].find(e => e.textContent.trim() === text);
        el?.click();
        return !!el;
      }, selector, text);
      assert.ok(ok, `no ${selector} with text "${text}"`);
    };
    const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `server-${name}.png`) }); };
    const panelText = () => page.$eval('[role="tabpanel"]', el => el.innerText);

    // --- Open from the status bar; charts fill in.
    await clickText('button', 'Server');
    await page.waitForSelector('[role="tablist"][aria-label="Server view"]');
    const tabs = await page.$$eval('[role="tab"]', els => els.map(e => e.textContent.trim()));
    assert.deepEqual(tabs, ['Overview', 'Services', 'Ports', 'Firewall', 'Docker']);
    await page.waitForFunction(() => window.__demo.useServerView.getState().samples.length >= 6);
    assert.equal((await calls()).start, 1, 'one sampler for the view');
    let text = await panelText();
    assert.match(text, /CPU\s+\d+\.\d%/, 'CPU shows a percentage');
    assert.match(text, /of 8\.00 GB/, 'memory shows the total');
    assert.match(text, /\/var\/lib\/postgresql/, 'filesystems table is filled');
    const paths = await page.$$eval('[role="tabpanel"] svg[role="img"] path[stroke]', els => els.map(e => e.getAttribute('d').length));
    assert.ok(paths.length >= 4 && paths.every(n => n > 20), 'each chart has a drawn line');
    const before = (await view()).samples;
    await page.waitForFunction(n => window.__demo.useServerView.getState().samples.length > n, {}, before);
    await shot('overview');

    // --- Leaving Overview stops the sampler; Services lists failed first.
    await clickText('[role="tab"]', 'Services');
    await page.waitForFunction(() => document.querySelector('[role="tabpanel"] tbody tr td')?.textContent.includes('backup.service'));
    assert.equal((await calls()).stop, 1, 'sampler stops when Overview is hidden');
    const frozen = (await view()).samples;
    await new Promise(r => setTimeout(r, 700));
    assert.equal((await view()).samples, frozen, 'no samples arrive while another tab shows');
    assert.match(await panelText(), /Failed \(1\)/);
    await shot('services');

    // --- Restart asks first and shows the exact command.
    await page.click('button[aria-label="Restart nginx.service"]');
    await page.waitForSelector('[role="dialog"]');
    const dialog = await page.$eval('[role="dialog"]', el => el.innerText);
    assert.match(dialog, /Restart nginx\.service\?/);
    assert.match(dialog, /sudo systemctl restart nginx\.service/);
    assert.equal((await calls()).actions.length, 0, 'nothing runs before confirming');
    await clickText('[role="dialog"] button', 'Restart');
    await page.waitForFunction(() => window.__demo.sysmonCalls.actions.length === 1);
    assert.deepEqual((await calls()).actions[0], { unit: 'nginx.service', action: 'restart', elevate: 'sudo' });

    // --- Logs drawer: the unit's journal, followed live (Plan 31).
    // The service list re-renders after the restart; wait for the row again.
    await page.waitForSelector('button[aria-label="Logs for nginx.service"]');
    await page.click('button[aria-label="Logs for nginx.service"]');
    await page.waitForFunction(() => document.querySelector('aside[aria-label="Logs for nginx.service"] .xterm-rows')?.innerText.includes('nginx: handled request'));

    // --- Ports and firewall.
    await clickText('[role="tab"]', 'Ports');
    await page.waitForFunction(() => document.querySelector('[role="tabpanel"]')?.innerText.includes('postgres'));
    text = await panelText();
    assert.match(text, /this host only/);
    assert.match(text, /all interfaces/);
    await shot('ports');
    await clickText('[role="tab"]', 'Firewall');
    await page.waitForFunction(() => document.querySelector('[role="tabpanel"]')?.innerText.includes('DENY IN'));
    text = await panelText();
    assert.match(text, /Active/);
    assert.match(text, /Read-only/);
    await shot('firewall');
    await clickText('[role="radio"]', 'nftables');
    await page.waitForFunction(() => document.querySelector('[role="tabpanel"]')?.innerText.includes('policy drop'));

    // --- Back on Overview the sampler starts again; Esc stops it for good.
    await clickText('[role="tab"]', 'Overview');
    await page.waitForFunction(() => window.__demo.sysmonCalls.start === 2);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__demo.useServerView.getState().open);
    assert.equal((await calls()).stop, 2, 'closing the view stops the sampler');

    // --- "Disk Usage" on a mount hands over to the Disk Usage overlay.
    await clickText('button', 'Server');
    await page.waitForFunction(() => window.__demo.useServerView.getState().disks.length > 0);
    await page.waitForSelector('[role="tabpanel"] tbody button');
    await page.click('[role="tabpanel"] tbody button');
    await page.waitForFunction(() => window.__demo.useDiskScan.getState().open);
    assert.equal((await view()).open, false, 'the two overlays never stack');
    await clickText('button', 'Server');
    await page.waitForFunction(() => window.__demo.useServerView.getState().open);
    assert.equal(await page.evaluate(() => window.__demo.useDiskScan.getState().open), false);
    const sid = (await view()).sessionId;

    // --- sudo that wants a password: one consent, then the action runs with it.
    await page.evaluate(sid => {
      window.__demo.useServerView.getState().close();
      window.__demo.useServerView.getState().dropSession(sid);
      window.__demo.setSysmonProbe({ root: 'password', hasPassword: true });
      return window.__demo.useServerView.getState().openFor(sid, 'services');
    }, sid);
    await page.waitForSelector('button[aria-label="Restart ssh.service"]');
    await page.click('button[aria-label="Restart ssh.service"]');
    await page.waitForSelector('[role="dialog"]');
    await clickText('[role="dialog"] button', 'Restart');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes("Use this connection's password for sudo?"));
    assert.equal((await calls()).actions.length, 1, 'still nothing new before consent');
    await clickText('[role="dialog"] button', 'Use password');
    await page.waitForFunction(() => window.__demo.sysmonCalls.actions.length === 2);
    assert.deepEqual((await calls()).actions[1], { unit: 'ssh.service', action: 'restart', elevate: 'password' });

    // --- Key login + password sudo: Faro can't answer, so it opens a terminal.
    await page.evaluate(sid => {
      window.__demo.useServerView.getState().close();
      window.__demo.useServerView.getState().dropSession(sid);
      window.__demo.setSysmonProbe({ root: 'password', hasPassword: false });
      return window.__demo.useServerView.getState().openFor(sid, 'services');
    }, sid);
    await page.waitForSelector('button[aria-label="Restart cron.service"]');
    await page.click('button[aria-label="Restart cron.service"]');
    await page.waitForSelector('[role="dialog"]');
    await clickText('[role="dialog"] button', 'Open in terminal');
    await page.waitForFunction(() => window.__demo.useTerminals.getState().tabs.some(t => t.initialCommand === 'sudo systemctl restart cron.service\n'));
    assert.equal((await calls()).actions.length, 2, 'the backend did not run it');

    // --- A host with nothing to read gets one clear empty state.
    const startsBefore = (await calls()).start;
    await page.evaluate(sid => {
      window.__demo.useServerView.getState().close();
      window.__demo.useServerView.getState().dropSession(sid);
      window.__demo.setSysmonProbe({ os: 'FreeBSD', proc: false, systemd: false, docker: false, ports: null, firewall: [] });
      return window.__demo.useServerView.getState().openFor(sid);
    }, sid);
    await page.waitForFunction(() => document.body.innerText.includes('Server view needs a Linux host'));
    assert.equal(await page.$('[role="tablist"][aria-label="Server view"]'), null);
    assert.equal((await calls()).start, startsBefore, 'no sampler on a host without /proc');

    // --- Disconnecting closes the view.
    await page.evaluate(sid => window.__demo.useConnections.getState().disconnect(sid), sid);
    await page.waitForFunction(() => !window.__demo.useServerView.getState().open);

    assert.deepEqual(errors, [], 'no uncaught page errors');
  } finally {
    await browser?.close();
    await server.close();
  }
});
