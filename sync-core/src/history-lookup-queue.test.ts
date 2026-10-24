import { afterEach, expect, it } from 'vite-plus/test';
import Dexie from 'dexie';
import { SynkDatabase } from './database';
import { HistoryCapture } from './history-capture';
import { generateRecoveryKey } from './crypto';
import type { HistoryClear } from './history';
import type { HistoryLookup, HistoryMarker } from './history-native';

const dbs: SynkDatabase[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
});
function database() {
  const db = new SynkDatabase(`lookup-queue-${crypto.randomUUID()}`);
  dbs.push(db);
  return db;
}
function lookup(id: string, extra: Partial<HistoryLookup> = {}): HistoryLookup {
  return {
    id,
    job_id: 'audit',
    item: { id, url: `https://example.com/${id}` },
    url_tag: '0'.repeat(64),
    kind: 'audit',
    start: 0,
    end: 1000,
    context: {},
    barriers: [],
    incarnation: 'test',
    position: 0,
    attempts: 0,
    ...extra,
  };
}

it('upgrades v12 queues without losing delayed work, errors, barriers or unrelated state', async () => {
  const template = database();
  await template.open();
  const legacy = new Dexie(`lookup-v12-${crypto.randomUUID()}`);
  legacy
    .version(12)
    .stores(
      Object.fromEntries(
        template.tables.map((t) => [
          t.name,
          t.name === 'historyLookups'
            ? 'id, job_id'
            : [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(','),
        ]),
      ),
    );
  const barrier: HistoryClear = {
    kind: 'history',
    schema_version: 1,
    operation_id: crypto.randomUUID(),
    revision: { author: crypto.randomUUID(), counter: 1, logical: 1, context: {} },
    action: { type: 'clear', scope: 'all' },
  };
  const rows = [
    lookup('ready', { barriers: [barrier], records: [{ visitId: '42' }] }),
    lookup('delayed', { retry_at: 500, error: 'Native unavailable', attempts: 3 }),
  ];
  const pending = { operation_id: 'pending', envelope: { ciphertext: 'opaque bytes' } };
  await legacy.table('historyLookups').bulkAdd(rows);
  await legacy.table('outbox').add(pending);
  legacy.close();
  const db = new SynkDatabase(legacy.name);
  dbs.push(db);
  expect(await db.historyLookups.toArray()).toEqual(
    rows
      .map((row) => ({ ...row, retry_at: row.retry_at ?? 0 }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  expect(await db.readyHistoryLookups(499).primaryKeys()).toEqual(['ready']);
  expect(await db.readyHistoryLookups(500).count()).toBe(2);
  expect(await db.retainedHistoryLookupError()).toBe('Native unavailable');
  expect(await db.outbox.toArray()).toEqual([pending]);
  db.close();
  await db.open();
  expect(await db.historyLookups.count()).toBe(2);
  expect(await db.retainedHistoryLookupError()).toBe('Native unavailable');
});

it('maintains scheduling and error indexes across insert, retry, reset, replacement and delete', async () => {
  const db = database();
  await db.historyLookups.bulkAdd([lookup('a'), lookup('b', { retry_at: 500 })]);
  expect(await db.readyHistoryLookups(100).primaryKeys()).toEqual(['a']);
  await db.historyLookups.update('a', { retry_at: 600, error: 'Retry failure' });
  expect(await db.readyHistoryLookups(100).count()).toBe(0);
  expect(await db.retainedHistoryLookupError()).toBe('Retry failure');
  await db.historyLookups.update('a', { retry_at: undefined, error: undefined });
  expect(await db.readyHistoryLookups(100).primaryKeys()).toEqual(['a']);
  expect(await db.retainedHistoryLookupError()).toBeUndefined();
  await db.historyLookups.put(lookup('b', { error: 'Replacement error' }));
  expect(await db.readyHistoryLookups(100).count()).toBe(2);
  expect(await db.retainedHistoryLookupError()).toBe('Replacement error');
  await db.historyLookups.delete('b');
  expect(await db.retainedHistoryLookupError()).toBeUndefined();
});

it('reconciles a large-barrier backlog with bounded payload reads even behind delayed entries', async () => {
  const db = database();
  await db.enroll(
    {
      account_id: crypto.randomUUID(),
      device_id: crypto.randomUUID(),
      name: 'Synthetic',
      token: 'a'.repeat(64),
      server_url: 'http://127.0.0.1:1',
    },
    generateRecoveryKey(),
  );
  const source = (await db.state.get('local'))!.credentials.device_id;
  let marker: HistoryMarker | undefined;
  let calls = 0;
  const capture = new HistoryCapture(
    db,
    {
      search: async () => [],
      getVisits: async () => {
        calls++;
        return [];
      },
      getMarker: async () => marker,
      setMarker: async (value) => {
        marker = value;
      },
    },
    () => 1000000,
  );
  await capture.enable(0);
  const setup = (await db.historySetup.get('history'))!;
  const barriers: HistoryClear[] = Array.from({ length: 651 }, (_, i) => ({
    kind: 'history',
    schema_version: 1,
    operation_id: crypto.randomUUID(),
    revision: { author: source, counter: i + 1, logical: i + 1, context: { [source]: i } },
    action: {
      type: 'clear',
      scope: 'url',
      source_id: source,
      url_tag: (i + 100000).toString(16).padStart(64, '0'),
    },
  }));
  await db.historyReplicas.put({
    id: 'history',
    value: { barriers, deleted: {}, stale: {}, frontier: { [source]: 651 }, logical: 651 },
  });
  await db.historySetup.update('history', {
    applied: barriers.map((b) => b.operation_id),
    last_audit: 1000000,
  });
  const rows = Array.from({ length: 1175 }, (_, i) =>
    lookup(String(i).padStart(5, '0'), {
      barriers,
      incarnation: setup.incarnation,
      context: { [source]: 651 },
      url_tag: i.toString(16).padStart(64, '0'),
      ...(i < 1170 ? { retry_at: 2000000, error: 'Delayed native lookup', attempts: 2 } : {}),
    }),
  );
  await db.historyLookups.bulkAdd(rows);
  let reads = 0;
  db.historyLookups.hook('reading', (value) => {
    reads++;
    return value;
  });
  expect(await db.readyHistoryLookups(1000000).count()).toBe(5);
  expect(await db.hasReadyHistoryLookups(1000000)).toBe(true);
  expect(await db.retainedHistoryLookupError()).toBe('Delayed native lookup');
  expect(reads).toBe(0);
  await capture.reconcile();
  expect(calls).toBe(5);
  expect(reads).toBeLessThanOrEqual(20);
  expect(await db.readyHistoryLookups(1000000).count()).toBe(0);
  expect(await db.hasReadyHistoryLookups(1000000)).toBe(false);
  expect(await db.historyLookups.count()).toBe(1170);
  expect((await db.historySetup.get('history'))?.error).toBe('Delayed native lookup');
  expect(await db.historyLookups.get('00000')).toEqual(rows[0]);
});
