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
