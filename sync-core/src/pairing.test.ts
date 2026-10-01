import { afterEach, expect, it, vi } from 'vitest';
import { SynkDatabase } from './database';
import { generateRecoveryKey } from './crypto';
import {
  stagePairing,
  completePairing,
  createPairingBundle,
  parsePairingBundle,
  pairingSummary,
  discardPairing,
  type PairingBundle,
} from './pairing';
const databases: SynkDatabase[] = [];
function db() {
  const database = new SynkDatabase(`pairing-${crypto.randomUUID()}`);
  databases.push(database);
  return database;
}
function bundle(): PairingBundle {
  return {
    format: 'helium-synk-pairing',
    version: 1,
    account_id: crypto.randomUUID(),
    server_epoch: crypto.randomUUID(),
    server_url: 'http://127.0.0.1:4318',
    invitation_token: 'a'.repeat(64),
    expires_at: Math.floor(Date.now() / 1000) + 900,
    recovery_key: generateRecoveryKey(),
    history_index_key: generateRecoveryKey(),
  };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const database of databases) database.close();
  for (const database of new Map(databases.splice(0).map((d) => [d.name, d])).values())
    await database.delete();
});
function accepted() {
  return vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body));
    return new Response(
      JSON.stringify({
        account_id: body.account_id,
        server_epoch: body.expected_epoch,
        device_id: body.device_id,
        name: body.name,
      }),
    );
  });
}
it('keeps root/index keys entirely out of enrollment requests and ordinary status', async () => {
  const database = db(),
    invitation = bundle(),
    fetch = accepted();
  vi.stubGlobal('fetch', fetch);
  await stagePairing(database, invitation, ' My disposable profile ');
  const candidate = (await database.pairingPending.get('pairing'))!;
  const summary = JSON.stringify(pairingSummary(candidate));
  expect(summary).not.toContain(invitation.recovery_key);
  expect(summary).not.toContain(invitation.invitation_token);
  expect(summary).not.toContain(candidate.credentials.token);
  await completePairing(database);
  const request = JSON.stringify(fetch.mock.calls);
  expect(request).not.toContain(invitation.recovery_key);
  expect(request).not.toContain(invitation.history_index_key);
  expect(request).not.toContain('recovery_key');
  expect(request).not.toContain('history_index_key');
  const state = (await database.state.get('local'))!;
  expect(state.recovery_key).toBe(invitation.recovery_key);
  expect(state.history_index_key).toBe(invitation.history_index_key);
  expect(state.credentials).toEqual(candidate.credentials);
  expect(state.server_epoch).toBe(invitation.server_epoch);
  expect(await database.pairingPending.count()).toBe(0);
  const exported = JSON.stringify(await database.exportReplica());
  expect(exported).not.toContain(invitation.recovery_key);
  expect(exported).not.toContain(invitation.invitation_token);
  expect(exported).not.toContain(state.credentials.token);
});
it('persists the exact enrollment claim across a lost reply and worker/database reopen', async () => {
  let database = db();
  const invitation = bundle(),
    bodies: string[] = [];
  await stagePairing(database, invitation, 'Restart profile');
  let lost = true;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      bodies.push(options.body);
      if (lost) {
        lost = false;
        throw new Error('Reply lost after registration');
      }
      const body = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          account_id: body.account_id,
          device_id: body.device_id,
          name: body.name,
          server_epoch: body.expected_epoch,
        }),
      );
    }),
  );
  await expect(completePairing(database)).rejects.toThrow('Reply lost');
  expect(await database.state.get('local')).toBeUndefined();
  database.close();
  database = new SynkDatabase(database.name);
  databases.push(database);
  await completePairing(database);
  expect(bodies[1]).toBe(bodies[0]);
  expect((await database.state.get('local'))?.next_counter).toBe(1);
});
it('rolls back local enrollment on storage failure and retries the committed server claim', async () => {
  const database = db(),
    invitation = bundle(),
    fetch = accepted();
  vi.stubGlobal('fetch', fetch);
  await stagePairing(database, invitation, 'Storage failure profile');
  const enrolled = vi
    .spyOn(database.state, 'add')
    .mockRejectedValue(new Error('No local disk space'));
  await expect(completePairing(database)).rejects.toThrow('No local disk space');
  expect(await database.state.get('local')).toBeUndefined();
  expect(await database.pairingPending.count()).toBe(1);
  enrolled.mockRestore();
  await completePairing(database);
  expect(fetch.mock.calls[1]![1]!.body).toBe(fetch.mock.calls[0]![1]!.body);
});
it('retains claims on expired invites, quota, malformed responses and changed epochs', async () => {
  for (const status of [401, 409, 410, 507, 429, 404, 426]) {
    const database = db();
    await stagePairing(database, bundle(), 'Failure profile');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status })),
    );
    await expect(completePairing(database)).rejects.toThrow();
    expect(await database.state.get('local')).toBeUndefined();
    expect(await database.pairingPending.count()).toBe(1);
  }
  for (const field of ['account_id', 'device_id', 'server_epoch', 'name']) {
    const database = db();
    await stagePairing(database, bundle(), 'Bad reply profile');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        const body = JSON.parse(options.body);
        return new Response(
          JSON.stringify({
            account_id: body.account_id,
            device_id: body.device_id,
            server_epoch: body.expected_epoch,
            name: body.name,
            [field]: 'wrong',
          }),
        );
      }),
    );
    await expect(completePairing(database)).rejects.toThrow('Invalid pairing acknowledgement');
    expect(await database.pairingPending.count()).toBe(1);
  }
});
it('serializes competing pairing attempts and refuses enrollment over an existing profile', async () => {
  const database = db(),
    invitation = bundle();
  const results = await Promise.allSettled([
    stagePairing(database, invitation, 'A'),
    stagePairing(database, invitation, 'B'),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(await database.pairingPending.count()).toBe(1);
  const candidate = (await database.pairingPending.get('pairing'))!;
  await expect(database.enroll(candidate.credentials, invitation.recovery_key)).rejects.toThrow(
    'pending pairing',
  );
  vi.stubGlobal('fetch', accepted());
  await completePairing(database);
  await expect(stagePairing(database, bundle(), 'Another')).rejects.toThrow('already enrolled');
});
it('validates bundles/endpoints/keys and UTF-8 names before storing or contacting the relay', async () => {
  for (const invalid of [
    { version: 2 },
    { server_url: 'http://public.example' },
    { server_url: 'https://example.com?token=secret' },
    { recovery_key: 'invalid' },
    { history_index_key: 'invalid' },
    { invitation_token: 'short' },
    { server_epoch: 'bad' },
    { expires_at: NaN },
  ]) {
    expect(() => parsePairingBundle({ ...bundle(), ...invalid })).toThrow();
  }
  const database = db();
  await expect(stagePairing(database, bundle(), '漢'.repeat(34))).rejects.toThrow('UTF-8');
  expect(await database.pairingPending.count()).toBe(0);
});
it('constructs a local-key bundle from an authenticated invitation without transmitting keys', async () => {
  const database = db(),
    invitation = bundle();
  await database.enroll(
    {
      account_id: invitation.account_id,
      device_id: crypto.randomUUID(),
      token: 'c'.repeat(64),
      name: 'Trusted',
      server_url: invitation.server_url,
    },
    invitation.recovery_key,
    invitation.history_index_key,
  );
  await database.state.update('local', { server_epoch: invitation.server_epoch });
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          account_id: invitation.account_id,
          server_epoch: invitation.server_epoch,
          invitation_token: invitation.invitation_token,
          expires_at: invitation.expires_at,
        }),
      ),
  );
  vi.stubGlobal('fetch', fetch);
  const exported = await createPairingBundle(database);
  expect(exported).toEqual({
    ...invitation,
    version: 2,
    key_epoch: 1,
    roots: { 1: invitation.recovery_key },
  });
  expect(JSON.stringify(fetch.mock.calls)).not.toContain(invitation.recovery_key);
  expect(JSON.stringify(fetch.mock.calls)).not.toContain(invitation.history_index_key);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ...invitation, server_epoch: crypto.randomUUID() })),
    ),
  );
  await expect(createPairingBundle(database)).rejects.toThrow('epoch changed');
});

it('preserves inconsistent claims for review and discards only explicit unenrolled setup attempts', async () => {
  const database = db(),
    invitation = bundle(),
    fetch = accepted();
  vi.stubGlobal('fetch', fetch);
  await stagePairing(database, invitation, 'Recovery profile');
  const candidate = (await database.pairingPending.get('pairing'))!;
  await database.pairingPending.update('pairing', {
    credentials: { ...candidate.credentials, server_url: 'https://other.example' },
  });
  await expect(completePairing(database)).rejects.toThrow('inconsistent');
  expect(fetch).not.toHaveBeenCalled();
  expect(await database.pairingPending.count()).toBe(1);
  await discardPairing(database);
  expect(await database.pairingPending.count()).toBe(0);
  await stagePairing(database, invitation, 'Replacement profile');
  await completePairing(database);
  await expect(discardPairing(database)).rejects.toThrow('already enrolled');
});
it('two concurrent completions converge on the same locally enrolled identity', async () => {
  const database = db();
  await stagePairing(database, bundle(), 'One installation');
  vi.stubGlobal('fetch', accepted());
  await Promise.all([completePairing(database), completePairing(database)]);
  expect(await database.state.count()).toBe(1);
  expect(await database.pairingPending.count()).toBe(0);
});
