import { validateEnvelope, type Diagnostic, type Envelope } from './protocol';
import { validatePayload, type Payload } from './payload';

export function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}
export function unbase64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
export function generateRecoveryKey(): string {
  return base64(crypto.getRandomValues(new Uint8Array(32)));
}
export function validateRecoveryKey(value: string): void {
  try {
    if (unbase64(value).byteLength !== 32) throw new Error();
  } catch {
    throw new Error('The recovery key must be a base64-encoded 256-bit key.');
  }
}
type Header = Omit<Envelope, 'nonce' | 'ciphertext'>;
function associatedData(e: Header): Uint8Array<ArrayBuffer> {
  // Fixed field order is part of protocol v1; do not depend on object insertion order.
  return new TextEncoder().encode(
    JSON.stringify([
      e.protocol_version,
      e.operation_id,
      e.account_id,
      e.device_id,
      e.counter,
      e.domain,
      e.key_epoch,
    ]),
  );
}
async function authorKey(root: string, e: Header): Promise<CryptoKey> {
  validateRecoveryKey(root);
  const material = await crypto.subtle.importKey('raw', unbase64(root), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(e.account_id),
      info: new TextEncoder().encode(`helium-synk:v1:${e.domain}:${e.device_id}:${e.key_epoch}`),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function encryptPayload(
  root: string,
  header: Header,
  payload: Payload,
  indexKey?: string,
): Promise<Envelope> {
  validateEnvelope({ ...header, nonce: '', ciphertext: '' });
  validatePayload(payload, header);
  await validateHistoryTag(root, header, payload, indexKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await authorKey(root, header);
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: nonce,
      additionalData: associatedData(header),
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { ...header, nonce: base64(nonce), ciphertext: base64(new Uint8Array(encrypted)) };
}
export async function decryptPayload(
  root: string,
  envelope: Envelope,
  indexKey?: string,
): Promise<Payload> {
  validateEnvelope(envelope);
  const iv = unbase64(envelope.nonce);
  if (iv.length !== 12) throw new Error('Invalid encryption nonce.');
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: associatedData(envelope),
      tagLength: 128,
    },
    await authorKey(root, envelope),
    unbase64(envelope.ciphertext),
  );
  const payload = JSON.parse(new TextDecoder().decode(plaintext)) as Payload;
  validatePayload(payload, envelope);
  await validateHistoryTag(root, envelope, payload, indexKey);
  return payload;
}
export function encryptDiagnostic(
  root: string,
  header: Header,
  payload: Diagnostic,
): Promise<Envelope> {
  return encryptPayload(root, header, payload);
}
export async function decryptDiagnostic(root: string, envelope: Envelope): Promise<Diagnostic> {
  const payload = await decryptPayload(root, envelope);
  if (payload.kind !== 'diagnostic') throw new Error('Expected a diagnostic record.');
  return payload;
}

/** Stable account index key is kept separately so later content-key rotation need not retag clear barriers. */
export async function deriveHistoryIndexKey(root: string, account: string): Promise<string> {
  validateRecoveryKey(root);
  const key = await crypto.subtle.importKey('raw', unbase64(root), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(account),
      info: new TextEncoder().encode('helium-synk:v1:history-url-index'),
    },
    key,
    256,
  );
  return base64(new Uint8Array(bits));
}
export async function historyUrlTag(indexKey: string, url: string): Promise<string> {
  validateRecoveryKey(indexKey);
  const key = await crypto.subtle.importKey(
    'raw',
    unbase64(indexKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(url)),
  );
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function validateHistoryTag(
  root: string,
  header: Header,
  payload: Payload,
  indexKey?: string,
): Promise<void> {
  if (payload.kind === 'history' && payload.action.type === 'visit') {
    const key = indexKey ?? (await deriveHistoryIndexKey(root, header.account_id));
    if ((await historyUrlTag(key, payload.action.visit.url)) !== payload.action.visit.url_tag)
      throw new Error('History URL tag does not match its encrypted URL.');
  }
}
