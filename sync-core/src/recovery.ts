import { SynkDatabase } from './database';
import { keySnapshot } from './key-manager';
import { parseKeyRing } from './key-state';
import { validateRecoveryKey, deriveHistoryIndexKey } from './crypto';
import { isUuid, serverUrl, parseCredentials, type Credentials } from './protocol';
export interface RecoveryBundle {
  format: 'helium-synk-recovery';
  version: 2;
  account_id: string;
  server_url: string;
  server_epoch: string;
  key_epoch: number;
  roots: Record<number, string>;
  recovery_key: string;
  history_index_key: string;
}
export function parseRecoveryBundle(value: unknown): RecoveryBundle {
  const bundle = value as RecoveryBundle;
  if (
    !bundle ||
    bundle.format !== 'helium-synk-recovery' ||
    bundle.version !== 2 ||
    !isUuid(bundle.account_id) ||
    !isUuid(bundle.server_epoch) ||
    typeof bundle.server_url !== 'string' ||
    typeof bundle.recovery_key !== 'string' ||
    typeof bundle.history_index_key !== 'string'
  )
    throw new Error('Invalid or unsupported private recovery bundle.');
  const ring = parseKeyRing(bundle);
  validateRecoveryKey(bundle.history_index_key);
  if (ring.roots[ring.key_epoch] !== bundle.recovery_key)
    throw new Error('Recovery keys are inconsistent.');
  return {
    format: 'helium-synk-recovery',
    version: 2,
    account_id: bundle.account_id,
    server_url: serverUrl(bundle.server_url),
    server_epoch: bundle.server_epoch,
    recovery_key: bundle.recovery_key,
    history_index_key: bundle.history_index_key,
    ...ring,
  };
}
export async function exportRecovery(db: SynkDatabase): Promise<RecoveryBundle> {
  await db.ensureHistoryIndexKey();
  const { local, secrets } = await keySnapshot(db);
  if (!local.server_epoch)
    throw new Error('Sync this installation before exporting a recovery bundle.');
  return parseRecoveryBundle({
    format: 'helium-synk-recovery',
    version: 2,
    account_id: local.credentials.account_id,
    server_url: local.credentials.server_url,
    server_epoch: local.server_epoch,
    key_epoch: local.key_epoch ?? 1,
    recovery_key: local.recovery_key,
    history_index_key: local.history_index_key,
    roots: secrets.roots,
  });
}
/** Recovery imports content keys only. The caller must issue a fresh installation credential. */
export async function enrollRecovery(
  db: SynkDatabase,
  credentials: Credentials,
  value: unknown,
): Promise<void> {
  const c = parseCredentials(credentials);
  const candidate = value as Partial<RecoveryBundle>;
  if (candidate?.format || candidate?.version) {
    const bundle = parseRecoveryBundle(value);
    if (bundle.account_id !== c.account_id || bundle.server_url !== c.server_url)
      throw new Error('Recovery bundle belongs to another account or relay.');
    await db.enroll(c, bundle.recovery_key, bundle.history_index_key, {
      key_epoch: bundle.key_epoch,
      roots: bundle.roots,
      server_epoch: bundle.server_epoch,
    });
  } else {
    // Original epoch-1 export; cannot restore an account that has rotated without a newer bundle.
    if (
      !candidate ||
      candidate.account_id !== c.account_id ||
      typeof candidate.server_url !== 'string' ||
      serverUrl(candidate.server_url) !== c.server_url ||
      typeof candidate.recovery_key !== 'string'
    )
      throw new Error('Invalid legacy recovery bundle or account mismatch.');
    const index =
      candidate.history_index_key ??
      (await deriveHistoryIndexKey(candidate.recovery_key, c.account_id));
    await db.enroll(c, candidate.recovery_key, index);
  }
}
