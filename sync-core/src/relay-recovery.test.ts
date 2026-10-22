import { afterEach, expect, it, vi } from 'vite-plus/test';
import { SynkDatabase } from './database';
import { generateRecoveryKey } from './crypto';
import {
  exportRelayRecovery,
  adoptRelayRecovery,
  type RelayRecoveryBundle,
} from './relay-recovery';
const databases: SynkDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.delete();
});
async function local() {
  const db = new SynkDatabase(`relay-recovery-${crypto.randomUUID()}`);
  databases.push(db);
  await db.enroll(
    {
      account_id: crypto.randomUUID(),
      device_id: crypto.randomUUID(),
      token: 'a'.repeat(64),
      name: 'Survivor',
      server_url: 'http://127.0.0.1:4318',
    },
    generateRecoveryKey(),
  );
  await db.state.update('local', { server_epoch: crypto.randomUUID() });
  return db;
}
const receipt = (b: RelayRecoveryBundle) => ({
  account_id: b.account_id,
  server_epoch: b.server_epoch,
  recovery_id: b.recovery_id,
  key_epoch: b.key_epoch,
  manifest_digest: b.manifest_digest,
  source_id: b.source.device_id,
});
it('adoption is atomic across key/cursor/sequence changes and preserves a later unsent operation and author counter', async () => {
  const db = await local();
  const id = await db.queueDiagnostic('Acknowledged data');
  await db.records.update(id, { sequence: 1 });
  await db.outbox.delete(id);
  const bundle = await exportRelayRecovery(db);
  const later = await db.queueDiagnostic('Captured after the rebuild file was saved');
  const before = await db.exportReplica(),
    keys = await db.keySecrets.get('keys');
  const counter = (await db.state.get('local'))!.next_counter;
  const failure = vi
    .spyOn(db.state, 'update')
    .mockRejectedValueOnce(new Error('Injected storage failure'));
  await expect(adoptRelayRecovery(db, receipt(bundle))).rejects.toThrow('Injected storage failure');
  failure.mockRestore();
  expect(await db.exportReplica()).toEqual(before);
  expect(await db.keySecrets.get('keys')).toEqual(keys);
  expect((await db.relayRecoveryPending.get('relay-recovery'))!.adopted).toBeUndefined();
  await adoptRelayRecovery(db, receipt(bundle));
  expect((await db.state.get('local'))!.next_counter).toBe(counter);
  expect((await db.state.get('local'))!.server_epoch).toBe(bundle.server_epoch);
  expect(await db.outbox.get(later)).toBeDefined();
  expect((await db.records.get(id))!.sequence).toBeUndefined();
  expect((await db.keySecrets.get('keys'))!.roots[1]).toBe(keys!.roots[1]);
  expect((await db.keySecrets.get('keys'))!.roots[2]).toBeDefined();
  expect((await db.relayRecoveryPending.get('relay-recovery'))!.bundle.entries).toEqual([]);
});
it('a stale rebuild cannot lose newly acknowledged data; re-export refreshes the proposal and still retries unchanged snapshots exactly', async () => {
  const db = await local();
  await db.queueDiagnostic('Original');
  const first = await exportRelayRecovery(db);
  expect(await exportRelayRecovery(db)).toEqual(first);
  const later = await db.queueDiagnostic('Acknowledged after recovery preparation');
  await db.records.update(later, { sequence: 9 });
  await db.outbox.delete(later);
  const before = await db.exportReplica();
  await expect(adoptRelayRecovery(db, receipt(first))).rejects.toThrow('New acknowledged data');
  expect(await db.exportReplica()).toEqual(before);
  const refreshed = await exportRelayRecovery(db);
  expect(refreshed.recovery_id).not.toBe(first.recovery_id);
  expect(refreshed.entries.some((e) => e.envelope.operation_id === later)).toBe(true);
  expect(await exportRelayRecovery(db)).toEqual(refreshed);
  await expect(adoptRelayRecovery(db, receipt(first))).rejects.toThrow('does not match');
  await adoptRelayRecovery(db, receipt(refreshed));
});
it('mismatched peer accounts and tampered manifests cannot replace a prepared proposal', async () => {
  const db = await local(),
    peer = await local();
  const bundle = await exportRelayRecovery(db),
    other = await exportRelayRecovery(peer);
  await expect(exportRelayRecovery(db, [other])).rejects.toThrow('different account');
  await expect(
    exportRelayRecovery(db, [{ ...bundle, manifest_digest: '0'.repeat(64) }]),
  ).rejects.toThrow('invalid manifest');
  expect((await db.relayRecoveryPending.get('relay-recovery'))!.bundle).toEqual(bundle);
});

it('an in-flight response from the old relay cannot roll back an adopted epoch or move its cursor', async () => {
  const db = await local();
  const { SyncCoordinator } = await import('./sync');
  const bundle = await exportRelayRecovery(db);
  let release!: () => void, requested!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const oldPass = new SyncCoordinator(db, () => ({
    async pull() {
      requested();
      await gate;
      return {
        server_epoch: bundle.previous_server_epoch,
        records: [],
        next_cursor: 0,
        has_more: false,
      };
    },
    async push() {
      throw new Error('Unexpected push');
    },
    async acknowledge() {
      throw new Error('Unexpected acknowledgement');
    },
  })).sync();
  await started;
  await adoptRelayRecovery(db, receipt(bundle));
  release();
  await expect(oldPass).rejects.toThrow('Recovery changed');
  expect((await db.state.get('local'))!.server_epoch).toBe(bundle.server_epoch);
  expect((await db.state.get('local'))!.cursor).toBe(0);
  expect((await db.state.get('local'))!.key_epoch).toBe(2);
});
