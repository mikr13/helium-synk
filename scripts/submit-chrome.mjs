import { spawnSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function normalizeChromeKey(raw) {
  try {
    let value = raw?.trim();
    if (value?.startsWith('{') || value?.startsWith('"')) {
      const parsed = JSON.parse(value);
      value = typeof parsed === 'string' ? parsed : parsed.private_key;
    }
    const key = createPrivateKey(value.replace(/\\r\\n|\\n/g, '\n'));
    if (key.asymmetricKeyType !== 'rsa') throw new Error('RSA required');
    return key.export({ type: 'pkcs8', format: 'pem' }).toString();
  } catch {
    throw new Error(
      'CHROME_SERVICE_ACCOUNT_PRIVATE_KEY must contain the complete RSA private_key PEM from the Google service-account JSON. Replace that GitHub secret; key contents are not logged.',
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const privateKey = normalizeChromeKey(process.env.CHROME_SERVICE_ACCOUNT_PRIVATE_KEY);
    // Run WXT with the normalized key only in memory; never persist or print the credential.
    const result = spawnSync(
      'pnpm',
      ['--filter', '@helium-synk/extension', 'exec', 'wxt', 'submit', ...process.argv.slice(2)],
      {
        stdio: 'inherit',
        env: { ...process.env, CHROME_SERVICE_ACCOUNT_PRIVATE_KEY: privateKey },
      },
    );
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
