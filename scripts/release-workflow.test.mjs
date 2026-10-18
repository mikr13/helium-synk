import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
const jobs = ['relay', 'publish', 'chrome'];
const successfulNeeds = {
  plan: { result: 'success', outputs: { release: 'true' } },
  extension: { result: 'success' },
  relay: { result: 'success' },
  publish: { result: 'success' },
};

test('release targets are Apple silicon and both Linux architectures', () => {
  const targets = [
    ...workflow.matchAll(/- runner: (\S+)\n\s+platform: (\S+)\n\s+arch: (\S+)/g),
  ].map(([, , platform, arch]) => `${platform}-${arch}`);
  assert.deepEqual(targets, ['darwin-arm64', 'linux-x64', 'linux-arm64']);
});

function eligible(job, needs, cancelled = false) {
  const block = workflow.split(`\n  ${job}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
  const expression = block?.match(/^    if: >-\n((?:      .+\n)+)/m)?.[1].trim();
  // GitHub applies an implicit success() across skipped ancestors unless a status function is explicit.
  // The automatic path intentionally skips the manual-only checks ancestor.
  if (!expression || !/\b(?:always|cancelled|failure|success)\(/.test(expression)) return false;
  return runInNewContext(expression, { needs, cancelled: () => cancelled });
}

test('successful automatic builds survive the skipped manual-checks ancestor through Chrome', () => {
  for (const job of jobs) assert.equal(eligible(job, successfulNeeds), true, job);
});

test('each publication gate rejects failure or skipping of its required predecessor', () => {
  for (const [job, predecessor] of [
    ['relay', 'extension'],
    ['publish', 'relay'],
    ['chrome', 'publish'],
  ])
    for (const result of ['failure', 'skipped', 'cancelled'])
      assert.equal(
        eligible(job, { ...successfulNeeds, [predecessor]: { result } }),
        false,
        `${job}: ${result}`,
      );
});

test('failed planning, already-released versions and cancellation cannot publish', () => {
  for (const job of jobs) {
    assert.equal(eligible(job, { ...successfulNeeds, plan: { result: 'failure' } }), false, job);
    assert.equal(eligible(job, successfulNeeds, true), false, job);
  }
  assert.equal(
    eligible('relay', {
      ...successfulNeeds,
      plan: { result: 'success', outputs: { release: 'false' } },
    }),
    false,
  );
});

test('Mac releases require signing and notarization before packaging and clean up keys on failure', () => {
  const block = workflow.split('\n  relay:\n')[1].split('\n  publish:\n')[0];
  assert.ok(
    block.indexOf('python3 scripts/macos-signing.py') <
      block.indexOf('python3 scripts/build-macos-app.py --notarize'),
  );
  assert.ok(
    block.indexOf('python3 scripts/build-macos-app.py --notarize') <
      block.indexOf('node scripts/package-release.mjs --relay-only'),
  );
  assert.match(
    block,
    /if: always\(\) && matrix\.platform == 'darwin'\n        run: python3 scripts\/macos-signing\.py cleanup/,
  );
  assert.match(workflow, /sha256sum[^\n]+\.dmg appcast\.xml > SHA256SUMS/);
  assert.match(
    workflow,
    /"helium-synk-server-\$VERSION-"\*\.dmg "helium-synk-server-\$VERSION-"\*-build\.json/,
  );
});

test('signed update feed is validated and uploaded before a draft release becomes public', () => {
  assert.match(workflow, /SPARKLE_ED_PRIVATE_KEY: \$\{\{ secrets\.SPARKLE_ED_PRIVATE_KEY \}\}/);
  assert.match(workflow, /python3 scripts\/macos-update\.py --verify artifacts/);
  assert.match(workflow, /gh release create "v\$VERSION" --draft --target/);
  assert.ok(
    workflow.indexOf('appcast.xml extension-build.json SHA256SUMS') <
      workflow.indexOf('gh release edit "v$VERSION" --draft=false --latest'),
  );
});
