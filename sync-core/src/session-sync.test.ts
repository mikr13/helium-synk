import { afterEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import { sessionWindow } from '../../tests/session-fixtures';
import { SynkDatabase } from './database';
import { generateRecoveryKey, encryptPayload, base64, unbase64 } from './crypto';
import { SyncCoordinator, type Transport } from './sync';
import type { Credentials, Envelope, PullPage } from './protocol';
import type { SessionPart } from './sessions';
const databases: SynkDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
async function pair() {
  const account = crypto.randomUUID(),
    key = generateRecoveryKey();
  async function local() {
    const db = new SynkDatabase(`session-${crypto.randomUUID()}`);
    databases.push(db);
    await db.enroll(
      {
        account_id: account,
        device_id: crypto.randomUUID(),
        token: 'a'.repeat(64),
        name: 'Session device',
        server_url: 'http://127.0.0.1:4318',
      },
      key,
    );
    return db;
  }
  return { a: await local(), b: await local(), key };
}
class Relay implements Transport {
  epoch = crypto.randomUUID();
  rows: Envelope[] = [];
  offline = false;
  loseReply = false;
  pageSize = 100;
  async pull(cursor: number): Promise<PullPage> {
    if (this.offline) throw new Error('Offline');
    return {
      server_epoch: this.epoch,
      records: this.rows
        .slice(cursor, cursor + this.pageSize)
        .map((envelope, i) => ({ sequence: cursor + i + 1, envelope })),
      next_cursor: Math.min(cursor + this.pageSize, this.rows.length),
      has_more: this.rows.length > cursor + this.pageSize,
    };
  }
  async push(envelopes: Envelope[]) {
    if (this.offline) throw new Error('Offline');
    const acknowledgements = envelopes.map((e) => {
      let index = this.rows.findIndex((old) => old.operation_id === e.operation_id);
      if (index < 0) {
        index = this.rows.length;
        this.rows.push(e);
      }
      return { operation_id: e.operation_id, sequence: index + 1 };
    });
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('Acknowledgement lost');
    }
    return { server_epoch: this.epoch, acknowledgements };
  }
}
const content = (kind: 'current' | 'closed' | 'previous' = 'current', count = 3) => ({
  kind,
  captured_at: '2026-10-01T08:00:00Z',
  windows: [sessionWindow(count)],
});
describe('durable session synchronization', () => {
  it('upgrades a v3 bookmark profile without losing pending capture, mappings or recovery data', async () => {
    const { a } = await pair(),
      local = (await a.state.get('local'))!,
      name = `legacy-${crypto.randomUUID()}`;
    const legacy = new Dexie(name);
    legacy.version(3).stores({
      state: 'id',
      outbox: 'operation_id, counter',
      records: 'operation_id, sequence, envelope.device_id',
      operations: 'operation_id, sequence, envelope.domain, envelope.device_id',
      drafts: 'operation_id, header.counter',
      replicas: 'domain',
      quarantine: 'operation_id, sequence',
      bookmarkSetup: 'id',
      bookmarkBindings: 'logical_id, &native_id',
      bookmarkInbox: '++id, native_id',
      bookmarkEffects: 'id, status, native_id',
    });
    const id = crypto.randomUUID(),
      operation_id = crypto.randomUUID();
    const payload = {
      kind: 'bookmark',
      schema_version: 1,
      operation_id,
      revision: { author: local.credentials.device_id, counter: 1, logical: 1, context: {} },
      action: {
        type: 'create',
        node_id: id,
        node_type: 'folder',
        title: 'Offline folder',
        placement: { parent: '00000000-0000-0000-0000-000000000001', position: '1/1' },
      },
    };
    await legacy.table('state').add({ ...local, next_counter: 2 });
    await legacy.table('drafts').add({
      operation_id,
      payload,
      header: {
        protocol_version: 1,
        operation_id,
        account_id: local.credentials.account_id,
        device_id: local.credentials.device_id,
        counter: 1,
        domain: 'bookmark',
        key_epoch: 1,
      },
    });
    await legacy.table('bookmarkBindings').add({ logical_id: id, native_id: '42' });
    legacy.close();
    const upgraded = new SynkDatabase(name);
    databases.push(upgraded);
    expect(await upgraded.drafts.where('header.domain').equals('bookmark').count()).toBe(1);
    expect((await upgraded.bookmarkBindings.get(id))!.native_id).toBe('42');
    const snapshot = await upgraded.stageSession(content());
    await upgraded.sessionRestores.put({
      id: crypto.randomUUID(),
      snapshot_id: snapshot,
      incarnation: 'runtime',
      created_at: '2026-10-01T08:00:00Z',
      status: 'running',
      selection: { mode: 'all' },
      windows: [],
      skipped: [],
    });
    await upgraded.flushDrafts();
    expect(await upgraded.pendingCount()).toBe(2);
    const exported = await upgraded.exportReplica();
    expect(JSON.stringify(exported)).toContain('Offline folder');
    expect(JSON.stringify(exported)).toContain('session_restores');
    expect(JSON.stringify(exported)).not.toContain(local.recovery_key);
    expect(JSON.stringify(exported)).not.toContain(local.credentials.token);
  });

  it('persists unpublished snapshots across database reopen, deduplicates lost acknowledgements and converges independent sources', async () => {
    const { a, b } = await pair(),
      relay = new Relay();
    relay.offline = true;
    const aId = await a.stageSession(content()),
      bId = await b.stageSession(content('closed'));
    await expect(new SyncCoordinator(a, () => relay).sync()).rejects.toThrow('Offline');
    a.close();
    const revived = new SynkDatabase(a.name);
    databases.push(revived);
    expect((await revived.sessionProjection()).snapshots[aId]).toBeDefined();
    relay.offline = false;
    relay.loseReply = true;
    await expect(new SyncCoordinator(revived, () => relay).sync()).rejects.toThrow('lost');
    expect(await revived.pendingCount()).toBe(1);
    await new SyncCoordinator(revived, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    await new SyncCoordinator(revived, () => relay).sync();
    expect(await revived.sessionProjection()).toEqual(await b.sessionProjection());
    expect((await b.sessionProjection()).snapshots[bId]).toBeDefined();
    expect(relay.rows).toHaveLength(2);
    expect(await revived.pendingCount()).toBe(0);
  });
  it('coalesces only wholly unencrypted current snapshots and retains closed and saved snapshots', async () => {
    const { a } = await pair(),
      old = await a.stageSession(content()),
      closed = await a.stageSession(content('closed')),
      saved = await a.stageSession(content('previous')),
      latest = await a.stageSession(content());
    const p = await a.sessionProjection();
    expect(p.snapshots[old]).toBeUndefined();
    expect([closed, saved, latest].every((id) => !!p.snapshots[id])).toBe(true);
    expect(await a.drafts.count()).toBe(3);
    await a.flushDrafts();
    await a.stageSession(content());
    expect(await a.outbox.count()).toBe(3);
    expect((await a.sessionProjection()).snapshots[latest]).toBeDefined();
  });
  it('keeps the last complete session visible across durable multipart cursor pages', async () => {
    const { a, b } = await pair(),
      relay = new Relay(),
      old = await a.stageSession(content());
    await new SyncCoordinator(a, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    const large = content('current', 600);
    large.windows[0]!.tabs.forEach((t) => {
      t.title = '漢'.repeat(200);
    });
    const newest = await a.stageSession(large);
    await new SyncCoordinator(a, () => relay).sync();
    expect(relay.rows.length).toBeGreaterThan(2);
    relay.pageSize = 1;
    let pulls = 0;
    const transport: Transport = {
      push: (e) => relay.push(e),
      pull: async (cursor) => {
        if (++pulls === 2) throw new Error('Page interrupted');
        return relay.pull(cursor);
      },
    };
    await expect(new SyncCoordinator(b, () => transport).sync()).rejects.toThrow('interrupted');
    const source = (await a.state.get('local'))!.credentials.device_id;
    expect((await b.sessionProjection()).current[source]).toBe(old);
    expect((await b.sessionProjection()).incomplete).toContain(newest);
    expect((await b.state.get('local'))!.cursor).toBe(2);
    await new SyncCoordinator(b, () => relay).sync();
    expect((await b.sessionProjection()).current[source]).toBe(newest);
  });
  it('binds encrypted session authors/counters and quarantines corrupted complete assemblies without advancing the failed page', async () => {
    const { a, b, key } = await pair(),
      relay = new Relay();
    await a.stageSession(content());
    await a.flushDrafts();
    const record = (await a.operations.toArray())[0]!,
      payload = record.payload as SessionPart;
    await expect(
      encryptPayload(key, { ...record.envelope, device_id: crypto.randomUUID() }, payload),
    ).rejects.toThrow('source/revision');
    const broken = { ...payload, data: btoa('{invalid') };
    const envelope = await encryptPayload(key, record.envelope, broken);
    relay.rows = [envelope];
    await expect(new SyncCoordinator(b, () => relay).sync()).rejects.toThrow();
    expect((await b.state.get('local'))!.cursor).toBe(0);
    expect(await b.quarantine.count()).toBe(1);
    expect(Object.keys((await b.sessionProjection()).snapshots)).toHaveLength(0);
  });
  it('preserves immutable fragments if a new capture arrives after encryption has started', async () => {
    const { a } = await pair(),
      big = content('current', 500);
    big.windows[0]!.tabs.forEach((t) => {
      t.title = 'Long'.repeat(100);
    });
    const old = await a.stageSession(big);
    const one = (await a.drafts.orderBy('header.counter').toArray())[0]!;
    const local = (await a.state.get('local'))!,
      envelope = await encryptPayload(local.recovery_key, one.header, one.payload);
    await a.transaction('rw', [a.drafts, a.operations, a.outbox], async () => {
      await a.operations.add({ operation_id: one.operation_id, payload: one.payload, envelope });
      await a.outbox.add(envelope);
      await a.drafts.delete(one.operation_id);
    });
    await a.stageSession(content());
    expect((await a.sessionProjection()).snapshots[old]).toBeDefined();
    await a.flushDrafts();
    expect(
      (await a.operations.where('envelope.domain').equals('session').toArray()).filter(
        (r) => (r.payload as SessionPart).snapshot_id === old,
      ),
    ).toHaveLength((one.payload as SessionPart).total);
  });
  it('rejects cross-domain author counter reuse and retains local queues', async () => {
    const { a, b, key } = await pair(),
      relay = new Relay();
    await a.queueDiagnostic('Existing');
    await new SyncCoordinator(a, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    await a.stageSession(content());
    const part = (await a.drafts.toArray())[0]!,
      payload = { ...(part.payload as SessionPart), source_revision: 1 };
    const body = JSON.parse(new TextDecoder().decode(unbase64(payload.data)));
    body.source_revision = 1;
    payload.data = base64(new TextEncoder().encode(JSON.stringify(body)));
    const envelope = await encryptPayload(key, { ...part.header, counter: 1 }, payload);
    relay.rows.push(envelope);
    await expect(new SyncCoordinator(b, () => relay).sync()).rejects.toThrow('counter');
    expect((await b.state.get('local'))!.cursor).toBe(1);
    expect(await b.quarantine.count()).toBe(1);
  });
});
