import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';

test('per-site navigation pairing and asynchronous isolation', { timeout: 180000 }, async t => {
  const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
    .find(p => p && existsSync(p));
  assert.ok(executablePath, 'Install Chrome/Chromium or set CHROME_PATH');
  const server = await createServer({ mode: 'mock', cacheDir: 'node_modules/.vite-site-pairing-test',
    server: { host: '127.0.0.1', port: 0, strictPort: false } });
  let browser;
  try {
    await server.listen();
    browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const url = `http://127.0.0.1:${server.httpServer.address().port}/scripts/fixtures/site-pairing.html`;
    const frame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const flush = () => page.evaluate(() => window.pairTest.useSites.getState().flushNavigation());
    const state = () => page.evaluate(() => {
      const h = window.pairTest.current;
      return { local: h.localPath, remote: h.remotePath, enabled: h.enabled, hint: h.hint };
    });
    const load = async (clear = true, beforeMount) => {
      await page.goto(url);
      await page.waitForFunction(() => !!window.pairTest);
      if (clear) { await page.evaluate(() => sessionStorage.clear()); await page.reload(); await page.waitForFunction(() => !!window.pairTest); }
      if (beforeMount) await page.evaluate(beforeMount);
      await page.evaluate(() => window.pairTest.mount());
      await page.waitForFunction(() => window.pairTest.useSites.getState().loaded);
      await frame();
      await flush();
    };
    const select = async (id, profile = 'p1', session = 's1') => {
      await page.evaluate(({ id, profile, session }) => {
        window.pairTest.useSites.getState().select(profile, id);
        window.pairTest.useConnections.setState({ activeProfileId: profile, activeSessionId: session });
      }, { id, profile, session });
      await frame();
    };
    const seedA = async () => {
      await load(); await select('a');
      await page.evaluate(() => { const h = window.pairTest.current; h.setLocalPath('/local/a'); h.setRemotePath('/remote/a'); });
      await frame();
      await page.evaluate(() => window.pairTest.current.toggle());
      await frame();
    };
    const begin = async (suffix = 'pending') => {
      await page.evaluate(suffix => {
        const h = window.pairTest;
        h.hold = { session: 's1', path: `/remote/a/${suffix}` };
        h.current.onLocalNavigate(`/local/a/${suffix}`);
      }, suffix);
      await page.waitForFunction(() => window.pairTest.pending.length === 1);
    };
    const finish = async (fail = false) => {
      await page.evaluate(fail => { const p = window.pairTest.pending.shift(); fail ? p.reject() : p.resolve(); }, fail);
      await frame();
    };

    await t.test('independent paths, enabled flags and original bases survive restart and reconnect', async () => {
      await seedA();
      await page.evaluate(() => window.pairTest.current.onLocalNavigate('/local/a/src'));
      await page.waitForFunction(() => window.pairTest.current.remotePath === '/remote/a/src');
      await select('b');
      assert.equal((await state()).enabled, false);
      await page.evaluate(() => { window.pairTest.current.setLocalPath('/local/b'); window.pairTest.current.setRemotePath('/remote/b/assets'); });
      await frame(); await select('a');
      assert.deepEqual(await state(), { local: '/local/a/src', remote: '/remote/a/src', enabled: true, hint: null });
      await flush(); await load(false);
      assert.deepEqual(await state(), { local: '/local/a/src', remote: '/remote/a/src', enabled: true, hint: null });
      await page.evaluate(() => window.pairTest.useConnections.setState({ activeSessionId: 's3' }));
      await frame();
      const base = await page.evaluate(() => window.pairTest.useSites.getState().syncPairs[window.pairTest.browserLocationKey('p1', 'a')].base);
      assert.deepEqual(base, { local: '/local/a', remote: '/remote/a' });
      await select('b', 'p1', 's3');
      assert.deepEqual(await state(), { local: '/local/b', remote: '/remote/b/assets', enabled: false, hint: null });
      await select(undefined, 'p1', 's3');
      assert.equal((await state()).local, '/local/default1');
      await select('c', 'p2', 's2');
      assert.equal((await state()).local, '/local/default2');
      assert.equal((await state()).enabled, false);
    });

    for (const fail of [false, true]) await t.test(`old same-server probe ${fail ? 'failure' : 'success'} cannot affect another site`, async () => {
      await seedA(); await begin(); await select('b'); const before = await state();
      await finish(fail); assert.deepEqual(await state(), before);
    });
    await t.test('A to B to A in one turn does not revive a pending probe or stale setters', async () => {
      await seedA(); await begin();
      await page.evaluate(() => {
        const h = window.pairTest; const old = h.current;
        h.useSites.getState().select('p1', 'b'); h.useSites.getState().select('p1', 'a');
        old.setRemotePath('/stale'); old.setLocalPath('/stale');
      });
      await frame(); await finish();
      assert.equal((await state()).remote, '/remote/a');
      assert.equal((await state()).local, '/local/a/pending');
    });
    await t.test('unmount and reconnect invalidate probes without changing saved bases', async () => {
      await seedA(); await begin();
      await page.evaluate(() => window.pairTest.unmount()); await frame();
      await page.evaluate(() => window.pairTest.mount()); await frame(); await finish();
      assert.equal((await state()).remote, '/remote/a');
      await begin('second');
      await page.evaluate(() => { window.pairTest.useConnections.setState({ activeSessionId: null }); window.pairTest.useConnections.setState({ activeSessionId: 's3' }); });
      await frame(); await finish(); assert.equal((await state()).remote, '/remote/a');
      assert.equal((await state()).enabled, true);
    });
    await t.test('toggle and rebase cancel the previous navigation generation', async () => {
      await seedA(); await begin();
      await page.evaluate(() => window.pairTest.current.toggle()); await frame();
      await page.evaluate(() => window.pairTest.current.toggle()); await frame();
      await finish(); assert.equal((await state()).remote, '/remote/a');
      await seedA(); await begin();
      await page.evaluate(() => window.pairTest.current.rebase()); await frame();
      await finish(); assert.equal((await state()).remote, '/remote/a');
    });
    await t.test('a connection-only round trip rejects old work and leaves new navigation usable', async () => {
      await seedA(); await begin();
      await page.evaluate(() => {
        const c = window.pairTest.useConnections;
        c.setState({ activeProfileId: 'p2', activeSessionId: 's2' });
        c.setState({ activeProfileId: 'p1', activeSessionId: 's1' });
      });
      await frame(); await finish(); assert.equal((await state()).remote, '/remote/a');
      await page.evaluate(() => window.pairTest.current.onLocalNavigate('/local/a/fresh'));
      await page.waitForFunction(() => window.pairTest.current.remotePath === '/remote/a/fresh');
    });
    await t.test('slow hydration preserves early navigation and its server-view identity', async () => {
      await seedA(); await flush();
      await page.reload(); await page.waitForFunction(() => !!window.pairTest);
      await page.evaluate(() => { window.pairTest.delayLoad = true; window.pairTest.mount(); });
      await page.waitForFunction(() => !!window.pairTest.current);
      await page.evaluate(() => {
        const h = window.pairTest;
        h.current.setLocalPath('/early/local'); h.current.setRemotePath('/early/remote');
        h.releaseLoad();
      });
      await page.waitForFunction(() => window.pairTest.useSites.getState().loaded);
      await frame(); await flush();
      assert.equal((await state()).local, '/early/local'); assert.equal((await state()).remote, '/early/remote');
      assert.equal(await page.evaluate(() => window.pairTest.useSites.getState().activeByProfile.p1), undefined);
    });
    await t.test('failed saves retry, and slow serialized writes preserve the latest pair on flush', async () => {
      await seedA(); await flush();
      await page.evaluate(() => { window.pairTest.failSave = true; window.pairTest.current.setLocalPath('/retry'); });
      await frame(); await flush();
      await page.evaluate(() => { window.pairTest.failSave = false; }); await flush();
      assert.equal(await page.evaluate(() => JSON.parse(window.pairTest.settings['siteNavigation.v1']).localPaths[window.pairTest.browserLocationKey('p1', 'a')]), '/retry');
      await page.evaluate(() => { window.pairTest.delaySave = true; window.pairTest.current.setLocalPath('/first'); });
      await page.waitForFunction(() => window.pairTest.writes.some(s => s.includes('/first')));
      await page.evaluate(() => { window.pairTest.current.setLocalPath('/latest'); window.pairTest.current.setRemotePath('/remote/latest'); window.pairTest.delaySave = false; window.pairTest.releaseSave(); });
      await frame(); await flush();
      const saved = await page.evaluate(() => JSON.parse(window.pairTest.settings['siteNavigation.v1']));
      assert.equal(saved.localPaths[JSON.stringify(['p1', 'a'])], '/latest'); assert.equal(saved.sitePaths.a, '/remote/latest');
    });
    await t.test('missing restored local folder disables its pair and a late fallback cannot replace newer navigation', async () => {
      await seedA(); await flush();
      await load(false, () => { window.pairTest.failPaths = ['/local/a']; });
      assert.equal((await state()).enabled, false); assert.notEqual((await state()).local, '/local/a');
      await seedA(); await flush();
      await load(false, () => { window.pairTest.hold = { session: window.pairTest.LOCAL_SESSION, path: '/local/a' }; });
      const pending = await page.evaluate(() => window.pairTest.pending.length);
      assert.equal(pending, 1);
      await page.evaluate(() => window.pairTest.current.setLocalPath('/newer'));
      await finish(true); assert.equal((await state()).local, '/newer');
    });
    await t.test('deleting a site cannot be undone by its pending local restoration', async () => {
      await seedA(); await flush();
      await load(false, () => { window.pairTest.hold = { session: window.pairTest.LOCAL_SESSION, path: '/local/a' }; });
      await page.waitForFunction(() => window.pairTest.pending.length === 1);
      await page.evaluate(async () => {
        const h = window.pairTest;
        await h.useSites.getState().remove('a');
        h.pending.shift().resolve();
      });
      await frame(); await flush();
      assert.equal(await page.evaluate(() => window.pairTest.useSites.getState().localPaths[window.pairTest.browserLocationKey('p1', 'a')]), undefined);
    });
    await t.test('restart prunes a deleted selection after its navigation snapshot fails to save', async () => {
      await seedA(); await flush();
      await page.evaluate(async () => { window.pairTest.failSave = true; await window.pairTest.useSites.getState().remove('a'); });
      await load(false);
      assert.equal((await state()).remote, '/remote/default1');
      await page.evaluate(() => window.pairTest.current.onLocalNavigate('/still-usable'));
      await frame(); assert.equal((await state()).local, '/still-usable');
      const saved = await page.evaluate(() => JSON.parse(window.pairTest.settings['siteNavigation.v1']));
      assert.equal(saved.activeByProfile.p1, undefined);
      assert.equal(saved.localPaths[JSON.stringify(['p1', 'a'])], undefined);
      assert.equal(saved.syncPairs[JSON.stringify(['p1', 'a'])], undefined);
    });
    await t.test('local navigation stays usable without a saved profile and never recreates deleted pairs', async () => {
      await seedA();
      await page.evaluate(async () => {
        const h = window.pairTest;
        h.useConnections.setState({ profiles: h.useConnections.getState().profiles.filter(p => p.id !== 'p1') });
        await h.useSites.getState().removeForProfile('p1');
      });
      await frame();
      assert.equal(await page.$('button[aria-label="Synchronized browsing"]'), null);
      await page.evaluate(() => window.pairTest.current.toggle());
      await page.evaluate(() => window.pairTest.current.onLocalNavigate('/unpaired-local'));
      await frame();
      assert.equal((await state()).local, '/unpaired-local');
      assert.equal((await state()).enabled, false);
      assert.equal(await page.evaluate(() => Object.keys(window.pairTest.useSites.getState().localPaths).some(key => JSON.parse(key)[0] === 'p1')), false);
      await page.evaluate(() => window.pairTest.useConnections.setState({ activeProfileId: null, activeSessionId: null }));
      await frame();
      await page.evaluate(() => window.pairTest.current.onLocalNavigate('/standalone'));
      await frame(); assert.equal((await state()).local, '/standalone');
    });
    await t.test('removing a site or profile removes persisted pairing metadata only', async () => {
      await seedA(); await flush();
      await page.evaluate(() => window.pairTest.useSites.getState().remove('a'));
      const after = await page.evaluate(() => JSON.parse(window.pairTest.settings['siteNavigation.v1']));
      assert.equal(after.sitePaths.a, undefined); assert.equal(after.localPaths[JSON.stringify(['p1', 'a'])], undefined);
      assert.equal(after.syncPairs[JSON.stringify(['p1', 'a'])], undefined);
      await select(undefined);
      await page.evaluate(() => window.pairTest.current.setLocalPath('/server'));
      await page.evaluate(() => window.pairTest.useSites.getState().removeForProfile('p1'));
      const saved = await page.evaluate(() => JSON.parse(window.pairTest.settings['siteNavigation.v1']));
      assert.equal(saved.localPaths[JSON.stringify(['p1', null])], undefined);
    });
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await server.close(); }
});
