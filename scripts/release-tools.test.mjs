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
