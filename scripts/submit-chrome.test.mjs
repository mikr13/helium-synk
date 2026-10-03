import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { test } from 'node:test';
import { normalizeChromeKey } from './submit-chrome.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

test('PEM, escaped newlines, JSON strings and service-account JSON retain the signing key', () => {
  const message = Buffer.from('synthetic Google service-account JWT');
  for (const input of [
    pem,
    pem.replace(/\n/g, '\\n'),
    JSON.stringify(pem),
    JSON.stringify({ private_key: pem }),
  ]) {
    const normalized = normalizeChromeKey(input);
    assert.equal(
      verify('RSA-SHA256', message, publicKey, sign('RSA-SHA256', message, normalized)),
      true,
    );
  }
});

test('invalid or unrelated secrets fail without including their contents', () => {
  const sentinel = 'synthetic-private-secret-sentinel';
  for (const input of [undefined, sentinel, JSON.stringify({ client_email: sentinel })])
    assert.throws(
      () => normalizeChromeKey(input),
      (error) =>
        error.message.includes('complete RSA private_key PEM') && !error.message.includes(sentinel),
    );
});
