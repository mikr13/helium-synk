import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vite-plus/test';
import { SynkDatabase } from './database';
import { SyncCoordinator, type Transport } from './sync';
import { HistoryPurger } from './history-purge';
import { decryptPayload, encryptPayload, generateRecoveryKey, historyUrlTag } from './crypto';
import { historyVisitId, type HistoryVisit } from './history';
import {
  envelopeDigest,
  sameEnvelope,
  type Envelope,
  type HistoryPurgeRequest,
  type HistoryPurgeReply,
  type PullPage,
  type RedactedHistoryEntry,
} from './protocol';
import { type HistoryErasure } from './history-erasure';
import { keySnapshot, KeyManager } from './key-manager';
import type { KeyTransport } from './key-state';

const databases: SynkDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases) db.close();
  for (const db of new Map(databases.splice(0).map((db) => [db.name, db])).values())
    await db.delete();
});
class Relay implements Transport {
  epoch = crypto.randomUUID();
  rows: PullPage['records'] = [];
  requests: HistoryPurgeRequest[] = [];
  pageSize = 100;
  loseReply = false;
  async pull(cursor: number): Promise<PullPage> {
    const records = structuredClone(this.rows.slice(cursor, cursor + this.pageSize));
    return {
      server_epoch: this.epoch,
      records,
      next_cursor: cursor + records.length,
      has_more: cursor + records.length < this.rows.length,
    };
  }
  async acknowledge(cursor: number, epoch: string) {
    return { server_epoch: epoch, processed_cursor: cursor };
  }
  async push(envelopes: Envelope[]) {
    const acknowledgements = envelopes.map((envelope) => {
      const known = this.rows.find(
        (row) =>
          ('envelope' in row ? row.envelope.operation_id : row.redacted.header.operation_id) ===
          envelope.operation_id,
      );
      if (known) return { operation_id: envelope.operation_id, sequence: known.sequence };
      const sequence = this.rows.length + 1;
      this.rows.push({ sequence, envelope: structuredClone(envelope) });
      return { operation_id: envelope.operation_id, sequence };
    });
    return { server_epoch: this.epoch, acknowledgements };
  }
  async purge(request: HistoryPurgeRequest): Promise<HistoryPurgeReply> {
    this.requests.push(structuredClone(request));
    const { acknowledgements } = await this.push([request.certificate]);
    const certificate_sequence = acknowledgements[0]!.sequence;
    const redactions: HistoryPurgeReply['redactions'] = [];
    for (const target of request.targets) {
      let row = this.rows.find(
        (row) =>
          ('envelope' in row ? row.envelope.operation_id : row.redacted.header.operation_id) ===
          target.header.operation_id,
      );
      if (row && 'envelope' in row && (await envelopeDigest(row.envelope)) !== target.digest)
        throw new Error('Digest conflict');
      if (!row) {
        row = {
          sequence: this.rows.length + 1,
          envelope: { ...target.header, nonce: '', ciphertext: '' },
        };
        this.rows.push(row);
      }
      const redacted: RedactedHistoryEntry =
        'redacted' in row
          ? row
          : {
              sequence: row.sequence,
              redacted: {
                ...target,
                certificate: structuredClone(request.certificate),
                certificate_sequence,
              },
            };
      this.rows[row.sequence - 1] = redacted;
      redactions.push({
        operation_id: target.header.operation_id,
        sequence: row.sequence,
        digest: target.digest,
        certificate_operation_id: redacted.redacted.certificate.operation_id,
      });
    }
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('Lost purge reply');
    }
    return { server_epoch: this.epoch, certificate_sequence, redactions };
  }
}
async function setup() {
  const relay = new Relay(),
    root = generateRecoveryKey(),
    account = crypto.randomUUID();
  const device = async () => {
    const db = new SynkDatabase(`purge-${crypto.randomUUID()}`);
    databases.push(db);
    await db.enroll(
      {
        account_id: account,
        device_id: crypto.randomUUID(),
        token: 'a'.repeat(64),
        name: 'Disposable profile',
        server_url: 'http://127.0.0.1:4318',
      },
      root,
    );
    return db;
  };
  const a = await device(),
    b = await device();
  const visit = async (db: SynkDatabase, native = '1'): Promise<HistoryVisit> => {
    const state = (await db.state.get('local'))!,
      incarnation = crypto.randomUUID();
    return {
      id: historyVisitId(state.credentials.device_id, incarnation, native, 1234.25),
      source_id: state.credentials.device_id,
      source_name: state.credentials.name,
      incarnation,
      native_id: native,
      visited_at: 1234.25,
      url: 'https://private.example/erase',
      title: 'Erase this title',
      transition: 'typed',
      referring_native_id: '0',
      url_tag: await historyUrlTag(
        await db.ensureHistoryIndexKey(),
        'https://private.example/erase',
      ),
      generation: {},
    };
  };
  const v = await visit(a),
    id = await a.stageHistory({ type: 'visit', visit: v });
  const sync = (db: SynkDatabase) => new SyncCoordinator(db, () => relay).sync();
  return { relay, root, a, b, v, id, visit, device, sync };
}
async function suppressed() {
  const f = await setup();
  await f.sync(f.a);
  await f.sync(f.b);
  await f.b.stageHistory({ type: 'delete', visit_ids: [f.v.id] });
  return f;
}
it('saves content-free claims and counter before encryption, then exact ciphertext/intent across reopening', async () => {
  const f = await suppressed(),
    purger = new HistoryPurger(f.b);
  const old = (await f.b.operations.get(f.id))!,
    counter = (await f.b.state.get('local'))!.next_counter;
  expect(await purger.prepare()).toBe(true);
  const claim = (await f.b.historyPurgeClaims.get(f.id))!;
  const draft = (await f.b.drafts.get(claim.certificate_operation_id))!;
  expect((await f.b.state.get('local'))!.next_counter).toBe(counter + 1);
  expect(await purger.prepare()).toBe(false);
  expect(JSON.stringify(draft)).not.toContain(f.v.url);
  expect(JSON.stringify(draft)).not.toContain(f.v.title);
  expect(JSON.stringify(draft)).not.toContain(old.envelope.ciphertext);
  f.b.close();
  const reopened = new SynkDatabase(f.b.name);
  databases.push(reopened);
  await reopened.flushDrafts();
  const pending = (await reopened.historyPurgePending.toArray())[0]!;
  expect(await reopened.outbox.get(pending.operation_id)).toBeUndefined();
  expect(await decryptPayload(f.root, pending.request.certificate)).toEqual(draft.payload);
  await reopened.flushDrafts();
  expect((await reopened.historyPurgePending.toArray())[0]).toEqual(pending);
  expect((await reopened.operations.get(f.id))!.envelope).toEqual(old.envelope);
});
it('erases known peers past their cursor and bootstraps redacted pages before the certificate sequence', async () => {
  const f = await suppressed(),
    original = (await f.a.operations.get(f.id))!.envelope;
  await f.sync(f.b);
  await f.sync(f.a);
  const fresh = await f.device();
  f.relay.pageSize = 1;
  await f.sync(fresh);
  for (const db of [f.a, f.b, fresh]) {
    const erased = (await db.operations.get(f.id))!;
    expect(erased.envelope.ciphertext).toBe('');
    expect(erased.envelope.nonce).toBe('');
    expect(erased.redacted?.digest).toBe(await envelopeDigest(original));
    expect(erased.sequence).toBe(1);
    expect(await db.historyVisits.count()).toBe(0);
    expect(await db.pendingCount()).toBe(0);
    expect(JSON.stringify(await db.exportReplica())).not.toContain(original.ciphertext);
  }
  expect((await fresh.state.get('local'))!.acknowledged_cursor).toBe(f.relay.rows.length);
  // Exact old content received again cannot restore either plaintext or ciphertext.
  f.relay.rows[0] = { sequence: 1, envelope: original };
  await fresh.state.update('local', { cursor: 0, acknowledged_cursor: 0 });
  await f.sync(fresh);
  expect((await fresh.operations.get(f.id))!.envelope.ciphertext).toBe('');
  f.relay.rows[0] = {
    sequence: 1,
    envelope: { ...original, ciphertext: original.ciphertext.slice(0, -4) + 'AAAA' },
  };
  await fresh.state.update('local', { cursor: 0, acknowledged_cursor: 0 });
  await expect(f.sync(fresh)).rejects.toThrow();
  expect((await fresh.state.get('local'))!.cursor).toBe(0);
  expect((await fresh.operations.get(f.id))!.envelope.ciphertext).toBe('');
});
it('retains a lost committed request and retries its exact body after reopening', async () => {
  const f = await suppressed(),
    purger = new HistoryPurger(f.b);
  await purger.prepare();
  await f.b.flushDrafts();
  const pending = (await f.b.historyPurgePending.toArray())[0]!;
  f.relay.loseReply = true;
  await expect(purger.resume((r) => f.relay.purge(r))).rejects.toThrow('Lost');
  expect(await f.b.historyPurgePending.get(pending.operation_id)).toEqual(pending);
  expect((await f.b.operations.get(f.id))!.envelope.ciphertext).not.toBe('');
  f.b.close();
  const reopened = new SynkDatabase(f.b.name);
  databases.push(reopened);
  await new HistoryPurger(reopened).resume((r) => f.relay.purge(r));
  expect(f.relay.requests).toEqual([pending.request, pending.request]);
  expect((await reopened.operations.get(f.id))!.envelope.ciphertext).toBe('');
  expect(await reopened.historyPurgePending.count()).toBe(0);
  expect(await reopened.historyPurgeClaims.count()).toBe(0);
});
it('retains exact intent on invalid target acknowledgements and rolls back failed local cleanup', async () => {
  const f = await suppressed(),
    purger = new HistoryPurger(f.b);
  await purger.prepare();
  await f.b.flushDrafts();
  const pending = (await f.b.historyPurgePending.toArray())[0]!;
  const reply = await f.relay.purge(pending.request);
  await expect(
    purger.resume(async () => ({
      ...reply,
      redactions: [{ ...reply.redactions[0]!, digest: '0'.repeat(64) }],
    })),
  ).rejects.toThrow('acknowledgement');
  expect(await f.b.historyPurgePending.get(pending.operation_id)).toEqual(pending);
  const put = f.b.operations.put.bind(f.b.operations);
  vi.spyOn(f.b.operations, 'put').mockImplementation((record) => {
    if (record.operation_id === f.id)
      return Dexie.Promise.reject(new Error('Local storage failed'));
    return put(record);
  });
  await expect(purger.resume(async () => reply)).rejects.toThrow('Local storage');
  expect(await f.b.historyPurgePending.get(pending.operation_id)).toEqual(pending);
  expect((await f.b.operations.get(pending.operation_id))!.sequence).toBeUndefined();
  expect((await f.b.operations.get(f.id))!.envelope.ciphertext).not.toBe('');
  vi.restoreAllMocks();
  await f.sync(f.b); // Authenticated pull completes intent without repeating purge.
  expect(f.relay.requests).toHaveLength(1);
  expect(await f.b.historyPurgePending.count()).toBe(0);
});
it('commits erasure, quarantine removal and cursor together; a failed receipt write preserves prior state', async () => {
  const f = await suppressed(),
    original = (await f.a.operations.get(f.id))!;
  await f.a.quarantine.put({
    operation_id: f.id,
    sequence: original.sequence!,
    envelope: original.envelope,
    reason: 'Old copy',
  });
  await f.sync(f.b);
  const state = (await f.a.state.get('local'))!,
    put = f.a.operations.put.bind(f.a.operations);
  vi.spyOn(f.a.operations, 'put').mockImplementation((record) => {
    if (record.operation_id === f.id && record.redacted)
      return Dexie.Promise.reject(new Error('Local storage failed'));
    return put(record);
  });
  await expect(f.sync(f.a)).rejects.toThrow('Local storage');
  expect((await f.a.state.get('local'))!.cursor).toBe(state.cursor);
  expect((await f.a.operations.get(f.id))!.envelope).toEqual(original.envelope);
  expect(await f.a.historyVisits.count()).toBe(1);
  expect(await f.a.quarantine.get(f.id)).toBeDefined();
  vi.restoreAllMocks();
  await f.sync(f.a);
  expect(await f.a.quarantine.get(f.id)).toBeUndefined();
  expect((await f.a.operations.get(f.id))!.envelope.ciphertext).toBe('');
});
it('rejects a valid encrypted certificate whose digest conflicts with the known original', async () => {
  const f = await suppressed();
  await f.sync(f.b);
  const request = f.relay.requests[0]!,
    payload = (await decryptPayload(f.root, request.certificate)) as HistoryErasure;
  payload.targets[0]!.digest = '0'.repeat(64);
  const envelope = await encryptPayload(f.root, request.certificate, payload);
  const row = f.relay.rows.findIndex(
    (r) => 'envelope' in r && r.envelope.operation_id === envelope.operation_id,
  );
  f.relay.rows[row] = { sequence: row + 1, envelope };
  const cursor = (await f.a.state.get('local'))!.cursor;
  await expect(f.sync(f.a)).rejects.toThrow('digest conflicts');
  expect((await f.a.state.get('local'))!.cursor).toBe(cursor);
  expect((await f.a.operations.get(f.id))!.envelope.ciphertext).not.toBe('');
});
it('claims each target once across concurrent database instances', async () => {
  const f = await suppressed(),
    other = new SynkDatabase(f.b.name);
  databases.push(other);
  const counter = (await f.b.state.get('local'))!.next_counter;
  expect(
    (
      await Promise.all([new HistoryPurger(f.b).prepare(), new HistoryPurger(other).prepare()])
    ).sort(),
  ).toEqual([false, true]);
  expect(await f.b.historyPurgeClaims.count()).toBe(1);
  expect((await f.b.state.get('local'))!.next_counter).toBe(counter + 1);
});
it('purges an encrypted own visit never uploaded, reserving its identity without sending the content', async () => {
  const f = await setup();
  await f.a.state.update('local', { server_epoch: f.relay.epoch });
  await f.a.flushDrafts();
  const original = (await f.a.operations.get(f.id))!.envelope;
  await f.a.stageHistory({ type: 'delete', visit_ids: [f.v.id] });
  await f.sync(f.a);
  await f.sync(f.b);
  expect(await f.a.outbox.get(f.id)).toBeUndefined();
  expect((await f.a.operations.get(f.id))!.envelope.ciphertext).toBe('');
  expect(JSON.stringify(f.relay.rows)).not.toContain(original.ciphertext);
  expect(f.relay.rows.some((r) => 'redacted' in r && r.redacted.header.operation_id === f.id)).toBe(
    true,
  );
  expect(await f.b.historyVisits.count()).toBe(0);
});
it.each(['missing', 'committed'] as const)(
  'rekeys a pending certificate only with an explicit %s proof',
  async (result) => {
    const f = await suppressed(),
      purger = new HistoryPurger(f.b);
    await purger.prepare();
    await f.b.flushDrafts();
    const pending = (await f.b.historyPurgePending.toArray())[0]!;
    await keySnapshot(f.b);
    const nextRoot = generateRecoveryKey();
    const secret = (await f.b.keySecrets.get('keys'))!;
    await f.b.keySecrets.put({ ...secret, roots: { ...secret.roots, 2: nextRoot } });
    await f.b.state.update('local', { key_epoch: 2, recovery_key: nextRoot });
    const rekeyCheck = vi.fn(async () => ({
      server_epoch: f.relay.epoch,
      key_epoch: 2,
      committed:
        result === 'committed' ? [{ operation_id: pending.operation_id, sequence: 2 }] : [],
      missing: result === 'missing' ? [pending.operation_id] : [],
    }));
    const keys = { rekeyCheck } as unknown as KeyTransport;
    const send = vi.fn(async (request: HistoryPurgeRequest) => {
      throw new Error(`Stop after proof ${request.certificate.key_epoch}`);
    });
    await expect(new HistoryPurger(f.b, keys).resume(send)).rejects.toThrow(
      `Stop after proof ${result === 'missing' ? 2 : 1}`,
    );
    const saved = (await f.b.historyPurgePending.toArray())[0]!;
    expect(saved.request.targets).toEqual(pending.request.targets);
    expect(saved.request.certificate.operation_id).toBe(pending.operation_id);
    expect(saved.request.certificate.counter).toBe(pending.request.certificate.counter);
    if (result === 'missing') {
      expect(sameEnvelope(saved.request.certificate, pending.request.certificate)).toBe(false);
      expect(await decryptPayload(nextRoot, saved.request.certificate)).toEqual(
        (await f.b.operations.get(pending.operation_id))!.payload,
      );
    } else expect(saved).toEqual(pending);
    expect(rekeyCheck).toHaveBeenCalledWith([pending.request.certificate], f.relay.epoch, 2);
  },
);
it('does not rekey ciphertext protected by a saved erasure claim', async () => {
  const f = await setup();
  await f.a.state.update('local', { server_epoch: f.relay.epoch });
  await f.a.flushDrafts();
  await f.a.stageHistory({ type: 'delete', visit_ids: [f.v.id] });
  await new HistoryPurger(f.a).prepare();
  await keySnapshot(f.a);
  const nextRoot = generateRecoveryKey(),
    secret = (await f.a.keySecrets.get('keys'))!;
  await f.a.keySecrets.put({ ...secret, roots: { ...secret.roots, 2: nextRoot } });
  await f.a.state.update('local', { key_epoch: 2, recovery_key: nextRoot });
  const rekeyCheck = vi.fn(),
    keys = { rekeyCheck } as unknown as KeyTransport;
  const original = (await f.a.outbox.get(f.id))!;
  await new KeyManager(f.a, keys).rekeyOutbox();
  expect(rekeyCheck).not.toHaveBeenCalled();
  expect(await f.a.outbox.get(f.id)).toEqual(original);
});
it('splits more than 80 erased identities into bounded certificates without losing work', async () => {
  const f = await setup();
  const visits = await Promise.all(
    Array.from({ length: 84 }, (_, i) => f.visit(f.a, String(i + 2))),
  );
  await f.a.stageHistories(visits.map((visit) => ({ type: 'visit' as const, visit })));
  await f.sync(f.a);
  await f.sync(f.b);
  await f.b.stageHistory({ type: 'clear', scope: 'all' });
  await f.sync(f.b);
  await f.sync(f.a);
  expect(f.relay.requests).toHaveLength(2);
  expect(f.relay.requests.map((r) => r.targets.length)).toEqual([80, 5]);
  expect(
    new Set(f.relay.requests.flatMap((r) => r.targets.map((t) => t.header.operation_id))).size,
  ).toBe(85);
  expect(await f.a.historyVisits.count()).toBe(0);
  expect(await f.b.historyPurgeClaims.count()).toBe(0);
  expect(await f.b.pendingCount()).toBe(0);
  expect(
    (await f.a.operations.where('envelope.domain').equals('history').toArray()).filter(
      (r) => r.redacted,
    ),
  ).toHaveLength(85);
  const fresh = await f.device(),
    put = vi.spyOn(fresh.operations, 'put');
  await f.sync(fresh);
  expect(
    put.mock.calls.filter(([record]) => record.envelope.domain === 'history-erasure'),
  ).toHaveLength(2);
  expect(await fresh.historyVisits.count()).toBe(0);
});
it('rejects an altered public redaction header even when its certificate authenticates', async () => {
  const f = await suppressed();
  await f.sync(f.b);
  const fresh = await f.device(),
    row = f.relay.rows[0] as RedactedHistoryEntry;
  row.redacted.header.counter++;
  await expect(f.sync(fresh)).rejects.toThrow('differs from its encrypted proof');
  expect((await fresh.state.get('local'))!.cursor).toBe(0);
  expect(await fresh.operations.count()).toBe(0);
  expect(await fresh.quarantine.count()).toBe(1);
});
it('rejects a certified original counter reused by a diagnostic operation, atomically', async () => {
  const f = await suppressed();
  await f.sync(f.b);
  const fresh = await f.device();
  const diagnostic = (await f.a.state.get('local'))!,
    original = (f.relay.rows[0] as RedactedHistoryEntry).redacted.header;
  const header = { ...original, operation_id: crypto.randomUUID(), domain: 'diagnostic' as const };
  const envelope = await encryptPayload(f.root, header, {
    kind: 'diagnostic',
    note: 'Conflicting author',
    created_at: new Date().toISOString(),
  });
  await fresh.records.add({
    operation_id: envelope.operation_id,
    envelope,
    payload: {
      kind: 'diagnostic',
      note: 'Conflicting author',
      created_at: new Date().toISOString(),
    },
  });
  expect(diagnostic.credentials.device_id).toBe(header.device_id);
  await expect(f.sync(fresh)).rejects.toThrow('counter was reused across domains');
  expect((await fresh.state.get('local'))!.cursor).toBe(0);
  expect(await fresh.operations.count()).toBe(0);
  expect(await fresh.records.count()).toBe(1);
});
it('retains encrypted intent and old ciphertext when the server epoch changes', async () => {
  const f = await suppressed(),
    purger = new HistoryPurger(f.b);
  await purger.prepare();
  await f.b.flushDrafts();
  const pending = (await f.b.historyPurgePending.toArray())[0]!;
  await f.b.state.update('local', { server_epoch: crypto.randomUUID() });
  const send = vi.fn();
  await expect(purger.resume(send)).rejects.toThrow('epoch changed');
  expect(send).not.toHaveBeenCalled();
  expect(await f.b.historyPurgePending.get(pending.operation_id)).toEqual(pending);
  expect((await f.b.operations.get(f.id))!.envelope.ciphertext).not.toBe('');
});
