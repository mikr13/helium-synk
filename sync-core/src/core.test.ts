import { afterEach, describe, expect, it, vi } from 'vitest';
import { decryptDiagnostic, generateRecoveryKey, encryptDiagnostic } from './crypto';
import { SynkDatabase } from './database';
import { SyncCoordinator, type Transport } from './sync';
import { parseCredentials, type Credentials, type Envelope, type PullPage } from './protocol';

const databases: SynkDatabase[] = [];
const credentials = (): Credentials => ({
  account_id: crypto.randomUUID(),
  device_id: crypto.randomUUID(),
  token: 'a'.repeat(64),
  name: 'Test device',
  server_url: 'http://127.0.0.1:4318',
});
async function enrolled(key = generateRecoveryKey(), c = credentials()) {
  const db = new SynkDatabase(`test-${crypto.randomUUID()}`);
  databases.push(db);
  await db.enroll(c, key);
  return db;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) await db.delete();
});
class Relay implements Transport {
  async acknowledge(cursor: number, epoch: string) {
    return { server_epoch: epoch, processed_cursor: cursor };
  }
  epoch = crypto.randomUUID();
  records: { sequence: number; envelope: Envelope }[] = [];
  loseResponse = false;
  offline = false;
  async pull(cursor: number): Promise<PullPage> {
    if (this.offline) throw new Error('Offline');
    const records = this.records.filter((r) => r.sequence > cursor).slice(0, 100);
    return {
      server_epoch: this.epoch,
      records,
      next_cursor: records.at(-1)?.sequence ?? cursor,
      has_more: this.records.filter((r) => r.sequence > cursor).length > 100,
    };
  }
  async push(envelopes: Envelope[]) {
    const acknowledgements = envelopes.map((envelope) => {
      let existing = this.records.find((r) => r.envelope.operation_id === envelope.operation_id);
      if (!existing) {
        existing = { sequence: this.records.length + 1, envelope };
        this.records.push(existing);
      }
      return { operation_id: envelope.operation_id, sequence: existing.sequence };
    });
    if (this.loseResponse) {
      this.loseResponse = false;
      throw new Error('Response lost after commit');
    }
    return { server_epoch: this.epoch, acknowledgements };
  }
}

describe('durable encrypted synchronization', () => {
  it('survives a database reopen while offline, then drains once', async () => {
    const db = await enrolled();
    const relay = new Relay();
    relay.offline = true;
    const id = await db.queueDiagnostic('Persist through a restart');
    await expect(new SyncCoordinator(db, () => relay).sync()).rejects.toThrow('Offline');
    const name = db.name;
    db.close();
    const reopened = new SynkDatabase(name);
    databases.push(reopened);
    expect(await reopened.outbox.count()).toBe(1);
    expect((await reopened.records.get(id))?.payload.note).toBe('Persist through a restart');
    relay.offline = false;
    const coordinator = new SyncCoordinator(reopened, () => relay);
    await coordinator.sync();
    await coordinator.sync();
    expect(relay.records).toHaveLength(1);
    expect(await reopened.outbox.count()).toBe(0);
  });
  it('retains ambiguous uploads and retries without duplication', async () => {
    const db = await enrolled();
    const relay = new Relay();
    relay.loseResponse = true;
    await db.queueDiagnostic('Commit succeeded but response disappeared');
    const coordinator = new SyncCoordinator(db, () => relay);
    await expect(coordinator.sync()).rejects.toThrow('Response lost');
    expect(await db.outbox.count()).toBe(1);
    await coordinator.sync();
    expect(await db.outbox.count()).toBe(0);
    expect(relay.records).toHaveLength(1);
  });
  it('decrypts on another installation with the shared recovery key', async () => {
    const key = generateRecoveryKey();
    const a = credentials();
    const first = await enrolled(key, a);
    const second = await enrolled(key, { ...a, device_id: crypto.randomUUID(), name: 'Second' });
    const relay = new Relay();
    await first.queueDiagnostic('From the first device');
    await new SyncCoordinator(first, () => relay).sync();
    await new SyncCoordinator(second, () => relay).sync();
    expect((await second.records.toArray())[0].payload.note).toBe('From the first device');
  });
  it('does not advance a cursor when the key is wrong', async () => {
    const a = credentials();
    const first = await enrolled(generateRecoveryKey(), a);
    const second = await enrolled(generateRecoveryKey(), { ...a, device_id: crypto.randomUUID() });
    const relay = new Relay();
    await first.queueDiagnostic('Unreadable without the shared key');
    await new SyncCoordinator(first, () => relay).sync();
    await expect(new SyncCoordinator(second, () => relay).sync()).rejects.toThrow();
    expect((await second.state.get('local'))?.cursor).toBe(0);
    expect(await second.records.count()).toBe(0);
  });
  it('pauses on a changed server epoch without dropping pending work', async () => {
    const db = await enrolled();
    const relay = new Relay();
    const coordinator = new SyncCoordinator(db, () => relay);
    await coordinator.sync();
    await db.queueDiagnostic('Keep me during recovery');
    relay.epoch = crypto.randomUUID();
    await expect(coordinator.sync()).rejects.toThrow('Server history changed');
    expect(await db.outbox.count()).toBe(1);
  });
  it('reserves unique counters during concurrent capture', async () => {
    const db = await enrolled();
    await Promise.all(Array.from({ length: 12 }, (_, i) => db.queueDiagnostic(`Record ${i}`)));
    const pending = await db.outbox.toArray();
    expect(new Set(pending.map((e) => e.counter)).size).toBe(12);
    expect(await db.records.count()).toBe(12);
  });
  it('shares in-flight synchronization and does not submit duplicate batches', async () => {
    const db = await enrolled();
    const relay = new Relay();
    await db.queueDiagnostic('Single flight');
    const coordinator = new SyncCoordinator(db, () => relay);
    await Promise.all([coordinator.sync(), coordinator.sync(), coordinator.sync()]);
    expect(relay.records).toHaveLength(1);
  });
  it('rejects a malformed acknowledgement and retains its outbox', async () => {
    const db = await enrolled();
    const relay = new Relay();
    await db.queueDiagnostic('Must be acknowledged');
    const transport: Transport = {
      acknowledge: (cursor, epoch) => relay.acknowledge(cursor, epoch),
      pull: (cursor) => relay.pull(cursor),
      push: async () => ({ server_epoch: relay.epoch, acknowledgements: [] }),
    };
    await expect(new SyncCoordinator(db, () => transport).sync()).rejects.toThrow(
      'Incomplete acknowledgement',
    );
    expect(await db.outbox.count()).toBe(1);
  });
  it('rejects a cursor that skips unprocessed records', async () => {
    const db = await enrolled();
    const relay = new Relay();
    const transport: Transport = {
      acknowledge: (cursor, epoch) => relay.acknowledge(cursor, epoch),
      push: (envelopes) => relay.push(envelopes),
      pull: async () => ({
        server_epoch: relay.epoch,
        records: [],
        next_cursor: 99,
        has_more: false,
      }),
    };
    await expect(new SyncCoordinator(db, () => transport).sync()).rejects.toThrow('skipped');
    expect((await db.state.get('local'))?.cursor).toBe(0);
  });
});

describe('encryption and configuration boundaries', () => {
  it('authenticates metadata and uses fresh nonces', async () => {
    const key = generateRecoveryKey();
    const c = credentials();
    const header = {
      protocol_version: 1 as const,
      operation_id: crypto.randomUUID(),
      account_id: c.account_id,
      device_id: c.device_id,
      counter: 1,
      domain: 'diagnostic' as const,
      key_epoch: 1 as const,
    };
    const payload = {
      kind: 'diagnostic' as const,
      note: 'Secret',
      created_at: new Date().toISOString(),
    };
    const a = await encryptDiagnostic(key, header, payload);
    const b = await encryptDiagnostic(key, header, payload);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.ciphertext).not.toContain('Secret');
    await expect(decryptDiagnostic(key, { ...a, counter: 2 })).rejects.toThrow();
  });
  it('rejects HTTP non-local origins and embedded credentials', () => {
    expect(() => parseCredentials({ ...credentials(), server_url: 'http://example.com' })).toThrow(
      'HTTPS',
    );
    expect(() =>
      parseCredentials({ ...credentials(), server_url: 'https://user:pass@example.com' }),
    ).toThrow('HTTPS');
    expect(() =>
      parseCredentials({
        ...credentials(),
        server_url: 'https://mini.example.ts.net?token=secret',
      }),
    ).toThrow('HTTPS');
  });
  it('refuses re-enrollment instead of wiping existing data', async () => {
    const db = await enrolled();
    await db.queueDiagnostic('Keep existing data');
    await expect(db.enroll(credentials(), generateRecoveryKey())).rejects.toThrow(
      'already enrolled',
    );
    expect(await db.outbox.count()).toBe(1);
  });
});

describe('durable processed-cursor acknowledgements', () => {
  async function incoming() {
    const key = generateRecoveryKey(),
      c = credentials();
    const source = await enrolled(key, c);
    const target = await enrolled(key, { ...c, device_id: crypto.randomUUID() });
    await source.queueDiagnostic('First durable page');
    const relay = new Relay();
    await relay.push(await source.outbox.toArray());
    return { source, target, relay };
  }
  it('acknowledges only after the records and cursor transaction commits', async () => {
    const { target, relay } = await incoming();
    const acknowledge = vi.spyOn(relay, 'acknowledge').mockImplementation(async (cursor, epoch) => {
      expect((await target.state.get('local'))?.cursor).toBe(cursor);
      expect(await target.records.count()).toBe(1);
      return { server_epoch: epoch, processed_cursor: cursor };
    });
    await new SyncCoordinator(target, () => relay).sync();
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(1, relay.epoch);
    expect((await target.state.get('local'))?.acknowledged_cursor).toBe(1);
  });
  it('retries a lost ACK reply after reopening and preserves unsent work', async () => {
    const { target, relay } = await incoming();
    await target.queueDiagnostic('Still pending during lost reply');
    const calls: number[] = [];
    let lose = true;
    vi.spyOn(relay, 'acknowledge').mockImplementation(async (cursor, epoch) => {
      calls.push(cursor);
      if (lose) {
        lose = false;
        throw new Error('ACK reply lost after server commit');
      }
      return { server_epoch: epoch, processed_cursor: cursor };
    });
    await expect(new SyncCoordinator(target, () => relay).sync()).rejects.toThrow('ACK reply lost');
    expect((await target.state.get('local'))?.cursor).toBe(1);
    expect((await target.state.get('local'))?.acknowledged_cursor).toBe(0);
    expect(await target.outbox.count()).toBe(1);
    target.close();
    const reopened = new SynkDatabase(target.name);
    databases.push(reopened);
    await new SyncCoordinator(reopened, () => relay).sync();
    expect(calls).toEqual([1, 1, 2]);
    expect(await reopened.outbox.count()).toBe(0);
    expect((await reopened.state.get('local'))?.acknowledged_cursor).toBe(2);
  });
  it('never ACKs a rolled-back local page or wrong-key quarantine', async () => {
    const { target, relay } = await incoming();
    const acknowledge = vi.spyOn(relay, 'acknowledge');
    const failed = vi
      .spyOn(target, 'persistHistory')
      .mockRejectedValue(new Error('Local disk full'));
    await expect(new SyncCoordinator(target, () => relay).sync()).rejects.toThrow(
      'Local disk full',
    );
    expect((await target.state.get('local'))?.cursor).toBe(0);
    expect(await target.records.count()).toBe(0);
    expect(acknowledge).not.toHaveBeenCalled();
    failed.mockRestore();
    const wrong = generateRecoveryKey();
    await target.transaction('rw', [target.state, target.keySecrets], async () => {
      await target.state.update('local', { recovery_key: wrong });
      await target.keySecrets.update('keys', { roots: { 1: wrong } });
    });
    await expect(new SyncCoordinator(target, () => relay).sync()).rejects.toThrow();
    expect(await target.quarantine.count()).toBe(1);
    expect(acknowledge).not.toHaveBeenCalled();
  });
  it('ACKs valid pages but stops before a later corrupted page', async () => {
    const { source, target, relay } = await incoming();
    await source.queueDiagnostic('Corrupted second page');
    await relay.push(await source.outbox.toArray());
    relay.records[1]!.envelope = { ...relay.records[1]!.envelope, nonce: 'bad' };
    const acknowledge = vi.spyOn(relay, 'acknowledge');
    const transport: Transport = {
      push: (e) => relay.push(e),
      acknowledge: (cursor, epoch) => relay.acknowledge(cursor, epoch),
      pull: async (cursor) => ({
        server_epoch: relay.epoch,
        records: relay.records.filter((r) => r.sequence > cursor).slice(0, 1),
        next_cursor: Math.min(cursor + 1, 2),
        has_more: cursor === 0,
      }),
    };
    await expect(new SyncCoordinator(target, () => transport).sync()).rejects.toThrow();
    expect(acknowledge).toHaveBeenCalledExactlyOnceWith(1, relay.epoch);
    expect((await target.state.get('local'))?.cursor).toBe(1);
    expect((await target.state.get('local'))?.acknowledged_cursor).toBe(1);
    expect((await target.quarantine.toArray())[0]?.sequence).toBe(2);
  });
  it('rejects malformed ACK replies and changed epochs without confirming progress', async () => {
    for (const reply of [
      { server_epoch: crypto.randomUUID(), processed_cursor: 1 },
      { server_epoch: 'invalid', processed_cursor: 1 },
      { processed_cursor: 2 },
      { processed_cursor: -1 },
      { processed_cursor: 0.5 },
    ]) {
      const { target, relay } = await incoming();
      vi.spyOn(relay, 'acknowledge').mockResolvedValue({ server_epoch: relay.epoch, ...reply });
      await expect(new SyncCoordinator(target, () => relay).sync()).rejects.toThrow();
      expect((await target.state.get('local'))?.cursor).toBe(1);
      expect((await target.state.get('local'))?.acknowledged_cursor).toBe(0);
    }
  });
  it('retries when storing an accepted ACK fails and upgrades states without an ACK field', async () => {
    const { target, relay } = await incoming();
    await target.state.update('local', { acknowledged_cursor: undefined });
    const acknowledge = vi.spyOn(relay, 'acknowledge');
    const original = target.state.update.bind(target.state);
    const update = vi.spyOn(target.state, 'update').mockImplementation((key, changes) => {
      if ('acknowledged_cursor' in changes) throw new Error('ACK persistence failed');
      return original(key, changes);
    });
    await expect(new SyncCoordinator(target, () => relay).sync()).rejects.toThrow(
      'ACK persistence failed',
    );
    expect((await target.state.get('local'))?.cursor).toBe(1);
    update.mockRestore();
    await new SyncCoordinator(target, () => relay).sync();
    expect(acknowledge).toHaveBeenCalledTimes(2);
    expect((await target.state.get('local'))?.acknowledged_cursor).toBe(1);
  });
  it('checks the live epoch before retrying an unconfirmed ACK', async () => {
    const { target, relay } = await incoming();
    const acknowledge = vi.spyOn(relay, 'acknowledge').mockRejectedValue(new Error('Offline ACK'));
    await expect(new SyncCoordinator(target, () => relay).sync()).rejects.toThrow('Offline ACK');
    acknowledge.mockClear();
    relay.epoch = crypto.randomUUID();
    await expect(new SyncCoordinator(target, () => relay).sync()).rejects.toThrow(
      'Server history changed',
    );
    expect(acknowledge).not.toHaveBeenCalled();
    expect((await target.state.get('local'))?.acknowledged_cursor).toBe(0);
  });
});
