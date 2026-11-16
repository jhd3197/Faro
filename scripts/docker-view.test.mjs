// Docker tab of the Server view (Plan 31) against the mock backend: lists,
// confirmed actions, the detail drawer, live logs, the container shell, and
// every way of reaching the daemon.
//
//   node --test scripts/docker-view.test.mjs
//
// Set SERVER_VIEW_SHOTS=<dir> to also save a screenshot of each section.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

test('Docker tab: lists, actions, drawer, live logs, shell, access modes', { timeout: 180000 }, async () => {
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
    page.on('pageerror', e => { errors.push(String(e)); if (process.env.SERVER_VIEW_DEBUG) console.log('PAGEERROR', e.stack); });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
    await page.waitForFunction(() => window.__demo?.useConnections.getState().activeSessionId);
    const sid = await page.evaluate(() => window.__demo.useConnections.getState().activeSessionId);

    const calls = () => page.evaluate(() => JSON.parse(JSON.stringify(window.__demo.dockerCalls)));
    const clickText = async (selector, text) => {
      const ok = await page.evaluate((selector, text) => {
        const el = [...document.querySelectorAll(selector)].find(e => e.textContent.trim() === text || e.textContent.trim().startsWith(text + ' '));
        el?.click();
        return !!el;
      }, selector, text);
      assert.ok(ok, `no ${selector} with text "${text}"`);
    };
    const shot = async name => { if (shots) await page.screenshot({ path: join(shots, `docker-${name}.png`) }); };
    const panel = () => page.$eval('[role="tabpanel"]', el => el.innerText);
    const waitText = text => page.waitForFunction(t => document.querySelector('[role="tabpanel"]')?.innerText.includes(t), {}, text);
    const dialog = () => page.evaluate(() => document.querySelector('[role="dialog"]')?.innerText ?? '');
    const open = (tab = 'docker') => page.evaluate((sid, tab) => window.__demo.useServerView.getState().openFor(sid, tab), sid, tab);
    const section = name => clickText('[role="tablist"][aria-label="Docker"] [role="tab"]', name);

    // --- The tab is there because the probe found docker; containers load.
    await open();
    await page.waitForSelector('[role="tablist"][aria-label="Docker"]');
    const tabs = await page.$$eval('[role="tablist"][aria-label="Server view"] [role="tab"]', els => els.map(e => e.textContent.trim()));
    assert.equal(tabs.at(-1), 'Docker');
    await waitText('shop-db-1');
    let text = await panel();
    assert.match(text, /COMPOSE · SHOP[\s\S]*shop-db-1[\s\S]*shop-web-1[\s\S]*NOT IN A COMPOSE PROJECT[\s\S]*cache/, 'compose project groups first');
    assert.match(text, /Docker 27\.3\.1/);
    assert.match(text, /Containers 5/);
    // Stats arrive for running containers and the list keeps itself current.
    await page.waitForFunction(() => /\d+\.\d%/.test(document.querySelector('[role="tabpanel"]')?.innerText ?? ''));
    const polls = (await calls()).reads.length;
    await page.waitForFunction(n => window.__demo.dockerCalls.reads.length > n, { timeout: 15000 }, polls);
    await shot('containers');

    // --- Stop is one click; the row changes and Start replaces it.
    await page.click('button[aria-label="Stop cache"]');
    await page.waitForSelector('button[aria-label="Start cache"]');
    assert.deepEqual((await calls()).actions.at(-1), { id: 'd4c3f5a2b1e0', action: 'stop', elevate: 'none' });
    assert.equal(await page.$eval('button[aria-label="Shell in cache"]', b => b.disabled), true, 'no shell in a stopped container');
    await page.click('button[aria-label="Start cache"]');
    await page.waitForSelector('button[aria-label="Stop cache"]');

    // --- Kill and Remove live in the menu and confirm with the command.
    await page.click('button[aria-label="More actions for shop-web-1"]');
    await clickText('button[role="menuitem"]', 'Remove…');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes('Remove shop-web-1?'));
    text = await dialog();
    assert.match(text, /docker rm -f shop-web-1/);
    assert.match(text, /running: it is killed and then removed/);
    const before = (await calls()).actions.length;
    await clickText('[role="dialog"] button', 'Cancel');
    assert.equal((await calls()).actions.length, before, 'cancelling runs nothing');
    await page.click('button[aria-label="More actions for nightly-backup"]');
    await clickText('button[role="menuitem"]', 'Remove…');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes('Remove nightly-backup?'));
    await clickText('[role="dialog"] button', 'Remove');
    await page.waitForFunction(() => !document.querySelector('[role="tabpanel"]')?.innerText.includes('nightly-backup'));
    assert.deepEqual((await calls()).actions.at(-1), { id: 'e5b4a6c3d2f1', action: 'remove', elevate: 'none' });

    // --- Details: environment values are masked until asked for.
    await clickText('[role="tabpanel"] td span', 'shop-db-1');
    await page.waitForSelector('aside[aria-label="Container shop-db-1"]');
    await page.waitForFunction(() => document.querySelector('aside')?.innerText.includes('POSTGRES_PASSWORD'));
    let drawer = await page.$eval('aside', el => el.innerText);
    assert.ok(!drawer.includes('correct-horse-battery'), 'secret is hidden by default');
    assert.match(drawer, /shop_pgdata\s*→\s*\/var\/lib\/data/);
    assert.match(drawer, /5432\/tcp/);
    await page.click('button[aria-label="Show POSTGRES_PASSWORD"]');
    drawer = await page.$eval('aside', el => el.innerText);
    assert.ok(drawer.includes('correct-horse-battery'), 'revealed on request');
    assert.ok(!drawer.includes('/usr/local/sbin'), 'other values stay hidden');
    await shot('details');
    // A bind mount opens in the file browser.
    // (The file browser consumes the request at once, so watch it being set.)
    await page.evaluate(() => {
      window.__revealSeen = null;
      window.__demo.useLayout.subscribe(s => { if (s.revealTarget) window.__revealSeen = s.revealTarget; });
    });
    await clickText('aside button', 'Reveal');
    await page.waitForFunction(() => !window.__demo.useServerView.getState().open);
    assert.deepEqual(await page.evaluate(() => window.__revealSeen), { sessionId: sid, path: '/srv/shop/config' });

    // --- Live logs: lines arrive, colour codes are rendered, pause holds them.
    await open();
    await waitText('shop-db-1');
    await page.click('button[aria-label="Logs for shop-web-1"]');
    const rows = () => page.$eval('[data-testid="log-view"] .xterm-rows', el => el.innerText);
    await page.waitForFunction(() => document.querySelector('[data-testid="log-view"] .xterm-rows')?.innerText.includes('handled request'));
    assert.deepEqual((await calls()).follows.at(-1), { key: 'docker:b2e1d3c0f9a8', elevate: 'none' });
    assert.ok(!(await rows()).includes('[32m'), 'ANSI codes are rendered, not printed');
    await page.waitForFunction(() => document.querySelector('aside [role="status"]')?.textContent.startsWith('Live'));
    await page.click('button[aria-label="Pause"]');
    const held = await rows();
    await new Promise(r => setTimeout(r, 700));
    assert.equal(await rows(), held, 'paused: nothing new is drawn');
    await page.click('button[aria-label="Resume"]');
    await page.waitForFunction(h => document.querySelector('[data-testid="log-view"] .xterm-rows')?.innerText !== h, {}, held);
    await shot('logs');
    // Another container's log replaces this one; closing stops the last.
    await page.click('button[aria-label="Logs for shop-db-1"]');
    await page.waitForFunction(() => window.__demo.dockerCalls.follows.at(-1)?.key === 'docker:a1f0c2d9e8b7');
    await page.click('button[aria-label="Close container panel"]');
    await page.waitForFunction(() => window.__demo.dockerCalls.stops.includes('docker:a1f0c2d9e8b7'));

    // --- Shell: a terminal tab named after the container, with the command.
    await page.click('button[aria-label="Shell in shop-db-1"]');
    const tab = await page.evaluate(() => window.__demo.useTerminals.getState().tabs.at(-1));
    // The trailing newline is what runs it: the terminal types the command verbatim.
    assert.equal(tab.initialCommand, "docker exec -it shop-db-1 sh -c 'command -v bash >/dev/null && exec bash || exec sh'\n");
    assert.equal(tab.title, 'shop-db-1');
    assert.equal(await page.evaluate(() => window.__demo.useLayout.getState().terminalOpen), true);

    // --- Images, volumes, networks.
    await section('Images');
    await waitText('ghcr.io/acme/shop-web:1.42.0');
    text = await panel();
    assert.match(text, /postgres:16[\s\S]*shop-db-1/, 'images name the containers using them');
    assert.match(text, /ghcr\.io\/acme\/shop-web:1\.41\.3[\s\S]*unused/);
    await shot('images');
    await page.click('button[aria-label="Remove image ghcr.io/acme/shop-web:1.41.3"]');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes('docker rmi ghcr.io/acme/shop-web:1.41.3'));
    await clickText('[role="dialog"] button', 'Remove');
    await page.waitForFunction(() => !document.querySelector('[role="tabpanel"]')?.innerText.includes('1.41.3'));
    assert.deepEqual((await calls()).removes.at(-1), { kind: 'image', id: 'ghcr.io/acme/shop-web:1.41.3', elevate: 'none' });

    await section('Volumes');
    await waitText('old-uploads');
    text = await panel();
    assert.match(text, /shop_pgdata[\s\S]*shop-db-1/);
    // Removing a volume in use: the warning names the container, and Docker's
    // refusal is shown instead of a silent failure.
    await page.click('button[aria-label="Remove volume shop_pgdata"]');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes('Remove shop_pgdata?'));
    text = await dialog();
    assert.match(text, /Used by shop-db-1/);
    assert.match(text, /can't be undone/);
    await clickText('[role="dialog"] button', 'Remove');
    await page.waitForFunction(() => document.body.innerText.includes('volume is in use'));
    assert.match(await panel(), /shop_pgdata/, 'the volume is still listed');
    await shot('volumes');

    await section('Networks');
    await waitText('legacy-net');
    assert.equal(await page.$eval('button[aria-label="bridge comes with Docker and can\'t be removed"]', b => b.disabled), true);
    assert.match(await panel(), /shop_default[\s\S]*shop-db-1/);

    // --- Prune is per section and says what it reclaims.
    await section('Containers');
    await page.evaluate(() => window.__demo.resetDocker());
    await clickText('[role="tabpanel"] button', 'Refresh');
    await waitText('nightly-backup');
    await clickText('[role="tabpanel"] button', 'Prune…');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes('Remove all stopped containers?'));
    text = await dialog();
    assert.match(text, /1\.1MB \(8%\) reclaimable/);
    assert.match(text, /docker container prune -f/);
    await clickText('[role="dialog"] button', 'Prune');
    await page.waitForFunction(() => !document.querySelector('[role="tabpanel"]')?.innerText.includes('nightly-backup'));
    assert.deepEqual((await calls()).prunes, [{ kind: 'containers', elevate: 'none' }]);

    // --- Through sudo: commands carry sudo, and there is no polling.
    const reopen = async (access, probe) => {
      await page.evaluate((sid, access, probe) => {
        window.__demo.useServerView.getState().close();
        window.__demo.useServerView.getState().dropSession(sid);
        window.__demo.useDocker.getState().dropSession(sid);
        window.__demo.resetDocker();
        window.__demo.setDockerAccess(access);
        window.__demo.setSysmonProbe(probe);
        return window.__demo.useServerView.getState().openFor(sid, 'docker');
      }, sid, access, probe);
    };
    await reopen({ mode: 'sudo' }, { root: 'sudo' });
    await waitText('shop-db-1');
    assert.match(await panel(), /through sudo, so lists refresh only when asked/);
    const quiet = (await calls()).reads.length;
    await new Promise(r => setTimeout(r, 5600));
    assert.equal((await calls()).reads.length, quiet, 'no timer through sudo');
    await page.click('button[aria-label="Restart cache"]');
    await page.waitForFunction(() => window.__demo.dockerCalls.actions.length === 1);
    assert.equal((await calls()).actions[0].elevate, 'sudo');
    await page.click('button[aria-label="Shell in cache"]');
    assert.match(await page.evaluate(() => window.__demo.useTerminals.getState().tabs.at(-1).initialCommand), /^sudo docker exec -it cache /);

    // --- sudo wants a password: nothing is listed until the user agrees;
    // then logs are a tail, because a stream can't type the password.
    await reopen({ mode: 'needsRoot', error: 'permission denied' }, { root: 'password', hasPassword: true });
    await page.waitForFunction(() => document.body.innerText.includes('Docker needs root on this host'));
    assert.equal((await calls()).reads.length, 0, 'no docker call before consent');
    await clickText('button', 'Use sudo password');
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.innerText.includes("password for sudo"));
    await clickText('[role="dialog"] button', 'Use password');
    await waitText('shop-db-1');
    assert.equal((await calls()).reads.at(-1).elevate, 'password');
    await page.click('button[aria-label="Logs for cache"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="log-view"] .xterm-rows')?.innerText.includes('tail line 3 of cache'));
    assert.equal((await calls()).follows.length, 0, 'no live follow with password sudo');
    assert.match(await page.$eval('aside [role="status"]', el => el.textContent), /Not live/);

    // --- No sudo password to offer: the way out is a terminal.
    await reopen({ mode: 'needsRoot', error: 'permission denied' }, { root: 'password', hasPassword: false });
    await page.waitForFunction(() => document.body.innerText.includes('Docker needs root on this host'));
    await clickText('[role="tabpanel"] button', 'Open in terminal');
    assert.equal(await page.evaluate(() => window.__demo.useTerminals.getState().tabs.at(-1).initialCommand), 'sudo docker ps -a\n');

    // --- No daemon: say so, with Docker's own words.
    await reopen({ mode: 'unavailable', error: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.' }, { root: 'sudo' });
    await page.waitForFunction(() => document.body.innerText.includes("Docker isn't answering on this host"));
    assert.match(await panel(), /Cannot connect to the Docker daemon/);

    // --- The Services journal now follows live too.
    await reopen({}, { root: 'sudo' });
    await clickText('[role="tablist"][aria-label="Server view"] [role="tab"]', 'Services');
    await page.waitForSelector('button[aria-label="Logs for nginx.service"]');
    await page.click('button[aria-label="Logs for nginx.service"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="log-view"] .xterm-rows')?.innerText.includes('nginx: handled request'));
    assert.deepEqual((await calls()).follows.at(-1), { key: 'unit:nginx.service', elevate: 'sudo' });
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => window.__demo.dockerCalls.stops.includes('unit:nginx.service'));

    assert.deepEqual(errors, [], 'no uncaught page errors');
  } catch (e) {
    // Leave a picture of where it stopped.
    const page = (await browser?.pages())?.at(-1);
    if (shots && page) await page.screenshot({ path: join(shots, 'docker-failure.png') }).catch(() => {});
    throw e;
  } finally {
    await browser?.close();
    await server.close();
  }
});
