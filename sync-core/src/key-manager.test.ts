import Dexie from 'dexie';
import { afterEach, expect, it, vi } from 'vitest';
import { SynkDatabase } from './database';
import { KeyManager, keySnapshot } from './key-manager';
import { SyncCoordinator, type Transport } from './sync';
import { generateRecoveryKey, decryptDiagnostic, historyUrlTag } from './crypto';
import { sameEnvelope, type Credentials, type Envelope } from './protocol';
import type {
  KeyState,
  KeyDevice,
  KeyTransport,
  RotationRequest,
  RotationReply,
} from './key-state';
import { exportRecovery, enrollRecovery, parseRecoveryBundle } from './recovery';
import { BOOKMARK_ROOTS } from './bookmarks';

const databases: SynkDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases) db.close();
  for (const db of new Map(databases.splice(0).map((db) => [db.name, db])).values())
    await db.delete();
});
class Relay {
  account = crypto.randomUUID();
  server = crypto.randomUUID();
  epoch = 1;
  devices = new Map<string, KeyDevice>();
  rotations = new Map<string, RotationRequest>();
  records: { sequence: number; envelope: Envelope }[] = [];
  lostIdentity = false;
  lostRotation = false;
  lostPush = false;
  identityBodies: string[] = [];
  rotationBodies: string[] = [];
  credentials(name: string): Credentials {
    const c = {
      account_id: this.account,
      device_id: crypto.randomUUID(),
      token: 'a'.repeat(64),
      name,
      server_url: 'http://127.0.0.1:4318',
    };
    this.devices.set(c.device_id, {
      device_id: c.device_id,
      name,
      revoked: false,
      public_key: null,
      proof: null,
      proof_epoch: null,
    });
    return c;
  }
  transport(c: Credentials): Transport & { keys: KeyTransport } {
    const active = () => {
      if (this.devices.get(c.device_id)?.revoked) throw new Error('Revoked');
    };
    const keys: KeyTransport = {
      state: async (after) => {
        active();
        if (after > this.epoch) throw new Error('Relay is behind');
        const authored = this.records
          .filter((r) => r.envelope.device_id === c.device_id)
          .sort((a, b) => b.envelope.counter - a.envelope.counter)[0];
        const packets = [...this.rotations.values()]
          .sort((a, b) => a.key_epoch - b.key_epoch)
          .filter((r) => r.key_epoch > after)
          .flatMap((r) => r.packets.filter((p) => p.recipient_id === c.device_id));
        return structuredClone({
          account_id: this.account,
          server_epoch: this.server,
          key_epoch: this.epoch,
          devices: [...this.devices.values()],
          packets: packets.slice(0, 32),
          has_more: packets.length > 32,
          author_counter: authored?.envelope.counter ?? 0,
          author_operation_id: authored?.envelope.operation_id ?? null,
        });
      },
      identity: async (identity, server) => {
        active();
        this.identityBodies.push(JSON.stringify(identity));
        const own = this.devices.get(c.device_id)!;
        if (own.public_key && own.public_key !== identity.public_key)
          throw new Error('Identity changed');
        if (!own.public_key && identity.proof_epoch !== this.epoch)
          throw new Error('Epoch changed');
        Object.assign(own, identity);
        if (this.lostIdentity) {
          this.lostIdentity = false;
          throw new Error('Lost identity reply');
        }
        return { ...identity, server_epoch: server };
      },
      rotate: async (request) => {
        active();
        this.rotationBodies.push(JSON.stringify(request));
        const previous = this.rotations.get(request.rotation_id);
        if (previous) {
          if (JSON.stringify(previous) !== JSON.stringify(request))
            throw new Error('Rotation changed');
        } else {
          if (request.from_epoch !== this.epoch) throw new Error('Epoch changed');
          const retained = [...this.devices.values()].filter(
            (d) => !d.revoked && !request.revoke_ids.includes(d.device_id),
          );
          if (
            retained.length !== request.packets.length ||
            retained.some(
              (d) =>
                !request.packets.some(
                  (p) => p.recipient_id === d.device_id && p.recipient_public_key === d.public_key,
                ),
            )
          )
            throw new Error('Membership changed');
          this.rotations.set(request.rotation_id, structuredClone(request));
          request.revoke_ids.forEach((id) => {
            this.devices.get(id)!.revoked = true;
          });
          this.epoch = request.key_epoch;
        }
        if (this.lostRotation) {
          this.lostRotation = false;
          throw new Error('Lost rotation reply');
        }
        return {
          server_epoch: this.server,
          rotation_id: request.rotation_id,
          key_epoch: request.key_epoch,
        };
      },
      rekeyCheck: async (envelopes, server, epoch) => {
        active();
        if (epoch !== this.epoch) throw new Error('Epoch changed');
        const committed = [],
          missing = [];
        for (const envelope of envelopes) {
          const old = this.records.find((r) => r.envelope.operation_id === envelope.operation_id);
          if (old) {
            if (!sameEnvelope(old.envelope, envelope)) throw new Error('Committed contents differ');
            committed.push({ operation_id: envelope.operation_id, sequence: old.sequence });
          } else missing.push(envelope.operation_id);
        }
        return { server_epoch: server, key_epoch: epoch, committed, missing };
      },
    };
    return {
      keys,
      pull: async (cursor) => {
        active();
        const records = this.records.slice(cursor, cursor + 100);
        return structuredClone({
          server_epoch: this.server,
          records,
          next_cursor: records.at(-1)?.sequence ?? cursor,
          has_more: this.records.length > cursor + 100,
        });
      },
      push: async (envelopes) => {
        active();
        const acknowledgements = [];
        for (const envelope of envelopes) {
          let record = this.records.find((r) => r.envelope.operation_id === envelope.operation_id);
          if (record) {
            if (!sameEnvelope(record.envelope, envelope))
              throw new Error('Committed identity changed');
          } else {
            if (envelope.key_epoch !== this.epoch) throw new Error('Epoch changed');
            record = { sequence: this.records.length + 1, envelope: structuredClone(envelope) };
            this.records.push(record);
          }
          acknowledgements.push({ operation_id: envelope.operation_id, sequence: record.sequence });
        }
        if (this.lostPush) {
          this.lostPush = false;
          throw new Error('Lost push reply');
        }
        return { server_epoch: this.server, acknowledgements };
      },
      acknowledge: async (cursor) => ({ server_epoch: this.server, processed_cursor: cursor }),
    };
  }
}
async function client(relay: Relay, name: string, root: string) {
  const c = relay.credentials(name),
    db = new SynkDatabase(`keys-${crypto.randomUUID()}`);
  databases.push(db);
  await db.enroll(c, root);
  const transport = relay.transport(c);
  return {
    db,
    c,
    transport,
    manager: new KeyManager(db, transport.keys),
    sync: () => new SyncCoordinator(db, () => transport).sync(),
  };
}
async function peers() {
  const relay = new Relay(),
    root = generateRecoveryKey();
  const a = await client(relay, 'A', root),
    b = await client(relay, 'B', root),
    removed = await client(relay, 'Removed', root);
  await a.sync();
  await b.sync();
  await removed.sync();
  return { relay, root, a, b, removed };
}
it('persists the independent wrapping identity before HTTP and retries it unchanged after reopen', async () => {
  const relay = new Relay(),
    a = await client(relay, 'A', generateRecoveryKey());
  relay.lostIdentity = true;
  await expect(a.manager.refresh()).rejects.toThrow('Lost identity');
  const saved = (await a.db.keySecrets.get('keys'))!;
  expect(saved.identity?.private_key.d).toBeTruthy();
  a.db.close();
  const reopened = new SynkDatabase(a.db.name);
  databases.push(reopened);
  await new KeyManager(reopened, a.transport.keys).refresh();
  expect(relay.identityBodies[1]).toBe(relay.identityBodies[0]);
  expect((await reopened.keySecrets.get('keys'))?.identity).toEqual(saved.identity);
  expect(JSON.stringify(relay.identityBodies)).not.toContain(saved.identity!.private_key.d);
});
it('migrates an enrolled schema-6 database while preserving keys, counters and queued notes', async () => {
  const relay = new Relay(),
    c = relay.credentials('Legacy'),
    root = generateRecoveryKey(),
    name = `keys-old-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(6).stores({
    state: 'id',
    outbox: 'operation_id, counter',
    records: 'operation_id, sequence, envelope.device_id',
  });
  await old
    .table('state')
    .put({ id: 'local', credentials: c, recovery_key: root, next_counter: 1, cursor: 0 });
  old.close();
  const db = new SynkDatabase(name);
  databases.push(db);
  const id = await db.queueDiagnostic('Kept through upgrade');
  await new KeyManager(db, relay.transport(c).keys).refresh();
  expect((await keySnapshot(db)).secrets.roots).toEqual({ 1: root });
  expect((await db.state.get('local'))?.next_counter).toBe(2);
  expect((await db.outbox.get(id))?.key_epoch).toBe(1);
});
it('recovers an exact saved rotation after a lost reply and worker/database reopen', async () => {
  const { relay, a, removed } = await peers();
  await a.manager.stageRotation([removed.c.device_id]);
  const pending = (await a.db.rotationPending.get('rotation'))!;
  expect((await a.db.state.get('local'))?.key_epoch).toBe(1);
  relay.lostRotation = true;
  await expect(a.manager.completeRotation()).rejects.toThrow('Lost rotation');
  a.db.close();
  const reopened = new SynkDatabase(a.db.name);
  databases.push(reopened);
  await new KeyManager(reopened, a.transport.keys).completeRotation();
  expect(relay.rotationBodies[1]).toBe(relay.rotationBodies[0]);
  expect((await reopened.state.get('local'))?.recovery_key).toBe(pending.new_root);
  expect(await reopened.rotationPending.count()).toBe(0);
  await expect(removed.sync()).rejects.toThrow('Revoked');
});
it('automatically resumes a pre-commit saved rotation and recovers committed intent through its own packet', async () => {
  const { relay, a, b, removed } = await peers();
  await a.manager.stageRotation([removed.c.device_id]);
  await a.sync();
  expect(relay.epoch).toBe(2);
  expect(await a.db.rotationPending.count()).toBe(0);
  await b.manager.refresh();
  await b.manager.stageRotation([]);
  relay.lostRotation = true;
  await expect(b.manager.completeRotation()).rejects.toThrow('Lost rotation');
  await b.sync();
  expect(relay.epoch).toBe(3);
  expect(await b.db.rotationPending.count()).toBe(0);
});
it('retains historical keys and safely rekeys offline diagnostic/bookmark work without changing logical identities or history indexes', async () => {
  const { relay, root, a, b, removed } = await peers();
  const note = await b.db.queueDiagnostic('Offline future note');
  const old = (await b.db.outbox.get(note))!;
  const node = crypto.randomUUID(),
    bookmark = await b.db.stageBookmark({
      type: 'create',
      node_id: node,
      node_type: 'bookmark',
      title: 'Offline bookmark',
      url: 'https://bookmark.example',
      placement: { parent: BOOKMARK_ROOTS.bar, position: '0/1' },
    });
  await a.manager.stageRotation([removed.c.device_id]);
  await a.manager.completeRotation();
  await b.sync();
  await a.sync();
  const queued = (await b.db.records.get(note))!;
  expect(queued.envelope.operation_id).toBe(old.operation_id);
  expect(queued.envelope.counter).toBe(old.counter);
  expect(queued.envelope.key_epoch).toBe(2);
  expect(queued.envelope.nonce).not.toBe(old.nonce);
  expect((await b.db.operations.get(bookmark))?.envelope.key_epoch).toBe(2);
  await expect(decryptDiagnostic(root, queued.envelope)).rejects.toThrow();
  expect((await a.db.bookmarkProjection()).nodes[node]?.title).toBe('Offline bookmark');
  const index = (await b.db.state.get('local'))!.history_index_key!;
  expect(await historyUrlTag(index, 'https://bookmark.example')).toBe(
    await historyUrlTag(
      (await a.db.state.get('local'))!.history_index_key!,
      'https://bookmark.example',
    ),
  );
  await a.manager.stageRotation([]);
  await a.manager.completeRotation();
  await b.sync();
  expect(Object.keys((await b.db.keySecrets.get('keys'))!.roots)).toEqual(['1', '2', '3']);
  expect(await b.db.pendingCount()).toBe(0);
  expect(relay.epoch).toBe(3);
});
it('acknowledges an ambiguously committed old envelope without rewriting its ciphertext', async () => {
  const { relay, a, b, removed } = await peers();
  const id = await b.db.queueDiagnostic('Already accepted');
  const envelope = (await b.db.outbox.get(id))!;
  relay.lostPush = true;
  await expect(b.sync()).rejects.toThrow('Lost push');
  await a.manager.stageRotation([removed.c.device_id]);
  await a.manager.completeRotation();
  await b.sync();
  expect((await b.db.records.get(id))?.envelope).toEqual(envelope);
  expect((await b.db.records.get(id))?.sequence).toBe(1);
  expect(await b.db.outbox.count()).toBe(0);
  expect(relay.records).toHaveLength(1);
});
it('keeps queues and journal ciphertext unchanged for incomplete, duplicated, unknown or wrong-epoch rekey proofs', async () => {
  const { a, b, removed } = await peers();
  const id = await b.db.queueDiagnostic('Keep until proven missing');
  const envelope = (await b.db.outbox.get(id))!;
  await a.manager.stageRotation([removed.c.device_id]);
  await a.manager.completeRotation();
  await b.manager.refresh();
  const valid = await b.transport.keys.rekeyCheck(
    [envelope],
    (await b.db.state.get('local'))!.server_epoch!,
    2,
  );
  const bad = [
    { ...valid, missing: [] },
    { ...valid, missing: [id, id] },
    { ...valid, missing: [crypto.randomUUID()] },
    { ...valid, key_epoch: 3 },
    { ...valid, server_epoch: crypto.randomUUID() },
    { ...valid, missing: [], committed: [{ operation_id: id, sequence: 0 }] },
  ];
  for (const proof of bad) {
    await expect(
      new KeyManager(b.db, { ...b.transport.keys, rekeyCheck: async () => proof }).rekeyOutbox(),
    ).rejects.toThrow();
    expect(await b.db.outbox.get(id)).toEqual(envelope);
    expect((await b.db.records.get(id))?.envelope).toEqual(envelope);
  }
});
it('rolls back local ciphertext replacement on storage failure then retries safely', async () => {
  const { a, b, removed } = await peers();
  const id = await b.db.queueDiagnostic('Atomic replacement');
  const old = (await b.db.outbox.get(id))!;
  await a.manager.stageRotation([removed.c.device_id]);
  await a.manager.completeRotation();
  await b.manager.refresh();
  const write = vi.spyOn(b.db.outbox, 'put').mockRejectedValueOnce(new Error('Local quota'));
  await expect(b.manager.rekeyOutbox()).rejects.toThrow('Local quota');
  expect(await b.db.outbox.get(id)).toEqual(old);
  expect((await b.db.records.get(id))?.envelope).toEqual(old);
  write.mockRestore();
  await b.sync();
  expect(await b.db.outbox.count()).toBe(0);
  expect((await b.db.records.get(id))?.envelope.key_epoch).toBe(2);
});
it('preserves the chosen epoch when key pages are tampered, skipped or the relay epoch rolls back', async () => {
  const { relay, a, b, removed } = await peers();
  await a.manager.stageRotation([removed.c.device_id]);
  await a.manager.completeRotation();
  const remote = await b.transport.keys.state(1);
  const bad = [
    { ...remote, server_epoch: crypto.randomUUID() },
    { ...remote, packets: [] },
    { ...remote, packets: [{ ...remote.packets[0]!, proof: generateRecoveryKey() }] },
    { ...remote, has_more: true },
  ];
  for (const value of bad) {
    await expect(
      new KeyManager(b.db, { ...b.transport.keys, state: async () => value }).refresh(),
    ).rejects.toThrow();
    expect((await b.db.state.get('local'))?.key_epoch).toBe(1);
  }
  await b.manager.refresh();
  relay.epoch = 1;
  await expect(b.manager.refresh()).rejects.toThrow('behind');
  expect((await b.db.state.get('local'))?.key_epoch).toBe(2);
});
it('concurrent initialization/adoption converges without replacing private identity or forked keys', async () => {
  const relay = new Relay(),
    a = await client(relay, 'A', generateRecoveryKey());
  await Promise.all([a.manager.refresh(), new KeyManager(a.db, a.transport.keys).refresh()]);
  expect(new Set(relay.identityBodies).size).toBe(1);
  await a.manager.stageRotation([]);
  await a.manager.completeRotation();
  await Promise.all([a.manager.refresh(), new KeyManager(a.db, a.transport.keys).refresh()]);
  expect(Object.keys((await a.db.keySecrets.get('keys'))!.roots)).toHaveLength(2);
});
it('does not transmit or activate a proposed root before a durable proposal write succeeds', async () => {
  const { relay, a, removed } = await peers();
  vi.spyOn(a.db.rotationPending, 'put').mockRejectedValueOnce(new Error('Storage unavailable'));
  await expect(a.manager.stageRotation([removed.c.device_id])).rejects.toThrow(
    'Storage unavailable',
  );
  expect(relay.rotationBodies).toHaveLength(0);
  expect(relay.epoch).toBe(1);
  expect((await a.db.state.get('local'))?.key_epoch).toBe(1);
});
it('retains a rejected membership proposal and requires explicit replacement before retry', async () => {
  const { relay, a, b, removed } = await peers();
  await a.manager.stageRotation([removed.c.device_id]);
  const pending = await a.db.rotationPending.get('rotation');
  const newcomer = await client(relay, 'New peer', (await a.db.state.get('local'))!.recovery_key);
  await newcomer.sync();
  await expect(a.manager.completeRotation()).rejects.toThrow('Membership changed');
  expect(await a.db.rotationPending.get('rotation')).toEqual(pending);
  await expect(a.manager.stageRotation([removed.c.device_id])).rejects.toThrow('saved rotation');
  await a.manager.stageRotation([removed.c.device_id], true);
  await a.manager.completeRotation();
  await b.sync();
  await newcomer.sync();
  expect(relay.epoch).toBe(2);
  expect(await a.db.rotationPending.count()).toBe(0);
});
it('exports every historical key privately and recovers using a fresh installation without copying author secrets', async () => {
  const { relay, a, removed } = await peers();
  await a.db.queueDiagnostic('Historical');
  await a.sync();
  await a.manager.stageRotation([removed.c.device_id]);
  await a.manager.completeRotation();
  await a.db.queueDiagnostic('Current');
  await a.sync();
  const bundle = await exportRecovery(a.db),
    ordinary = JSON.stringify(await a.db.exportReplica());
  expect(bundle.key_epoch).toBe(2);
  expect(Object.keys(bundle.roots)).toHaveLength(2);
  const secrets = (await a.db.keySecrets.get('keys'))!;
  for (const secret of [
    ...Object.values(bundle.roots),
    a.c.token,
    secrets.identity!.private_key.d!,
  ])
    expect(ordinary).not.toContain(secret);
  expect(JSON.stringify(bundle)).not.toContain(a.c.token);
  expect(JSON.stringify(bundle)).not.toContain(secrets.identity!.private_key.d);
  const c = relay.credentials('Recovered'),
    db = new SynkDatabase(`recovered-${crypto.randomUUID()}`);
  databases.push(db);
  await enrollRecovery(db, c, bundle);
  await new SyncCoordinator(db, () => relay.transport(c)).sync();
  expect((await db.records.toArray()).map((r) => r.payload.note).sort()).toEqual([
    'Current',
    'Historical',
  ]);
  expect((await db.state.get('local'))?.next_counter).toBe(1);
  expect((await db.keySecrets.get('keys'))?.identity?.public_key).not.toBe(
    secrets.identity!.public_key,
  );
});
it('rejects stale backups, incomplete key rings and copying an earlier installation credential', async () => {
  const { relay, a, root } = await peers();
  await a.db.queueDiagnostic('Prior author counter');
  await a.sync();
  const fresh = new SynkDatabase(`copied-${crypto.randomUUID()}`);
  databases.push(fresh);
  await fresh.enroll(a.c, root);
  await expect(new SyncCoordinator(fresh, () => a.transport).sync()).rejects.toThrow(
    'counter is behind',
  );
  expect(await fresh.records.count()).toBe(0);
  const bundle = await exportRecovery(a.db);
  expect(() => parseRecoveryBundle({ ...bundle, key_epoch: 2 })).toThrow();
  expect(() => parseRecoveryBundle({ ...bundle, roots: {} })).toThrow();
  const restored = new SynkDatabase(`wrong-${crypto.randomUUID()}`);
  databases.push(restored);
  const wrong = relay.credentials('Wrong');
  await expect(
    enrollRecovery(restored, wrong, { ...bundle, account_id: crypto.randomUUID() }),
  ).rejects.toThrow('another account');
  expect(await restored.state.count()).toBe(0);
  await a.manager.stageRotation([wrong.device_id]);
  await a.manager.completeRotation();
  const legacy = new SynkDatabase(`stale-${crypto.randomUUID()}`);
  databases.push(legacy);
  const c = relay.credentials('Stale recovery');
  await enrollRecovery(legacy, c, {
    account_id: relay.account,
    server_url: c.server_url,
    recovery_key: root,
  });
  await expect(new SyncCoordinator(legacy, () => relay.transport(c)).sync()).rejects.toThrow(
    'no packet',
  );
  expect((await legacy.state.get('local'))?.key_epoch).toBe(1);
});
it('refuses a lost or altered private wrapping key and leaves the journal untouched', async () => {
  const { a } = await peers();
  await a.db.keySecrets.update('keys', { identity: undefined, public_identity: undefined });
  await expect(a.manager.refresh()).rejects.toThrow('lost its private');
  expect(await a.db.records.count()).toBe(0);
});
it('adopts multiple bounded packet pages in order for a long-offline retained installation', async () => {
  const { relay, a, b, removed } = await peers();
  await a.manager.stageRotation([removed.c.device_id]);
  await a.manager.completeRotation();
  for (let n = 0; n < 32; n++) {
    await a.manager.stageRotation([]);
    await a.manager.completeRotation();
  }
  expect(relay.epoch).toBe(34);
  expect((await b.db.state.get('local'))?.key_epoch).toBe(1);
  await b.manager.refresh();
  expect(Object.keys((await b.db.keySecrets.get('keys'))!.roots)).toHaveLength(34);
  expect((await b.db.state.get('local'))?.key_epoch).toBe(34);
});
it('rolls back root-ring and epoch adoption together on a failed local state write', async () => {
  const { a, b, removed } = await peers();
  await a.manager.stageRotation([removed.c.device_id]);
  await a.manager.completeRotation();
  vi.spyOn(b.db.state, 'update').mockRejectedValueOnce(new Error('Cannot save epoch'));
  await expect(b.manager.refresh()).rejects.toThrow('Cannot save epoch');
  expect((await b.db.state.get('local'))?.key_epoch).toBe(1);
  expect(Object.keys((await b.db.keySecrets.get('keys'))!.roots)).toEqual(['1']);
  await b.manager.refresh();
  expect((await b.db.state.get('local'))?.key_epoch).toBe(2);
});
it('serializes competing local proposals and rejects forged retained installation proofs', async () => {
  const { relay, a, b, removed } = await peers();
  const outcomes = await Promise.allSettled([
    a.manager.stageRotation([removed.c.device_id]),
    new KeyManager(a.db, a.transport.keys).stageRotation([]),
  ]);
  expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
  expect(await a.db.rotationPending.count()).toBe(1);
  const prior = await a.db.rotationPending.get('rotation');
  relay.devices.get(b.c.device_id)!.proof = generateRecoveryKey();
  await expect(a.manager.stageRotation([removed.c.device_id], true)).rejects.toThrow(
    'authentication',
  );
  expect(await a.db.rotationPending.get('rotation')).toEqual(prior);
  expect(relay.rotationBodies).toHaveLength(0);
});
