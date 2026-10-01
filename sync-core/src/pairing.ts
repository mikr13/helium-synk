import { SynkDatabase } from './database';
import { validateRecoveryKey } from './crypto';
import { isUuid, parseCredentials, serverUrl, type Credentials } from './protocol';

export interface PairingBundle {
  format: 'helium-synk-pairing';
  version: 1;
  account_id: string;
  server_url: string;
  server_epoch: string;
  invitation_token: string;
  expires_at: number;
  recovery_key: string;
  history_index_key: string;
}
export interface PairingCandidate {
  id: 'pairing';
  bundle: PairingBundle;
  credentials: Credentials;
}
const secret = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export function parsePairingBundle(value: unknown): PairingBundle {
  const bundle = value as PairingBundle;
  if (
    !bundle ||
    bundle.format !== 'helium-synk-pairing' ||
    bundle.version !== 1 ||
    !isUuid(bundle.account_id) ||
    !isUuid(bundle.server_epoch) ||
    !secret(bundle.invitation_token) ||
    !Number.isSafeInteger(bundle.expires_at) ||
    bundle.expires_at <= 0 ||
    typeof bundle.server_url !== 'string' ||
    typeof bundle.recovery_key !== 'string' ||
    typeof bundle.history_index_key !== 'string'
  )
    throw new Error('Invalid or unsupported pairing bundle.');
  validateRecoveryKey(bundle.recovery_key);
  validateRecoveryKey(bundle.history_index_key);
  return {
    format: 'helium-synk-pairing',
    version: 1,
    account_id: bundle.account_id,
    server_url: serverUrl(bundle.server_url),
    server_epoch: bundle.server_epoch,
    invitation_token: bundle.invitation_token,
    expires_at: bundle.expires_at,
    recovery_key: bundle.recovery_key,
    history_index_key: bundle.history_index_key,
  };
}
function apiError(status: number): Error {
  if (status === 401)
    return new Error('Pairing credentials were revoked. Check the trusted installation.');
  if (status === 409)
    return new Error(
      'Pairing identity or server history changed. Keep this pending claim and review it on the trusted installation.',
    );
  if (status === 410)
    return new Error(
      'Pairing invitation expired or was withdrawn. Request a new bundle from a trusted installation.',
    );
  if (status === 507)
    return new Error(
      'Relay installation quota was reached. The pending claim was retained for retry.',
    );
  if (status === 429)
    return new Error('Pairing invitation limit reached. Wait for existing invitations to expire.');
  if (status === 404 || status === 426)
    return new Error('Relay pairing API is unavailable. Upgrade to a compatible relay.');
  return new Error(`Pairing request failed (${status}). The pending claim was retained.`);
}
async function post(url: string, path: string, body: unknown, token?: string): Promise<unknown> {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    cache: 'no-store',
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw apiError(response.status);
  return response.json();
}
export async function createPairingBundle(db: SynkDatabase): Promise<PairingBundle> {
  const state = await db.state.get('local');
  if (!state?.server_epoch)
    throw new Error('Sync this trusted installation before creating a pairing bundle.');
  const indexKey = await db.ensureHistoryIndexKey();
  const invitation = (await post(
    state.credentials.server_url,
    '/v1/pairing/invites',
    {},
    state.credentials.token,
  )) as Pick<PairingBundle, 'account_id' | 'server_epoch' | 'invitation_token' | 'expires_at'>;
  if (
    !invitation ||
    invitation.account_id !== state.credentials.account_id ||
    invitation.server_epoch !== state.server_epoch
  )
    throw new Error(
      'Pairing account or server epoch changed. Synchronization recovery is required.',
    );
  return parsePairingBundle({
    ...invitation,
    format: 'helium-synk-pairing',
    version: 1,
    server_url: state.credentials.server_url,
    recovery_key: state.recovery_key,
    history_index_key: indexKey,
  });
}
export async function stagePairing(db: SynkDatabase, value: unknown, name: string): Promise<void> {
  const bundle = parsePairingBundle(value);
  const clean = name.trim();
  if (!clean || new TextEncoder().encode(clean).length > 100)
    throw new Error('Use a profile name of 1–100 UTF-8 bytes.');
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  const candidate: PairingCandidate = {
    id: 'pairing',
    bundle,
    credentials: {
      account_id: bundle.account_id,
      device_id: crypto.randomUUID(),
      name: clean,
      token,
      server_url: bundle.server_url,
    },
  };
  await db.transaction('rw', [db.state, db.pairingPending], async () => {
    if (await db.state.get('local')) throw new Error('This profile is already enrolled.');
    if (await db.pairingPending.get('pairing'))
      throw new Error(
        'A pending pairing claim already exists. Retry that claim before starting another.',
      );
    await db.pairingPending.add(candidate);
  });
}
export async function completePairing(db: SynkDatabase): Promise<void> {
  const candidate = await db.pairingPending.get('pairing');
  if (!candidate) throw new Error('No pending pairing claim.');
  const bundle = parsePairingBundle(candidate.bundle),
    credentials = parseCredentials(candidate.credentials);
  if (credentials.account_id !== bundle.account_id || credentials.server_url !== bundle.server_url)
    throw new Error('Pending pairing claim is inconsistent. Preserve it for recovery.');
  const reply = (await post(bundle.server_url, '/v1/pairing/register', {
    account_id: bundle.account_id,
    expected_epoch: bundle.server_epoch,
    invitation_token: bundle.invitation_token,
    device_id: credentials.device_id,
    name: credentials.name,
    token: credentials.token,
  })) as Pick<Credentials, 'account_id' | 'device_id' | 'name'> & { server_epoch: string };
  if (
    !reply ||
    reply.account_id !== bundle.account_id ||
    reply.server_epoch !== bundle.server_epoch ||
    reply.device_id !== credentials.device_id ||
    reply.name !== credentials.name
  )
    throw new Error('Invalid pairing acknowledgement. The pending claim was retained.');
  await db.transaction('rw', [db.state, db.pairingPending], async () => {
    const current = await db.pairingPending.get('pairing');
    if (!current) {
      const local = await db.state.get('local');
      if (
        local?.credentials.device_id === credentials.device_id &&
        local.credentials.token === credentials.token &&
        local.credentials.account_id === bundle.account_id &&
        local.credentials.server_url === bundle.server_url &&
        local.recovery_key === bundle.recovery_key &&
        local.history_index_key === bundle.history_index_key
      )
        return;
    }
    if (!current || JSON.stringify(current) !== JSON.stringify(candidate))
      throw new Error('Pending pairing claim changed.');
    await db.pairingPending.delete('pairing');
    await db.enroll(credentials, bundle.recovery_key, bundle.history_index_key);
    await db.state.update('local', { server_epoch: bundle.server_epoch });
  });
}
export function pairingSummary(candidate?: PairingCandidate) {
  return candidate
    ? {
        name: candidate.credentials.name,
        endpoint: candidate.bundle.server_url,
        expires_at: candidate.bundle.expires_at,
        device_id: candidate.credentials.device_id,
      }
    : undefined;
}
/** Explicitly discard setup secrets; an ambiguous server registration must be revoked separately. */
export async function discardPairing(db: SynkDatabase): Promise<void> {
  await db.transaction('rw', [db.state, db.pairingPending], async () => {
    if (await db.state.get('local')) throw new Error('This profile is already enrolled.');
    await db.pairingPending.delete('pairing');
  });
}
