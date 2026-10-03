import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const mode = process.argv[2] ?? '--all';
if (!['--all', '--extension-only', '--relay-only', '--verify-extension'].includes(mode))
  throw new Error(`Unknown packaging mode: ${mode}`);
const extensionDir = join(root, 'extension/.output/chrome-mv3');
const extension = JSON.parse(readFileSync(join(root, 'extension/package.json'), 'utf8'));
const server = JSON.parse(readFileSync(join(root, 'server/package.json'), 'utf8'));
if (extension.version !== server.version || !/^\d+\.\d+\.\d+$/.test(extension.version))
  throw new Error('Release package versions must match and use numeric x.y.z.');
function validateManifest(manifest, contains) {
  if (manifest.manifest_version !== 3 || manifest.version !== extension.version)
    throw new Error('Extension manifest/version mismatch.');
  const required = [
    manifest.background?.service_worker,
    manifest.options_ui?.page,
    manifest.action?.default_popup,
    ...Object.values(manifest.icons ?? {}),
  ];
  if (!Object.keys(manifest.icons ?? {}).length) throw new Error('Missing packaged icons.');
  for (const path of required) {
    if (
      !path ||
      resolve(extensionDir, path).startsWith(extensionDir + '/') === false ||
      !contains(path)
    )
      throw new Error(`Missing or invalid packaged entrypoint: ${path}`);
  }
}
const binary = join(root, 'target/release/synk-server');
const output = join(root, 'release');
mkdirSync(output, { recursive: true });
const zipName = `helium-synk-extension-${extension.version}.zip`;
const binaryName = `synk-server-${server.version}-${process.platform}-${process.arch}`;
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const digest = (name) =>
  createHash('sha256')
    .update(readFileSync(join(output, name)))
    .digest('hex');
const artifact = (name) => ({
  name,
  bytes: statSync(join(output, name)).size,
  sha256: digest(name),
});
const sourceCommit = git('rev-parse', 'HEAD');
if (mode === '--all' || mode === '--extension-only') {
  const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
  validateManifest(manifest, (path) => existsSync(join(extensionDir, path)));
  // Replace only generated artifacts, never unrelated/private release files.
  rmSync(join(output, zipName), { force: true });
  execFileSync('zip', ['-qr', join(output, zipName), '.'], { cwd: extensionDir });
} else {
  const proof = JSON.parse(readFileSync(join(output, 'extension-build.json'), 'utf8'));
  if (
    proof.source_commit !== sourceCommit ||
    proof.uncommitted_changes ||
    proof.versions?.extension !== extension.version ||
    proof.artifacts?.length !== 1 ||
    proof.artifacts[0].name !== zipName ||
    proof.artifacts[0].sha256 !== digest(zipName) ||
    proof.artifacts[0].bytes !== statSync(join(output, zipName)).size
  )
    throw new Error('Extension artifact does not match the clean release source/checksum.');
  const entries = execFileSync('unzip', ['-Z1', join(output, zipName)], {
    encoding: 'utf8',
  }).split('\n');
  const manifest = JSON.parse(
    execFileSync('unzip', ['-p', join(output, zipName), 'manifest.json'], { encoding: 'utf8' }),
  );
  validateManifest(manifest, (path) => entries.includes(path));
}
if (mode === '--verify-extension') {
  console.log(`Verified ${zipName} for source ${sourceCommit}.`);
  process.exit(0);
}
const extensionOnly = mode === '--extension-only';
if (!extensionOnly) {
  if (!existsSync(binary)) throw new Error('Build the Rust release binary first.');
  cpSync(binary, join(output, binaryName));
  execFileSync(join(output, binaryName), ['--help'], { stdio: 'ignore' });
}
const artifacts = (extensionOnly ? [zipName] : [zipName, binaryName]).map(artifact);
const metadata = {
  built_at: new Date().toISOString(),
  source_commit: sourceCommit,
  uncommitted_changes: git('status', '--porcelain').length > 0,
  versions: { extension: extension.version, server: server.version, vite_plus: '1.0.0' },
  target: extensionOnly ? 'chrome-mv3' : `${process.platform}-${process.arch}`,
  protocol: 1,
  relay_schema: 5,
  client_schema: 10,
  node: process.version,
  sqlite_libraries:
    !extensionOnly && process.platform === 'darwin'
      ? execFileSync('otool', ['-L', binary], { encoding: 'utf8' })
          .split('\n')
          .slice(1)
          .map((line) => line.trim())
          .filter(Boolean)
      : [],
  artifacts,
};
writeFileSync(
  join(output, extensionOnly ? 'extension-build.json' : 'build.json'),
  JSON.stringify(metadata, null, 2) + '\n',
);
writeFileSync(
  join(output, extensionOnly ? 'extension-SHA256SUMS' : 'SHA256SUMS'),
  artifacts.map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n',
);
for (const { name, bytes, sha256 } of artifacts)
  console.log(`${name}: ${bytes} bytes, SHA-256 ${sha256}`);
console.log(`Release candidate: ${output}. Uncommitted source: ${metadata.uncommitted_changes}.`);
