import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'vite';

test('server search ignores separators and matches words loosely', { timeout: 60000 }, async () => {
  const server = await createServer({ mode: 'mock', cacheDir: 'node_modules/.vite-search-test', server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { searchRank } = await server.ssrLoadModule('/src/lib/serverSearch.ts');
    const servers = [
      { name: 'acmecorp', host: '10.0.0.1' },
      { name: 'acme_prod', host: 'prod.acme.io' },
      { name: 'acme-prod-corp', host: 'web1.example.com', group: 'Clients' },
      { name: 'billing', host: 'db.internal', username: 'deploy', group: 'Acme Corp' },
      { name: 'staging', host: 'stage.example.com' },
    ];
    const fields = s => [
      { text: s.name, weight: 40 }, { text: s.group, weight: 25 },
      { text: s.host, weight: 20 }, { text: s.username, weight: 10 },
    ];
    const names = q => searchRank(servers, q, fields).map(s => s.name);

    for (const q of ['acme corp', 'acme-corp', 'acmecorp', 'ACME.Corp']) {
      assert.ok(names(q).includes('acmecorp'), `${q} finds acmecorp`);
    }
    assert.ok(names('acme-prod').includes('acme_prod'));
    assert.ok(names('acme prod').includes('acme-prod-corp'));
    assert.ok(names('corp acme').includes('acme-prod-corp'));
    assert.equal(names('acme corp')[0], 'acmecorp', 'the whole name run ranks first');
    assert.ok(names('acme corp').includes('billing'), 'the group name is searched');
    assert.deepEqual(names('clients'), ['acme-prod-corp']);
    assert.deepEqual(names('stg'), ['staging'], 'a word can match as a subsequence');
    assert.deepEqual(names('zzz'), []);
    assert.deepEqual(names('  '), servers.map(s => s.name), 'an empty query keeps every server in order');
  } finally {
    await server.close();
  }
});
