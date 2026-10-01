import { SynkDatabase, type LocalState } from './database';
import { generateRecoveryKey, encryptPayload } from './crypto';
import {
  generateWrappingIdentity,
  validateWrappingIdentity,
  proveIdentity,
  verifyIdentity,
  parseKeyPacket,
  unwrapContentKey,
  wrapContentKey,
  type PublicIdentity,
} from './key-crypto';
import {
  checkKeyServer,
  parseKeyRing,
  type KeySecrets,
  type KeyState,
  type KeyDevice,
  type KeyTransport,
  type RotationPending,
} from './key-state';
import { envelopeBatch, isUuid, validKeyEpoch, sameEnvelope, type Envelope } from './protocol';

export async function keySnapshot(
  db: SynkDatabase,
): Promise<{ local: LocalState; secrets: KeySecrets }> {
  return db.transaction('r', [db.state, db.keySecrets], async () => {
    const local = await db.state.get('local');
    if (!local) throw new Error('Connect this device first.');
    const secrets = (await db.keySecrets.get('keys')) ?? {
      id: 'keys' as const,
      account_id: local.credentials.account_id,
      device_id: local.credentials.device_id,
      server_epoch: local.server_epoch,
      roots: { 1: local.recovery_key },
    };
    const ring = parseKeyRing({ key_epoch: local.key_epoch ?? 1, roots: secrets.roots });
    if (
      secrets.account_id !== local.credentials.account_id ||
      secrets.device_id !== local.credentials.device_id ||
      ring.roots[ring.key_epoch] !== local.recovery_key ||
      (secrets.server_epoch && secrets.server_epoch !== local.server_epoch)
    )
      throw new Error('Local key state is inconsistent. Preserve it for recovery.');
    return { local, secrets };
  });
}
export async function contentKey(db: SynkDatabase, epoch: number): Promise<string> {
  const { secrets } = await keySnapshot(db);
  const key = secrets.roots[epoch];
  if (!key)
    throw new Error(
      'This content-key epoch is unavailable. Refresh keys or use a current private recovery bundle.',
    );
  return key;
}
function validateState(local: LocalState, value: KeyState): KeyState {
  checkKeyServer(local, value);
  if (
    !validKeyEpoch(value.key_epoch) ||
    value.key_epoch < (local.key_epoch ?? 1) ||
    !Array.isArray(value.devices) ||
    value.devices.length < 1 ||
    value.devices.length > 256 ||
    !Array.isArray(value.packets) ||
    value.packets.length > 32 ||
    typeof value.has_more !== 'boolean'
  )
    throw new Error('Invalid or older relay key state. Local keys were retained.');
  if (
    !Number.isSafeInteger(value.author_counter) ||
    value.author_counter < 0 ||
    (value.author_counter === 0
      ? value.author_operation_id !== null
      : !isUuid(value.author_operation_id))
  )
    throw new Error('Invalid installation counter frontier.');
  if (value.author_counter >= local.next_counter)
    throw new Error(
      'This installation counter is behind the relay. Preserve local data and enroll a fresh installation for recovery.',
    );
  const ids = new Set<string>();
  for (const d of value.devices) {
    if (
      !d ||
      !isUuid(d.device_id) ||
      ids.has(d.device_id) ||
      typeof d.name !== 'string' ||
      !d.name.trim() ||
      new TextEncoder().encode(d.name).length > 100 ||
      typeof d.revoked !== 'boolean'
    )
      throw new Error('Invalid installation registry.');
    ids.add(d.device_id);
    const empty = d.public_key === null && d.proof === null && d.proof_epoch === null;
    if (
      !empty &&
      (typeof d.public_key !== 'string' ||
        typeof d.proof !== 'string' ||
        !validKeyEpoch(d.proof_epoch) ||
        d.proof_epoch > value.key_epoch)
    )
      throw new Error('Invalid installation public identity.');
  }
  if (!value.devices.some((d) => d.device_id === local.credentials.device_id && !d.revoked))
    throw new Error('This installation is absent or revoked.');
  return value;
}
function publicIdentity(d: KeyDevice): PublicIdentity {
  if (!d.public_key || !d.proof || !d.proof_epoch)
    throw new Error(
      `Installation “${d.name}” needs to sync with an upgraded client or be explicitly removed before rotation.`,
    );
  return {
    device_id: d.device_id,
    public_key: d.public_key,
    proof: d.proof,
    proof_epoch: d.proof_epoch,
  };
}
export class KeyManager {
  constructor(
    private db: SynkDatabase,
    private api: KeyTransport,
  ) {}
  private async ensureIdentity(state: KeyState): Promise<KeySecrets> {
    let { local, secrets } = await keySnapshot(this.db);
    const own = state.devices.find((d) => d.device_id === local.credentials.device_id)!;
    if (!secrets.identity) {
      if (state.author_counter > 0) {
        const known =
          (await this.db.records.get(state.author_operation_id!)) ??
          (await this.db.operations.get(state.author_operation_id!));
        if (!known || known.envelope.counter !== state.author_counter)
          throw new Error(
            'This credential belongs to an earlier installation. Use a fresh credential for recovery.',
          );
      }
      if (own.public_key)
        throw new Error(
          'This installation lost its private wrapping key. Preserve local data and enroll a fresh installation.',
        );
      if (state.key_epoch !== (local.key_epoch ?? 1))
        throw new Error(
          'This installation has no packet for the current keys. Join using a current pairing bundle.',
        );
      const identity = await generateWrappingIdentity();
      const public_identity = await proveIdentity(
        local.recovery_key,
        local.credentials.account_id,
        state.server_epoch,
        {
          device_id: local.credentials.device_id,
          public_key: identity.public_key,
          proof_epoch: local.key_epoch ?? 1,
        },
      );
      await this.db.transaction('rw', [this.db.state, this.db.keySecrets], async () => {
        const latest = await keySnapshot(this.db);
        if (latest.secrets.identity) return;
        if ((latest.local.key_epoch ?? 1) !== (local.key_epoch ?? 1))
          throw new Error('Keys changed while creating a wrapping identity. Retry.');
        checkKeyServer(latest.local, state);
        await this.db.keySecrets.put({
          ...latest.secrets,
          server_epoch: state.server_epoch,
          identity,
          public_identity,
        });
        await this.db.state.update('local', { server_epoch: state.server_epoch });
      });
      ({ local, secrets } = await keySnapshot(this.db));
    }
    if (
      !secrets.public_identity ||
      secrets.identity!.public_key !== secrets.public_identity.public_key ||
      secrets.public_identity.device_id !== local.credentials.device_id
    )
      throw new Error('Saved installation identity is inconsistent.');
    await validateWrappingIdentity(secrets.identity!);
    const proofRoot = secrets.roots[secrets.public_identity.proof_epoch];
    if (!proofRoot) throw new Error('Installation proof key is missing.');
    await verifyIdentity(
      proofRoot,
      local.credentials.account_id,
      state.server_epoch,
      secrets.public_identity,
    );
    if (
      own.public_key &&
      (own.public_key !== secrets.public_identity.public_key ||
        own.proof !== secrets.public_identity.proof ||
        own.proof_epoch !== secrets.public_identity.proof_epoch)
    )
      throw new Error('Relay installation identity changed. Preserve local keys for recovery.');
    // Private identity/proof were durably saved before this first/retried request.
    const reply = await this.api.identity(secrets.public_identity, state.server_epoch);
    if (
      !reply ||
      reply.server_epoch !== state.server_epoch ||
      ['device_id', 'public_key', 'proof_epoch', 'proof'].some(
        (field) =>
          reply[field as keyof PublicIdentity] !==
          secrets.public_identity![field as keyof PublicIdentity],
      )
    )
      throw new Error('Invalid wrapping-identity acknowledgement. Saved keys were retained.');
    return secrets;
  }
  async refresh(): Promise<KeyState> {
    let { local } = await keySnapshot(this.db);
    let remote = validateState(local, await this.api.state(local.key_epoch ?? 1));
    let secrets = await this.ensureIdentity(remote);
    for (let page = 0; page < 8; page++) {
      const start = await keySnapshot(this.db);
      const roots = { ...start.secrets.roots };
      let epoch = start.local.key_epoch ?? 1;
      const receipts: Record<number, string> = {};
      for (const raw of remote.packets) {
        const packet = parseKeyPacket(raw);
        if (packet.key_epoch <= epoch) {
          // Concurrent managers may have adopted this same page already. Verify,
          // rather than trusting a repeated packet or overwriting the chosen root.
          const recovered = await unwrapContentKey(
            roots[packet.from_epoch]!,
            secrets.identity!,
            packet,
            {
              ...packet,
              account_id: start.local.credentials.account_id,
              server_epoch: remote.server_epoch,
              recipient_id: start.local.credentials.device_id,
            },
          );
          if (roots[packet.key_epoch] !== recovered)
            throw new Error('Content-key history forked. Preserve local keys.');
          continue;
        }
        if (packet.from_epoch !== epoch || packet.key_epoch > remote.key_epoch || !roots[epoch])
          throw new Error('Relay skipped a content-key epoch. Local keys were retained.');
        roots[packet.key_epoch] = await unwrapContentKey(roots[epoch]!, secrets.identity!, packet, {
          ...packet,
          account_id: start.local.credentials.account_id,
          server_epoch: remote.server_epoch,
          recipient_id: start.local.credentials.device_id,
        });
        receipts[packet.key_epoch] = packet.rotation_id;
        epoch = packet.key_epoch;
      }
      if (
        remote.has_more
          ? remote.packets.length !== 32 || epoch >= remote.key_epoch
          : epoch !== remote.key_epoch
      )
        throw new Error('Relay key packet page is incomplete. Keep local keys and retry.');
      await this.db.transaction(
        'rw',
        [this.db.state, this.db.keySecrets, this.db.rotationPending],
        async () => {
          const latest = await keySnapshot(this.db);
          checkKeyServer(latest.local, remote);
          for (const [number, root] of Object.entries(latest.secrets.roots))
            if (roots[Number(number)] && roots[Number(number)] !== root)
              throw new Error('Concurrent key history forked.');
          if ((latest.local.key_epoch ?? 1) <= epoch) {
            await this.db.keySecrets.put({
              ...latest.secrets,
              roots,
              server_epoch: remote.server_epoch,
            });
            await this.db.state.update('local', {
              key_epoch: epoch,
              recovery_key: roots[epoch]!,
              server_epoch: remote.server_epoch,
            });
          }
          const pending = await this.db.rotationPending.get('rotation');
          if (
            pending &&
            receipts[pending.request.key_epoch] === pending.request.rotation_id &&
            roots[pending.request.key_epoch] === pending.new_root
          )
            await this.db.rotationPending.delete('rotation');
        },
      );
      ({ local, secrets } = await keySnapshot(this.db));
      if (!remote.has_more) {
        // Validate active identities after adopting their proof epochs, including peers that joined later.
        for (const device of remote.devices)
          if (!device.revoked && device.public_key) {
            const identity = publicIdentity(device),
              root = secrets.roots[identity.proof_epoch];
            if (!root) throw new Error('Installation identity uses an unavailable proof epoch.');
            await verifyIdentity(root, local.credentials.account_id, remote.server_epoch, identity);
          }
        const own = remote.devices.find((d) => d.device_id === local.credentials.device_id)!;
        Object.assign(own, secrets.public_identity);
        return remote;
      }
      remote = validateState(local, await this.api.state(local.key_epoch ?? 1));
    }
    throw new Error('More content-key pages remain. Retry to continue.');
  }
  async stageRotation(revokeIds: string[], replace = false): Promise<void> {
    if (
      !Array.isArray(revokeIds) ||
      revokeIds.length > 256 ||
      revokeIds.some((id) => !isUuid(id)) ||
      new Set(revokeIds).size !== revokeIds.length
    )
      throw new Error('Invalid installation removal selection.');
    const remote = await this.refresh(),
      { local, secrets } = await keySnapshot(this.db);
    if ((local.key_epoch ?? 1) !== remote.key_epoch || remote.key_epoch >= 255)
      throw new Error(
        'Content-key epoch changed or exhausted. Refresh or recover before rotation.',
      );
    if (
      revokeIds.includes(local.credentials.device_id) ||
      revokeIds.some((id) => !remote.devices.some((d) => d.device_id === id))
    )
      throw new Error('Select other known installations for removal.');
    const prior = await this.db.rotationPending.get('rotation');
    if (prior && !replace)
      throw new Error('A saved rotation already exists. Retry or explicitly refresh its proposal.');
    const root = generateRecoveryKey(),
      rotation_id = crypto.randomUUID();
    const context = {
      rotation_id,
      account_id: local.credentials.account_id,
      server_epoch: remote.server_epoch,
      issuer_id: local.credentials.device_id,
      from_epoch: remote.key_epoch,
      key_epoch: remote.key_epoch + 1,
    };
    const packets = [];
    for (const device of remote.devices
      .filter((d) => !d.revoked && !revokeIds.includes(d.device_id))
      .sort((a, b) => a.device_id.localeCompare(b.device_id))) {
      const identity = publicIdentity(device),
        proofRoot = secrets.roots[identity.proof_epoch];
      if (!proofRoot) throw new Error('A retained installation proof key is missing.');
      packets.push(await wrapContentKey(local.recovery_key, root, context, identity, proofRoot));
    }
    const pending: RotationPending = {
      id: 'rotation',
      new_root: root,
      request: {
        rotation_id,
        server_epoch: remote.server_epoch,
        from_epoch: remote.key_epoch,
        key_epoch: remote.key_epoch + 1,
        revoke_ids: [...revokeIds].sort(),
        packets,
      },
    };
    await this.db.transaction('rw', [this.db.state, this.db.rotationPending], async () => {
      const latest = (await this.db.state.get('local'))!;
      if (
        (latest.key_epoch ?? 1) !== remote.key_epoch ||
        latest.server_epoch !== remote.server_epoch ||
        JSON.stringify(await this.db.rotationPending.get('rotation')) !== JSON.stringify(prior)
      )
        throw new Error('Local keys or the saved proposal changed. Refresh before retrying.');
      await this.db.rotationPending.put(pending);
    });
  }
  async completeRotation(): Promise<void> {
    const pending = await this.db.rotationPending.get('rotation');
    if (!pending) return;
    const { local } = await keySnapshot(this.db);
    if (pending.request.server_epoch !== local.server_epoch)
      throw new Error('Saved rotation server epoch changed. Preserve it for recovery.');
    const reply = await this.api.rotate(pending.request);
    if (
      !reply ||
      reply.server_epoch !== pending.request.server_epoch ||
      reply.rotation_id !== pending.request.rotation_id ||
      reply.key_epoch !== pending.request.key_epoch
    )
      throw new Error('Invalid rotation acknowledgement. The saved proposal was retained.');
    await this.refresh();
    await this.db.transaction(
      'rw',
      [this.db.state, this.db.keySecrets, this.db.rotationPending],
      async () => {
        const snapshot = await keySnapshot(this.db),
          current = await this.db.rotationPending.get('rotation');
        if (snapshot.secrets.roots[pending.request.key_epoch] !== pending.new_root)
          throw new Error('Committed rotation root disagrees with the saved proposal.');
        if (current && JSON.stringify(current) === JSON.stringify(pending))
          await this.db.rotationPending.delete('rotation');
      },
    );
  }
  async resumePending(): Promise<void> {
    const pending = await this.db.rotationPending.get('rotation'),
      local = await this.db.state.get('local');
    if (pending && pending.request.from_epoch === (local?.key_epoch ?? 1))
      await this.completeRotation();
  }
  async rekeyOutbox(): Promise<void> {
    const { local } = await keySnapshot(this.db),
      epoch = local.key_epoch ?? 1;
    const batch = envelopeBatch(
      (await this.db.outbox.orderBy('counter').limit(100).toArray()).filter(
        (e) => e.key_epoch < epoch,
      ),
    );
    if (!batch.length) return;
    const reply = await this.api.rekeyCheck(batch, local.server_epoch!, epoch);
    if (
      !reply ||
      reply.server_epoch !== local.server_epoch ||
      reply.key_epoch !== epoch ||
      !Array.isArray(reply.committed) ||
      !Array.isArray(reply.missing)
    )
      throw new Error('Invalid offline rekey proof. Pending ciphertext was retained.');
    const ids = new Set(batch.map((e) => e.operation_id));
    for (const ack of reply.committed)
      if (
        !ack ||
        !ids.delete(ack.operation_id) ||
        !Number.isSafeInteger(ack.sequence) ||
        ack.sequence < 1
      )
        throw new Error('Invalid committed rekey acknowledgement.');
    for (const id of reply.missing)
      if (!ids.delete(id)) throw new Error('Invalid missing-record rekey proof.');
    if (ids.size)
      throw new Error('Incomplete offline rekey proof. Pending ciphertext was retained.');
    const replacements = new Map<string, Envelope>();
    for (const id of reply.missing) {
      const old = batch.find((e) => e.operation_id === id)!;
      const record = (await this.db.records.get(id)) ?? (await this.db.operations.get(id));
      if (!record || !sameEnvelope(record.envelope, old) || record.sequence !== undefined)
        throw new Error(
          'Queued rekey record is missing, changed or already committed. Preserve it for recovery.',
        );
      replacements.set(
        id,
        await encryptPayload(
          local.recovery_key,
          { ...old, key_epoch: epoch },
          record.payload,
          local.history_index_key,
        ),
      );
    }
    await this.db.transaction(
      'rw',
      [this.db.state, this.db.outbox, this.db.records, this.db.operations],
      async () => {
        const latest = (await this.db.state.get('local'))!;
        if ((latest.key_epoch ?? 1) !== epoch || latest.server_epoch !== local.server_epoch)
          throw new Error('Keys changed during offline rekey. Pending ciphertext was retained.');
        for (const old of batch) {
          const queued = await this.db.outbox.get(old.operation_id);
          if (!queued) continue; // An exact committed push already acknowledged it.
          if (!sameEnvelope(queued, old)) throw new Error('Queued envelope changed during rekey.');
          const replacement = replacements.get(old.operation_id);
          if (replacement) {
            const record =
              (await this.db.records.get(old.operation_id)) ??
              (await this.db.operations.get(old.operation_id));
            if (!record || !sameEnvelope(record.envelope, old) || record.sequence !== undefined)
              throw new Error('Record changed during rekey.');
            await this.db.records.update(old.operation_id, { envelope: replacement });
            await this.db.operations.update(old.operation_id, { envelope: replacement });
            await this.db.outbox.put(replacement);
          } else {
            const ack = reply.committed.find((a) => a.operation_id === old.operation_id)!;
            await this.db.records.update(old.operation_id, { sequence: ack.sequence });
            await this.db.operations.update(old.operation_id, { sequence: ack.sequence });
            await this.db.outbox.delete(old.operation_id);
          }
        }
      },
    );
  }
}
