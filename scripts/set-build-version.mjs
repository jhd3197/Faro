import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Stamp a version into the build tree (never committed). Used by the dev → main
// test builds, which must not touch the version in git. `1.4.23-7` is the
// shape WiX accepts: Tauri turns a numeric-only pre-release into the MSI's
// fourth field (1.4.23.7). A label such as `-test.7` fails the MSI bundle.
export const TEST_VERSION = /^\d+\.\d+\.\d+-\d{1,5}$/;

const CARGO_MANIFESTS = [
  'src-tauri/Cargo.toml',
  'src-tauri/faro-cli/Cargo.toml',
  'src-tauri/faro-agent-proto/Cargo.toml',
  'src-tauri/faro-agentd/Cargo.toml',
];

/** Replace the first `version = "..."` line, the [package] one. */
export function withCargoVersion(text, version) {
  return text.replace(/^version = ".*"/m, `version = "${version}"`);
}

export function withTauriVersion(text, version) {
  const config = JSON.parse(text);
  config.version = version;
  return JSON.stringify(config, null, 2) + '\n';
}

export function setBuildVersion(version, root = '.') {
  if (!TEST_VERSION.test(version) || Number(version.split('-')[1]) > 65535) {
    throw new Error('Expected a test version such as 1.4.23-7 (numeric pre-release, at most 65535)');
  }
  const conf = `${root}/src-tauri/tauri.conf.json`;
  writeFileSync(conf, withTauriVersion(readFileSync(conf, 'utf8'), version));
  for (const manifest of CARGO_MANIFESTS) {
    const file = `${root}/${manifest}`;
    writeFileSync(file, withCargoVersion(readFileSync(file, 'utf8'), version));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: set-build-version.mjs <version>');
    setBuildVersion(process.argv[2]);
    console.log(`Build version set to ${process.argv[2]}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
