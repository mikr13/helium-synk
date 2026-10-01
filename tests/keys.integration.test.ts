import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import {
  generateRecoveryKey,
  generateWrappingIdentity,
  proveIdentity,
  wrapContentKey,
  unwrapContentKey,
  encryptDiagnostic,
  decryptDiagnostic,
  type Credentials,
  type KeyPacket,
  type Envelope,
} from '../sync-core/src/index';

it('real relay persists an identical lost-reply rotation, excludes a removed installation and proves offline rekey eligibility', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'helium-synk-keys-'));
  const database = join(directory, 'relay.sqlite'),
    binary = resolve('target/debug/synk-server');
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('No local test port');
  const port = address.port,
    origin = `http://127.0.0.1:${port}`;
  await new Promise<void>((resolve, reject) => probe.close((e) => (e ? reject(e) : resolve())));
  let process: ChildProcess | undefined;
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
    throw new Error('Relay did not become ready');
  }
  async function stop() {
    const child = process;
    process = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Relay did not drain'));
      }, 5000);
      child.once('exit', (code) => {
        clearTimeout(deadline);
        code === 0 ? resolve() : reject(new Error('Unclean relay exit'));
      });
      child.kill('SIGTERM');
    });
  }
  const credential = (name: string): Credentials => {
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
  };
  async function api(path: string, c: Credentials, body?: unknown) {
    return fetch(`${origin}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${c.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  try {
    const a = credential('Retained A'),
      b = credential('Offline B'),
      removed = credential('Removed');
    await start();
    const epoch = (await (await fetch(`${origin}/health/ready`)).json()).server_epoch as string;
    const old = generateRecoveryKey(),
      next = generateRecoveryKey();
    const aid = await generateWrappingIdentity(),
      bid = await generateWrappingIdentity(),
      rid = await generateWrappingIdentity();
    const publics = await Promise.all(
      [
        [a, aid],
        [b, bid],
        [removed, rid],
      ].map(async ([c, identity]) => {
        const credentials = c as Credentials,
          wrapping = identity as typeof aid;
        const publicIdentity = await proveIdentity(old, a.account_id, epoch, {
          device_id: credentials.device_id,
          public_key: wrapping.public_key,
          proof_epoch: 1,
        });
        const response = await api('/v1/keys/identity', credentials, {
          server_epoch: epoch,
          public_key: publicIdentity.public_key,
          proof_epoch: 1,
          proof: publicIdentity.proof,
        });
        expect(response.status).toBe(200);
        return publicIdentity;
      }),
    );
    const encrypt = (
      c: Credentials,
      counter: number,
      keyEpoch: number,
      root: string,
      note: string,
      operationId = crypto.randomUUID(),
    ) =>
      encryptDiagnostic(
        root,
        {
          protocol_version: 1,
          operation_id: operationId,
          account_id: c.account_id,
          device_id: c.device_id,
          counter,
          key_epoch: keyEpoch,
          domain: 'diagnostic',
        },
        { kind: 'diagnostic', note, created_at: new Date().toISOString() },
      );
    const committed = await encrypt(b, 1, 1, old, 'Accepted before rotation');
    const offline = await encrypt(b, 2, 1, old, 'Captured offline; accepted only after rotation');
    expect(
      (await api('/v1/sync/push', b, { expected_epoch: epoch, envelopes: [committed] })).status,
    ).toBe(200);
    const context = {
      rotation_id: crypto.randomUUID(),
      account_id: a.account_id,
      server_epoch: epoch,
      issuer_id: a.device_id,
      from_epoch: 1,
      key_epoch: 2,
    };
    const packets = await Promise.all(
      publics.slice(0, 2).map((identity) => wrapContentKey(old, next, context, identity)),
    );
    const proposal = {
      rotation_id: context.rotation_id,
      server_epoch: epoch,
      from_epoch: 1,
      key_epoch: 2,
      revoke_ids: [removed.device_id],
      packets,
    };
    const encodedProposal = JSON.stringify(proposal);
    // Intentionally discard the committed HTTP reply, then restart the actual relay.
    await expect(
      (async () => {
        const response = await api('/v1/keys/rotate', a, proposal);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
        throw new Error('Lost rotation reply after commit');
      })(),
    ).rejects.toThrow('Lost rotation reply');
    await stop();
    await start();
    const retry = await api('/v1/keys/rotate', a, JSON.parse(encodedProposal));
    expect(retry.status).toBe(200);
    expect((await retry.json()).key_epoch).toBe(2);
    expect((await api('/v1/keys/state', removed)).status).toBe(401);
    expect(
      (
        await api('/v1/sync/push', removed, {
          expected_epoch: epoch,
          envelopes: [await encrypt(removed, 1, 2, old, 'Rejected removed writer')],
        })
      ).status,
    ).toBe(401);
    const state = await (await api('/v1/keys/state?after_epoch=1', b)).json();
    expect(state.key_epoch).toBe(2);
    expect(state.packets).toHaveLength(1);
    const packet = state.packets[0] as KeyPacket;
    expect(packet.recipient_id).toBe(b.device_id);
    const bRoot = await unwrapContentKey(old, bid, packet, {
      ...context,
      recipient_id: b.device_id,
    });
    expect(bRoot).toBe(next);
    await expect(
      unwrapContentKey(old, rid, packet, { ...context, recipient_id: b.device_id }),
    ).rejects.toThrow();
    const proof = await (
      await api('/v1/sync/rekey-check', b, {
        server_epoch: epoch,
        key_epoch: 2,
        envelopes: [committed, offline],
      })
    ).json();
    expect(proof.committed).toEqual([{ operation_id: committed.operation_id, sequence: 1 }]);
    expect(proof.missing).toEqual([offline.operation_id]);
    expect(
      (await api('/v1/sync/push', b, { expected_epoch: epoch, envelopes: [offline] })).status,
    ).toBe(412);
    const replacement = await encrypt(
      b,
      2,
      2,
      bRoot,
      'Captured offline; accepted only after rotation',
      offline.operation_id,
    );
    expect(
      (await api('/v1/sync/push', b, { expected_epoch: epoch, envelopes: [replacement] })).status,
    ).toBe(200);
    expect(
      (await api('/v1/sync/push', b, { expected_epoch: epoch, envelopes: [replacement] })).status,
    ).toBe(200);
    const page = await (await api('/v1/sync/pull?cursor=0', a)).json();
    expect(page.records).toHaveLength(2);
    expect((await decryptDiagnostic(old, page.records[0].envelope)).note).toBe(
      'Accepted before rotation',
    );
    const future = page.records[1].envelope as Envelope;
    expect(future.operation_id).toBe(offline.operation_id);
    expect(future.counter).toBe(2);
    expect(future.key_epoch).toBe(2);
    expect((await decryptDiagnostic(next, future)).note).toContain('Captured offline');
    await expect(decryptDiagnostic(old, future)).rejects.toThrow();
    expect(
      (
        await api('/v1/sync/rekey-check', b, {
          server_epoch: epoch,
          key_epoch: 2,
          envelopes: [offline],
        })
      ).status,
    ).toBe(409);
    const stored = execFileSync(
      'sqlite3',
      [
        database,
        'SELECT packet FROM key_packets; SELECT wrapping_public_key,wrapping_proof,token_hash FROM devices; SELECT envelope FROM operations;',
      ],
      { encoding: 'utf8' },
    );
    for (const secret of [
      old,
      next,
      aid.private_key.d!,
      bid.private_key.d!,
      rid.private_key.d!,
      a.token,
      b.token,
      removed.token,
      'Accepted before rotation',
      'Captured offline; accepted only after rotation',
    ])
      expect(stored).not.toContain(secret);
  } finally {
    await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
