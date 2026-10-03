import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { sessionWindow, sessionSnapshot } from '../../tests/session-fixtures';
import { SynkDatabase } from './database';
import { generateRecoveryKey, encryptPayload } from './crypto';
import { SyncCoordinator, type Transport } from './sync';
import type { Envelope, PullPage } from './protocol';
import { DEFAULT_LOCAL_STORAGE } from './local-storage';
import {
  DEFAULT_SESSION_RETENTION,
  expireSessions,
  selectSessionExpiry,
  sessionRetentionPolicy,
} from './session-retention';
import {
  eraseSessionPart,
  projectSessions,
  splitSession,
  validateSessionExpiration,
  type SessionContent,
  type SessionExpiration,
  type SessionSnapshot,
} from './sessions';
import type { SessionRestoreJob } from './session-restore';
import { sessionFingerprintDigest } from './session-native';

const databases: SynkDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) await db.delete();
});
const NOW = Date.parse('2026-10-03T12:00:00Z'),
  DAY = 86_400_000;
const policy = { ...DEFAULT_SESSION_RETENTION, enabled: true };
async function local(account = crypto.randomUUID(), key = generateRecoveryKey()) {
  const db = new SynkDatabase(`session-retention-${crypto.randomUUID()}`);
  databases.push(db);
  await db.enroll(
    {
      account_id: account,
      device_id: crypto.randomUUID(),
      token: 'a'.repeat(64),
      name: 'Retention fixture',
      server_url: 'http://127.0.0.1:4318',
    },
    key,
  );
  return db;
}
function content(kind: SessionSnapshot['kind'] = 'closed', at = NOW - 31 * DAY): SessionContent {
  return { kind, captured_at: new Date(at).toISOString(), windows: [sessionWindow()] };
}
async function acknowledge(db: SynkDatabase) {
  while (await db.drafts.count()) await db.flushDrafts();
  for (const envelope of await db.outbox.toArray()) {
    await db.operations.update(envelope.operation_id, { sequence: envelope.counter });
    await db.records.update(envelope.operation_id, { sequence: envelope.counter });
    await db.outbox.delete(envelope.operation_id);
  }
}
function expiration(snapshot: SessionSnapshot, parts = splitSession(snapshot)): SessionExpiration {
  return {
    kind: 'session',
    schema_version: 2,
    operation_id: crypto.randomUUID(),
    source_id: snapshot.source_id,
    source_revision: snapshot.source_revision + parts.length,
    targets: [
      {
        snapshot_id: snapshot.id,
        source_revision: snapshot.source_revision,
        snapshot_kind: snapshot.kind,
        total: parts.length,
      },
    ],
  };
}
function job(snapshot: SessionSnapshot, status: SessionRestoreJob['status']): SessionRestoreJob {
  return {
    id: crypto.randomUUID(),
    snapshot_id: snapshot.id,
    status,
    selection: { mode: 'all' },
    incarnation: 'fixture',
    created_at: new Date(NOW).toISOString(),
    skipped: [],
    windows: snapshot.windows.map((source) => ({
      source,
      tabs: source.tabs.map((tab) => ({
        source: tab,
        url: tab.url,
        phase: 'pending',
      })),
      groups: [],
      phase: 'pending',
      owned: true,
      order_index: 0,
    })),
  };
}
class Relay implements Transport {
  epoch = crypto.randomUUID();
  rows: Envelope[] = [];
  loseReply = false;
  pageSize = 100;
  async acknowledge(cursor: number, epoch: string) {
    return { server_epoch: epoch, processed_cursor: cursor };
  }
  async pull(cursor: number): Promise<PullPage> {
    return {
      server_epoch: this.epoch,
      records: this.rows
        .slice(cursor, cursor + this.pageSize)
        .map((envelope, index) => ({ envelope, sequence: cursor + index + 1 })),
      next_cursor: Math.min(cursor + this.pageSize, this.rows.length),
      has_more: cursor + this.pageSize < this.rows.length,
    };
  }
  async push(envelopes: Envelope[]) {
    const acknowledgements = envelopes.map((envelope) => {
      let index = this.rows.findIndex((old) => old.operation_id === envelope.operation_id);
      if (index < 0) {
        index = this.rows.length;
        this.rows.push(envelope);
      }
      return { operation_id: envelope.operation_id, sequence: index + 1 };
    });
    if (this.loseReply) {
      this.loseReply = false;
      throw new Error('Acknowledgement lost');
    }
    return { server_epoch: this.epoch, acknowledgements };
  }
}

describe('source-owned session archive retention', () => {
  it('defaults to opt-in 30 days/100 archives/50 MiB and persists validated settings across reopen/export', async () => {
    const db = await local();
    const id = await db.stageSession(content());
    await acknowledge(db);
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 0 });
    expect((await db.sessionProjection()).snapshots[id]).toBeDefined();
    const cached = (await db.sessionReplicas.get('session'))!;
    delete (cached.value as Partial<typeof cached.value>).expired;
    await db.sessionReplicas.put(cached);
    expect((await db.sessionProjection()).expired).toEqual({});
    for (const invalid of [
      null,
      { ...policy, extra: 1 },
      { ...policy, enabled: 'yes' },
      { ...policy, days: 0 },
      { ...policy, days: 3651 },
      { ...policy, max_archives: 0 },
      { ...policy, max_archives: 1.5 },
      { ...policy, max_bytes: 1024 },
      { ...policy, max_bytes: 1024 ** 3 + 1 },
    ])
      expect(() => sessionRetentionPolicy(invalid)).toThrow();
    await db.setSessionRetention(policy);
    db.close();
    const reopened = new SynkDatabase(db.name);
    databases.push(reopened);
    expect((await reopened.state.get('local'))!.session_retention).toEqual(policy);
    expect(
      ((await reopened.exportReplica()) as { progress: { session_retention: unknown } }).progress
        .session_retention,
    ).toEqual(policy);
    expect(await expireSessions(reopened, NOW)).toMatchObject({ expired: 1 });
  });

  it('redacts legacy closed-capture content atomically while keeping duplicate-detection identities', async () => {
    const db = await local();
    const id = await db.stageSession(content());
    const pending = await db.stageSession(content());
    const fingerprint = JSON.stringify([
      ['https://private.example/reset?token=secret', 'Private title', false],
    ]);
    const receipt = {
      id: 'live/fixture/10',
      snapshot_id: id,
      fingerprint,
      captured_at: new Date(NOW - 31 * DAY).toISOString(),
    };
    await db.sessionClosedSeen.add(receipt);
    await db.sessionClosedSeen.add({
      ...receipt,
      id: 'native/fixture',
      native_session: 'native/fixture',
    });
    await db.sessionClosedSeen.add({ ...receipt, id: 'pending', snapshot_id: pending });
    // Only the first archive is acknowledged; queued capture copies must remain intact.
    await db.flushDrafts();
    for (const record of await db.operations.toArray()) {
      if (
        record.payload.kind === 'session' &&
        record.payload.schema_version === 1 &&
        record.payload.snapshot_id === id
      ) {
        await db.operations.update(record.operation_id, { sequence: record.envelope.counter });
        await db.outbox.delete(record.operation_id);
      }
    }
    await db.setSessionRetention(policy);
    vi.spyOn(db.sessionClosedSeen, 'put').mockRejectedValueOnce(new Error('Receipt write failed'));
    await expect(expireSessions(db, NOW)).rejects.toThrow('Receipt write failed');
    expect((await db.sessionProjection()).snapshots[id]).toBeDefined();
    expect(await db.sessionClosedSeen.get(receipt.id)).toEqual(receipt);
    vi.restoreAllMocks();
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 1 });
    const digest = await sessionFingerprintDigest(fingerprint);
    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(await sessionFingerprintDigest(digest)).toBe(digest);
    expect(await db.sessionClosedSeen.get(receipt.id)).toEqual({ ...receipt, fingerprint: digest });
    expect((await db.sessionClosedSeen.get('native/fixture'))?.fingerprint).toBe(digest);
    expect((await db.sessionClosedSeen.get('pending'))?.fingerprint).toBe(fingerprint);
    const put = vi.spyOn(db.sessionClosedSeen, 'put');
    await db.persistSessions(await db.sessionProjection());
    expect(put).not.toHaveBeenCalled(); // Subsequent captures must not rewrite every expired receipt.

    db.close();
    const reopened = new SynkDatabase(db.name);
    databases.push(reopened);
    expect(await expireSessions(reopened, NOW)).toMatchObject({ expired: 0 });
    expect((await reopened.sessionClosedSeen.get(receipt.id))?.fingerprint).toBe(digest);
  });

  it('uses strict original-time age, retains boundary/future captures and never selects another source or latest current', async () => {
    const db = await local(),
      latest = await db.stageSession(content('current')),
      closed = await db.stageSession(content()),
      saved = await db.stageSession(content('previous')),
      boundary = await db.stageSession(content('closed', NOW - 30 * DAY)),
      future = await db.stageSession(content('closed', NOW + DAY));
    await acknowledge(db);
    await db.setSessionRetention(policy);
    const peer = {
      ...sessionSnapshot(),
      kind: 'closed' as const,
      captured_at: new Date(NOW - 100 * DAY).toISOString(),
    };
    const state = (await db.state.get('local'))!;
    const peerParts = splitSession(peer);
    for (const [index, part] of peerParts.entries()) {
      const envelope = await encryptPayload(
        state.recovery_key,
        {
          protocol_version: 1,
          account_id: state.credentials.account_id,
          device_id: peer.source_id,
          operation_id: part.operation_id,
          counter: part.source_revision + part.part,
          domain: 'session',
          key_epoch: 1,
        },
        part,
      );
      await db.operations.add({
        operation_id: part.operation_id,
        payload: part,
        envelope,
        sequence: 100 + index,
      });
    }
    const projection = projectSessions(await db.sessionOperations());
    await db.persistSessions(projection);
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 2 });
    const after = await db.sessionProjection();
    expect(after.snapshots[closed]).toBeUndefined();
    expect(after.snapshots[saved]).toBeUndefined();
    for (const id of [latest, boundary, future, peer.id]) expect(after.snapshots[id]).toBeDefined();
    expect(() => selectSessionExpiry(after, peer.source_id, policy, new Set(), -1)).toThrow('time');
  });

  it('applies one combined archive count cap, removes oldest first and keeps the last published current while a replacement uploads', async () => {
    const db = await local(),
      published = await db.stageSession(content('current', NOW - 2 * DAY));
    await acknowledge(db);
    const oldClosed = await db.stageSession(content('closed', NOW - DAY)),
      saved = await db.stageSession(content('previous', NOW - 1000));
    await acknowledge(db);
    const current = await db.stageSession(content('current', NOW));
    await db.setSessionRetention({ ...policy, max_archives: 1 });
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 2, protected: 1 });
    let p = await db.sessionProjection();
    expect(p.snapshots[published]).toBeDefined();
    expect(p.snapshots[current]).toBeDefined();
    expect(p.snapshots[oldClosed]).toBeUndefined();
    expect(p.snapshots[saved]).toBeUndefined();
    await acknowledge(db);
    await db.stageSession(content('previous', NOW));
    await acknowledge(db);
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 1 });
    p = await db.sessionProjection();
    expect(p.snapshots[published]).toBeUndefined();
    expect(Object.values(p.current)).toContain(current);
  });

  it('measures UTF-8 snapshot content for the byte cap, excluding the latest current session', () => {
    const current = sessionSnapshot(1, [sessionWindow(500, '漢'.repeat(800))]),
      large = {
        ...sessionSnapshot(100, [sessionWindow(500, '漢'.repeat(800))]),
        source_id: current.source_id,
        kind: 'closed' as const,
        captured_at: new Date(NOW - DAY).toISOString(),
      },
      small = {
        ...sessionSnapshot(200),
        source_id: current.source_id,
        kind: 'previous' as const,
        captured_at: new Date(NOW).toISOString(),
      };
    const p = projectSessions([current, large, small].flatMap(splitSession));
    expect(
      selectSessionExpiry(
        p,
        current.source_id,
        { ...policy, max_bytes: 1024 * 1024 },
        new Set(),
        NOW,
      ).ids,
    ).toEqual([large.id]);
    const protectedSelection = selectSessionExpiry(
      p,
      current.source_id,
      { ...policy, max_bytes: 1024 * 1024 },
      new Set([large.id]),
      NOW,
    );
    expect(protectedSelection.ids).toEqual([small.id]);
    expect(protectedSelection.retained_bytes).toBeGreaterThan(1024 * 1024);
  });

  it('protects drafts, every unacknowledged multipart fragment and incomplete captures until acknowledgement', async () => {
    const db = await local(),
      draft = await db.stageSession(content());
    await db.setSessionRetention(policy);
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 0, protected: 1 });
    const big = content();
    big.windows = [sessionWindow(400, '漢'.repeat(300))];
    const multipart = await db.stageSession(big);
    while (await db.drafts.count()) await db.flushDrafts();
    const rows = (await db.operations.toArray()).filter(
      (row) =>
        row.payload.kind === 'session' &&
        row.payload.schema_version === 1 &&
        row.payload.snapshot_id === multipart,
    );
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows.slice(0, -1)) {
      await db.operations.update(row.operation_id, { sequence: row.envelope.counter });
      await db.outbox.delete(row.operation_id);
    }
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 0, protected: 2 });
    const before = rows.map((row) => row.envelope);
    await acknowledge(db);
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 2 });
    expect((await db.sessionProjection()).snapshots[draft]).toBeUndefined();
    expect((await db.sessionProjection()).snapshots[multipart]).toBeUndefined();
    expect(
      await Promise.all(
        rows.map(async (row) => (await db.operations.get(row.operation_id))!.envelope),
      ),
    ).toEqual(before);
    expect(rows.every((row) => row.payload.kind === 'session')).toBe(true);
    for (const row of rows)
      expect((await db.operations.get(row.operation_id))!.payload).toMatchObject({ erased: true });
  });

  it('keeps running and blocked restoration data, clears expired terminal jobs and expires archives after jobs finish', async () => {
    const db = await local();
    const ids = await Promise.all(
      ['running', 'blocked', 'complete', 'cancelled'].map(() => db.stageSession(content())),
    );
    await acknowledge(db);
    await db.setSessionRetention(policy);
    const p = await db.sessionProjection();
    const jobs = ids.map((id, index) =>
      job(
        p.snapshots[id]!,
        ['running', 'blocked', 'complete', 'cancelled'][index] as SessionRestoreJob['status'],
      ),
    );
    await db.sessionRestores.bulkAdd(jobs);
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 2, protected: 2 });
    expect(await db.sessionRestores.toArray()).toEqual(expect.arrayContaining(jobs.slice(0, 2)));
    expect(await db.sessionRestores.count()).toBe(2);
    await db.sessionRestores.update(jobs[0]!.id, { status: 'complete' });
    await db.sessionRestores.update(jobs[1]!.id, { status: 'cancelled' });
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 2 });
    expect(await db.sessionRestores.count()).toBe(0);
  });

  it('never expires an acknowledged but incomplete multipart snapshot', async () => {
    const db = await local(),
      state = (await db.state.get('local'))!;
    const snapshot = {
      ...sessionSnapshot(1, [sessionWindow(400, '漢'.repeat(300))]),
      source_id: state.credentials.device_id,
      kind: 'closed' as const,
      captured_at: new Date(NOW - 31 * DAY).toISOString(),
    };
    const parts = splitSession(snapshot);
    expect(parts.length).toBeGreaterThan(1);
    const first = parts[0]!;
    const envelope = await encryptPayload(
      state.recovery_key,
      {
        protocol_version: 1,
        operation_id: first.operation_id,
        account_id: state.credentials.account_id,
        device_id: first.source_id,
        counter: first.source_revision,
        domain: 'session',
        key_epoch: 1,
      },
      first,
    );
    await db.operations.add({
      operation_id: first.operation_id,
      payload: first,
      envelope,
      sequence: 1,
    });
    await db.state.update('local', { next_counter: parts.length + 1 });
    await db.persistSessions(projectSessions(await db.sessionOperations()));
    await db.setSessionRetention(policy);
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 0 });
    expect((await db.sessionProjection()).incomplete).toEqual([snapshot.id]);
    expect((await db.operations.get(first.operation_id))!.payload).toHaveProperty('data');
  });

  it('rolls back proof/counter/projection/plaintext cleanup together on a failed write', async () => {
    const db = await local(),
      id = await db.stageSession(content());
    await acknowledge(db);
    await db.setSessionRetention(policy);
    const before = await db.state.get('local'),
      rows = await db.operations.toArray();
    vi.spyOn(db.sessionReplicas, 'put').mockRejectedValueOnce(new Error('Disk full'));
    await expect(expireSessions(db, NOW)).rejects.toThrow('Disk full');
    expect(await db.state.get('local')).toEqual(before);
    expect(await db.drafts.count()).toBe(0);
    expect(await db.operations.toArray()).toEqual(rows);
    expect((await db.sessionProjection()).snapshots[id]).toBeDefined();
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 1 });
  });

  it('allows essential expiry at the ordinary pending-work limit and serializes concurrent workers', async () => {
    const db = await local();
    await db.stageSession(content());
    await acknowledge(db);
    await db.setSessionRetention(policy);
    await db.setStoragePolicy({ ...DEFAULT_LOCAL_STORAGE, max_pending: 100 });
    for (let index = 0; index < 100; index++) await db.queueDiagnostic(`Pending fixture ${index}`);
    await expect(db.assertCaptureCapacity()).rejects.toThrow('pending-work limit');
    const second = new SynkDatabase(db.name);
    databases.push(second);
    const results = await Promise.all([expireSessions(db, NOW), expireSessions(second, NOW)]);
    expect(results.map((result) => result.expired).sort((a, b) => a - b)).toEqual([0, 1]);
    expect(await db.pendingCount()).toBe(101);
  });

  it('bounds each proof to 100 archives and resumes after reopening without starving eligible archives', async () => {
    const db = await local();
    for (let index = 0; index < 205; index++) await db.stageSession(content());
    await acknowledge(db);
    await db.setSessionRetention(policy);
    expect(await expireSessions(db, NOW)).toMatchObject({ expired: 100, more: true });
    db.close();
    const reopened = new SynkDatabase(db.name);
    databases.push(reopened);
    expect(await expireSessions(reopened, NOW)).toMatchObject({ expired: 100, more: true });
    expect(await expireSessions(reopened, NOW)).toMatchObject({ expired: 5, more: false });
    expect(Object.keys((await reopened.sessionProjection()).snapshots)).toHaveLength(0);
    expect(await expireSessions(reopened, NOW)).toMatchObject({ expired: 0 });
  });
});

describe('authenticated session expiration and replay', () => {
  it('binds the expiry author/counter and rejects future targets, duplicate targets, reused identities and cross-source expiry', async () => {
    const snapshot = { ...sessionSnapshot(), kind: 'closed' as const },
      parts = splitSession(snapshot),
      proof = expiration(snapshot, parts);
    validateSessionExpiration(proof);
    const header = {
      protocol_version: 1 as const,
      operation_id: proof.operation_id,
      account_id: crypto.randomUUID(),
      device_id: proof.source_id,
      counter: proof.source_revision,
      domain: 'session' as const,
      key_epoch: 1,
    };
    await expect(
      encryptPayload(generateRecoveryKey(), { ...header, device_id: crypto.randomUUID() }, proof),
    ).rejects.toThrow('source/revision');
    await expect(
      encryptPayload(generateRecoveryKey(), { ...header, counter: header.counter + 1 }, proof),
    ).rejects.toThrow('source/revision');
    expect(() =>
      validateSessionExpiration({ ...proof, source_revision: snapshot.source_revision }),
    ).toThrow('target');
    expect(() =>
      validateSessionExpiration({ ...proof, targets: [...proof.targets, ...proof.targets] }),
    ).toThrow('target');
    expect(() => projectSessions([...parts, { ...proof, source_id: crypto.randomUUID() }])).toThrow(
      'source snapshot',
    );
    expect(() =>
      projectSessions([
        ...parts,
        proof,
        { ...proof, targets: [{ ...proof.targets[0]!, total: 2 }], source_revision: 100 },
      ]),
    ).toThrow('identity');
    expect(() => projectSessions([eraseSessionPart(parts[0]!)])).toThrow('no expiration proof');
    const extended = { ...parts[0]!, private_extra: 'https://private.example/' };
    const receipt = eraseSessionPart(extended);
    expect(receipt).not.toHaveProperty('private_extra');
    const extendedReceipt = { ...receipt, private_extra: 'secret' };
    expect(() => projectSessions([proof, extendedReceipt])).toThrow('contains content');
    expect(projectSessions([...parts, proof]).snapshots[snapshot.id]).toBeUndefined();
    expect(
      projectSessions([proof, ...parts.map(eraseSessionPart)]).snapshots[snapshot.id],
    ).toBeUndefined();
    expect(projectSessions([proof, ...parts]).snapshots[snapshot.id]).toBeUndefined();
    const overlapping = {
      ...proof,
      operation_id: crypto.randomUUID(),
      source_revision: 100,
      targets: [{ ...proof.targets[0]!, snapshot_id: crypto.randomUUID() }],
    };
    expect(() => projectSessions([proof, overlapping])).toThrow('overlap');
  });

  it('survives a lost proof acknowledgement/reopen, converges peers and fresh bootstrap, and preserves a peer active restore', async () => {
    const account = crypto.randomUUID(),
      key = generateRecoveryKey(),
      a = await local(account, key),
      b = await local(account, key),
      relay = new Relay();
    const id = await a.stageSession(content('closed', Date.now() - 31 * DAY));
    await new SyncCoordinator(a, () => relay).sync();
    await new SyncCoordinator(b, () => relay).sync();
    const remoteJob = job((await b.sessionProjection()).snapshots[id]!, 'running');
    await b.sessionRestores.add(remoteJob);
    await a.setSessionRetention(policy);
    relay.loseReply = true;
    await expect(new SyncCoordinator(a, () => relay).sync()).rejects.toThrow(
      'Acknowledgement lost',
    );
    expect((await a.sessionProjection()).snapshots[id]).toBeUndefined();
    const originalCipher = relay.rows[0]!;
    a.close();
    const reopened = new SynkDatabase(a.name);
    databases.push(reopened);
    await new SyncCoordinator(reopened, () => relay).sync();
    relay.pageSize = 1;
    await new SyncCoordinator(b, () => relay).sync();
    expect((await b.sessionProjection()).snapshots[id]).toBeUndefined();
    expect(await b.sessionRestores.get(remoteJob.id)).toEqual(remoteJob);
    expect(await reopened.pendingCount()).toBe(0);
    expect(relay.rows).toHaveLength(2);
    const fresh = await local(account, key);
    await new SyncCoordinator(fresh, () => relay).sync();
    expect(await fresh.sessionProjection()).toEqual(await reopened.sessionProjection());
    expect(relay.rows[0]).toEqual(originalCipher); // Ciphertext purge is a separate pending gate.
    expect((await fresh.operations.get(originalCipher.operation_id))!.payload).not.toHaveProperty(
      'data',
    );
    await b.sessionRestores.update(remoteJob.id, { status: 'complete' });
    await new SyncCoordinator(b, () => relay).sync();
    expect(await b.sessionRestores.get(remoteJob.id)).toBeUndefined();
    expect(projectSessions(await fresh.sessionOperations()).snapshots[id]).toBeUndefined();
  });
});
