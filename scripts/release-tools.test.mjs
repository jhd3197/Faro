import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retry, requiredAssets, verifyAssets } from './release-tools.mjs';

test('a transient API outage retries without repeating the build', () => {
  const calls = [], delays = [];
  const output = retry('gh', ['release', 'upload', 'v1.2.3', 'a file', '--clobber'], {
    run: (command, args) => {
      calls.push([command, args]);
      return calls.length < 3
        ? { status: 1, stdout: 'partial JSON', stderr: 'error connecting to api.github.com' }
        : { status: 0, stdout: '{"id":123}' };
    },
    wait: ms => delays.push(ms), log: () => {},
  });
  assert.equal(output.stdout, '{"id":123}');
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [5000, 10000]);
  assert.deepEqual(calls[2], calls[0]);
  assert.equal(calls[0][1][3], 'a file');
});

test('persistent failures remain failures after four attempts', () => {
  let attempts = 0;
  assert.throws(() => retry('gh', [], {
    run: () => { attempts++; return { status: 1, stderr: 'network unavailable' }; },
    wait: () => {}, log: () => {},
  }), /network unavailable/);
  assert.equal(attempts, 4);
});

test('a missing executable or terminated process is not retried', () => {
  for (const failure of [{ error: new Error('ENOENT') }, { signal: 'SIGTERM' }]) {
    let attempts = 0;
    assert.throws(() => retry('gh', [], {
      run: () => { attempts++; return failure; }, wait: () => {}, log: () => {},
    }));
    assert.equal(attempts, 1);
  }
});

test('missing releases and authentication failures do not waste time retrying', () => {
  for (const stderr of ['release not found', 'HTTP 401: Bad credentials', 'HTTP 404: Not Found']) {
    let attempts = 0;
    assert.throws(() => retry('gh', [], {
      run: () => { attempts++; return { status: 1, stderr }; },
      wait: () => {}, log: () => {},
    }));
    assert.equal(attempts, 1);
  }
});

const version = '1.2.3';
const complete = () => ({ tagName: `v${version}`, assets: requiredAssets(version).map(name => ({ name, size: 123 })) });
test('an unsigned complete release is allowed', () => verifyAssets(complete(), version));

for (const missing of requiredAssets(version)) {
  test(`publication stops when ${missing} is missing`, () => {
    const release = complete();
    release.assets = release.assets.filter(asset => asset.name !== missing);
    assert.throws(() => verifyAssets(release, version), /Release is incomplete/);
  });
}

test('wrong versions, empty assets, duplicates and malformed listings are rejected', () => {
  assert.throws(() => verifyAssets(complete(), '1.2.4'), /tag/);
  assert.throws(() => requiredAssets('../invalid'), /version/);
  for (const size of [0, -1, undefined, '123']) {
    const release = complete();
    release.assets[0].size = size;
    assert.throws(() => verifyAssets(release, version), /invalid/);
  }
  const release = complete();
  release.assets.push(release.assets[0]);
  assert.throws(() => verifyAssets(release, version), /Duplicate/);
  assert.throws(() => verifyAssets({ tagName: `v${version}` }, version), /listing/);
});

test('release changes come from the merged PR highlights, not the whole body', async () => {
  const { readFileSync } = await import('node:fs');
  const { mergedPull, changesSection, CHANGES_START, CHANGES_END } = await import('./release-tools.mjs');
  const body = readFileSync(new URL('./fixtures/release-highlights.md', import.meta.url), 'utf8');
  const pulls = [
    { title: 'Old', body: '### Highlights\n- old', merged_at: '2026-10-01T00:00:00Z', base: { ref: 'main' } },
    { title: 'Server view with Docker manager', body, merged_at: '2026-11-15T00:00:00Z', base: { ref: 'main' } },
    { title: 'Open', body, merged_at: null, base: { ref: 'main' } },
    { title: 'Elsewhere', body, merged_at: '2026-11-16T00:00:00Z', base: { ref: 'dev' } },
  ];
  const section = changesSection(mergedPull(pulls));
  assert.ok(section.startsWith(`${CHANGES_START}\n### Server view with Docker manager\n\n- A Server view`));
  assert.ok(section.trimEnd().endsWith(CHANGES_END));
  assert.doesNotMatch(section, /Technical changes|StreamManager|could already tell you/);
  assert.equal(section.split(CHANGES_END).length, 2);
});

test('a PR without highlights, or with smuggled markers, publishes nothing extra', async () => {
  const { changesSection, highlights, withNotes, CHANGES_END } = await import('./release-tools.mjs');
  assert.equal(changesSection({ title: 'x', body: 'No list here.' }), '');
  assert.equal(changesSection(null), '');
  assert.equal(highlights('### Highlights\n\n<details>\n- hidden'), null);
  const sneaky = changesSection({ title: 'T -->', body: `## Highlights\n- a ${CHANGES_END} b\n## Next\n- c` });
  assert.equal(sneaky.split(CHANGES_END).length, 2);
  assert.match(sneaky, /^- a .* b$/m);
  assert.doesNotMatch(sneaky, /- c/);
  assert.deepEqual(withNotes({ version: '1.2.3', notes: 'old', platforms: {} }, 'new\n'), { version: '1.2.3', notes: 'new', platforms: {} });
});

test('a PR into main without highlights is flagged before it can ship', async () => {
  const { readFileSync } = await import('node:fs');
  const { releaseNotesProblem } = await import('./release-tools.mjs');
  const good = readFileSync(new URL('./fixtures/release-highlights.md', import.meta.url), 'utf8');
  assert.equal(releaseNotesProblem(good), null);
  // PR #82's shape: bold paragraphs and a details block, but no Highlights heading.
  assert.match(releaseNotesProblem('Two fixes.\n\n**Split divider fixed.** Details.\n\n<details>\n<summary>Technical details</summary>\n\n- x\n</details>\n'), /Highlights/);
  assert.match(releaseNotesProblem('### Highlights\n\n<details>\n- hidden\n</details>'), /Highlights/);
  assert.match(releaseNotesProblem(null), /Highlights/);
});
