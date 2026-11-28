import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setBuildVersion, withCargoVersion, withTauriVersion, TEST_VERSION } from './set-build-version.mjs';

test('accepts only numeric pre-releases the MSI bundler can use', () => {
  assert.ok(TEST_VERSION.test('1.4.23-7'));
  assert.ok(!TEST_VERSION.test('1.4.23-test.7'));
  assert.ok(!TEST_VERSION.test('1.4.23'));
  assert.throws(() => setBuildVersion('1.4.23-test.7'));
  assert.throws(() => setBuildVersion('1.4.23-70000'));
});

test('changes only the package version line of a Cargo manifest', () => {
  const before = '[package]\nname = "faro"\nversion = "1.4.22"\n\n[dependencies]\nserde = { version = "1" }\n';
  const after = withCargoVersion(before, '1.4.23-7');
  assert.equal(after, before.replace('1.4.22', '1.4.23-7'));
});

test('rewrites the tauri config version and keeps the rest', () => {
  const out = JSON.parse(withTauriVersion('{"productName":"Faro","version":"1.4.22"}', '1.4.23-7'));
  assert.deepEqual(out, { productName: 'Faro', version: '1.4.23-7' });
});

test('stamps every manifest in a tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'faro-version-'));
  for (const dir of ['src-tauri/faro-cli', 'src-tauri/faro-agent-proto', 'src-tauri/faro-agentd']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), '{"version":"1.4.22"}');
  for (const file of ['src-tauri/Cargo.toml', 'src-tauri/faro-cli/Cargo.toml', 'src-tauri/faro-agent-proto/Cargo.toml', 'src-tauri/faro-agentd/Cargo.toml']) {
    writeFileSync(join(root, file), '[package]\nversion = "1.4.22"\n');
  }
  setBuildVersion('1.4.23-7', root);
  assert.match(readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8'), /version = "1.4.23-7"/);
  assert.equal(JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version, '1.4.23-7');
});
