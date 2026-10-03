import { afterEach, expect, it, vi } from 'vite-plus/test';
import { SynkDatabase } from './database';
import { encryptPayload, generateRecoveryKey, historyUrlTag } from './crypto';
import { expireHistory, historyRetentionPolicy } from './history-retention';
import { historyVisitId, type HistoryVisit, type HistoryOperation } from './history';

const DAY = 86_400_000,
  now = 200 * DAY;
const dbs: SynkDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of dbs) db.close();
  for (const db of new Map(dbs.splice(0).map((db) => [db.name, db])).values()) await db.delete();
});
async function fixture() {
  const db = new SynkDatabase(`retention-${crypto.randomUUID()}`);
  dbs.push(db);
  await db.enroll(
    {
      account_id: crypto.randomUUID(),
      device_id: crypto.randomUUID(),
      name: 'Retention fixture',
      token: 'a'.repeat(64),
      server_url: 'http://127.0.0.1:4318',
    },
    generateRecoveryKey(),
  );
  const source = (await db.state.get('local'))!.credentials.device_id;
  const incarnation = crypto.randomUUID();
  const url = 'https://retention.example/private';
  const tag = await historyUrlTag(await db.ensureHistoryIndexKey(), url);
  const visit = (native: string, visited_at = 100 * DAY, source_id = source): HistoryVisit => ({
    id: historyVisitId(source_id, incarnation, native, visited_at),
    source_id,
    source_name: 'Retention fixture',
    incarnation,
    native_id: native,
    visited_at,
    url,
    url_tag: tag,
    title: 'Private retained title',
    generation: {},
  });
  const stage = async (visits: HistoryVisit[]) => {
    const ids: string[] = [];
    for (let offset = 0; offset < visits.length; offset += 100)
      ids.push(
        ...(await db.stageHistories(
          visits.slice(offset, offset + 100).map((v) => ({ type: 'visit', visit: v })),
        )),
      );
    return ids;
  };
  const acknowledged = async (visits: HistoryVisit[]) => {
    const ids = await stage(visits);
    while (await db.drafts.count()) await db.flushDrafts();
    await db.transaction('rw', [db.operations, db.outbox], async () => {
      for (const [i, id] of ids.entries()) {
        await db.operations.update(id, { sequence: i + 1 });
        await db.outbox.delete(id);
      }
    });
    return ids;
  };
  return { db, source, visit, stage, acknowledged };
}
it('validates and persists opt-in settings across reopening and ordinary export', async () => {
  const { db } = await fixture();
  for (const bad of [
    null,
    { enabled: true, days: 0 },
    { enabled: 'yes', days: 90 },
    { enabled: true, days: 3651 },
    { enabled: true, days: 1.5 },
    { enabled: true, days: 90, extra: 1 },
  ])
    expect(() => historyRetentionPolicy(bad)).toThrow('retention');
  await db.setHistoryRetention({ enabled: true, days: 180 });
  const reopened = new SynkDatabase(db.name);
  dbs.push(reopened);
  expect((await reopened.state.get('local'))!.history_retention).toEqual({
    enabled: true,
    days: 180,
  });
  expect(await reopened.exportReplica()).toMatchObject({
    progress: { history_retention: { enabled: true, days: 180 } },
  });
  await expect(expireHistory(db, Infinity)).rejects.toThrow('retention time');
});
it('leaves expiry off until selected and uses original timestamps with a strict cutoff', async () => {
  const { db, visit, acknowledged } = await fixture();
  const old = visit('old'),
    boundary = visit('boundary', 110 * DAY),
    recent = visit('recent', 111 * DAY),
    future = visit('future', now + DAY);
  const ids = await acknowledged([old, boundary, recent, future]);
  const before = await db.exportReplica();
  expect(await expireHistory(db, now)).toEqual({
    examined: 0,
    expired: 0,
    protected: 0,
    more: false,
  });
  expect(await db.exportReplica()).toEqual(before);
  await db.setHistoryRetention({ enabled: true, days: 90 });
  expect(await expireHistory(db, now)).toMatchObject({ examined: 1, expired: 1 });
  expect(await db.historyVisits.get(old.id)).toBeUndefined();
  expect(await db.historyVisits.count()).toBe(3);
  expect((await db.operations.get(ids[0]!))!.payload).toMatchObject({
    action: { type: 'erased-visit' },
  });
  expect((await db.operations.get(ids[0]!))!.envelope.ciphertext).not.toBe('');
  expect((await db.historyMetadata()).deleted[old.id]).toHaveLength(1);
  expect(await db.pendingCount()).toBe(1); // Durable deletion proof; purge runs during sync.
  await db.setHistoryRetention({ enabled: false, days: 180 });
  await db.stageHistory({ type: 'visit', visit: old });
  expect(await db.historyVisits.get(old.id)).toBeUndefined();
  expect(await db.historyErasedDrafts.count()).toBe(1);
});
it('protects pending drafts, immutable encrypted uploads and an acknowledged copy still in the outbox', async () => {
  const { db, visit } = await fixture();
  const plain = visit('plain'),
    encrypted = visit('encrypted'),
    retry = visit('retry');
  const encryptedId = await db.stageHistory({ type: 'visit', visit: encrypted });
  const retryId = await db.stageHistory({ type: 'visit', visit: retry });
  await db.flushDrafts();
  await db.operations.update(retryId, { sequence: 1 });
  await db.stageHistory({ type: 'visit', visit: plain });
  await db.setHistoryRetention({ enabled: true, days: 90 });
  const saved = await db.outbox.get(encryptedId),
    counter = (await db.state.get('local'))!.next_counter;
  expect(await expireHistory(db, now)).toMatchObject({ expired: 0, protected: 3 });
  expect(await db.historyVisits.count()).toBe(3);
  expect(await db.outbox.get(encryptedId)).toEqual(saved);
  expect((await db.state.get('local'))!.next_counter).toBe(counter);
});
it('protects every native-identity copy when only one duplicate is acknowledged', async () => {
  const { db, visit, acknowledged } = await fixture();
  const value = visit('duplicate');
  await acknowledged([value]);
  await db.stageHistory({ type: 'visit', visit: value });
  await db.flushDrafts();
  await db.setHistoryRetention({ enabled: true, days: 90 });
  expect(await expireHistory(db, now)).toMatchObject({ expired: 0, protected: 1 });
  expect(await db.historyVisits.get(value.id)).toBeDefined();
});
it('does not expire another source even when its complete visit is cached locally', async () => {
  const { db, visit, acknowledged } = await fixture();
  await acknowledged([visit('own')]);
  const remote = visit('remote', 100 * DAY, crypto.randomUUID());
  const local = (await db.state.get('local'))!,
    operation_id = crypto.randomUUID();
  const payload: HistoryOperation = {
    kind: 'history',
    schema_version: 1,
    operation_id,
    revision: { author: remote.source_id, counter: 1, logical: 1, context: {} },
    action: { type: 'visit', visit: remote },
  };
  const envelope = await encryptPayload(
    local.recovery_key,
    {
      protocol_version: 1,
      account_id: local.credentials.account_id,
      device_id: remote.source_id,
      operation_id,
      counter: 1,
      domain: 'history',
      key_epoch: 1,
    },
    payload,
  );
  await db.operations.add({ operation_id, payload, envelope, sequence: 999 });
  await db.historyVisits.put({ ...remote, operation_id });
  await db.setHistoryRetention({ enabled: true, days: 90 });
  expect(await expireHistory(db, now)).toMatchObject({ expired: 1 });
  expect(await db.historyVisits.get(remote.id)).toBeDefined();
});
it('rolls back expiry, counter reservations, projection and scan progress on storage failure', async () => {
  const { db, visit, acknowledged } = await fixture();
  await acknowledged([visit('rollback')]);
  await db.setHistoryRetention({ enabled: true, days: 90 });
  const before = await db.exportReplica();
  const fail = () => {
    throw new Error('Retention storage failure');
  };
  db.state.hook('updating', fail);
  await expect(expireHistory(db, now)).rejects.toThrow('Retention storage failure');
  db.state.hook('updating').unsubscribe(fail);
  expect(await db.exportReplica()).toEqual(before);
  expect(await expireHistory(db, now)).toMatchObject({ expired: 1 });
});
it('resumes a bounded batch across reopening without skipping same-timestamp identities', async () => {
  const { db, visit, acknowledged } = await fixture();
  await acknowledged(Array.from({ length: 125 }, (_, i) => visit(String(i))));
  await db.setHistoryRetention({ enabled: true, days: 90 });
  expect(await expireHistory(db, now)).toMatchObject({ examined: 100, expired: 100, more: true });
  const reopened = new SynkDatabase(db.name);
  dbs.push(reopened);
  expect(await expireHistory(reopened, now)).toMatchObject({
    examined: 25,
    expired: 25,
    more: false,
  });
  expect(await db.historyVisits.count()).toBe(0);
  expect(Object.keys((await db.historyMetadata()).deleted)).toHaveLength(125);
});
it('advances over a full pending page, then revisits it when its uploads become acknowledged', async () => {
  const { db, visit, stage, acknowledged } = await fixture();
  await stage(Array.from({ length: 500 }, (_, i) => visit(String(i), 99 * DAY)));
  const ready = visit('ready', 100 * DAY);
  await acknowledged([ready]); // Flushes all drafts; only this returned ID gets an ACK.
  await db.setHistoryRetention({ enabled: true, days: 90 });
  expect(await expireHistory(db, now)).toMatchObject({
    examined: 500,
    protected: 500,
    expired: 0,
    more: true,
  });
  expect(await expireHistory(db, now)).toMatchObject({ examined: 1, expired: 1, more: false });
  expect(await db.historyVisits.get(ready.id)).toBeUndefined();
  const pending = await db.outbox.toCollection().primaryKeys();
  await db.transaction('rw', [db.operations, db.outbox], async () => {
    for (const [i, id] of pending.entries()) await db.operations.update(id, { sequence: i + 2 });
    await db.outbox.bulkDelete(pending);
  });
  expect(await expireHistory(db, now)).toMatchObject({ expired: 100 });
});
it('serializes competing expiry passes so they create one selected-deletion proof', async () => {
  const { db, visit, acknowledged } = await fixture();
  const value = visit('concurrent');
  await acknowledged([value]);
  await db.setHistoryRetention({ enabled: true, days: 90 });
  const peer = new SynkDatabase(db.name);
  dbs.push(peer);
  const results = await Promise.all([expireHistory(db, now), expireHistory(peer, now)]);
  expect(results.reduce((n, r) => n + r.expired, 0)).toBe(1);
  expect((await db.historyMetadata()).deleted[value.id]).toHaveLength(1);
});
it('resets an exhausted or clock-rolled-back scan without reading the history journal', async () => {
  const { db, visit, acknowledged } = await fixture();
  const value = visit('clock');
  await acknowledged([value]);
  await db.setHistoryRetention({ enabled: true, days: 90 });
  await db.state.update('local', {
    history_retention_cursor: { visited_at: value.visited_at, id: value.id },
  });
  const scan = vi.spyOn(db.operations, 'where');
  expect(await expireHistory(db, 100 * DAY)).toMatchObject({ examined: 0, expired: 0 });
  expect(scan).not.toHaveBeenCalled();
  expect((await db.state.get('local'))!.history_retention_cursor).toBeUndefined();
  expect(await db.historyVisits.get(value.id)).toBeDefined();
});
