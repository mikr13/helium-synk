import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SynkDatabase } from './database';
import { SyncCoordinator, type Transport } from './sync';
import {
  generateRecoveryKey,
  deriveHistoryIndexKey,
  historyUrlTag,
  encryptPayload,
  decryptPayload,
  encryptDiagnostic,
} from './crypto';
import {
  historyGeneration,
  historyVisitId,
  type HistoryVisit,
  type HistoryOperation,
} from './history';
import type { Envelope, PullPage } from './protocol';
const dbs: SynkDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) await db.delete();
});

describe('local history journal erasure', () => {
  it('commits remote clear capture cleanup with the durable cursor and rolls it back on failure', async () => {
    const { a, b } = await pair(),
      relay = new Relay(),
      v = await visit(b);
    const syncA = new SyncCoordinator(a, () => relay),
      syncB = new SyncCoordinator(b, () => relay);
    await b.stageHistory({ type: 'visit', visit: v });
    await syncB.sync();
    await syncA.sync();
    const metadata = await b.historyMetadata();
    await b.historyInbox.add({
      event: { type: 'visited', item: { id: 'queued', url, title: v.title, lastVisitTime: 2000 } },
      context: metadata.frontier,
      barriers: metadata.barriers,
      incarnation: v.incarnation,
      created_at: 2000,
    });
    await b.historyLookups.add({
      id: 'saved',
      job_id: 'event',
      kind: 'event',
      item: { id: 'queued', url, title: v.title, lastVisitTime: 2000 },
      url_tag: v.url_tag,
      start: 2000,
      end: 2001,
      context: metadata.frontier,
      barriers: metadata.barriers,
      incarnation: v.incarnation,
      position: 0,
      attempts: 0,
    });
    await a.stageHistory({
      type: 'clear',
      scope: 'url',
      source_id: v.source_id,
      url_tag: v.url_tag,
    });
    await syncA.sync();
    const before = await b.exportReplica();
    const fail = () => {
      throw new Error('Cleanup storage failure');
    };
    b.historyInbox.hook('deleting', fail);
    await expect(syncB.sync()).rejects.toThrow('Cleanup storage failure');
    expect(await b.exportReplica()).toEqual(before);
    b.historyInbox.hook('deleting').unsubscribe(fail);
    await syncB.sync();
    expect(await b.historyInbox.count()).toBe(0);
    expect(await b.historyLookups.count()).toBe(0);
    expect((await b.state.get('local'))!.cursor).toBe(relay.rows.length);
    expect(JSON.stringify(await b.exportReplica())).not.toContain(url);
    expect(JSON.stringify(await b.exportReplica())).not.toContain(v.title);
  });
  it('does not resurrect a draft when deletion commits while its encryption is in flight', async () => {
    const { a } = await pair(),
      v = await visit(a);
    const id = await a.stageHistory({ type: 'visit', visit: v });
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      }),
      encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (algorithm, key, data) => {
      entered();
      await gate;
      return encrypt(algorithm, key, data);
    });
    const flushing = a.flushDrafts();
    await ready;
    try {
      await a.stageHistory({ type: 'delete', visit_ids: [v.id] });
    } finally {
      release();
    }
    await flushing;
    expect(await a.outbox.get(id)).toBeUndefined();
    expect(await a.operations.get(id)).toBeUndefined();
    expect(await a.historyErasedDrafts.get(id)).toBeDefined();
    expect(JSON.stringify(await a.exportReplica())).not.toContain(url);
    expect(await a.pendingCount()).toBe(1);
  });
  it('removes decrypted journal content on both peers and keeps immutable encrypted retries', async () => {
    const { a, b, key } = await pair(),
      relay = new Relay(),
      v = await visit(a);
    const id = await a.stageHistory({ type: 'visit', visit: v });
    await a.flushDrafts();
    const encrypted = (await a.outbox.get(id))!;
    await a.stageHistory({ type: 'delete', visit_ids: [v.id] });
    expect((await a.operations.get(id))?.payload).toMatchObject({
      action: { type: 'erased-visit' },
    });
    expect(await a.outbox.get(id)).toEqual(encrypted);
    expect((await a.operations.get(id))?.envelope).toEqual(encrypted);
    expect(JSON.stringify(await a.exportReplica())).not.toContain(url);
    expect(JSON.stringify(await a.exportReplica())).not.toContain(v.title);
    // Ciphertext erasure is a separate protocol step, still pending at this checkpoint.
    expect(await decryptPayload(key, encrypted, await a.ensureHistoryIndexKey())).toMatchObject({
      action: { visit: { url } },
    });
    await new SyncCoordinator(a, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    expect(JSON.stringify(await b.exportReplica())).not.toContain(url);
    expect((await b.operations.get(id))?.payload).toMatchObject({
      action: { type: 'erased-visit' },
    });
    expect(await a.pendingCount()).toBe(0);
    expect((await b.historyProjection()).visits).toEqual({});
    // Replaying old relay ciphertext cannot persist the plaintext again.
    await b.state.update('local', { cursor: 0, acknowledged_cursor: 0 });
    await new SyncCoordinator(b, () => relay).sync();
    expect(JSON.stringify(await b.exportReplica())).not.toContain(v.title);
    expect((await b.operations.get(id))?.envelope).toEqual(encrypted);
  });

  it('cancels erased unencrypted visits while retaining their identity/counters across reopening', async () => {
    const { a } = await pair(),
      v = await visit(a);
    const id = await a.stageHistory({ type: 'visit', visit: v });
    const original = (await a.drafts.get(id))!;
    await a.stageHistory({ type: 'delete', visit_ids: [v.id] });
    expect(await a.drafts.get(id)).toBeUndefined();
    expect(await a.historyErasedDrafts.get(id)).toMatchObject({
      header: original.header,
      payload: { action: { type: 'erased-visit' }, revision: { counter: original.header.counter } },
    });
    expect(await a.pendingCount()).toBe(1);
    expect(JSON.stringify(await a.exportReplica())).not.toContain(url);
    const next = (await a.state.get('local'))!.next_counter;
    a.close();
    const reopened = new SynkDatabase(a.name);
    dbs.push(reopened);
    await reopened.flushDrafts();
    expect(await reopened.outbox.get(id)).toBeUndefined();
    expect((await reopened.state.get('local'))!.next_counter).toBe(next);
    expect((await reopened.historyProjection()).deleted[v.id]).toHaveLength(1);
    const newer = await reopened.stageHistory({
      type: 'visit',
      visit: await visit(reopened, '2', 2000),
    });
    expect((await reopened.drafts.get(newer))?.header.counter).toBe(next);
    expect((await reopened.queryHistory()).visits.map((row) => row.native_id)).toEqual(['2']);
  });

  it('rolls back journal erasure, draft cancellation, timeline and counters as one transaction', async () => {
    const { a } = await pair(),
      first = await visit(a),
      second = await visit(a, '2', 2000);
    await a.stageHistory({ type: 'visit', visit: first });
    await a.flushDrafts();
    await a.stageHistory({ type: 'visit', visit: second });
    const before = await a.exportReplica();
    const write = vi
      .spyOn(a.historyErasedDrafts, 'put')
      .mockRejectedValueOnce(new Error('Erasure write failed'));
    await expect(
      a.stageHistory({ type: 'delete', visit_ids: [first.id, second.id] }),
    ).rejects.toThrow('Erasure write failed');
    write.mockRestore();
    expect(await a.exportReplica()).toEqual(before);
    await a.stageHistory({ type: 'delete', visit_ids: [first.id, second.id] });
    expect((await a.queryHistory()).visits).toEqual([]);
    expect(JSON.stringify(await a.exportReplica())).not.toContain(url);
    expect(await a.historyErasedDrafts.count()).toBe(1);
  });

  it('retains discarded draft counters for cross-domain reuse validation', async () => {
    const { a, key } = await pair(),
      relay = new Relay(),
      v = await visit(a);
    const id = await a.stageHistory({ type: 'visit', visit: v }),
      original = (await a.drafts.get(id))!;
    await a.stageHistory({ type: 'delete', visit_ids: [v.id] });
    relay.rows.push(
      await encryptDiagnostic(
        key,
        { ...original.header, operation_id: crypto.randomUUID(), domain: 'diagnostic' },
        { kind: 'diagnostic', note: 'Counter reuse', created_at: new Date().toISOString() },
      ),
    );
    await expect(new SyncCoordinator(a, () => relay).sync()).rejects.toThrow('counter was reused');
    expect((await a.state.get('local'))!.cursor).toBe(0);
    expect(await a.quarantine.count()).toBe(1);
    expect(await a.historyErasedDrafts.get(id)).toBeDefined();
    expect((await a.queryHistory()).visits).toEqual([]);
  });

  it('upgrades v7 deleted journals atomically without changing encrypted pending bytes', async () => {
    const { a } = await pair(),
      first = await visit(a),
      second = await visit(a, '2', 2000);
    const firstId = await a.stageHistory({ type: 'visit', visit: first });
    await a.flushDrafts();
    const original = (await a.operations.get(firstId))!;
    const secondId = await a.stageHistory({ type: 'visit', visit: second }),
      draft = (await a.drafts.get(secondId))!;
    await a.stageHistory({ type: 'clear', scope: 'all' });
    const legacy = new Dexie(`history-erasure-v7-${crypto.randomUUID()}`);
    const tables = a.tables.filter((t) => t.name !== 'historyErasedDrafts');
    legacy
      .version(7)
      .stores(
        Object.fromEntries(
          tables.map((t) => [
            t.name,
            [t.schema.primKey.src, ...t.schema.indexes.map((index) => index.src)].join(','),
          ]),
        ),
      );
    for (const table of tables) await legacy.table(table.name).bulkPut(await table.toArray());
    // Restore the plaintext shape actually stored by v7, before the v8 erasure policy.
    await legacy.table('operations').put(original);
    await legacy.table('drafts').put(draft);
    const bytes = await legacy.table('outbox').toArray(),
      state = await legacy.table('state').get('local');
    legacy.close();
    const upgraded = new SynkDatabase(legacy.name);
    dbs.push(upgraded);
    expect(await upgraded.outbox.toArray()).toEqual(bytes);
    expect(await upgraded.state.get('local')).toEqual(state);
    expect((await upgraded.operations.get(firstId))?.payload).toMatchObject({
      action: { type: 'erased-visit' },
    });
    expect((await upgraded.historyErasedDrafts.get(secondId))?.payload.action.type).toBe(
      'erased-visit',
    );
    expect(await upgraded.drafts.get(secondId)).toBeUndefined();
    expect(JSON.stringify(await upgraded.exportReplica())).not.toContain(url);
    expect((await upgraded.queryHistory()).visits).toEqual([]);
  });
});
async function pair() {
  const account = crypto.randomUUID(),
    key = generateRecoveryKey();
  async function device() {
    const db = new SynkDatabase(`history-${crypto.randomUUID()}`);
    dbs.push(db);
    await db.enroll(
      {
        account_id: account,
        device_id: crypto.randomUUID(),
        name: 'History profile',
        token: 'a'.repeat(64),
        server_url: 'http://127.0.0.1:4318',
      },
      key,
    );
    return db;
  }
  return { a: await device(), b: await device(), key, account };
}
const incarnation = crypto.randomUUID(),
  url = 'https://example.com/private-history';
async function visit(db: SynkDatabase, native = '1', time = 1000.25): Promise<HistoryVisit> {
  const local = (await db.state.get('local'))!,
    tag = await historyUrlTag(await db.ensureHistoryIndexKey(), url);
  return {
    id: historyVisitId(local.credentials.device_id, incarnation, native, time),
    source_id: local.credentials.device_id,
    source_name: local.credentials.name,
    incarnation,
    native_id: native,
    visited_at: time,
    url,
    url_tag: tag,
    title: 'Private research title',
    transition: 'link',
    referring_native_id: '0',
    generation: historyGeneration(await db.historyProjection(), local.credentials.device_id, tag),
  };
}
class Relay implements Transport {
  async acknowledge(cursor: number, epoch: string) {
    return { server_epoch: epoch, processed_cursor: cursor };
  }
  epoch = crypto.randomUUID();
  rows: Envelope[] = [];
  offline = false;
  loseReply = false;
  async pull(cursor: number): Promise<PullPage> {
    if (this.offline) throw new Error('Offline');
    return {
      server_epoch: this.epoch,
      records: this.rows
        .slice(cursor, cursor + 100)
        .map((envelope, i) => ({ sequence: cursor + i + 1, envelope })),
      next_cursor: Math.min(this.rows.length, cursor + 100),
      has_more: this.rows.length > cursor + 100,
    };
  }
  async push(envelopes: Envelope[]) {
    if (this.offline) throw new Error('Offline');
    const acknowledgements = envelopes.map((e) => {
      let i = this.rows.findIndex((old) => old.operation_id === e.operation_id);
      if (i < 0) {
        i = this.rows.length;
        this.rows.push(e);
      }
      return { operation_id: e.operation_id, sequence: i + 1 };
    });
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('Reply lost');
    }
    return { server_epoch: this.epoch, acknowledgements };
  }
}
describe('durable encrypted history transport and timeline index', () => {
  it('persists original visits offline across reopening and deduplicates a lost acknowledgement on both clients', async () => {
    const { a, b } = await pair(),
      relay = new Relay(),
      v = await visit(a);
    await a.stageHistory({ type: 'visit', visit: v });
    relay.offline = true;
    await expect(new SyncCoordinator(a, () => relay).sync()).rejects.toThrow('Offline');
    a.close();
    const reopened = new SynkDatabase(a.name);
    dbs.push(reopened);
    expect((await reopened.queryHistory()).visits[0]!.visited_at).toBe(1000.25);
    relay.offline = false;
    relay.loseReply = true;
    await expect(new SyncCoordinator(reopened, () => relay).sync()).rejects.toThrow('lost');
    expect(await reopened.pendingCount()).toBe(1);
    await new SyncCoordinator(reopened, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    expect(await b.historyProjection()).toEqual(await reopened.historyProjection());
    expect(relay.rows).toHaveLength(1);
    expect(JSON.stringify(relay.rows)).not.toContain(url);
    expect(JSON.stringify(relay.rows)).not.toContain(v.title);
    expect((await b.queryHistory()).visits[0]!.transition).toBe('link');
    expect(await reopened.pendingCount()).toBe(0);
  });
  it('applies a global clear before delayed stale uploads and accepts genuinely new-generation visits', async () => {
    const { a, b } = await pair(),
      relay = new Relay();
    relay.offline = true;
    await a.stageHistory({ type: 'visit', visit: await visit(a, '1') });
    await a.stageHistory({ type: 'visit', visit: await visit(a, '2', 2000) });
    await b.stageHistory({ type: 'clear', scope: 'all' });
    relay.offline = false;
    await new SyncCoordinator(b, () => relay).sync();
    await new SyncCoordinator(a, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    expect((await a.queryHistory()).visits).toHaveLength(0);
    expect((await b.queryHistory()).visits).toHaveLength(0);
    expect(Object.keys((await a.historyProjection()).stale)).toHaveLength(2);
    expect(await a.historyErasedDrafts.count()).toBe(2);
    // The erased unencrypted visits never reached the relay or the peer's journal.
    expect(relay.rows).toHaveLength(1);
    expect(Object.keys((await b.historyProjection()).stale)).toHaveLength(0);
    await a.stageHistory({ type: 'visit', visit: await visit(a, '3', 3000) });
    await new SyncCoordinator(a, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    expect((await b.queryHistory()).visits.map((v) => v.native_id)).toEqual(['3']);
    expect(await a.pendingCount()).toBe(0);
    expect(await b.pendingCount()).toBe(0);
  });
  it('keeps selected deletion durable and prevents a later duplicate scan from retagging the erased visit', async () => {
    const { a, b } = await pair(),
      relay = new Relay(),
      v = await visit(a);
    await a.stageHistory({ type: 'visit', visit: v });
    await new SyncCoordinator(a, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    await b.stageHistory({ type: 'delete', visit_ids: [v.id] });
    await new SyncCoordinator(b, () => relay).sync();
    await new SyncCoordinator(a, () => relay).sync();
    await a.stageHistory({ type: 'visit', visit: { ...v, title: 'Newly observed page title' } });
    await new SyncCoordinator(a, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    expect((await b.queryHistory()).visits).toHaveLength(0);
    expect((await b.historyProjection()).deleted[v.id]).toHaveLength(1);
  });
  it('binds URL tags to a separate account index key and rejects mismatched tags/authors before encryption', async () => {
    const { a, b, key, account } = await pair(),
      local = (await a.state.get('local'))!,
      index = await a.ensureHistoryIndexKey();
    expect(index).toBe(await b.ensureHistoryIndexKey());
    expect(index).toBe(await deriveHistoryIndexKey(key, account));
    expect(index).not.toBe(await deriveHistoryIndexKey(key, crypto.randomUUID()));
    expect(index).not.toBe(await deriveHistoryIndexKey(generateRecoveryKey(), account));
    await a.stageHistory({ type: 'visit', visit: await visit(a) });
    const draft = (await a.drafts.toArray())[0]!,
      payload = draft.payload as HistoryOperation;
    if (payload.action.type !== 'visit') throw new Error('Fixture');
    await expect(
      encryptPayload(
        key,
        draft.header,
        {
          ...payload,
          action: { type: 'visit', visit: { ...payload.action.visit, url_tag: '0'.repeat(64) } },
        },
        index,
      ),
    ).rejects.toThrow('URL tag');
    await expect(
      encryptPayload(key, { ...draft.header, device_id: crypto.randomUUID() }, payload, index),
    ).rejects.toThrow('author/revision');
    const envelope = await encryptPayload(key, draft.header, payload, index);
    await expect(decryptPayload(key, envelope, generateRecoveryKey())).rejects.toThrow('URL tag');
    // A retained independent index key also works with a different content root, once key epochs are implemented.
    const replacementRoot = generateRecoveryKey(),
      replacementEnvelope = await encryptPayload(replacementRoot, draft.header, payload, index);
    expect(await decryptPayload(replacementRoot, replacementEnvelope, index)).toEqual(payload);
    const exported = JSON.stringify(await a.exportReplica());
    expect(exported).not.toContain(index);
    expect(exported).not.toContain(local.recovery_key);
  });
  it('quarantines a peer history record when the stored URL index key is wrong and retains the failed-page cursor', async () => {
    const { a, b } = await pair(),
      relay = new Relay();
    await a.stageHistory({ type: 'visit', visit: await visit(a) });
    await new SyncCoordinator(a, () => relay).sync();
    await b.state.update('local', { history_index_key: generateRecoveryKey() });
    await expect(new SyncCoordinator(b, () => relay).sync()).rejects.toThrow('URL tag');
    expect((await b.state.get('local'))!.cursor).toBe(0);
    expect(await b.quarantine.count()).toBe(1);
    expect(await b.historyVisits.count()).toBe(0);
  });
  it('rolls back index/replica/draft/counter changes if a local timeline write fails', async () => {
    const { a } = await pair(),
      v = await visit(a),
      before = (await a.state.get('local'))!.next_counter;
    const spy = vi
      .spyOn(a.historyVisits, 'bulkPut')
      .mockRejectedValueOnce(new Error('Storage full'));
    await expect(a.stageHistory({ type: 'visit', visit: v })).rejects.toThrow('Storage full');
    spy.mockRestore();
    expect(await a.drafts.count()).toBe(0);
    expect(await a.historyVisits.count()).toBe(0);
    expect((await a.state.get('local'))!.next_counter).toBe(before);
    await a.stageHistory({ type: 'visit', visit: v });
    expect((await a.queryHistory()).visits).toHaveLength(1);
  });
  it('caps indexed searches at 2000 examined rows and resumes without skipping equal timestamps or filtered records', async () => {
    const { a, b } = await pair(),
      base = await visit(a),
      other = await visit(b);
    const rows = Array.from({ length: 2005 }, (_, n) => {
      const native_id = String(n).padStart(4, '0');
      return {
        ...base,
        native_id,
        id: historyVisitId(base.source_id, incarnation, native_id, base.visited_at),
        title: n === 0 ? 'Needle target' : 'Ordinary',
        operation_id: crypto.randomUUID(),
      };
    });
    await a.historyVisits.bulkPut([...rows, { ...other, operation_id: crypto.randomUUID() }]);
    const first = await a.queryHistory({ source_id: base.source_id, text: 'needle' });
    expect(first.visits).toHaveLength(0);
    expect(first.examined).toBe(2000);
    expect(first.has_more).toBe(true);
    const second = await a.queryHistory({
      source_id: base.source_id,
      text: 'needle',
      cursor: first.cursor,
    });
    expect(second.visits.map((v) => v.native_id)).toEqual(['0000']);
    expect(second.examined).toBe(5);
    expect(second.has_more).toBe(false);
    const ids: string[] = [];
    let cursor: typeof first.cursor;
    do {
      const page = await a.queryHistory({ source_id: base.source_id, limit: 200, cursor });
      ids.push(...page.visits.map((v) => v.id));
      cursor = page.cursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(2005);
    expect(ids).toHaveLength(2005);
    expect((await a.queryHistory({ start_time: 1000.25, end_time: 1000.25 })).visits).toHaveLength(
      0,
    );
    await expect(
      a.queryHistory({ source_id: other.source_id, cursor: first.cursor }),
    ).rejects.toThrow('cursor');
  });
  it('upgrades a v4 profile while retaining encrypted pending work and interrupted session restoration', async () => {
    const { a } = await pair();
    await a.queueDiagnostic('Kept across history migration');
    const local = (await a.state.get('local'))!,
      name = `history-legacy-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(4).stores({
      state: 'id',
      outbox: 'operation_id, counter',
      records: 'operation_id, sequence, envelope.device_id',
      operations: 'operation_id, sequence, envelope.domain, envelope.device_id',
      drafts: 'operation_id, header.counter, header.domain',
      replicas: 'domain',
      quarantine: 'operation_id, sequence',
      bookmarkSetup: 'id',
      bookmarkBindings: 'logical_id, &native_id',
      bookmarkInbox: '++id, native_id',
      bookmarkEffects: 'id, status, native_id',
      sessionReplicas: 'id',
      sessionSetup: 'id',
      sessionRestores: 'id, status, created_at',
      sessionIdentities: 'key, &logical_id',
      sessionWindows: 'runtime_id',
      sessionClosedSeen: 'id, fingerprint',
    });
    const { history_index_key: _key, ...oldState } = local;
    await legacy.table('state').put(oldState);
    await legacy.table('outbox').bulkPut(await a.outbox.toArray());
    await legacy.table('records').bulkPut(await a.records.toArray());
    const job = {
      id: crypto.randomUUID(),
      snapshot_id: crypto.randomUUID(),
      incarnation: 'runtime',
      created_at: '2026-10-01T08:00:00Z',
      status: 'blocked',
      selection: { mode: 'all' },
      windows: [],
      skipped: [],
    };
    await legacy.table('sessionRestores').put(job);
    legacy.close();
    const upgraded = new SynkDatabase(name);
    dbs.push(upgraded);
    expect(await upgraded.outbox.toArray()).toEqual(await a.outbox.toArray());
    expect(await upgraded.sessionRestores.get(job.id)).toEqual(job);
    expect((await upgraded.state.get('local'))!.next_counter).toBe(local.next_counter);
    expect(await upgraded.ensureHistoryIndexKey()).toBe(await a.ensureHistoryIndexKey());
    expect(await upgraded.historyVisits.count()).toBe(0);
    expect(await upgraded.exportReplica()).toMatchObject({ format: 'helium-synk-replica' });
  });
});
