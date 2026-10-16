import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { create } from 'zustand';
import ts from 'typescript';

// Run the real store, substituting only the IPC boundary and UI preferences.
const code = ts.transpileModule(readFileSync(new URL('../src/stores/transfersStore.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
async function harness(options = {}) {
  const calls = [];
  let event;
  let seq = 0;
  const single = { path: 'C:\\été\\index.html', kind: 'file', files: 1, directories: 0, size: 4, directoryPaths: [], fingerprint: 'file-fingerprint' };
  const folder = { path: 'C:\\été\\dist', kind: 'directory', files: 2, directories: 2, size: 8, directoryPaths: ['dist', 'dist/assets'], fingerprint: 'tree-fingerprint' };
  const start = (kind, args) => {
    calls.push([kind, ...args]);
    if (options.startError && kind === 'directory') throw new Error('assets: permission denied');
    const ids = Array.from({ length: kind === 'directory' ? 2 : 1 }, () => `transfer-${++seq}`);
    for (const id of ids) event('added', { id, status: options.fileError ? 'error' : 'done', transferred: options.volumeMismatch ? 3 : 4, size: 4, source: args[1], kind: 'upload', error: options.fileError ? 'network interrupted' : undefined });
    return kind === 'directory' ? ids : ids[0];
  };
  const ipc = {
    startDirectoryUpload: async (...args) => start('directory', args),
    startUpload: async (...args) => start('file', args),
    capabilities: async () => ({ hasDirectories: true, canRename: true }),
    createDirectory: async (...args) => calls.push(['mkdir', ...args]),
    listDirectory: async () => [],
    renamePath: async (...args) => calls.push(['publish', ...args]),
  };
  const dependencies = {
    zustand: { create },
    '@/lib/ipc': {
      ipc,
      inspectUploadPaths: async (paths) => {
        if (options.inspectError) throw new Error('Unreadable selection');
        return paths.map(path => path === folder.path ? folder : single);
      },
      verifyUploadDirectories: async (...args) => {
        calls.push(['verify', ...args]);
        if (options.verifyError) throw new Error('assets directory missing');
      },
      onTransferEvent: async (cb) => { event = cb; return () => {}; },
      onTransferProgressBatch: async () => () => {},
      onTransferQueue: async () => () => {},
    },
    './settingsStore': { useSettings: { getState: () => ({ overwritePolicy: 'overwrite', promptOnOverwrite: false }) } },
    './toastStore': { toast: { error() {}, info() {}, success() {} } },
    './conflictStore': { useConflicts: { getState: () => { throw new Error('unexpected conflict prompt'); } } },
    '@/lib/format': { baseName: path => path.split(/[\\/]/).pop() },
    '@/lib/types': { LOCAL_SESSION: 'local' },
  };
  const exports = {};
  vm.runInNewContext(code, { exports, crypto: webcrypto, require: name => {
    assert.ok(dependencies[name], `unexpected dependency ${name}`);
    return dependencies[name];
  } });
  const store = exports.useTransfers;
  await store.getState().initListeners();
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  return { store, single, folder, calls, settle };
}

test('mixed upload queues every file and folder with the inventoried fingerprint', async () => {
  const { store, single, folder, calls, settle } = await harness();
  await store.getState().enqueueUploads('server', [single, folder], '/target/subfolder');
  await settle();
  const report = store.getState().uploadReports[0];
  assert.equal(report.files, 3);
  assert.equal(report.transferIds.length, 3);
  assert.equal(report.validation, 'done');
  assert.equal(report.verifiedDirectories, 2);
  assert.equal(calls.find(call => call[0] === 'directory')[3], '/target/subfolder');
  assert.equal(calls.find(call => call[0] === 'directory')[5], 'tree-fingerprint');
});
test('preparation errors are retained when the progress panel is hidden', async () => {
  const { store, folder } = await harness({ startError: true });
  await store.getState().enqueueUploads('server', [folder], '/target');
  store.getState().setPanelOpen(false);
  assert.equal(store.getState().uploadReports[0].errors.length, 1);
  assert.equal(store.getState().uploadReports[0].retryItems[0].path, folder.path);
});
test('an inventory error prevents every remote mutation', async () => {
  const { store, folder, calls } = await harness({ inspectError: true });
  await store.getState().enqueueUploads('server', [folder], '/target', true);
  assert.equal(calls.length, 0);
  assert.equal(store.getState().uploadReports[0].errors.length, 1);
});
test('upload reports can be hidden and reopened without losing failures or transfer rows', async () => {
  const { store, folder } = await harness({ fileError: true });
  await store.getState().enqueueUploads('server', [folder], '/target');
  const reportId = store.getState().uploadReports[0].id;
  store.getState().setUploadReportsOpen(false);
  assert.equal(store.getState().uploadReportsOpen, false);
  assert.equal(store.getState().uploadReports[0].id, reportId);
  assert.equal(Object.values(store.getState().byId).filter(t => t.status === 'error').length, 2);
  store.getState().setPanelOpen(false);
  store.getState().togglePanel();
  assert.equal(store.getState().uploadReportsOpen, true);
  assert.equal(store.getState().uploadReports[0].id, reportId);
});
test('a new upload reopens hidden reports and closing Transfers hides both panels', async () => {
  const { store, single } = await harness();
  store.getState().setUploadReportsOpen(false);
  await store.getState().enqueueUploads('server', [single], '/target');
  assert.equal(store.getState().uploadReportsOpen, true);
  store.getState().setPanelOpen(false);
  assert.equal(store.getState().uploadReportsOpen, false);
  assert.equal(store.getState().panelOpen, false);
});
test('staged publication happens once, only after final verification', async () => {
  const { store, folder, calls, settle } = await harness();
  await store.getState().enqueueUploads('server', [folder], '/target', true);
  await settle();
  assert.equal(calls.filter(call => call[0] === 'publish').length, 1);
  assert.ok(calls.findIndex(call => call[0] === 'verify') < calls.findIndex(call => call[0] === 'publish'));
  assert.match(store.getState().uploadReports[0].destination, /^\/target\/release-/);
});
for (const options of [{ fileError: true }, { verifyError: true }, { volumeMismatch: true }]) {
  test(`staging cannot publish after ${Object.keys(options)[0]}`, async () => {
    const { store, folder, calls, settle } = await harness(options);
    await store.getState().enqueueUploads('server', [folder], '/target', true);
    await settle();
    assert.equal(calls.filter(call => call[0] === 'publish').length, 0);
    assert.notEqual(store.getState().uploadReports[0].validation, 'done');
  });
}
