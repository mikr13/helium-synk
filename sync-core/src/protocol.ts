export const PROTOCOL_VERSION = 1 as const;
export const MAX_BATCH = 100;
export const MAX_TRANSFER_BYTES = 512 * 1_024;
export const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

// Browser permissions are enabled only when their capture/application adapters are ready.
export interface Envelope {
  protocol_version: 1;
  operation_id: string;
  account_id: string;
  device_id: string;
  counter: number;
  domain: 'diagnostic' | 'bookmark' | 'session';
  key_epoch: 1;
  nonce: string;
  ciphertext: string;
}

export interface RecordEntry {
  sequence: number;
  envelope: Envelope;
}
export interface PullPage {
  server_epoch: string;
  records: RecordEntry[];
  next_cursor: number;
  has_more: boolean;
}
export interface PushReply {
  server_epoch: string;
  acknowledgements: { operation_id: string; sequence: number }[];
}
export interface Diagnostic {
  kind: 'diagnostic';
  note: string;
  created_at: string;
}
export interface Credentials {
  account_id: string;
  device_id: string;
  token: string;
  server_url: string;
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
export function validCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
export function validateEnvelope(e: Envelope): void {
  if (
    !e ||
    e.protocol_version !== 1 ||
    !['diagnostic', 'bookmark', 'session'].includes(e.domain) ||
    e.key_epoch !== 1 ||
    !isUuid(e.operation_id) ||
    !isUuid(e.account_id) ||
    !isUuid(e.device_id) ||
    !validCounter(e.counter) ||
    typeof e.nonce !== 'string' ||
    typeof e.ciphertext !== 'string' ||
    e.ciphertext.length > 90_000
  ) {
    throw new Error('Unsupported or invalid encrypted record.');
  }
}

export function serverUrl(value: string): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error('Use an HTTPS server origin, or HTTP localhost for development.');
  }
  return url.origin;
}
export function parseCredentials(value: unknown): Credentials {
  const c = value as Credentials;
  if (
    !c ||
    !isUuid(c.account_id) ||
    !isUuid(c.device_id) ||
    typeof c.token !== 'string' ||
    !/^[0-9a-f]{64}$/.test(c.token) ||
    typeof c.name !== 'string' ||
    c.name.length < 1 ||
    c.name.length > 100 ||
    typeof c.server_url !== 'string'
  ) {
    throw new Error('Invalid device credential file.');
  }
  return { ...c, server_url: serverUrl(c.server_url) };
}

const ENVELOPE_FIELDS = [
  'protocol_version',
  'operation_id',
  'account_id',
  'device_id',
  'counter',
  'domain',
  'key_epoch',
  'nonce',
  'ciphertext',
] as const;
/** JSON member order is not part of envelope identity across Rust/JavaScript serializers. */
export function sameEnvelope(a: Envelope, b: Envelope): boolean {
  return ENVELOPE_FIELDS.every((field) => a[field] === b[field]);
}

/** Keep legitimate large records below the relay body limit without ever discarding a row. */
export function envelopeBatch(pending: readonly Envelope[]): Envelope[] {
  const batch: Envelope[] = [];
  let bytes = 512; // Fixed request fields, epoch and punctuation.
  for (const envelope of pending.slice(0, MAX_BATCH)) {
    const size = new TextEncoder().encode(JSON.stringify(envelope)).byteLength + 1;
    if (size + 512 > MAX_TRANSFER_BYTES)
      throw new Error('Queued envelope exceeds the transfer limit. Pending work was retained.');
    if (bytes + size > MAX_TRANSFER_BYTES) break;
    batch.push(envelope);
    bytes += size;
  }
  return batch;
}
