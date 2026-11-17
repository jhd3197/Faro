import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('deep links match a saved connection instead of duplicating it', { timeout: 60000 }, async () => {
  const server = await createServer({ mode: 'mock', cacheDir: 'node_modules/.vite-link-test', server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { matchLinkProfile, sameRemotePath, siteNameFor } = await server.ssrLoadModule('/src/lib/deepLinkMatch.ts');
    const p = (id, extra) => ({ id, name: id, protocol: 'sftp', host: 'web1.example.com', port: 22, username: 'deploy', auth: { kind: 'password' }, ...extra });
    const profiles = [
      p('deploy', { group: 'Clients' }),
      p('root', { username: 'root' }),
      p('ftp', { protocol: 'ftp', port: 21 }),
      p('cf', { host: 'box', username: 'jane', proxyCommand: { kind: 'cloudflare', hostname: 'ssh.example.com' } }),
      p('alt-port', { host: 'docker.local', port: 2222 }),
      { id: 'agent', name: 'agent', protocol: 'faro-agent', host: 'web1.example.com', port: 8722, username: '', auth: { kind: 'none' } },
    ];
    const id = dl => matchLinkProfile(profiles, { action: 'connect', ...dl })?.id ?? null;

    assert.equal(id({ host: 'WEB1.example.com ', username: 'deploy' }), 'deploy', 'host case and spaces are ignored');
    assert.equal(id({ host: 'web1.example.com', username: 'root' }), 'root');
    assert.equal(id({ host: 'web1.example.com', username: 'nobody' }), null);
    assert.equal(id({ host: 'web1.example.com', username: 'deploy', protocol: 'ftp' }), 'ftp');
    assert.equal(id({ host: 'web1.example.com' }), null, 'no username and several logins: never guess');
    assert.equal(id({ host: 'docker.local' }), 'alt-port', 'a single host match needs no username');
    assert.equal(id({ host: 'docker.local', port: 22 }), null, 'a different port is a different server');
    assert.equal(id({ host: 'box', username: 'jane', via: 'cloudflare', access: 'ssh.example.com' }), 'cf');
    assert.equal(id({ host: 'box', username: 'jane', via: 'cloudflare', access: 'other.example.com' }), null);
    assert.equal(id({ username: 'deploy' }), null, 'no host, no match');

    assert.ok(sameRemotePath('/var/www/', '/var/www'));
    assert.ok(!sameRemotePath('/var/www/a', '/var/www'));
    assert.equal(siteNameFor({ action: 'site' }, '/var/www/shop/'), 'shop');
    assert.equal(siteNameFor({ action: 'site', name: ' Shop ' }, '/x'), 'Shop');
  } finally {
    await server.close();
  }
});
