import Dexie from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BOOKMARK_ROOTS, type BookmarkOperation } from './bookmarks';
import { generateRecoveryKey, encryptDiagnostic, encryptPayload } from './crypto';
import { SynkDatabase } from './database';
import { HttpTransport, SyncCoordinator, type Transport } from './sync';
import { MAX_TRANSFER_BYTES, type Credentials, type Envelope, type PullPage } from './protocol';

const databases: SynkDatabase[] = [];
const credentials = (account_id: string = crypto.randomUUID()): Credentials => ({
  account_id,
  device_id: crypto.randomUUID(),
  name: 'Bookmark client',
  token: 'a'.repeat(64),
  server_url: 'http://127.0.0.1:4318',
});
async function local(c: Credentials, key: string) {
  const db = new SynkDatabase(`book-sync-${crypto.randomUUID()}`);
  databases.push(db);
  await db.enroll(c, key);
  return db;
}
async function pair() {
  const key = generateRecoveryKey(),
    a = credentials();
  return { key, a: await local(a, key), b: await local(credentials(a.account_id), key) };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) await db.delete();
});
class Relay implements Transport {
  async acknowledge(cursor: number, epoch: string) {
    return { server_epoch: epoch, processed_cursor: cursor };
  }
  epoch = crypto.randomUUID();
  offline = false;
  loseResponse = false;
  records: { sequence: number; envelope: Envelope }[] = [];
  async pull(cursor: number): Promise<PullPage> {
    if (this.offline) throw new Error('Offline');
    const records = this.records.filter((r) => r.sequence > cursor).slice(0, 100);
    return {
      server_epoch: this.epoch,
      records,
      next_cursor: records.at(-1)?.sequence ?? cursor,
      has_more: this.records.filter((r) => r.sequence > cursor).length > records.length,
    };
  }
  async push(envelopes: Envelope[]) {
    if (this.offline) throw new Error('Offline');
    const acknowledgements = envelopes.map((envelope) => {
      let old = this.records.find((r) => r.envelope.operation_id === envelope.operation_id);
      if (!old) {
        old = { sequence: this.records.length + 1, envelope };
        this.records.push(old);
      } else if (JSON.stringify(old.envelope) !== JSON.stringify(envelope))
        throw new Error('Reused operation identity');
      return { operation_id: envelope.operation_id, sequence: old.sequence };
    });
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new Error('Lost committed acknowledgement');
    }
    return { server_epoch: this.epoch, acknowledgements };
  }
}
const create = (id: string, title = 'Original') => ({
  type: 'create' as const,
  node_id: id,
  node_type: 'bookmark' as const,
  title,
  url: 'https://example.test/bookmark',
  placement: { parent: BOOKMARK_ROOTS.bar, position: '1/1' },
});

describe('durable bookmark pipeline', () => {
  it('surfaces relay storage exhaustion while retaining the committed local queue', async () => {
    const { a } = await pair(),
      id = crypto.randomUUID();
    await a.queueBookmark(create(id));
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'Relay storage is full' }), { status: 507 }),
      ),
    );
    const state = (await a.state.get('local'))!;
    await expect(new SyncCoordinator(a, () => new HttpTransport(state)).sync()).rejects.toThrow(
      'storage is full',
    );
    expect(await a.pendingCount()).toBe(1);
    expect((await a.bookmarkProjection()).nodes[id]).toBeDefined();
  });
  it('drains large records in byte-bounded batches while preserving their author order', async () => {
    const { a } = await pair(),
      relay = new Relay();
    for (let index = 0; index < 18; index++)
      await a.stageBookmark(create(crypto.randomUUID(), '漢'.repeat(16_000)));
    const sizes: number[] = [],
      counters: number[] = [];
    const transport: Transport = {
      acknowledge: (cursor, epoch) => relay.acknowledge(cursor, epoch),
      pull: (cursor) => relay.pull(cursor),
      push: async (envelopes, epoch) => {
        sizes.push(
          new TextEncoder().encode(JSON.stringify({ envelopes, expected_epoch: epoch })).byteLength,
        );
        counters.push(...envelopes.map((e) => e.counter));
        return relay.push(envelopes);
      },
    };
    await new SyncCoordinator(a, () => transport).sync();
    expect(sizes.length).toBeGreaterThan(1);
    expect(sizes.every((size) => size <= MAX_TRANSFER_BYTES)).toBe(true);
    expect(counters).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect(await a.pendingCount()).toBe(0);
    expect((await a.bookmarkProjection()).nodes[BOOKMARK_ROOTS.bar].children).toHaveLength(18);
  });
  it('accepts unchanged envelope fields returned in a different JSON member order', async () => {
    const { a } = await pair(),
      relay = new Relay(),
      id = crypto.randomUUID();
    await a.queueBookmark(create(id));
    const transport: Transport = {
      acknowledge: (cursor, epoch) => relay.acknowledge(cursor, epoch),
      push: (envelopes) => relay.push(envelopes),
      pull: async (cursor) => {
        const page = await relay.pull(cursor);
        return {
          ...page,
          records: page.records.map((record) => ({
            ...record,
            envelope: Object.fromEntries(
              Object.entries(
                'envelope' in record ? record.envelope : record.redacted.certificate,
              ).reverse(),
            ) as unknown as Envelope,
          })),
        };
      },
    };
    await new SyncCoordinator(a, () => transport).sync();
    expect(await a.pendingCount()).toBe(0);
    expect((await a.bookmarkProjection()).nodes[id]).toBeDefined();
  });
  it('recovers capture committed before encryption after a database reopen', async () => {
    const { a } = await pair(),
      relay = new Relay(),
      id = crypto.randomUUID();
    await a.stageBookmark(create(id));
    expect(await a.drafts.count()).toBe(1);
    expect(await a.outbox.count()).toBe(0);
    expect((await a.bookmarkProjection()).nodes[id].title).toBe('Original');
    const name = a.name;
    a.close();
    const reopened = new SynkDatabase(name);
    databases.push(reopened);
    await new SyncCoordinator(reopened, () => relay).sync();
    expect(await reopened.pendingCount()).toBe(0);
    expect(await reopened.operations.count()).toBe(1);
    expect(relay.records[0].envelope.domain).toBe('bookmark');
    expect((await reopened.bookmarkProjection()).nodes[id].title).toBe('Original');
  });
  it('converges after an offline rename and move, including a lost acknowledgement', async () => {
    const { a, b } = await pair(),
      relay = new Relay(),
      id = crypto.randomUUID();
    const sa = new SyncCoordinator(a, () => relay),
      sb = new SyncCoordinator(b, () => relay);
    await a.queueBookmark(create(id));
    await sa.sync();
    await sb.sync();
    relay.offline = true;
    await a.queueBookmark({ type: 'edit', node_id: id, title: 'Renamed offline' });
    await b.queueBookmark({
      type: 'move',
      node_id: id,
      placement: { parent: BOOKMARK_ROOTS.other, position: '2/3' },
    });
    await expect(sa.sync()).rejects.toThrow('Offline');
    expect(await a.pendingCount()).toBe(1);
    expect(await b.pendingCount()).toBe(1);
    relay.offline = false;
    relay.loseResponse = true;
    await expect(sb.sync()).rejects.toThrow('Lost committed');
    const before = (await b.outbox.toArray())[0];
    await sb.sync();
    await sa.sync();
    await sb.sync();
    expect(
      relay.records.find((r) => r.envelope.operation_id === before.operation_id)?.envelope,
    ).toEqual(before);
    expect(await a.bookmarkProjection()).toEqual(await b.bookmarkProjection());
    expect((await a.bookmarkProjection()).nodes[id]).toMatchObject({
      title: 'Renamed offline',
      parent: BOOKMARK_ROOTS.other,
      position: '2/3',
    });
    expect(await a.pendingCount()).toBe(0);
    expect(await b.pendingCount()).toBe(0);
    expect(relay.records).toHaveLength(3);
  });
  it('keeps mixed note/bookmark captures distinct and uses one author counter stream', async () => {
    const { a, b } = await pair(),
      relay = new Relay(),
      id = crypto.randomUUID();
    await a.queueDiagnostic('Diagnostic stays visible');
    await a.queueBookmark(create(id));
    await new SyncCoordinator(a, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    expect(relay.records.map((r) => r.envelope.counter)).toEqual([1, 2]);
    expect((await b.records.toArray()).map((r) => r.payload.note)).toEqual([
      'Diagnostic stays visible',
    ]);
    expect(await b.operations.count()).toBe(1);
    expect((await b.bookmarkProjection()).nodes[id]).toBeDefined();
  });
  it('serializes concurrent capture revisions and completes drafts shared by overlapping callers', async () => {
    const { a } = await pair(),
      relay = new Relay();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        a.queueBookmark(create(crypto.randomUUID(), `Node ${i}`)),
      ),
    );
    expect(await a.pendingCount()).toBe(12);
    await new SyncCoordinator(a, () => relay).sync();
    const operations = await a.bookmarkOperations();
    expect(new Set(operations.map((o) => o.revision.counter)).size).toBe(12);
    expect(operations.map((o) => o.revision.logical).sort((x, y) => x - y)).toEqual(
      Array.from({ length: 12 }, (_, i) => i + 1),
    );
    expect(await a.pendingCount()).toBe(0);
    expect((await a.bookmarkProjection()).nodes[BOOKMARK_ROOTS.bar].children).toHaveLength(12);
  });
  it('retains the cursor and local draft while quarantining corrupted ciphertext', async () => {
    const { a, b } = await pair(),
      relay = new Relay();
    await a.queueBookmark(create(crypto.randomUUID()));
    const bad = (await a.outbox.toArray())[0];
    relay.records.push({
      sequence: 1,
      envelope: { ...bad, ciphertext: btoa('corrupted ciphertext') },
    });
    const localId = crypto.randomUUID();
    await b.stageBookmark(create(localId, 'Keep local work'));
    await expect(new SyncCoordinator(b, () => relay).sync()).rejects.toThrow();
    expect((await b.state.get('local'))?.cursor).toBe(0);
    expect(await b.operations.count()).toBe(0);
    expect(await b.quarantine.count()).toBe(1);
    expect(await b.pendingCount()).toBe(1);
    expect((await b.bookmarkProjection()).nodes[localId].title).toBe('Keep local work');
  });
  it('quarantines authenticated but impossible causal revisions without advancing durable progress', async () => {
    const { a, b, key } = await pair(),
      relay = new Relay(),
      id = crypto.randomUUID();
    await a.queueBookmark(create(id));
    await new SyncCoordinator(a, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    const ac = (await a.state.get('local'))!.credentials,
      bc = (await b.state.get('local'))!.credentials;
    const operation_id = crypto.randomUUID();
    const payload: BookmarkOperation = {
      kind: 'bookmark',
      schema_version: 1,
      operation_id,
      revision: { author: bc.device_id, counter: 1, logical: 1, context: { [ac.device_id]: 1 } },
      action: { type: 'edit', node_id: id, title: 'Invalid causal clock' },
    };
    const envelope = await encryptPayload(
      key,
      {
        protocol_version: 1,
        operation_id,
        account_id: ac.account_id,
        device_id: bc.device_id,
        counter: 1,
        domain: 'bookmark',
        key_epoch: 1,
      },
      payload,
    );
    await relay.push([envelope]);
    await expect(new SyncCoordinator(a, () => relay).sync()).rejects.toThrow('causal');
    expect((await a.state.get('local'))?.cursor).toBe(1);
    expect((await a.bookmarkProjection()).nodes[id].title).toBe('Original');
    expect(await a.quarantine.count()).toBe(1);
    expect(await a.operations.count()).toBe(1);
  });
  it('binds the encrypted operation author/counter/identity to its envelope', async () => {
    const { a, key } = await pair(),
      id = crypto.randomUUID();
    await a.queueBookmark(create(id));
    const record = (await a.operations.toArray())[0];
    if (record.payload.kind !== 'bookmark') throw new Error('Expected bookmark fixture.');
    for (const changed of [
      { ...record.envelope, counter: 999 },
      { ...record.envelope, operation_id: crypto.randomUUID() },
      { ...record.envelope, device_id: crypto.randomUUID() },
    ]) {
      await expect(encryptPayload(key, changed, record.payload)).rejects.toThrow('envelope');
    }
  });
  it('rejects an oversized operation before committing a counter, draft or projection', async () => {
    const { a } = await pair();
    const action = create(crypto.randomUUID(), '漢'.repeat(16_384));
    action.url = 'https://example.test/' + 'x'.repeat(16_000);
    await expect(a.stageBookmark(action)).rejects.toThrow('payload limit');
    expect((await a.state.get('local'))?.next_counter).toBe(1);
    expect(await a.drafts.count()).toBe(0);
    expect((await a.bookmarkProjection()).nodes[BOOKMARK_ROOTS.bar].children).toEqual([]);
  });
  it('exports tombstones, current values and pending drafts without API credentials or encryption keys', async () => {
    const { a, key } = await pair(),
      id = crypto.randomUUID();
    await a.queueBookmark(create(id));
    await a.stageBookmark({ type: 'remove', node_id: id, observed_descendants: [] });
    const exported = JSON.stringify(await a.exportReplica());
    expect(exported).toContain('helium-synk-replica');
    expect(exported).toContain(id);
    expect(exported).toContain('observed_descendants');
    expect(exported).toContain('Original');
    expect(exported).not.toContain(key);
    expect(exported).not.toContain('a'.repeat(64));
    expect((await a.bookmarkProjection()).deleted[id]).toBeDefined();
  });
  it('re-pulls a hint arriving after the final pull snapshot instead of losing it in single-flight work', async () => {
    const { a, b } = await pair(),
      relay = new Relay(),
      id = crypto.randomUUID();
    let snapshotTaken!: () => void, release!: () => void;
    const taken = new Promise<void>((resolve) => {
      snapshotTaken = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pulls = 0;
    const transport: Transport = {
      acknowledge: (cursor, epoch) => relay.acknowledge(cursor, epoch),
      push: (envelopes) => relay.push(envelopes),
      pull: async (cursor) => {
        const page = await relay.pull(cursor);
        if (++pulls === 2) {
          snapshotTaken();
          await held;
        }
        return page;
      },
    };
    const coordinator = new SyncCoordinator(a, () => transport),
      pending = coordinator.sync();
    await taken;
    await b.queueBookmark(create(id));
    await new SyncCoordinator(b, () => relay).sync();
    const hinted = coordinator.sync();
    expect(hinted).toBe(pending);
    release();
    await pending;
    expect((await a.bookmarkProjection()).nodes[id]).toBeDefined();
    expect((await a.state.get('local'))?.cursor).toBe(1);
  });
  it('migrates the diagnostic-only database without losing its data or outgoing work', async () => {
    const name = `legacy-${crypto.randomUUID()}`,
      c = credentials(),
      key = generateRecoveryKey();
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      state: 'id',
      outbox: 'operation_id, counter',
      records: 'operation_id, sequence, envelope.device_id',
    });
    const payload = {
      kind: 'diagnostic' as const,
      note: 'Legacy queue',
      created_at: new Date().toISOString(),
    };
    const envelope = await encryptDiagnostic(
      key,
      {
        protocol_version: 1,
        operation_id: crypto.randomUUID(),
        account_id: c.account_id,
        device_id: c.device_id,
        counter: 1,
        domain: 'diagnostic',
        key_epoch: 1,
      },
      payload,
    );
    await legacy
      .table('state')
      .put({ id: 'local', credentials: c, recovery_key: key, next_counter: 2, cursor: 0 });
    await legacy.table('records').put({ operation_id: envelope.operation_id, envelope, payload });
    await legacy.table('outbox').put(envelope);
    legacy.close();
    const upgraded = new SynkDatabase(name);
    databases.push(upgraded);
    expect(await upgraded.outbox.count()).toBe(1);
    expect((await upgraded.records.toArray())[0].payload.note).toBe('Legacy queue');
    const id = crypto.randomUUID();
    await upgraded.queueBookmark(create(id));
    const relay = new Relay();
    await new SyncCoordinator(upgraded, () => relay).sync();
    expect(relay.records.map((r) => r.envelope.counter)).toEqual([1, 2]);
    expect((await upgraded.bookmarkProjection()).nodes[id]).toBeDefined();
    expect(await upgraded.pendingCount()).toBe(0);
  });
});
