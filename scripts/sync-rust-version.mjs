import { readFileSync, writeFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../server/package.json', import.meta.url), 'utf8'));
const path = new URL('../server/Cargo.toml', import.meta.url);
const original = readFileSync(path, 'utf8');
const match = original.match(/^version = "([^"]+)"$/m);
if (!match) throw new Error('Server crate must have an explicit version.');
if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)) throw new Error('Invalid server package version.');
if (process.argv.includes('--check')) {
  if (match[1] !== manifest.version) throw new Error('Server versions differ. Run pnpm version-packages.');
} else {
  writeFileSync(path, original.replace(/^version = "[^"]+"$/m, `version = "${manifest.version}"`));
}
