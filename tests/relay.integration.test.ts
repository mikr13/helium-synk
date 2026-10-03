import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  generateRecoveryKey,
  BOOKMARK_ROOTS,
  SynkDatabase,
  SyncCoordinator,
  HttpTransport,
  createPairingBundle,
  stagePairing,
  completePairing,
  type Credentials,
  historyVisitId,
  historyGeneration,
  historyUrlTag,
  envelopeDigest,
  base64,
  DEFAULT_SESSION_RETENTION,
} from '../sync-core/src/index';
import { sessionWindow } from './session-fixtures';

const binary = resolve('target/debug/synk-server');
const directory = mkdtempSync(join(tmpdir(), 'helium-synk-integration-'));
const database = join(directory, 'relay.sqlite');
let process: ChildProcess | undefined;
let port: number;
let credentialsA: Credentials;
let credentialsB: Credentials;
let credentialsC: Credentials;
let credentialsD: Credentials;
let credentialsE: Credentials;
let credentialsF: Credentials;
let credentialsG: Credentials;
let credentialsH: Credentials;
let credentialsI: Credentials;
let credentialsJ: Credentials;
let credentialsK: Credentials;
const sharedKey = generateRecoveryKey();
const localDatabases: SynkDatabase[] = [];
const sockets: WebSocket[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const result = probe.address();
  if (!result || typeof result === 'string') throw new Error('Could not allocate port');
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return result.port;
}
async function start(): Promise<void> {
  process = spawn(binary, ['--database', database, 'serve', '--port', String(port)], {
    stdio: 'ignore',
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (process.exitCode !== null) throw new Error('Relay exited before becoming ready');
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Relay did not become ready');
}
async function stop() {
  const child = process;
  process = undefined;
  if (!child || child.exitCode !== null) return;
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Relay did not drain within five seconds'));
      }, 5_000);
      child.once('exit', (code, signal) => {
        clearTimeout(deadline);
        resolve({ code, signal });
      });
      child.kill('SIGTERM');
    },
  );
}
beforeAll(async () => {
  port = await freePort();
  for (const name of ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']) {
    execFileSync(
      binary,
      [
        '--database',
        database,
        'issue-device',
        '--name',
        name,
        '--server-url',
        `http://127.0.0.1:${port}`,
        '--output',
        join(directory, `${name}.credential.json`),
      ],
      { stdio: 'ignore' },
    );
  }
  credentialsA = JSON.parse(readFileSync(join(directory, 'A.credential.json'), 'utf8'));
  credentialsB = JSON.parse(readFileSync(join(directory, 'B.credential.json'), 'utf8'));
  credentialsC = JSON.parse(readFileSync(join(directory, 'C.credential.json'), 'utf8'));
  credentialsD = JSON.parse(readFileSync(join(directory, 'D.credential.json'), 'utf8'));
  credentialsE = JSON.parse(readFileSync(join(directory, 'E.credential.json'), 'utf8'));
  credentialsF = JSON.parse(readFileSync(join(directory, 'F.credential.json'), 'utf8'));
  credentialsG = JSON.parse(readFileSync(join(directory, 'G.credential.json'), 'utf8'));
  credentialsH = JSON.parse(readFileSync(join(directory, 'H.credential.json'), 'utf8'));
  credentialsI = JSON.parse(readFileSync(join(directory, 'I.credential.json'), 'utf8'));
  credentialsJ = JSON.parse(readFileSync(join(directory, 'J.credential.json'), 'utf8'));
  credentialsK = JSON.parse(readFileSync(join(directory, 'K.credential.json'), 'utf8'));
  await start();
});
afterAll(async () => {
  for (const socket of sockets) socket.close();
  await stop();
  for (const db of localDatabases) db.close();
  for (const db of new Map(localDatabases.map((db) => [db.name, db])).values()) await db.delete();
  rmSync(directory, { recursive: true, force: true });
});
async function local(credentials: Credentials, key: string) {
  const db = new SynkDatabase(`integration-${crypto.randomUUID()}`);
  localDatabases.push(db);
  await db.enroll(credentials, key);
  return db;
}

it('two durable clients exchange encrypted notes across relay and client restarts', async () => {
  const key = sharedKey;
  let a = await local(credentialsA, key);
  const b = await local(credentialsB, key);
  await a.queueDiagnostic('First signal');
  await new SyncCoordinator(a).sync();
  await new SyncCoordinator(b).sync();
  expect((await b.records.toArray()).map((r) => r.payload.note)).toContain('First signal');
  await stop();
  await a.queueDiagnostic('Captured on A during outage');
  await b.queueDiagnostic('Captured on B during outage');
  await expect(new SyncCoordinator(a).sync()).rejects.toThrow();
  const localName = a.name;
  a.close();
  a = new SynkDatabase(localName);
  localDatabases.push(a);
  expect(await a.outbox.count()).toBe(1);
  expect(await b.outbox.count()).toBe(1);
  await start();
  await new SyncCoordinator(b).sync();
  await new SyncCoordinator(a).sync();
  await new SyncCoordinator(b).sync();
  const notes = (await a.records.toArray()).map((r) => r.payload.note).sort();
  expect(notes).toEqual(
    ['Captured on A during outage', 'Captured on B during outage', 'First signal'].sort(),
  );
  expect((await b.records.toArray()).map((r) => r.payload.note).sort()).toEqual(notes);
  expect(await a.outbox.count()).toBe(0);
  expect(await b.outbox.count()).toBe(0);
  // Inspect storage through SQL, rather than assuming encryption from a JSON response.
  const stored = execFileSync('sqlite3', [database, 'SELECT envelope FROM operations;'], {
    encoding: 'utf8',
  });
  expect(stored).not.toContain('Captured on');
  expect(stored).not.toContain('First signal');
  expect(stored).not.toContain(key);
});

it('authenticates WebSockets and announces committed changes without data or URL credentials', async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(new Error('Socket failed'));
  });
  const events: string[] = [];
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    events.push(message.type);
    if (message.type === 'ping') socket.send('pong');
  };
  socket.send(JSON.stringify({ token: credentialsA.token }));
  await expect.poll(() => events.includes('ready')).toBe(true);
  const db = await local(credentialsC, sharedKey);
  await db.queueDiagnostic('WebSocket commit probe');
  const envelope = (await db.outbox.toArray())[0];
  const health = (await (await fetch(`http://127.0.0.1:${port}/health/ready`)).json()) as {
    server_epoch: string;
  };
  const response = await fetch(`http://127.0.0.1:${port}/v1/sync/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credentialsC.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelopes: [envelope], expected_epoch: health.server_epoch }),
  });
  expect(response.ok).toBe(true);
  await expect.poll(() => events.includes('sync_available')).toBe(true);
  socket.close();
});

it('causal bookmarks survive a relay outage and pre-encryption client restart across Rust HTTP', async () => {
  let a = await local(credentialsD, sharedKey);
  const b = await local(credentialsE, sharedKey),
    id = crypto.randomUUID();
  await a.queueBookmark({
    type: 'create',
    node_id: id,
    node_type: 'bookmark',
    title: 'Before outage',
    url: 'https://example.test/private-bookmark',
    placement: { parent: BOOKMARK_ROOTS.bar, position: '1/1' },
  });
  await new SyncCoordinator(a).sync();
  await new SyncCoordinator(b).sync();
  await stop();
  await a.stageBookmark({ type: 'edit', node_id: id, title: 'Offline bookmark rename' });
  await b.queueBookmark({
    type: 'move',
    node_id: id,
    placement: { parent: BOOKMARK_ROOTS.other, position: '5/3' },
  });
  const name = a.name;
  a.close();
  a = new SynkDatabase(name);
  localDatabases.push(a);
  expect(await a.drafts.count()).toBe(1);
  expect((await a.bookmarkProjection()).nodes[id].title).toBe('Offline bookmark rename');
  await expect(new SyncCoordinator(a).sync()).rejects.toThrow();
  expect(await a.pendingCount()).toBe(1);
  expect(await b.pendingCount()).toBe(1);
  await start();
  await new SyncCoordinator(a).sync();
  await new SyncCoordinator(b).sync();
  await new SyncCoordinator(a).sync();
  expect(await a.bookmarkProjection()).toEqual(await b.bookmarkProjection());
  expect((await a.bookmarkProjection()).nodes[id]).toMatchObject({
    title: 'Offline bookmark rename',
    parent: BOOKMARK_ROOTS.other,
    position: '5/3',
  });
  expect(await a.pendingCount()).toBe(0);
  expect(await b.pendingCount()).toBe(0);
  const stored = execFileSync(
    'sqlite3',
    [
      database,
      "SELECT envelope FROM operations WHERE json_extract(envelope, '$.domain') = 'bookmark';",
    ],
    { encoding: 'utf8' },
  );
  expect(stored).not.toContain('Offline bookmark rename');
  expect(stored).not.toContain('https://example.test/private-bookmark');
  expect(stored).not.toContain(sharedKey);
  expect(stored.trim().split('\n')).toHaveLength(3);
});

it('encrypted multipart sessions and offline closed windows survive client and Rust relay restart', async () => {
  let a = await local(credentialsF, sharedKey);
  const b = await local(credentialsG, sharedKey);
  const first = await a.stageSession({
    kind: 'current',
    captured_at: '2026-10-01T08:00:00Z',
    windows: [sessionWindow()],
  });
  await new SyncCoordinator(a).sync();
  await new SyncCoordinator(b).sync();
  expect((await b.sessionProjection()).current[credentialsF.device_id]).toBe(first);
  await stop();
  const closed = await a.stageSession({
    kind: 'closed',
    captured_at: '2026-10-01T08:02:00Z',
    windows: [sessionWindow()],
  });
  const large = sessionWindow(600, 'Private session title ' + '漢'.repeat(200));
  const newest = await a.stageSession({
    kind: 'current',
    captured_at: '2026-10-01T08:03:00Z',
    windows: [large],
  });
  const second = sessionWindow(2);
  second.focused = false;
  const remote = await b.stageSession({
    kind: 'current',
    captured_at: '2026-10-01T08:04:00Z',
    windows: [sessionWindow(), second],
  });
  const name = a.name;
  a.close();
  a = new SynkDatabase(name);
  localDatabases.push(a);
  expect((await a.sessionProjection()).snapshots[closed]).toBeDefined();
  await expect(new SyncCoordinator(a).sync()).rejects.toThrow();
  expect(await a.pendingCount()).toBeGreaterThan(2);
  await start();
  await new SyncCoordinator(a).sync();
  await new SyncCoordinator(b).sync();
  await new SyncCoordinator(a).sync();
  const p = await a.sessionProjection();
  expect(p).toEqual(await b.sessionProjection());
  expect(p.current[credentialsF.device_id]).toBe(newest);
  expect(p.current[credentialsG.device_id]).toBe(remote);
  expect(p.snapshots[closed]!.windows[0]!.tabs).toHaveLength(3);
  expect(p.snapshots[newest]!.windows[0]!.tabs).toHaveLength(600);
  expect(await a.pendingCount()).toBe(0);
  expect(await b.pendingCount()).toBe(0);
  const stored = execFileSync(
    'sqlite3',
    [
      database,
      "SELECT envelope FROM operations WHERE json_extract(envelope, '$.domain') = 'session';",
    ],
    { encoding: 'utf8' },
  );
  expect(stored).not.toContain('Private session title');
  expect(stored).not.toContain('https://example.com/');
  expect(stored).not.toContain(sharedKey);
  expect(stored.trim().split('\n').length).toBeGreaterThan(4);
});

it('source-owned session expiry uploads pending archives first and survives a lost reply, relay/client restart and fresh bootstrap', async () => {
  const issue = (name: string): Credentials => {
    const output = join(directory, `${name}.json`);
    execFileSync(
      binary,
      [
        '--database',
        database,
        'issue-device',
        '--name',
        name,
        '--server-url',
        `http://127.0.0.1:${port}`,
        '--output',
        output,
      ],
      { stdio: 'ignore' },
    );
    return JSON.parse(readFileSync(output, 'utf8'));
  };
  let owner = await local(issue('Session retention owner'), sharedKey);
  const peer = await local(issue('Session retention peer'), sharedKey);
  const time = Date.now(),
    day = 86_400_000;
  const capture = (kind: 'current' | 'closed' | 'previous', age: number) => ({
    kind,
    captured_at: new Date(time - age * day).toISOString(),
    windows: [sessionWindow()],
  });
  const peerOld = await peer.stageSession(capture('closed', 60));
  await new SyncCoordinator(peer).sync();
  await owner.setSessionRetention({ ...DEFAULT_SESSION_RETENTION, enabled: true });
  const current = await owner.stageSession(capture('current', 60)),
    old = await owner.stageSession(capture('closed', 60)),
    recent = await owner.stageSession(capture('previous', 2));
  await owner.flushDrafts();
  const original = (await owner.operations.toArray()).find(
    (row) =>
      row.payload.kind === 'session' &&
      row.payload.schema_version === 1 &&
      row.payload.snapshot_id === old,
  )!;
  await new SyncCoordinator(owner).sync();
  expect((await owner.sessionProjection()).snapshots[old]).toBeDefined();
  expect((await owner.operations.get(original.operation_id))!.sequence).toBeGreaterThan(0);
  const base = new HttpTransport((await owner.state.get('local'))!);
  await expect(
    new SyncCoordinator(owner, () => ({
      keys: base.keys,
      purge: (request) => base.purge(request),
      pull: (cursor) => base.pull(cursor),
      acknowledge: (cursor, epoch) => base.acknowledge(cursor, epoch),
      push: async (envelopes, epoch) => {
        await base.push(envelopes, epoch);
        throw new Error('Session expiry reply discarded');
      },
    })).sync(),
  ).rejects.toThrow('reply discarded');
  expect((await owner.sessionProjection()).snapshots[old]).toBeUndefined();
  expect(await owner.pendingCount()).toBe(1);
  const name = owner.name;
  owner.close();
  await stop();
  await start();
  owner = new SynkDatabase(name);
  localDatabases.push(owner);
  expect((await owner.state.get('local'))!.session_retention?.enabled).toBe(true);
  await new SyncCoordinator(owner).sync();
  await new SyncCoordinator(peer).sync();
  const fresh = await local(issue('Session retention fresh'), sharedKey);
  await new SyncCoordinator(fresh).sync();
  for (const db of [owner, peer, fresh]) {
    const projection = await db.sessionProjection();
    expect(projection.snapshots[old]).toBeUndefined();
    for (const id of [current, recent, peerOld]) expect(projection.snapshots[id]).toBeDefined();
    expect((await db.operations.get(original.operation_id))!.payload).not.toHaveProperty('data');
    expect((await db.operations.get(original.operation_id))!.envelope).toEqual(original.envelope);
  }
  expect(await owner.pendingCount()).toBe(0);
  const proofs = (await owner.operations.toArray()).filter(
    (row) =>
      row.payload.kind === 'session' &&
      row.payload.schema_version === 2 &&
      row.envelope.device_id === original.envelope.device_id,
  );
  expect(proofs).toHaveLength(1);
  const stored = execFileSync(
    'sqlite3',
    [database, `SELECT envelope FROM operations WHERE operation_id = '${original.operation_id}';`],
    { encoding: 'utf8' },
  );
  expect(stored).toContain(original.envelope.ciphertext); // Authenticated ciphertext purge remains open.
  expect(stored).not.toContain('https://example.com/');
});

it('history erases live ciphertext across lost purge replies, client/relay restarts and fresh bootstrap', async () => {
  let a = await local(credentialsH, sharedKey);
  let b = await local(credentialsI, sharedKey);
  const incarnation = crypto.randomUUID();
  const url = 'https://history-integration.example/private-research';
  async function visit(db: SynkDatabase, native: string, time: number) {
    const local = (await db.state.get('local'))!,
      source = local.credentials.device_id;
    const tag = await historyUrlTag(await db.ensureHistoryIndexKey(), url);
    return await db.stageHistory({
      type: 'visit',
      visit: {
        id: historyVisitId(source, incarnation, native, time),
        source_id: source,
        source_name: local.credentials.name,
        incarnation,
        native_id: native,
        visited_at: time,
        url,
        url_tag: tag,
        title: 'Private history title',
        transition: 'typed',
        referring_native_id: '0',
        generation: historyGeneration(await db.historyProjection(), source, tag),
      },
    });
  }
  await visit(a, 'first', 1_000.25);
  await new SyncCoordinator(a).sync();
  await new SyncCoordinator(b).sync();
  await visit(b, 'second', 2_000.75);
  await new SyncCoordinator(b).sync();
  await new SyncCoordinator(a).sync();
  expect((await a.queryHistory()).visits.map((v) => v.visited_at)).toEqual([2_000.75, 1_000.25]);
  const originals = (await a.operations.toArray()).map((r) => r.envelope);
  await stop();
  const canceled = await visit(a, 'during-outage', 3_000.125);
  await b.stageHistory({ type: 'clear', scope: 'all' });
  await expect(new SyncCoordinator(a).sync()).rejects.toThrow();
  const name = a.name;
  a.close();
  a = new SynkDatabase(name);
  localDatabases.push(a);
  expect(await a.pendingCount()).toBe(1);
  await start();
  const transport = new HttpTransport((await b.state.get('local'))!);
  await expect(
    new SyncCoordinator(b, () => ({
      keys: transport.keys,
      pull: (cursor) => transport.pull(cursor),
      push: (envelopes, epoch) => transport.push(envelopes, epoch),
      acknowledge: (cursor, epoch) => transport.acknowledge(cursor, epoch),
      purge: async (request) => {
        await transport.purge(request);
        throw new Error('Discarded committed purge reply');
      },
    })).sync(),
  ).rejects.toThrow('Discarded committed purge reply');
  expect(await b.historyPurgePending.count()).toBe(1);
  const saved = (await b.historyPurgePending.toArray())[0]!;
  await stop();
  await start();
  b.close();
  const resumed = new SynkDatabase(b.name);
  localDatabases.push(resumed);
  expect(await resumed.historyPurgePending.get(saved.operation_id)).toEqual(saved);
  await new SyncCoordinator(resumed).sync();
  expect(await resumed.historyPurgePending.count()).toBe(0);
  b = resumed; // Clear commits before the stale source returns.
  await new SyncCoordinator(a).sync();
  await new SyncCoordinator(b).sync();
  expect((await a.historyProjection()).visits).toEqual((await b.historyProjection()).visits);
  expect((await a.historyProjection()).barriers).toEqual((await b.historyProjection()).barriers);
  // This never-encrypted visit is now a private suppression receipt, not an upload.
  expect(await a.historyErasedDrafts.get(canceled)).toBeDefined();
  expect(await a.outbox.get(canceled)).toBeUndefined();
  expect(Object.keys((await b.historyProjection()).deleted)).toHaveLength(2);
  expect(await a.historyVisits.count()).toBe(0);
  expect(Object.keys((await a.historyProjection()).stale)).toHaveLength(1);
  await visit(a, 'fresh-generation', 4_000.875);
  await new SyncCoordinator(a).sync();
  await new SyncCoordinator(b).sync();
  const fresh = (await b.queryHistory()).visits[0]!;
  expect(fresh.visited_at).toBe(4_000.875);
  await b.stageHistory({ type: 'delete', visit_ids: [fresh.id] });
  await new SyncCoordinator(b).sync();
  await stop();
  await start();
  await new SyncCoordinator(a).sync();
  expect(await a.historyVisits.count()).toBe(0);
  expect((await a.historyProjection()).deleted[fresh.id]).toHaveLength(2);
  expect(await a.pendingCount()).toBe(0);
  expect(await b.pendingCount()).toBe(0);
  for (const original of originals) {
    const current = (await a.operations.get(original.operation_id))!;
    if (original.domain === 'history') {
      expect(current.envelope.ciphertext).toBe('');
      expect(current.redacted?.digest).toBe(await envelopeDigest(original));
      expect(JSON.stringify(await a.exportReplica())).not.toContain(original.ciphertext);
      expect(JSON.stringify(await b.exportReplica())).not.toContain(original.ciphertext);
    } else expect(current.envelope).toEqual(original);
  }
  const freshCredentialsPath = join(directory, 'erasure-bootstrap.credential.json');
  execFileSync(
    binary,
    [
      '--database',
      database,
      'issue-device',
      '--name',
      'Erasure bootstrap',
      '--server-url',
      `http://127.0.0.1:${port}`,
      '--output',
      freshCredentialsPath,
    ],
    { stdio: 'ignore' },
  );
  const bootstrap = await local(JSON.parse(readFileSync(freshCredentialsPath, 'utf8')), sharedKey);
  await new SyncCoordinator(bootstrap).sync();
  expect(await bootstrap.historyVisits.count()).toBe(0);
  for (const original of originals.filter((e) => e.domain === 'history')) {
    expect((await bootstrap.operations.get(original.operation_id))!.envelope.ciphertext).toBe('');
    // Real relay retries reserve identity and ACK without restoring the old body.
    const owner = original.device_id === credentialsH.device_id ? a : b;
    const reply = await new HttpTransport((await owner.state.get('local'))!).push(
      [original],
      (await a.state.get('local'))!.server_epoch!,
    );
    expect(reply.acknowledgements[0]!.sequence).toBe(
      (await a.operations.get(original.operation_id))!.sequence,
    );
  }

  expect(JSON.stringify(await a.exportReplica())).not.toContain(url);
  expect(JSON.stringify(await b.exportReplica())).not.toContain('Private history title');
  const stored = execFileSync(
    'sqlite3',
    [
      database,
      "SELECT envelope FROM operations WHERE json_extract(envelope, '$.domain') = 'history';",
    ],
    { encoding: 'utf8' },
  );
  expect(stored.trim().split('\n')).toHaveLength(5);
  expect(stored).not.toContain(url);
  expect(stored).not.toContain('Private history title');
  expect(stored).not.toContain(sharedKey);
  expect(stored).not.toContain(await a.ensureHistoryIndexKey());
  for (const original of originals.filter((e) => e.domain === 'history'))
    expect(stored).not.toContain(original.ciphertext);
  const counts = execFileSync('sqlite3', [database, 'SELECT COUNT(*) FROM history_redactions;'], {
    encoding: 'utf8',
  });
  expect(Number(counts.trim())).toBe(3);
});

async function relayStatus(credentials: Credentials) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/status`, {
    headers: { Authorization: `Bearer ${credentials.token}` },
  });
  expect(response.ok).toBe(true);
  return response.json();
}
it('retries a real lost cursor ACK after graceful SIGTERM and durable client reopen', async () => {
  const source = await local(credentialsJ, sharedKey);
  let target = await local(credentialsK, sharedKey);
  await source.queueDiagnostic('Shutdown and lost progress reply probe');
  await new SyncCoordinator(source).sync();
  const before = await relayStatus(credentialsJ);
  const native = new HttpTransport((await target.state.get('local'))!);
  let acknowledged = 0;
  const coordinator = new SyncCoordinator(target, () => ({
    pull: (cursor) => native.pull(cursor),
    push: (envelopes, epoch) => native.push(envelopes, epoch),
    acknowledge: async (cursor, epoch) => {
      const reply = await native.acknowledge(cursor, epoch);
      expect((await target.state.get('local'))?.cursor).toBe(cursor);
      acknowledged = cursor;
      throw new Error('Real committed ACK reply deliberately lost');
    },
  }));
  await expect(coordinator.sync()).rejects.toThrow('deliberately lost');
  expect(acknowledged).toBeGreaterThan(0);
  expect((await target.state.get('local'))?.acknowledged_cursor).toBe(0);
  expect((await relayStatus(credentialsK)).processed_cursor).toBe(acknowledged);
  const name = target.name;
  target.close();
  expect(await stop()).toEqual({ code: 0, signal: null });
  await start();
  target = new SynkDatabase(name);
  localDatabases.push(target);
  const resumed = new HttpTransport((await target.state.get('local'))!);
  const retries: number[] = [];
  await new SyncCoordinator(target, () => ({
    pull: (cursor) => resumed.pull(cursor),
    push: (envelopes, epoch) => resumed.push(envelopes, epoch),
    acknowledge: (cursor, epoch) => {
      retries.push(cursor);
      return resumed.acknowledge(cursor, epoch);
    },
  })).sync();
  expect(retries[0]).toBe(acknowledged);
  expect((await target.state.get('local'))?.acknowledged_cursor).toBe(before.latest_sequence);
  const after = await relayStatus(credentialsK);
  expect(after.processed_cursor).toBe(before.latest_sequence);
  expect(after.server_epoch).toBe(before.server_epoch);
  expect(after.journal_operations).toBe(before.journal_operations);
  const integrity = execFileSync('sqlite3', [database, 'PRAGMA integrity_check;'], {
    encoding: 'utf8',
  });
  expect(integrity.trim()).toBe('ok');
});

it('enforces running relay quotas while preserving identical retries and durable client work', async () => {
  // Reuse the actual durable installation; copying its credential into a fresh
  // profile would lose its private wrapping key and author-counter history.
  let source: SynkDatabase | undefined;
  for (const candidate of [...localDatabases].reverse())
    if (
      candidate.isOpen() &&
      (await candidate.state.get('local'))?.credentials.device_id === credentialsA.device_id
    ) {
      source = candidate;
      break;
    }
  if (!source) throw new Error('Original quota-test installation is missing');
  await source.queueDiagnostic('Retain until quota increases');
  const envelope = (await source.outbox.toArray())[0]!;
  const before = await relayStatus(credentialsA);
  const setLimits = (operations: number) =>
    execFileSync(
      binary,
      [
        '--database',
        database,
        'set-limits',
        '--max-journal-bytes',
        '1073741824',
        '--max-operations',
        String(operations),
        '--max-devices',
        '64',
      ],
      { stdio: 'ignore' },
    );
  setLimits(before.journal_operations);
  try {
    await expect(new SyncCoordinator(source).sync()).rejects.toThrow('quota');
    expect(await source.outbox.count()).toBe(1);
    expect((await relayStatus(credentialsA)).journal_operations).toBe(before.journal_operations);
    setLimits(before.journal_operations + 1);
    await new SyncCoordinator(source).sync();
    expect(await source.outbox.count()).toBe(0);
    const transport = new HttpTransport((await source.state.get('local'))!);
    const reply = await transport.push([envelope], before.server_epoch);
    expect(reply.acknowledgements).toHaveLength(1);
    expect((await relayStatus(credentialsA)).journal_operations).toBe(
      before.journal_operations + 1,
    );
  } finally {
    setLimits(1_000_000);
  }
});

it('bounds notification connections, releases slots and drains authenticated sockets on shutdown', async () => {
  // Clear earlier test connections, and use the same credential in multiple bounded sockets.
  await stop();
  await start();
  const connections: WebSocket[] = [];
  async function connect(): Promise<WebSocket> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/events`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Socket readiness timed out')), 2_000);
      socket.onopen = () => socket.send(JSON.stringify({ token: credentialsA.token }));
      socket.onerror = () => {
        clearTimeout(deadline);
        reject(new Error('Socket rejected'));
      };
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data));
        if (message.type === 'ready') {
          clearTimeout(deadline);
          resolve();
        }
        if (message.type === 'ping') socket.send('pong');
      };
    });
    return socket;
  }
  for (let i = 0; i < 32; i++) connections.push(await connect());
  await expect(connect()).rejects.toThrow('Socket rejected');
  // HTTP reconciliation remains usable at the socket limit.
  expect((await relayStatus(credentialsA)).protocol_version).toBe(1);
  connections[0]!.close();
  await expect.poll(() => connections[0]!.readyState).toBe(WebSocket.CLOSED);
  connections.push(await connect());
  expect(await stop()).toEqual({ code: 0, signal: null });
  await expect.poll(() => connections.every((s) => s.readyState === WebSocket.CLOSED)).toBe(true);
  await start();
  const recovered = await connect();
  recovered.close();
});

it('pairs a new installation across a real lost enrollment reply and relay/client restart without relay key material', async () => {
  const credentialFile = join(directory, 'pairing-issuer.credential.json');
  execFileSync(
    binary,
    [
      '--database',
      database,
      'issue-device',
      '--name',
      'Pairing issuer',
      '--server-url',
      `http://127.0.0.1:${port}`,
      '--output',
      credentialFile,
    ],
    { stdio: 'ignore' },
  );
  const trusted = await local(JSON.parse(readFileSync(credentialFile, 'utf8')), sharedKey);
  await new SyncCoordinator(trusted).sync();
  const bundle = await createPairingBundle(trusted);
  let target = new SynkDatabase(`integration-pairing-${crypto.randomUUID()}`);
  localDatabases.push(target);
  await stagePairing(target, bundle, 'Disposable paired profile');
  const pending = (await target.pairingPending.get('pairing'))!;
  const nativeFetch = globalThis.fetch;
  let dropped = false;
  const sent: string[] = [];
  globalThis.fetch = async (input, init) => {
    if (String(input).endsWith('/v1/pairing/register')) {
      sent.push(String(init?.body));
      const reply = await nativeFetch(input, init);
      expect(reply.ok).toBe(true);
      if (!dropped) {
        dropped = true;
        throw new Error('Committed enrollment reply dropped');
      }
      return reply;
    }
    return nativeFetch(input, init);
  };
  try {
    await expect(completePairing(target)).rejects.toThrow('reply dropped');
    expect(await target.state.get('local')).toBeUndefined();
    const name = target.name;
    target.close();
    expect(await stop()).toEqual({ code: 0, signal: null });
    await start();
    target = new SynkDatabase(name);
    localDatabases.push(target);
    await completePairing(target);
    expect(sent[1]).toBe(sent[0]);
  } finally {
    globalThis.fetch = nativeFetch;
  }
  const state = (await target.state.get('local'))!;
  expect(state.credentials.device_id).toBe(pending.credentials.device_id);
  expect(state.recovery_key).toBe(sharedKey);
  expect(await target.pairingPending.count()).toBe(0);
  await target.queueDiagnostic('Signal from invitation-enrolled profile');
  await new SyncCoordinator(target).sync();
  await new SyncCoordinator(trusted).sync();
  expect((await trusted.records.toArray()).map((r) => r.payload.note)).toContain(
    'Signal from invitation-enrolled profile',
  );
  const stored = execFileSync(
    'sqlite3',
    [
      database,
      'SELECT invitation_hash,claim_hash FROM pairing_invites; SELECT token_hash FROM devices; SELECT envelope FROM operations;',
    ],
    { encoding: 'utf8' },
  );
  expect(stored).not.toContain(bundle.recovery_key);
  expect(stored).not.toContain(bundle.history_index_key);
  expect(stored).not.toContain(bundle.invitation_token);
  expect(stored).not.toContain(pending.credentials.token);
  expect(stored).not.toContain('Signal from invitation-enrolled profile');
  expect(JSON.stringify(sent)).not.toContain(bundle.recovery_key);
  expect(JSON.stringify(sent)).not.toContain(bundle.history_index_key);
  expect((await relayStatus(state.credentials)).schema_version).toBe(5);
});

it('local capacity retains the download cursor while draining real queued uploads, then resumes after a limit increase', async () => {
  async function issued(name: string) {
    const output = join(directory, `${name}.credential.json`);
    execFileSync(
      binary,
      [
        '--database',
        database,
        'issue-device',
        '--name',
        name,
        '--server-url',
        `http://127.0.0.1:${port}`,
        '--output',
        output,
      ],
      { stdio: 'ignore' },
    );
    return JSON.parse(readFileSync(output, 'utf8')) as Credentials;
  }
  const source = await local(await issued('Capacity source'), sharedKey);
  let measured = 0;
  const target = new SynkDatabase(`capacity-real-${crypto.randomUUID()}`, async () => ({
    usage: measured,
  }));
  localDatabases.push(target);
  await target.enroll(await issued('Capacity target'), sharedKey);
  await new SyncCoordinator(source).sync();
  await new SyncCoordinator(target).sync();
  const cursor = (await target.state.get('local'))!.cursor;
  const id = await target.queueDiagnostic('Queued before local capacity was reached');
  await source.queueDiagnostic('Unseen remote capacity record');
  await new SyncCoordinator(source).sync();
  const policy = {
    max_bytes: 16 * 1024 * 1024,
    max_pending: 100000,
    max_journal: 500000,
    max_capture_tasks: 30000,
  };
  await target.setStoragePolicy(policy);
  measured = policy.max_bytes;
  await target.storageStatus(true);
  await expect(new SyncCoordinator(target).sync()).rejects.toThrow('storage estimate');
  expect(await target.outbox.count()).toBe(0);
  expect((await target.records.get(id))!.sequence).toBeGreaterThan(cursor);
  expect((await target.state.get('local'))!.cursor).toBe(cursor);
  expect(await target.quarantine.count()).toBe(0);
  await target.setStoragePolicy({ ...policy, max_bytes: policy.max_bytes * 2 });
  await new SyncCoordinator(target).sync();
  expect((await target.state.get('local'))!.cursor).toBeGreaterThan(cursor);
  expect(
    (await target.records.toArray()).some(
      (r) => r.payload.note === 'Unseen remote capacity record',
    ),
  ).toBe(true);
  const count = execFileSync(
    'sqlite3',
    [database, `SELECT COUNT(*) FROM operations WHERE operation_id = '${id}';`],
    { encoding: 'utf8' },
  );
  expect(Number(count.trim())).toBe(1);
});

it('history retention uploads pending old visits before owner expiry and purges their ciphertext across peers and fresh bootstrap', async () => {
  const issue = (name: string): Credentials => {
    const output = join(directory, `${name}.json`);
    execFileSync(
      binary,
      [
        '--database',
        database,
        'issue-device',
        '--name',
        name,
        '--server-url',
        `http://127.0.0.1:${port}`,
        '--output',
        output,
      ],
      { stdio: 'ignore' },
    );
    return JSON.parse(readFileSync(output, 'utf8'));
  };
  let owner = await local(issue('Retention owner'), sharedKey);
  const peer = await local(issue('Retention peer'), sharedKey);
  await new SyncCoordinator(owner).sync();
  await new SyncCoordinator(peer).sync();
  const time = Date.now(),
    day = 86_400_000;
  const visit = async (db: SynkDatabase, native: string, age: number) => {
    const state = (await db.state.get('local'))!;
    const source = state.credentials.device_id,
      incarnation = crypto.randomUUID();
    const url = `https://retention-integration.example/${native}`;
    const tag = await historyUrlTag(await db.ensureHistoryIndexKey(), url);
    const visited_at = time - age * day,
      id = historyVisitId(source, incarnation, native, visited_at);
    const operation_id = await db.stageHistory({
      type: 'visit',
      visit: {
        id,
        source_id: source,
        source_name: state.credentials.name,
        incarnation,
        native_id: native,
        visited_at,
        url,
        url_tag: tag,
        title: 'Retention integration title',
        generation: historyGeneration(await db.historyProjection(), source, tag),
      },
    });
    return { id, operation_id, visited_at };
  };
  const peerOld = await visit(peer, 'peer-old', 120);
  await new SyncCoordinator(peer).sync();
  await owner.setHistoryRetention({ enabled: true, days: 90 });
  const old = await visit(owner, 'owner-old', 120),
    recent = await visit(owner, 'owner-recent', 10);
  await owner.flushDrafts();
  const original = (await owner.outbox.get(old.operation_id))!;
  await new SyncCoordinator(owner).sync();
  expect((await owner.operations.get(old.operation_id))!.sequence).toBeGreaterThan(0);
  expect((await owner.operations.get(old.operation_id))!.envelope).toEqual(original);
  expect((await owner.historyVisits.get(old.id))!.visited_at).toBe(old.visited_at);
  expect(await owner.outbox.get(old.operation_id)).toBeUndefined();
  const name = owner.name;
  owner.close();
  owner = new SynkDatabase(name);
  localDatabases.push(owner);
  await new SyncCoordinator(owner).sync();
  await new SyncCoordinator(peer).sync();
  for (const db of [owner, peer]) {
    expect(await db.historyVisits.get(old.id)).toBeUndefined();
    expect((await db.operations.get(old.operation_id))!.envelope.ciphertext).toBe('');
    expect(await db.historyVisits.get(peerOld.id)).toBeDefined();
    expect(await db.historyVisits.get(recent.id)).toBeDefined();
  }
  const fresh = await local(issue('Retention fresh'), sharedKey);
  await new SyncCoordinator(fresh).sync();
  expect(await fresh.historyVisits.get(old.id)).toBeUndefined();
  expect(await fresh.historyVisits.get(peerOld.id)).toBeDefined();
  expect((await fresh.historyVisits.get(recent.id))!.visited_at).toBe(recent.visited_at);
  expect(await owner.pendingCount()).toBe(0);
  const stored = execFileSync(
    'sqlite3',
    [database, `SELECT envelope FROM operations WHERE operation_id = '${old.operation_id}';`],
    { encoding: 'utf8' },
  );
  expect(stored).not.toContain(original.ciphertext);
});

it('real relay purges history ciphertext with durable receipts across a discarded reply and restart', async () => {
  const issue = (name: string): Credentials => {
    const path = join(directory, `${name}.json`);
    execFileSync(
      binary,
      [
        '--database',
        database,
        'issue-device',
        '--name',
        name,
        '--server-url',
        `http://127.0.0.1:${port}`,
        '--output',
        path,
      ],
      { stdio: 'ignore' },
    );
    return JSON.parse(readFileSync(path, 'utf8'));
  };
  const author = issue('Purge source'),
    remover = issue('Purge helper');
  const db = await local(author, sharedKey);
  const url = 'https://purge.example/private-record';
  const incarnation = crypto.randomUUID();
  const operation = await db.stageHistory({
    type: 'visit',
    visit: {
      id: historyVisitId(author.device_id, incarnation, '1', 1234.5),
      source_id: author.device_id,
      source_name: author.name,
      incarnation,
      native_id: '1',
      visited_at: 1234.5,
      url,
      url_tag: await historyUrlTag(await db.ensureHistoryIndexKey(), url),
      title: 'Purged integration history',
      generation: {},
    },
  });
  await db.flushDrafts();
  const original = (await db.outbox.get(operation))!;
  const epoch = (await relayStatus(author)).server_epoch;
  const api = (path: string, c: Credentials, body?: unknown, capable = true) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${c.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(capable ? { 'X-Synk-History-Erasure': '1' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const pushed = await api('/v1/sync/push', author, {
    expected_epoch: epoch,
    envelopes: [original],
  });
  expect(pushed.status).toBe(200);
  const ack = await pushed.json();
  const { nonce: _nonce, ciphertext: _ciphertext, ...header } = original;
  const digest = await envelopeDigest(original);
  // The relay treats certificates as opaque. Client proof creation/validation and
  // local erasure are the following checkpoint; this exercises only the relay contract.
  const certificate = {
    ...header,
    operation_id: crypto.randomUUID(),
    device_id: remover.device_id,
    counter: 1,
    domain: 'history-erasure',
    nonce: base64(crypto.getRandomValues(new Uint8Array(12))),
    ciphertext: base64(crypto.getRandomValues(new Uint8Array(32))),
  };
  const request = { expected_epoch: epoch, certificate, targets: [{ header, digest }] };
  const discarded = await api('/v1/history/purge', remover, request);
  expect(discarded.status).toBe(200);
  await discarded.arrayBuffer(); // Discard the committed reply, then reopen the real relay.
  expect(await stop()).toEqual({ code: 0, signal: null });
  await start();
  const retry = await api('/v1/history/purge', remover, request);
  expect(retry.status).toBe(200);
  const reply = await retry.json();
  expect(reply.redactions[0]).toMatchObject({
    operation_id: original.operation_id,
    digest,
    sequence: ack.acknowledgements[0].sequence,
    certificate_operation_id: certificate.operation_id,
  });
  expect(
    (await api('/v1/sync/push', author, { expected_epoch: epoch, envelopes: [original] })).status,
  ).toBe(200);
  expect(
    (
      await api('/v1/sync/push', author, {
        expected_epoch: epoch,
        envelopes: [{ ...original, ciphertext: base64(new Uint8Array(32).fill(7)) }],
      })
    ).status,
  ).toBe(409);
  expect((await api('/v1/sync/pull?cursor=0', author, undefined, false)).status).toBe(426);
  const stored = execFileSync(
    'sqlite3',
    [database, 'SELECT envelope FROM operations; SELECT original_digest FROM history_redactions;'],
    { encoding: 'utf8' },
  );
  expect(stored).toContain(digest);
  expect(stored).not.toContain(original.ciphertext);
  expect(stored).not.toContain(url);
  const keyState = await (await api('/v1/keys/state', author)).json();
  expect(keyState.author_counter).toBe(1);
  expect(keyState.author_operation_id).toBe(original.operation_id);
  // A new author still bootstraps from zero; an arbitrary late cursor is never delivery proof.
  let cursor = 0;
  let found = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await api(`/v1/sync/pull?cursor=${cursor}`, author);
    expect(response.status).toBe(200);
    const page = await response.json();
    const record = page.records.find(
      (entry: { sequence: number }) => entry.sequence === ack.acknowledgements[0].sequence,
    );
    if (record) {
      expect(record.redacted).toMatchObject({ header, digest, certificate });
      found = true;
      break;
    }
    cursor = page.next_cursor;
    if (!page.has_more) break;
  }
  expect(found).toBe(true);
});
