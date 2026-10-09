import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Keep failed attempts off stdout so redirected JSON contains only a complete response.
export function retry(command, args, {
  run = spawnSync,
  wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
  log = message => console.error(message),
  attempts = 4,
} = {}) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = run(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (result.status === 0) return result;
    const permanent = /HTTP (400|401|403|404|422)|release not found|not logged into/i.test(result.stderr || '')
      && !/rate limit/i.test(result.stderr || '');
    if (result.error || result.signal || permanent || attempt === attempts) {
      throw new Error(result.error?.message || result.stderr || `${command} failed (${result.signal || result.status})`);
    }
    const delay = 5000 * 2 ** (attempt - 1);
    log(`${command} failed; retrying in ${delay / 1000}s (${attempt}/${attempts}).`);
    wait(delay);
  }
}

export function requiredAssets(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a version such as 1.2.3');
  return [
    ...['faro-cli', 'faro-agentd'].flatMap(binary =>
      ['macos-arm64', 'macos-x86_64', 'linux-x86_64', 'windows-x86_64.exe'].map(platform => `${binary}-${platform}`)),
    'install-agentd.sh',
    `Faro_${version}_universal.dmg`,
    'Faro_universal.app.tar.gz',
    `Faro_${version}_x64-setup.exe`,
    `Faro_${version}_x64_en-US.msi`,
    `Faro_${version}_x64-portable.zip`,
    `Faro_${version}_amd64.AppImage`,
    `Faro_${version}_amd64.deb`,
    `Faro-${version}-1.x86_64.rpm`,
  ];
}

export function verifyAssets(release, version) {
  if (release.tagName !== `v${version}`) throw new Error('Release tag does not match the expected version');
  if (!Array.isArray(release.assets)) throw new Error('Release asset listing is missing');
  const names = new Set();
  for (const asset of release.assets) {
    if (names.has(asset.name)) throw new Error(`Duplicate release asset: ${asset.name}`);
    names.add(asset.name);
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0) throw new Error(`Empty or invalid release asset: ${asset.name}`);
  }
  const missing = requiredAssets(version).filter(name => !names.has(name));
  if (missing.length) throw new Error(`Release is incomplete: ${missing.join(', ')}`);
}

function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'gh') {
    const result = retry('gh', args);
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
  } else if (mode === 'verify-assets' && args.length === 2) {
    verifyAssets(JSON.parse(readFileSync(args[0], 'utf8')), args[1]);
    console.log('All required release downloads are present and nonempty.');
  } else {
    throw new Error('Usage: release-tools.mjs gh <args...> | verify-assets <release.json> <version>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
