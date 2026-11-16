import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
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

// The app shows only the text between these markers, never the download tables.
export const CHANGES_START = '<!-- faro:changes -->';
export const CHANGES_END = '<!-- /faro:changes -->';

/** Pick the merged PR into main from `GET /commits/{sha}/pulls`, newest first. */
export function mergedPull(pulls) {
  if (!Array.isArray(pulls)) return null;
  return pulls
    .filter(pr => pr?.merged_at && pr.base?.ref === 'main')
    .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at))[0] ?? null;
}

/** The `Highlights` list of a PR body, or null when the PR has none. */
export function highlights(body) {
  if (typeof body !== 'string') return null;
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex(line => /^#{2,4}\s+Highlights\s*$/i.test(line.trim()));
  if (start < 0) return null;
  const section = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,4}\s/.test(line.trim()) || /^<details/i.test(line.trim()) || /^(---+|\*\*\*+)$/.test(line.trim())) break;
    section.push(line.replace(/<!--|-->/g, ''));
  }
  const text = section.join('\n').trim();
  return text || null;
}

/** The marked "what changed" block for a release, or '' when there is nothing to say. */
export function changesSection(pull) {
  const list = highlights(pull?.body);
  if (!list) return '';
  const title = typeof pull.title === 'string' ? pull.title.replace(/<!--|-->/g, '').trim() : '';
  return [CHANGES_START, ...(title ? [`### ${title}`, ''] : []), list, CHANGES_END, ''].join('\n');
}

/** latest.json with its `notes` replaced; the signatures cover artifacts, not this field. */
export function withNotes(manifest, changes) {
  return { ...manifest, notes: changes.trim() };
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
  } else if (mode === 'changes' && args.length === 1) {
    process.stdout.write(changesSection(mergedPull(JSON.parse(readFileSync(args[0], 'utf8')))));
  } else if (mode === 'set-notes' && args.length === 2) {
    const manifest = JSON.parse(readFileSync(args[0], 'utf8'));
    writeFileSync(args[0], JSON.stringify(withNotes(manifest, readFileSync(args[1], 'utf8')), null, 2) + '\n');
  } else {
    throw new Error('Usage: release-tools.mjs gh <args...> | verify-assets <release.json> <version>'
      + ' | changes <commit-pulls.json> | set-notes <latest.json> <changes.md>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
