import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
const source = ts.transpileModule(readFileSync(new URL('../src/lib/uploadOutcome.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { uploadOutcome } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const baseline = { preparing: false, files: 2, directories: 3, verifiedDirectories: 3,
  errors: [], skipped: 0, canceled: false };
const rows = (...statuses) => statuses.map(status => ({ status }));
test('all manifest files and directories are required for complete success', () => {
  assert.equal(uploadOutcome(baseline, rows('done', 'done')).complete, true);
});
for (const status of ['error', 'canceled', 'skipped', 'queued', 'transferring', 'paused']) {
  test(`index.html done cannot hide assets ${status}`, () => {
    assert.equal(uploadOutcome(baseline, rows('done', status)).complete, false);
  });
}
test('missing engine rows cannot disappear into success', () => {
  assert.equal(uploadOutcome(baseline, [{ status: 'done' }, undefined]).pending, true);
  assert.equal(uploadOutcome(baseline, rows('done')).complete, false);
});
test('missing empty directory prevents success', () => {
  assert.equal(uploadOutcome({ ...baseline, verifiedDirectories: 2 }, rows('done', 'done')).complete, false);
});
test('permission failure before queueing remains incomplete', () => {
  assert.equal(uploadOutcome({ ...baseline, errors: ['assets: permission denied'] }, rows('done', 'done')).complete, false);
});
test('explicit skip and batch cancellation prevent complete success', () => {
  assert.equal(uploadOutcome({ ...baseline, skipped: 1 }, rows('done', 'done')).complete, false);
  assert.equal(uploadOutcome({ ...baseline, canceled: true }, rows('done', 'done')).status, 'Upload canceled');
});
test('retry can recover from a network failure without adding another task', () => {
  assert.equal(uploadOutcome(baseline, rows('done', 'error')).complete, false);
  assert.equal(uploadOutcome(baseline, rows('done', 'transferring')).pending, true);
  assert.equal(uploadOutcome(baseline, rows('done', 'done')).complete, true);
});
test('empty folder is successful only after directory validation', () => {
  assert.equal(uploadOutcome({ ...baseline, files: 0 }, []).complete, true);
  assert.equal(uploadOutcome({ ...baseline, files: 0, verifiedDirectories: 0 }, []).complete, false);
});
test('manifest preparation cannot be considered finished', () => {
  assert.equal(uploadOutcome({ ...baseline, preparing: true }, rows('done', 'done')).complete, false);
});
test('a changed total byte count cannot match the original manifest', () => {
  assert.equal(uploadOutcome({ ...baseline, bytes: 12 }, [{ status: 'done', transferred: 4 }, { status: 'done', transferred: 7 }]).complete, false);
});
test('final validation and staged publication must finish before complete success', () => {
  assert.equal(uploadOutcome({ ...baseline, validation: 'checking' }, rows('done', 'done')).complete, false);
  assert.equal(uploadOutcome({ ...baseline, validation: 'error' }, rows('done', 'done')).complete, false);
  assert.equal(uploadOutcome({ ...baseline, validation: 'done' }, rows('done', 'done')).complete, true);
});
