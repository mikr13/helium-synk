import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'synk-package-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['scripts', 'server', 'extension/.output/chrome-mv3', 'release'])
    mkdirSync(join(root, path), { recursive: true });
  cpSync(
    new URL('./package-release.mjs', import.meta.url),
    join(root, 'scripts/package-release.mjs'),
  );
  writeFileSync(join(root, '.gitignore'), 'release/\ntarget/\nextension/.output/\n');
  for (const name of ['extension', 'server'])
    writeFileSync(join(root, name, 'package.json'), JSON.stringify({ version: '0.2.0' }));
  const manifest = {
    manifest_version: 3,
    version: '0.2.0',
    background: { service_worker: 'background.js' },
    options_ui: { page: 'options.html' },
    action: { default_popup: 'popup.html' },
    icons: { 128: 'icon.png' },
  };
  const directory = join(root, 'extension/.output/chrome-mv3');
  const saveManifest = () =>
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
  saveManifest();
  for (const name of ['background.js', 'options.html', 'popup.html', 'icon.png'])
    writeFileSync(join(directory, name), 'fixture');
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Release test',
      '-c',
      'user.email=release@example.invalid',
      'commit',
      '-qm',
      'fixture',
    ],
    { cwd: root },
  );
  const run = (mode) =>
    spawnSync(process.execPath, [join(root, 'scripts/package-release.mjs'), mode], {
      cwd: root,
      encoding: 'utf8',
    });
  const zip = join(root, 'release/helium-synk-extension-0.2.0.zip');
  const proofPath = join(root, 'release/extension-build.json');
  return { root, manifest, saveManifest, run, zip, proofPath };
}

test('canonical extension and relay bundle share the ZIP; private release files stay untouched', (t) => {
  const f = fixture(t);
  const privatePath = join(f.root, 'release/private.credential.json');
  writeFileSync(privatePath, 'private sentinel');
  assert.equal(f.run('--extension-only').status, 0);
  const proof = JSON.parse(readFileSync(f.proofPath, 'utf8'));
  assert.equal(proof.uncommitted_changes, false);
  assert.deepEqual(
    proof.artifacts.map((item) => item.name),
    ['helium-synk-extension-0.2.0.zip'],
  );
  assert.equal(f.run('--verify-extension').status, 0);
  // A native executable exercises binary copying/permissions without depending on a relay build.
  mkdirSync(join(f.root, 'target/release'), { recursive: true });
  cpSync(process.execPath, join(f.root, 'target/release/synk-server'));
  const result = f.run('--relay-only');
  assert.equal(result.status, 0, result.stderr);
  const bundle = JSON.parse(readFileSync(join(f.root, 'release/build.json'), 'utf8'));
  assert.deepEqual(bundle.artifacts[0], proof.artifacts[0]);
  assert.equal(bundle.target, `${process.platform}-${process.arch}`);
  assert.equal(bundle.artifacts.length, 2);
  assert.equal(readFileSync(privatePath, 'utf8'), 'private sentinel');
});

test('publishing refuses a tampered ZIP', (t) => {
  const f = fixture(t);
  assert.equal(f.run('--extension-only').status, 0);
  writeFileSync(f.zip, 'tampered archive');
  const result = f.run('--verify-extension');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /source\/checksum/);
});

test('publishing refuses a different source commit or dirty build', (t) => {
  const f = fixture(t);
  assert.equal(f.run('--extension-only').status, 0);
  const proof = JSON.parse(readFileSync(f.proofPath, 'utf8'));
  writeFileSync(f.proofPath, JSON.stringify({ ...proof, source_commit: '0'.repeat(40) }));
  assert.notEqual(f.run('--verify-extension').status, 0);
  writeFileSync(f.proofPath, JSON.stringify({ ...proof, uncommitted_changes: true }));
  assert.notEqual(f.run('--verify-extension').status, 0);
});

test('packaging refuses escaping/missing entrypoints and mismatched versions', (t) => {
  const f = fixture(t);
  f.manifest.background.service_worker = '../outside.js';
  f.saveManifest();
  assert.match(f.run('--extension-only').stderr, /invalid packaged entrypoint/);
  f.manifest.background.service_worker = 'missing.js';
  f.saveManifest();
  assert.match(f.run('--extension-only').stderr, /invalid packaged entrypoint/);
  f.manifest.version = '9.9.9';
  f.saveManifest();
  assert.match(f.run('--extension-only').stderr, /manifest\/version mismatch/);
});
