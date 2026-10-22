import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { expect, it } from 'vite-plus/test';
import {
  compactBookmarks,
  exportRelayRecovery,
  adoptRelayRecovery,
  exportRecovery,
  enrollRecovery,
  SynkDatabase,
  SyncCoordinator,
  HttpTransport,
  KeyManager,
  BOOKMARK_ROOTS,
  generateRecoveryKey,
  historyVisitId,
  historyUrlTag,
  type Credentials,
} from '../sync-core/src/index';
import { sessionWindow } from './session-fixtures';

async function harness() {
  const directory = mkdtempSync(join(tmpdir(), 'helium-recovery-'));
  const database = join(directory, 'relay.sqlite'),
    binary = resolve('target/debug/synk-server');
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No disposable recovery port');
  const port = address.port,
    origin = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  let child: ChildProcess | undefined;
  const locals: SynkDatabase[] = [];
  const cli = (...args: string[]) =>
    execFileSync(binary, ['--database', database, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const issue = (name: string): Credentials => {
    const output = join(directory, `${name}.credential.json`);
    cli('issue-device', '--name', name, '--server-url', origin, '--output', output);
    return JSON.parse(readFileSync(output, 'utf8'));
  };
  const root = generateRecoveryKey();
  const local = async (name: string) => {
    const db = new SynkDatabase(`recovery-${crypto.randomUUID()}`);
    locals.push(db);
    await db.enroll(issue(name), root);
    return db;
  };
  async function start() {
    child = spawn(binary, ['--database', database, 'serve', '--port', String(port)], {
      stdio: 'ignore',
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error('Recovery relay exited');
      try {
        if ((await fetch(`${origin}/health/ready`)).ok) return;
      } catch {
        /* Starting. */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('Recovery relay startup timed out');
  }
  async function stop() {
    const process = child;
    child = undefined;
    if (!process || process.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        process.kill('SIGKILL');
        reject(new Error('Recovery relay drain timed out'));
      }, 5000);
      process.once('exit', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error('Recovery relay exited uncleanly'));
      });
      process.kill('SIGTERM');
    });
  }
  const removeDatabase = () => {
    for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true });
  };
  const sql = (query: string) =>
    execFileSync('sqlite3', [database, query], { encoding: 'utf8' }).trim();
  return {
    directory,
    database,
    origin,
    locals,
    cli,
    local,
    start,
    stop,
    sql,
    removeDatabase,
    async cleanup() {
      await stop();
      for (const db of locals) await db.delete();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
const sync = (db: SynkDatabase) => new SyncCoordinator(db).sync();

it('online CLI backup includes WAL; an older marked restore preserves client keys, erased state and all pending domain work', async () => {
  const h = await harness();
  try {
    const a = await h.local('Backup A'),
      b = await h.local('Backup B');
    await h.start();
    await sync(a);
    await sync(b);
    const before = await a.queueDiagnostic('Before consistent backup');
    await sync(a);
    const local = (await a.state.get('local'))!,
      source = local.credentials.device_id;
    const incarnation = crypto.randomUUID(),
      url = 'https://backup-recovery.example/private';
    const visited_at = Date.now() - 1000,
      visitId = historyVisitId(source, incarnation, 'old', visited_at);
    const historyId = await a.stageHistory({
      type: 'visit',
      visit: {
        id: visitId,
        source_id: source,
        source_name: local.credentials.name,
        incarnation,
        native_id: 'old',
        visited_at,
        url,
        title: 'Original backup visit',
        url_tag: await historyUrlTag(await a.ensureHistoryIndexKey(), url),
        generation: {},
      },
    });
    await a.stageSession({
      kind: 'current',
      captured_at: new Date().toISOString(),
      windows: [sessionWindow()],
    });
    await sync(a);
    await sync(b);
    const oldEpoch = (await a.state.get('local'))!.server_epoch!;
    expect(statSync(h.database + '-wal').size).toBeGreaterThan(0);
    const snapshot = join(h.directory, 'consistent.sqlite');
    h.cli('backup', '--output', snapshot);
    expect(statSync(snapshot).mode & 0o777).toBe(0o600);
    expect(
      execFileSync('sqlite3', [snapshot, 'PRAGMA integrity_check;'], { encoding: 'utf8' }).trim(),
    ).toBe('ok');
    const backupBytes = readFileSync(snapshot);
    expect(backupBytes.includes(Buffer.from(local.credentials.token))).toBe(false);
    expect(backupBytes.includes(Buffer.from(local.recovery_key))).toBe(false);
    expect(() => h.cli('backup', '--output', snapshot)).toThrow();
    expect(readFileSync(snapshot)).toEqual(backupBytes);
    expect(() => h.cli('mark-restored', '--expected-epoch', oldEpoch)).toThrow(
      /Stop that relay first/,
    );
    expect((await (await fetch(h.origin + '/health/ready')).json()).server_epoch).toBe(oldEpoch);
    await a.stageHistory({ type: 'delete', visit_ids: [visitId] });
    await sync(a);
    await sync(b);
    const acknowledgedLater = await a.queueDiagnostic('Acknowledged after the backup');
    await sync(a);
    await sync(b);
    const manager = new KeyManager(a, new HttpTransport((await a.state.get('local'))!).keys);
    await manager.stageRotation([]);
    await expect(exportRelayRecovery(a)).rejects.toThrow('saved key rotation');
    await manager.completeRotation();
    await sync(b);
    expect((await b.state.get('local'))!.key_epoch).toBe(2);
    await h.stop();
    const pending = await b.queueDiagnostic('Unacknowledged during recovery outage');
    await b.stageBookmark({
      type: 'create',
      node_id: crypto.randomUUID(),
      node_type: 'bookmark',
      title: 'Pending recovery bookmark',
      url: 'https://backup-recovery.example/bookmark',
      placement: { parent: BOOKMARK_ROOTS.bar, position: '0/1' },
    });
    await b.stageSession({
      kind: 'closed',
      captured_at: new Date().toISOString(),
      windows: [sessionWindow()],
    });
    const queuedSource = (await b.state.get('local'))!.credentials;
    const queuedIncarnation = crypto.randomUUID(),
      queuedTime = Date.now();
    await b.stageHistory({
      type: 'visit',
      visit: {
        id: historyVisitId(queuedSource.device_id, queuedIncarnation, 'pending', queuedTime),
        source_id: queuedSource.device_id,
        source_name: queuedSource.name,
        incarnation: queuedIncarnation,
        native_id: 'pending',
        visited_at: queuedTime,
        url,
        title: 'Pending recovery history',
        url_tag: await historyUrlTag(await b.ensureHistoryIndexKey(), url),
        generation: {},
      },
    });
    const exports = await Promise.all([a.exportReplica(), b.exportReplica()]);
    const secrets = await Promise.all([a.keySecrets.get('keys'), b.keySecrets.get('keys')]);
    h.removeDatabase();
    copyFileSync(snapshot, h.database);
    h.cli('mark-restored', '--expected-epoch', oldEpoch);
    const restoredEpoch = h.sql('SELECT server_epoch FROM settings WHERE id=1;');
    expect(restoredEpoch).not.toBe(oldEpoch);
    expect(
      Number(h.sql(`SELECT COUNT(*) FROM operations WHERE operation_id='${acknowledgedLater}';`)),
    ).toBe(0);
    expect(Number(h.sql(`SELECT COUNT(*) FROM operations WHERE operation_id='${before}';`))).toBe(
      1,
    );
    await h.start();
    for (const db of [a, b]) {
      // The older relay rejects newer key frontiers/cursors before returning an epoch page.
      await expect(sync(db)).rejects.toThrow('conflicts with local state');
    }
    expect(await Promise.all([a.exportReplica(), b.exportReplica()])).toEqual(exports);
    expect(await Promise.all([a.keySecrets.get('keys'), b.keySecrets.get('keys')])).toEqual(
      secrets,
    );
    expect(await a.historyVisits.get(visitId)).toBeUndefined();
    expect((await a.operations.get(historyId))!.envelope.ciphertext).toBe('');
    expect(await b.outbox.get(pending)).toBeDefined();
    expect(await b.drafts.count()).toBe(3);
    expect(await a.records.get(acknowledgedLater)).toBeDefined();
  } finally {
    await h.cleanup();
  }
});

it('a lost relay creates a separate account and rejected old credentials leave surviving replica exports, queues and roots intact', async () => {
  const h = await harness();
  try {
    expect(() => h.cli('backup', '--output', join(h.directory, 'missing.sqlite'))).toThrow(
      'existing relay database',
    );
    expect(existsSync(h.database)).toBe(false);
    const db = await h.local('Disk-loss source');
    await h.start();
    await sync(db);
    const accepted = await db.queueDiagnostic('Acknowledged before server disk loss');
    await sync(db);
    await h.stop();
    const queued = await db.queueDiagnostic('Pending after server disk loss');
    const exported = await db.exportReplica(),
      keys = await db.keySecrets.get('keys');
    const account = (await db.state.get('local'))!.credentials.account_id;
    h.removeDatabase();
    await h.start();
    expect(h.sql('SELECT account_id FROM settings WHERE id=1;')).not.toBe(account);
    await expect(sync(db)).rejects.toThrow('Device credentials were rejected');
    expect(await db.exportReplica()).toEqual(exported);
    expect(await db.keySecrets.get('keys')).toEqual(keys);
    expect(await db.records.get(accepted)).toBeDefined();
    expect(await db.outbox.get(queued)).toBeDefined();
  } finally {
    await h.cleanup();
  }
});

it('rebuilds a lost relay from multiple surviving profiles without resurrecting history/sessions or old access; compaction preserves exact retry identities', async () => {
  const h = await harness();
  try {
    const a = await h.local('Rebuild A'),
      b = await h.local('Rebuild B'),
      revoked = await h.local('Removed profile');
    await h.start();
    for (const db of [a, b, revoked]) await sync(db);
    const initial = (await a.state.get('local'))!;
    const staleBackup = join(h.directory, 'older-backup.sqlite');
    h.cli('backup', '--output', staleBackup);
    const staleBytes = readFileSync(staleBackup);
    const manager = new KeyManager(a, new HttpTransport(initial).keys);
    await manager.stageRotation([(await revoked.state.get('local'))!.credentials.device_id]);
    await expect(exportRelayRecovery(a)).rejects.toThrow('saved key rotation');
    await manager.completeRotation();
    await sync(b);
    const current = (await a.state.get('local'))!;
    expect(current.key_epoch).toBe(2);
    const incarnation = crypto.randomUUID(),
      visited_at = Date.now() - 1000;
    const visitId = historyVisitId(
      current.credentials.device_id,
      incarnation,
      'rebuild',
      visited_at,
    );
    const historyId = await a.stageHistory({
      type: 'visit',
      visit: {
        id: visitId,
        source_id: current.credentials.device_id,
        source_name: 'Rebuild A',
        incarnation,
        native_id: 'rebuild',
        visited_at,
        url: 'https://rebuild.example/erase',
        title: 'Must stay erased',
        url_tag: await historyUrlTag(
          await a.ensureHistoryIndexKey(),
          'https://rebuild.example/erase',
        ),
        generation: {},
      },
    });
    const oldSession = await a.stageSession({
      kind: 'closed',
      captured_at: new Date(Date.now() - 100 * 86_400_000).toISOString(),
      windows: [sessionWindow()],
    });
    const liveSession = await a.stageSession({
      kind: 'current',
      captured_at: new Date().toISOString(),
      windows: [sessionWindow()],
    });
    await sync(a);
    const bookmark = crypto.randomUUID();
    await a.queueBookmark({
      type: 'create',
      node_id: bookmark,
      node_type: 'bookmark',
      title: 'Initial',
      url: 'https://rebuild.example/bookmark',
      placement: { parent: BOOKMARK_ROOTS.bar, position: '0/1' },
    });
    await sync(a);
    const oldEdit = await a.queueBookmark({
      type: 'edit',
      node_id: bookmark,
      title: 'Old version'.repeat(1000),
    });
    await sync(a);
    await a.queueBookmark({ type: 'edit', node_id: bookmark, title: 'Retained version' });
    await sync(a);
    const oldEditEnvelope = (await a.operations.get(oldEdit))!.envelope;
    expect(await compactBookmarks(a)).toBe(1);
    await sync(a);
    expect((await a.operations.get(oldEdit))!.redacted).toBeDefined();
    await new HttpTransport((await a.state.get('local'))!).push(
      [oldEditEnvelope],
      current.server_epoch!,
    );
    const originalPart = structuredClone(
      (await a.operations
        .where('envelope.domain')
        .equals('session')
        .filter(
          (r) =>
            r.payload.kind === 'session' &&
            r.payload.schema_version === 1 &&
            r.payload.snapshot_id === oldSession,
        )
        .first())!.envelope,
    );
    await a.stageHistory({ type: 'delete', visit_ids: [visitId] });
    await a.setSessionRetention({
      enabled: true,
      days: 30,
      max_archives: 100,
      max_bytes: 50 * 1024 * 1024,
    });
    await sync(a);
    await sync(b);
    expect((await a.operations.get(historyId))!.redacted).toBeDefined();
    expect((await a.operations.get(originalPart.operation_id))!.redacted).toBeDefined();
    expect((await a.operations.get(originalPart.operation_id))!.envelope.ciphertext).toBe('');
    const compactedBytes = Number(h.sql('SELECT journal_bytes FROM settings WHERE id=1;'));
    const retry = await new HttpTransport((await a.state.get('local'))!).push(
      [originalPart],
      current.server_epoch!,
    );
    expect(retry.acknowledgements[0]!.operation_id).toBe(originalPart.operation_id);
    expect(Number(h.sql('SELECT journal_bytes FROM settings WHERE id=1;'))).toBe(compactedBytes);
    const oldClient = await fetch(`${h.origin}/v1/sync/pull?cursor=0`, {
      headers: {
        Authorization: `Bearer ${current.credentials.token}`,
        'X-Synk-History-Erasure': '1',
      },
    });
    expect(oldClient.status).toBe(426);
    expect(() =>
      h.cli('compact', '--backup', join(h.directory, 'online-compact.sqlite')),
    ).toThrow();
    await h.stop();
    const acknowledged = await a.queueDiagnostic('Queued on authority after relay loss');
    const peerPending = await b.queueDiagnostic('Queued only on the other surviving profile');
    await b.stageHistory({ type: 'clear', scope: 'all' });
    const lateIncarnation = crypto.randomUUID(),
      lateTime = Date.now();
    const staleVisitId = historyVisitId(
      current.credentials.device_id,
      lateIncarnation,
      'late',
      lateTime,
    );
    const staleOperation = await a.stageHistory({
      type: 'visit',
      visit: {
        id: staleVisitId,
        source_id: current.credentials.device_id,
        source_name: 'Rebuild A',
        incarnation: lateIncarnation,
        native_id: 'late',
        visited_at: lateTime,
        url: 'https://rebuild.example/stale-offline',
        title: 'Suppressed by unseen clear',
        url_tag: await historyUrlTag(
          await a.ensureHistoryIndexKey(),
          'https://rebuild.example/stale-offline',
        ),
        generation: {},
      },
    });
    const peer = await exportRelayRecovery(b);
    const bundle = await exportRelayRecovery(a, [peer]);
    expect(await exportRelayRecovery(a)).toEqual(bundle);
    expect(JSON.stringify(bundle)).not.toContain(current.recovery_key);
    expect(bundle.entries.some((r) => r.envelope.operation_id === peerPending)).toBe(true);
    const afterExport = await a.queueDiagnostic('Captured after recovery-file transfer');
    const input = join(h.directory, 'rebuild.json');
    writeFileSync(input, JSON.stringify(bundle), { mode: 0o600 });
    const rebuilt = join(h.directory, 'rebuilt.sqlite');
    const binary = resolve('target/debug/synk-server');
    const build = (output: string, file = input, account = bundle.account_id) =>
      execFileSync(
        binary,
        ['--database', output, 'rebuild', '--input', file, '--expected-account', account],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );
    expect(() => build(staleBackup)).toThrow();
    expect(() => build(rebuilt, input, crypto.randomUUID())).toThrow();
    expect(existsSync(rebuilt)).toBe(false);
    const orphaned = join(h.directory, 'orphaned.sqlite');
    writeFileSync(orphaned + '-wal', 'preserved orphaned WAL');
    expect(() => build(orphaned)).toThrow();
    expect(readFileSync(orphaned + '-wal', 'utf8')).toBe('preserved orphaned WAL');
    expect(existsSync(orphaned)).toBe(false);
    const tampered = join(h.directory, 'tampered.json');
    writeFileSync(tampered, JSON.stringify({ ...bundle, manifest_digest: '0'.repeat(64) }));
    expect(() => build(rebuilt, tampered)).toThrow();
    expect(existsSync(rebuilt)).toBe(false);
    expect(build(rebuilt)).toContain('"active_installations":1');
    expect(statSync(rebuilt).mode & 0o777).toBe(0o600);
    expect(readFileSync(staleBackup)).toEqual(staleBytes);
    const saved = await a.exportReplica();
    await expect(
      adoptRelayRecovery(a, {
        account_id: bundle.account_id,
        server_epoch: crypto.randomUUID(),
        recovery_id: bundle.recovery_id,
        key_epoch: bundle.key_epoch,
        manifest_digest: bundle.manifest_digest,
        source_id: bundle.source.device_id,
      }),
    ).rejects.toThrow('does not match');
    expect(await a.exportReplica()).toEqual(saved);
    h.removeDatabase();
    copyFileSync(rebuilt, h.database);
    await h.start();
    await expect(sync(a)).rejects.toThrow(); // No implicit epoch reset.
    await adoptRelayRecovery(a);
    await sync(a);
    await adoptRelayRecovery(a); // Lost completion reply / repeated click.
    const recovered = (await a.state.get('local'))!;
    expect(recovered.key_epoch).toBe(3);
    expect(recovered.next_counter).toBeGreaterThanOrEqual(current.next_counter);
    expect((await a.sessionProjection()).snapshots[oldSession]).toBeUndefined();
    expect((await a.sessionProjection()).snapshots[liveSession]).toBeDefined();
    expect(await a.historyVisits.get(visitId)).toBeUndefined();
    expect(await a.records.get(acknowledged)).toBeDefined();
    expect(await a.records.get(peerPending)).toBeDefined();
    expect((await a.records.get(afterExport))!.envelope.key_epoch).toBe(3);
    expect(await a.historyVisits.get(staleVisitId)).toBeUndefined();
    expect((await a.operations.get(staleOperation))!.redacted).toBeDefined();
    expect(await a.pendingCount()).toBe(0);
    await expect(sync(b)).rejects.toThrow('Device credentials were rejected');
    await expect(sync(revoked)).rejects.toThrow('Device credentials were rejected');
    expect(h.sql('SELECT COUNT(*) FROM devices WHERE revoked=0;')).toBe('1');
    const credentialFile = join(h.directory, 'new-peer.json');
    h.cli(
      'issue-device',
      '--name',
      'Fresh recovery peer',
      '--server-url',
      h.origin,
      '--output',
      credentialFile,
    );
    const fresh = new SynkDatabase(`rebuilt-fresh-${crypto.randomUUID()}`);
    h.locals.push(fresh);
    await enrollRecovery(
      fresh,
      JSON.parse(readFileSync(credentialFile, 'utf8')),
      await exportRecovery(a),
    );
    await sync(fresh);
    expect(await fresh.historyVisits.get(visitId)).toBeUndefined();
    expect((await fresh.sessionProjection()).snapshots[oldSession]).toBeUndefined();
    expect((await fresh.sessionProjection()).snapshots[liveSession]).toBeDefined();
    expect(await fresh.records.get(peerPending)).toBeDefined();
    expect((await fresh.bookmarkProjection()).nodes[bookmark]!.title).toBe('Retained version');
    expect((await fresh.operations.get(oldEdit))!.envelope.ciphertext).toBe('');
    await h.stop();
    const rows = h.sql(
      'SELECT operation_id,envelope,purged FROM operations ORDER BY operation_id;',
    );
    h.cli('compact', '--backup', join(h.directory, 'pre-compact.sqlite'));
    expect(
      h.sql('SELECT operation_id,envelope,purged FROM operations ORDER BY operation_id;'),
    ).toBe(rows);
    expect(h.sql('PRAGMA integrity_check;')).toBe('ok');
    expect(readFileSync(staleBackup)).toEqual(staleBytes);
    await h.start();
    await sync(a);
    expect(await a.pendingCount()).toBe(0);
  } finally {
    await h.cleanup();
  }
});
