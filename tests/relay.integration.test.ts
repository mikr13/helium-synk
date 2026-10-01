import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import {
  generateRecoveryKey,
  SynkDatabase,
  SyncCoordinator,
  type Credentials,
} from '../sync-core/src/index';

const binary = resolve('target/debug/synk-server');
const directory = mkdtempSync(join(tmpdir(), 'helium-synk-integration-'));
const database = join(directory, 'relay.sqlite');
let process: ChildProcess | undefined;
let port: number;
let credentialsA: Credentials;
let credentialsB: Credentials;
let credentialsC: Credentials;
const sharedKey = generateRecoveryKey();
const localDatabases: SynkDatabase[] = [];
const sockets: WebSocket[] = [];

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
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
async function stop(): Promise<void> {
  const child = process;
  process = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}
beforeAll(async () => {
  port = await freePort();
  for (const name of ['A', 'B', 'C']) {
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
  await start();
});
afterAll(async () => {
  for (const socket of sockets) socket.close();
  await stop();
  for (const db of localDatabases) await db.delete();
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
