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
const extensionDir = join(root, 'extension/.output/chrome-mv3');
const manifest = JSON.parse(readFileSync(join(extensionDir, 'manifest.json'), 'utf8'));
const extension = JSON.parse(readFileSync(join(root, 'extension/package.json'), 'utf8'));
const server = JSON.parse(readFileSync(join(root, 'server/package.json'), 'utf8'));
if (manifest.manifest_version !== 3 || manifest.version !== extension.version)
  throw new Error('Extension manifest/version mismatch.');
const required = [
  manifest.background.service_worker,
  manifest.options_ui.page,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
];
for (const path of required) {
  if (
    !path ||
    resolve(extensionDir, path).startsWith(extensionDir + '/') === false ||
    !existsSync(join(extensionDir, path))
  )
    throw new Error(`Missing or invalid packaged entrypoint: ${path}`);
}
const binary = join(root, 'target/release/synk-server');
if (!existsSync(binary)) throw new Error('Build the Rust release binary first.');
const output = join(root, 'release');
mkdirSync(output, { recursive: true });
const zipName = `helium-synk-extension-${extension.version}.zip`;
const binaryName = `synk-server-${server.version}-${process.platform}-${process.arch}`;
// Replace only these generated artifacts; never touch credentials/databases or unrelated release files.
rmSync(join(output, zipName), { force: true });
execFileSync('zip', ['-qr', join(output, zipName), '.'], { cwd: extensionDir });
cpSync(binary, join(output, binaryName));
execFileSync(join(output, binaryName), ['--help'], { stdio: 'ignore' });
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const digest = (name) =>
  createHash('sha256')
    .update(readFileSync(join(output, name)))
    .digest('hex');
const artifacts = [zipName, binaryName].map((name) => ({
  name,
  bytes: statSync(join(output, name)).size,
  sha256: digest(name),
}));
const metadata = {
  built_at: new Date().toISOString(),
  source_commit: git('rev-parse', 'HEAD'),
  uncommitted_changes: git('status', '--porcelain').length > 0,
  versions: { extension: extension.version, server: server.version, vite_plus: '1.0.0' },
  target: `${process.platform}-${process.arch}`,
  protocol: 1,
  relay_schema: 5,
  client_schema: 10,
  node: process.version,
  sqlite_libraries:
    process.platform === 'darwin'
      ? execFileSync('otool', ['-L', binary], { encoding: 'utf8' })
          .split('\n')
          .slice(1)
          .map((line) => line.trim())
          .filter(Boolean)
      : [],
  artifacts,
};
writeFileSync(join(output, 'build.json'), JSON.stringify(metadata, null, 2) + '\n');
writeFileSync(
  join(output, 'SHA256SUMS'),
  artifacts.map((a) => `${a.sha256}  ${a.name}`).join('\n') + '\n',
);
for (const { name, bytes, sha256 } of artifacts)
  console.log(`${name}: ${bytes} bytes, SHA-256 ${sha256}`);
console.log(`Release candidate: ${output}. Uncommitted source: ${metadata.uncommitted_changes}.`);
