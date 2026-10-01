import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import {
  SynkDatabase,
  SyncCoordinator,
  HttpTransport,
  KeyManager,
  generateRecoveryKey,
  createPairingBundle,
  stagePairing,
  completePairing,
  exportRecovery,
  enrollRecovery,
  decryptPayload,
  BOOKMARK_ROOTS,
  historyVisitId,
  historyUrlTag,
  historyGeneration,
  type Credentials,
} from '../sync-core/src/index';
import { sessionWindow } from './session-fixtures';

it('durable clients rotate across offline work, lost replies/reopens, late pairing and fresh recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helium-key-lifecycle-'));
  const database = join(directory, 'relay.sqlite'),
    binary = resolve('target/debug/synk-server');
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No disposable port');
  const port = address.port,
    origin = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));
  let process: ChildProcess | undefined;
  const locals: SynkDatabase[] = [];
  const nativeFetch = globalThis.fetch;
  async function start() {
    process = spawn(binary, ['--database', database, 'serve', '--port', String(port)], {
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (process.exitCode !== null) throw new Error('Relay exited');
      try {
        if ((await fetch(`${origin}/health/ready`)).ok) return;
      } catch {
        /* Starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Relay startup timed out');
  }
  async function stop() {
    const child = process;
    process = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Drain timed out'));
      }, 5000);
      child.once('exit', (code) => {
        clearTimeout(deadline);
        code === 0 ? resolve() : reject(new Error('Unclean exit'));
      });
      child.kill('SIGTERM');
    });
  }
  function credential(name: string): Credentials {
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
        origin,
        '--output',
        path,
      ],
      { stdio: 'ignore' },
    );
    return JSON.parse(readFileSync(path, 'utf8'));
  }
  function db(name?: string) {
    const local = new SynkDatabase(name ?? `lifecycle-${crypto.randomUUID()}`);
    locals.push(local);
    return local;
  }
  const sync = (local: SynkDatabase) => new SyncCoordinator(local).sync();
  async function manager(local: SynkDatabase) {
    return new KeyManager(local, new HttpTransport((await local.state.get('local'))!).keys);
  }
  try {
    const ca = credential('Retained A'),
      cb = credential('Offline B'),
      cr = credential('Removed');
    const root = generateRecoveryKey();
    let a = db(),
      b = db();
    const removed = db();
    await a.enroll(ca, root);
    await b.enroll(cb, root);
    await removed.enroll(cr, root);
    await start();
    await sync(a);
    await sync(b);
    await sync(removed);
    await a.queueDiagnostic('Historical readable signal');
    await sync(a);
    await sync(b);
    const committed = await b.queueDiagnostic('Committed but reply lost');
    const committedEnvelope = (await b.outbox.get(committed))!;
    // Send once but deliberately leave the corresponding local queue entry unacknowledged.
    await new HttpTransport((await b.state.get('local'))!).push(
      [committedEnvelope],
      (await b.state.get('local'))!.server_epoch!,
    );
    const offline = await b.queueDiagnostic('Offline future signal'),
      oldOffline = (await b.outbox.get(offline))!;
    const node = crypto.randomUUID(),
      bookmark = await b.stageBookmark({
        type: 'create',
        node_id: node,
        node_type: 'bookmark',
        title: 'Private offline bookmark',
        url: 'https://offline.example/bookmark',
        placement: { parent: BOOKMARK_ROOTS.bar, position: '0/1' },
      });
    const session = await b.stageSession({
      kind: 'closed',
      captured_at: '2026-10-01T10:00:00Z',
      windows: [sessionWindow(4, 'Private offline session')],
    });
    const url = 'https://offline.example/history',
      time = 12345.75,
      incarnation = crypto.randomUUID();
    const index = (await b.state.get('local'))!.history_index_key!,
      tag = await historyUrlTag(index, url);
    const visit = historyVisitId(cb.device_id, incarnation, 'native-test-1', time);
    await b.stageHistory({
      type: 'visit',
      visit: {
        id: visit,
        source_id: cb.device_id,
        source_name: cb.name,
        incarnation,
        native_id: 'native-test-1',
        visited_at: time,
        url,
        url_tag: tag,
        title: 'Private offline history',
        transition: 'typed',
        referring_native_id: '0',
        generation: historyGeneration(await b.historyProjection(), cb.device_id, tag),
      },
    });
    await b.flushDrafts(); // Exercise immutable old ciphertext in all domains, not only unencrypted drafts.
    const originalIds = (await b.outbox.toArray()).map((e) => [e.operation_id, e.counter]);
    await (await manager(a)).stageRotation([cr.device_id]);
    const pending = (await a.rotationPending.get('rotation'))!;
    const sent: string[] = [];
    let lostRotation = true;
    globalThis.fetch = async (input, options) => {
      const response = await nativeFetch(input, options);
      if (String(input).endsWith('/v1/keys/rotate')) {
        sent.push(String(options?.body));
        if (lostRotation && response.ok) {
          lostRotation = false;
          await response.arrayBuffer();
          throw new Error('Lost committed rotation reply');
        }
      }
      return response;
    };
    await expect((await manager(a)).completeRotation()).rejects.toThrow('Lost committed');
    expect((await a.state.get('local'))!.key_epoch).toBe(1);
    expect(await a.rotationPending.get('rotation')).toEqual(pending);
    a.close();
    a = db(a.name);
    expect((await a.keySecrets.get('keys'))!.identity?.private_key.d).toBeTruthy();
    await stop();
    await start();
    await (await manager(a)).completeRotation();
    expect(sent[1]).toBe(sent[0]);
    globalThis.fetch = nativeFetch;
    expect((await a.state.get('local'))!.key_epoch).toBe(2);
    expect(await a.rotationPending.count()).toBe(0);
    await expect(sync(removed)).rejects.toThrow('credentials were rejected');
    b.close();
    b = db(b.name);
    await sync(b);
    await sync(a);
    expect((await b.records.get(committed))!.envelope).toEqual(committedEnvelope);
    const future = (await b.records.get(offline))!;
    expect(future.envelope.operation_id).toBe(oldOffline.operation_id);
    expect(future.envelope.counter).toBe(oldOffline.counter);
    expect(future.envelope.key_epoch).toBe(2);
    expect(future.envelope.nonce).not.toBe(oldOffline.nonce);
    await expect(decryptPayload(root, future.envelope, index)).rejects.toThrow();
    expect((await b.operations.get(bookmark))!.envelope.key_epoch).toBe(2);
    for (const [id, counter] of originalIds) {
      const record = (await b.records.get(String(id))) ?? (await b.operations.get(String(id)));
      expect(record!.envelope.counter).toBe(counter);
      expect(record!.sequence).toBeGreaterThan(0);
    }
    expect((await a.bookmarkProjection()).nodes[node]?.title).toBe('Private offline bookmark');
    expect((await a.sessionProjection()).snapshots[session]?.windows[0]?.tabs).toHaveLength(4);
    expect((await a.queryHistory()).visits[0]?.id).toBe(visit);
    expect((await a.queryHistory()).visits[0]?.visited_at).toBe(time);
    expect(await b.pendingCount()).toBe(0);
    expect((await b.state.get('local'))!.history_index_key).toBe(index);
    await b.stageSession({
      kind: 'closed',
      captured_at: '2026-10-01T10:01:00Z',
      windows: [sessionWindow()],
    }); // A durable draft crosses the next rotation.
    await (await manager(a)).stageRotation([]);
    await (await manager(a)).completeRotation();
    await sync(b);
    await sync(a);
    expect((await b.state.get('local'))!.key_epoch).toBe(3);
    expect(Object.keys((await b.keySecrets.get('keys'))!.roots)).toEqual(['1', '2', '3']);
    const bundle = await createPairingBundle(a);
    expect(bundle.version).toBe(2);
    expect(bundle.key_epoch).toBe(3);
    let target = db();
    await stagePairing(target, bundle, 'Late paired profile');
    const claim = (await target.pairingPending.get('pairing'))!;
    let lostClaim = true;
    const claims: string[] = [];
    globalThis.fetch = async (input, options) => {
      const response = await nativeFetch(input, options);
      if (String(input).endsWith('/v1/pairing/register')) {
        claims.push(String(options?.body));
        if (lostClaim && response.ok) {
          lostClaim = false;
          await response.arrayBuffer();
          throw new Error('Lost paired reply');
        }
      }
      return response;
    };
    await expect(completePairing(target)).rejects.toThrow('Lost paired reply');
    // The relay already has the recipient's public identity, so it can be retained while still pending locally.
    await (await manager(a)).stageRotation([]);
    await (await manager(a)).completeRotation();
    target.close();
    target = db(target.name);
    await completePairing(target);
    expect(claims[1]).toBe(claims[0]);
    globalThis.fetch = nativeFetch;
    expect((await target.keySecrets.get('keys'))!.identity).toEqual(claim.identity);
    expect((await target.state.get('local'))!.key_epoch).toBe(3);
    await sync(target);
    await sync(b);
    expect((await target.state.get('local'))!.key_epoch).toBe(4);
    expect((await target.bookmarkProjection()).nodes[node]?.title).toBe('Private offline bookmark');
    const backup = await exportRecovery(a),
      recovered = db(),
      fresh = credential('Recovered fresh author');
    expect(Object.keys(backup.roots)).toEqual(['1', '2', '3', '4']);
    await enrollRecovery(recovered, fresh, backup);
    await sync(recovered);
    expect((await recovered.records.toArray()).map((r) => r.payload.note).sort()).toEqual(
      (await a.records.toArray()).map((r) => r.payload.note).sort(),
    );
    expect((await recovered.state.get('local'))!.next_counter).toBe(1);
    expect((await recovered.keySecrets.get('keys'))!.identity?.public_key).not.toBe(
      (await a.keySecrets.get('keys'))!.identity!.public_key,
    );
    const replica = JSON.stringify(await a.exportReplica()),
      stored = execFileSync(
        'sqlite3',
        [
          database,
          'SELECT packet FROM key_packets; SELECT envelope FROM operations; SELECT token_hash,wrapping_public_key,wrapping_proof FROM devices;',
        ],
        { encoding: 'utf8' },
      );
    for (const secret of [
      ...Object.values(backup.roots),
      ca.token,
      cb.token,
      cr.token,
      (await a.keySecrets.get('keys'))!.identity!.private_key.d!,
    ]) {
      expect(replica).not.toContain(secret);
      expect(stored).not.toContain(secret);
      expect(JSON.stringify(sent)).not.toContain(secret);
    }
    for (const text of [
      'Private offline bookmark',
      'Private offline session',
      'Private offline history',
      'Offline future signal',
    ])
      expect(stored).not.toContain(text);
    expect(JSON.stringify(claims)).not.toContain(bundle.recovery_key);
    expect(JSON.stringify(claims)).not.toContain(bundle.history_index_key);
  } finally {
    globalThis.fetch = nativeFetch;
    await stop();
    for (const local of locals) local.close();
    for (const local of new Map(locals.map((local) => [local.name, local])).values())
      await local.delete();
    rmSync(directory, { recursive: true, force: true });
  }
});
