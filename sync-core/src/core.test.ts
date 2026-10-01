import { afterEach, describe, expect, it } from 'vitest';
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
  for (const db of databases.splice(0)) await db.delete();
});
class Relay implements Transport {
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
