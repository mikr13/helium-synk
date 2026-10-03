import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const numericVersion = /^\d+\.\d+\.\d+$/;
const newer = (left, right) => {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
};

export function planRelease(extensionVersion, serverVersion, releases, tags) {
  if (!numericVersion.test(extensionVersion) || extensionVersion !== serverVersion)
    throw new Error('Release versions must match. Review and merge pnpm version-packages.');
  const tag = `v${extensionVersion}`;
  const existing = releases.find((release) => release.tagName === tag);
  if (existing?.isDraft)
    throw new Error(`${tag} is still a draft. Resolve the existing draft before automation.`);
  let reason = existing ? `${tag} is already published; merge a Changesets version bump.` : '';
  if (
    releases.some(
      (release) =>
        !release.isDraft &&
        numericVersion.test(release.tagName.slice(1)) &&
        release.tagName.startsWith('v') &&
        newer(release.tagName.slice(1), extensionVersion),
    )
  )
    reason = `${tag} is older than a published release; skipping the stale build.`;
  if (!reason && tags.includes(tag))
    throw new Error(`${tag} already exists without a release. Resolve the tag before automation.`);
  return { version: extensionVersion, tag, release: !reason, reason };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const manifest = (name) =>
    JSON.parse(readFileSync(new URL(`../${name}/package.json`, import.meta.url), 'utf8'));
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
  if (!process.env.GH_REPO) throw new Error('GH_REPO is required.');
  const releases = JSON.parse(
    gh(
      'release',
      'list',
      '--repo',
      process.env.GH_REPO,
      '--limit',
      '1000',
      '--json',
      'tagName,isDraft',
    ),
  );
  const tags = gh(
    'api',
    '--paginate',
    `repos/${process.env.GH_REPO}/tags`,
    '--jq',
    '.[].name',
  ).split('\n');
  const plan = planRelease(
    manifest('extension').version,
    manifest('server').version,
    releases,
    tags,
  );
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `version=${plan.version}\ntag=${plan.tag}\nrelease=${plan.release}\n`,
    );
  const message = plan.reason || `Build and publish ${plan.tag} from the checked source commit.`;
  console.log(message);
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n`);
}
