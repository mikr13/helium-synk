import { afterEach, expect, it, vi } from 'vite-plus/test';
import { SynkDatabase } from './database';
import { DEFAULT_LOCAL_STORAGE, storagePolicy } from './local-storage';
import { encryptPayload, generateRecoveryKey, historyUrlTag } from './crypto';
import { historyVisitId, eraseHistoryVisit, type HistoryVisit } from './history';
import { SyncCoordinator, type Transport } from './sync';
import { type Envelope, envelopeDigest, type PullPage } from './protocol';
import { type HistoryErasure } from './history-erasure';
import { sessionWindow } from '../../tests/session-fixtures';
import { HistoryCapture } from './history-capture';
const dbs: SynkDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of dbs) db.close();
  for (const db of new Map(dbs.splice(0).map((db) => [db.name, db])).values()) await db.delete();
});
async function fixture() {
  const account = crypto.randomUUID(),
    root = generateRecoveryKey();
  let usage: number | undefined;
  const device = async () => {
    const db = new SynkDatabase(`capacity-${crypto.randomUUID()}`, async () => ({ usage }));
    dbs.push(db);
    await db.enroll(
      {
        account_id: account,
        device_id: crypto.randomUUID(),
        token: 'a'.repeat(64),
        name: 'Capacity fixture',
        server_url: 'http://127.0.0.1:4318',
      },
      root,
    );
    return db;
  };
  const db = await device(),
    source = (await db.state.get('local'))!.credentials.device_id,
    incarnation = crypto.randomUUID(),
    url = 'https://capacity.example/private',
    tag = await historyUrlTag(await db.ensureHistoryIndexKey(), url);
  const visit = (native: string): HistoryVisit => ({
    id: historyVisitId(source, incarnation, native, 1000),
    source_id: source,
    source_name: 'Capacity fixture',
    incarnation,
    native_id: native,
    visited_at: 1000,
    url,
    title: 'Capacity title',
    url_tag: tag,
    generation: {},
  });
  const limit = { ...DEFAULT_LOCAL_STORAGE, max_pending: 100 };
  return {
    db,
    root,
    device,
    visit,
    limit,
    setUsage: (n?: number) => {
      usage = n;
    },
  };
}
class Relay implements Transport {
  epoch = crypto.randomUUID();
  rows: Envelope[] = [];
  async pull(cursor: number): Promise<PullPage> {
    const records = this.rows
      .slice(cursor, cursor + 100)
      .map((envelope, index) => ({ sequence: cursor + index + 1, envelope }));
    return {
      server_epoch: this.epoch,
      records,
      next_cursor: cursor + records.length,
      has_more: this.rows.length > cursor + records.length,
    };
  }
  async push(envelopes: Envelope[]) {
    const acknowledgements = envelopes.map((envelope) => {
      let index = this.rows.findIndex((r) => r.operation_id === envelope.operation_id);
      if (index < 0) {
        index = this.rows.length;
        this.rows.push(envelope);
      }
      return { operation_id: envelope.operation_id, sequence: index + 1 };
    });
    return { server_epoch: this.epoch, acknowledgements };
  }
  async acknowledge(cursor: number, epoch: string) {
    return { server_epoch: epoch, processed_cursor: cursor };
  }
}
it('persists limits across reopening/export, rejects invalid configuration without changing them', async () => {
  const f = await fixture();
  await f.db.setStoragePolicy(f.limit);
  for (const policy of [
    { ...f.limit, max_bytes: 1 },
    { ...f.limit, max_pending: NaN },
    { ...f.limit, extra: 1 },
    { ...f.limit, max_journal: Infinity },
  ])
    await expect(f.db.setStoragePolicy(policy)).rejects.toThrow('Invalid local storage');
  expect(storagePolicy(DEFAULT_LOCAL_STORAGE)).toEqual(DEFAULT_LOCAL_STORAGE);
  expect(
    ((await f.db.exportReplica()) as { progress: { storage_policy: unknown } }).progress
      .storage_policy,
  ).toEqual(f.limit);
  f.db.close();
  const reopened = new SynkDatabase(f.db.name);
  dbs.push(reopened);
  expect((await reopened.storageStatus()).policy).toEqual(f.limit);
});
it('admits the exact pending boundary atomically and preserves rejected capture state', async () => {
  const f = await fixture();
  await f.db.setStoragePolicy(f.limit);
  await f.db.stageHistories(
    Array.from({ length: 100 }, (_, i) => ({ type: 'visit' as const, visit: f.visit(String(i)) })),
  );
  const state = (await f.db.state.get('local'))!,
    history = await f.db.historyProjection();
  expect((await f.db.storageStatus()).blocked).toBe(true);
  await expect(f.db.stageHistory({ type: 'visit', visit: f.visit('overflow') })).rejects.toThrow(
    'pending-work limit',
  );
  expect((await f.db.state.get('local'))!.next_counter).toBe(state.next_counter);
  expect(await f.db.historyProjection()).toEqual(history);
  expect(await f.db.drafts.count()).toBe(100);
  await f.db.flushDrafts(); // Existing immutable work still encrypts at capacity.
  expect(await f.db.outbox.count()).toBe(100);
  const relay = new Relay();
  await new SyncCoordinator(f.db, () => relay).sync();
  expect(await f.db.pendingCount()).toBe(0);
  expect((await f.db.storageStatus()).blocked).toBe(false);
  await f.db.stageHistory({ type: 'visit', visit: f.visit('after-recovery') });
});
it('serializes competing captures against the same durable budget', async () => {
  const f = await fixture();
  await f.db.setStoragePolicy(f.limit);
  await f.db.stageHistories(
    Array.from({ length: 99 }, (_, i) => ({ type: 'visit' as const, visit: f.visit(String(i)) })),
  );
  const other = new SynkDatabase(f.db.name);
  dbs.push(other);
  const results = await Promise.allSettled([
    f.db.stageHistory({ type: 'visit', visit: f.visit('first') }),
    other.stageHistory({ type: 'visit', visit: f.visit('second') }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  expect(await f.db.drafts.count()).toBe(100);
  expect((await f.db.state.get('local'))!.next_counter).toBe(101);
});
it('allows clear/deletion at the limit and preserves the suppressed private identities', async () => {
  const f = await fixture();
  await f.db.setStoragePolicy(f.limit);
  await f.db.stageHistories(
    Array.from({ length: 100 }, (_, i) => ({ type: 'visit' as const, visit: f.visit(String(i)) })),
  );
  await f.db.stageHistory({ type: 'clear', scope: 'all' });
  expect(await f.db.historyVisits.count()).toBe(0);
  expect(await f.db.historyErasedDrafts.count()).toBe(100);
  expect(await f.db.pendingCount()).toBe(1);
});
it('coalesces an unsent current session at capacity, while preserving it if a closed snapshot cannot be admitted', async () => {
  const f = await fixture();
  await f.db.setStoragePolicy(f.limit);
  await f.db.stageHistories(
    Array.from({ length: 99 }, (_, i) => ({ type: 'visit' as const, visit: f.visit(String(i)) })),
  );
  const content = {
    kind: 'current' as const,
    captured_at: new Date().toISOString(),
    windows: [sessionWindow()],
  };
  const old = await f.db.stageSession(content),
    next = await f.db.stageSession({ ...content, windows: [sessionWindow(1)] });
  expect(await f.db.pendingCount()).toBe(100);
  expect((await f.db.sessionProjection()).snapshots[old]).toBeUndefined();
  await expect(f.db.stageSession({ ...content, kind: 'closed' })).rejects.toThrow(
    'pending-work limit',
  );
  expect((await f.db.sessionProjection()).snapshots[next]).toBeDefined();
  expect(await f.db.pendingCount()).toBe(100);
});
it('reports the browser estimate, warns at 80 percent and rejects material before reserving a counter', async () => {
  const f = await fixture(),
    policy = { ...f.limit, max_bytes: 16 * 1024 * 1024 };
  await f.db.setStoragePolicy(policy);
  f.setUsage(policy.max_bytes * 0.8);
  expect((await f.db.storageStatus(true)).warning).toContain('approaching');
  f.setUsage(policy.max_bytes);
  const status = await f.db.storageStatus(true);
  expect(status.estimated_bytes).toBe(policy.max_bytes);
  expect(status.blocked).toBe(true);
  const counter = (await f.db.state.get('local'))!.next_counter;
  await expect(f.db.queueDiagnostic('Full storage')).rejects.toThrow('storage estimate');
  expect((await f.db.state.get('local'))!.next_counter).toBe(counter);
  expect(await f.db.records.count()).toBe(0);
  await f.db.stageHistory({ type: 'clear', scope: 'all' });
  expect(await f.db.pendingCount()).toBe(1);
});
it('stops a full-byte download without quarantine/cursor advancement, then resumes after capacity returns', async () => {
  const f = await fixture(),
    target = await f.device(),
    relay = new Relay();
  await f.db.queueDiagnostic('Remote data');
  await new SyncCoordinator(f.db, () => relay).sync();
  const policy = { ...DEFAULT_LOCAL_STORAGE, max_bytes: 16 * 1024 * 1024 };
  await target.setStoragePolicy(policy);
  f.setUsage(policy.max_bytes);
  await target.storageStatus(true);
  await expect(new SyncCoordinator(target, () => relay).sync()).rejects.toThrow('storage estimate');
  expect((await target.state.get('local'))!.cursor).toBe(0);
  expect(await target.records.count()).toBe(0);
  expect(await target.quarantine.count()).toBe(0);
  f.setUsage(0);
  await target.storageStatus(true);
  await new SyncCoordinator(target, () => relay).sync();
  expect((await target.records.toArray())[0]!.payload.note).toBe('Remote data');
  expect((await target.state.get('local'))!.acknowledged_cursor).toBe(1);
});
it('processes a certified remote deletion even while the byte budget is full', async () => {
  const f = await fixture(),
    target = await f.device(),
    relay = new Relay();
  const id = await f.db.stageHistory({ type: 'visit', visit: f.visit('original') });
  await new SyncCoordinator(f.db, () => relay).sync();
  await new SyncCoordinator(target, () => relay).sync();
  const old = (await f.db.operations.get(id))!;
  if (old.payload.kind !== 'history') throw new Error('Fixture');
  const certificate: HistoryErasure = {
    kind: 'history-erasure',
    schema_version: 1,
    operation_id: crypto.randomUUID(),
    revision: {
      author: old.envelope.device_id,
      counter: 2,
      logical: 2,
      context: { [old.envelope.device_id]: 1 },
    },
    targets: [
      {
        receipt: eraseHistoryVisit(old.payload),
        digest: await envelopeDigest(old.envelope),
        key_epoch: 1,
      },
    ],
  };
  relay.rows.push(
    await encryptPayload(
      f.root,
      {
        ...old.envelope,
        operation_id: certificate.operation_id,
        counter: 2,
        domain: 'history-erasure',
      },
      certificate,
    ),
  );
  const policy = { ...DEFAULT_LOCAL_STORAGE, max_bytes: 16 * 1024 * 1024 };
  await target.setStoragePolicy(policy);
  f.setUsage(policy.max_bytes);
  await target.storageStatus(true);
  await new SyncCoordinator(target, () => relay).sync();
  expect((await target.operations.get(id))!.envelope.ciphertext).toBe('');
  expect(await target.historyVisits.count()).toBe(0);
  expect((await target.state.get('local'))!.cursor).toBe(2);
});
it('bounds native event tasks without discarding previously saved intent, while accepting removal work', async () => {
  const f = await fixture();
  await f.db.setStoragePolicy({ ...DEFAULT_LOCAL_STORAGE, max_capture_tasks: 100 });
  let marker: { author: string; id: string } | undefined;
  const capture = new HistoryCapture(f.db, {
    search: async () => [],
    getVisits: async () => [],
    getMarker: async () => marker,
    setMarker: async (next) => {
      marker = next;
    },
  });
  await capture.enable(0);
  for (let i = 0; i < 100; i++)
    await capture.capture({
      type: 'visited',
      item: { id: String(i), url: f.visit(String(i)).url, lastVisitTime: 1000 },
    });
  await expect(
    capture.capture({ type: 'visited', item: { id: 'overflow', url: f.visit('x').url } }),
  ).rejects.toThrow('capture-task limit');
  expect(await f.db.historyInbox.count()).toBe(100);
  await capture.capture({ type: 'removed', all: true, urls: [] });
  expect(await f.db.historyInbox.count()).toBe(101);
});
it('uses count limits when the browser estimate is unavailable or fails', async () => {
  const f = await fixture();
  const policy = { ...DEFAULT_LOCAL_STORAGE, max_journal: 1000 };
  await f.db.setStoragePolicy(policy);
  const template = {
      kind: 'diagnostic' as const,
      note: 'Known record',
      created_at: new Date().toISOString(),
    },
    state = (await f.db.state.get('local'))!;
  await f.db.records.bulkAdd(
    Array.from({ length: 1000 }, (_, i) => {
      const operation_id = crypto.randomUUID();
      return {
        operation_id,
        payload: template,
        envelope: {
          protocol_version: 1 as const,
          operation_id,
          account_id: state.credentials.account_id,
          device_id: state.credentials.device_id,
          counter: i + 1,
          domain: 'diagnostic' as const,
          key_epoch: 1,
          nonce: '',
          ciphertext: '',
        },
        sequence: i + 1,
      };
    }),
  );
  expect((await f.db.storageStatus()).estimated_bytes).toBeUndefined();
  await expect(
    f.db.stageHistory({ type: 'visit', visit: f.visit('over-journal') }),
  ).rejects.toThrow('journal limit');
  f.db.close();
  const reopened = new SynkDatabase(f.db.name, async () => {
    throw new Error('Estimate unavailable');
  });
  dbs.push(reopened);
  expect((await reopened.storageStatus()).blocked).toBe(true);
  await expect(reopened.queueDiagnostic('More content')).rejects.toThrow('journal limit');
});
it('drains saved uploads even when an unseen incoming page exceeds the local byte budget', async () => {
  const f = await fixture(),
    target = await f.device(),
    relay = new Relay();
  await f.db.queueDiagnostic('Unseen peer note');
  await new SyncCoordinator(f.db, () => relay).sync();
  const id = await target.queueDiagnostic('Saved during outage');
  const policy = { ...DEFAULT_LOCAL_STORAGE, max_bytes: 16 * 1024 * 1024 };
  await target.setStoragePolicy(policy);
  f.setUsage(policy.max_bytes);
  await target.storageStatus(true);
  await expect(new SyncCoordinator(target, () => relay).sync()).rejects.toThrow('storage estimate');
  expect(await target.outbox.count()).toBe(0);
  expect((await target.records.get(id))!.sequence).toBe(2);
  expect(relay.rows).toHaveLength(2);
  expect((await target.state.get('local'))!.cursor).toBe(0);
  expect((await target.state.get('local'))!.server_epoch).toBe(relay.epoch);
  expect(await target.quarantine.count()).toBe(0);
});
