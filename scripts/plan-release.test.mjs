import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planRelease } from './plan-release.mjs';

test('a new Changesets package version produces its exact release tag', () => {
  assert.deepEqual(
    planRelease('0.2.1', '0.2.1', [{ tagName: 'v0.2.0', isDraft: false }], ['v0.2.0']),
    {
      version: '0.2.1',
      tag: 'v0.2.1',
      release: true,
      reason: '',
    },
  );
});

test('repeated merges and delayed older builds do not republish or downgrade', () => {
  const releases = [{ tagName: 'v0.2.10', isDraft: false }];
  assert.equal(planRelease('0.2.10', '0.2.10', releases, ['v0.2.10']).release, false);
  assert.equal(planRelease('0.2.9', '0.2.9', releases, ['v0.2.10']).release, false);
  assert.equal(planRelease('0.2.11', '0.2.11', releases, ['v0.2.10']).release, true);
});

test('drafts and orphan tags require resolution rather than overwriting assets', () => {
  assert.throws(
    () => planRelease('0.2.0', '0.2.0', [{ tagName: 'v0.2.0', isDraft: true }], []),
    /still a draft/,
  );
  assert.throws(() => planRelease('0.2.0', '0.2.0', [], ['v0.2.0']), /without a release/);
});

test('inconsistent package versions and unsupported versions fail before publishing', () => {
  assert.throws(() => planRelease('0.2.0', '0.2.1', [], []), /versions must match/);
  assert.throws(() => planRelease('0.2.1-beta.1', '0.2.1-beta.1', [], []), /versions must match/);
});
