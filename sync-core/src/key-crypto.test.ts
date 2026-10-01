import { describe, expect, it } from 'vitest';
import { encryptDiagnostic, decryptDiagnostic, generateRecoveryKey, base64 } from './crypto';
import {
  generateWrappingIdentity,
  validateWrappingIdentity,
  proveIdentity,
  verifyIdentity,
  wrapContentKey,
  unwrapContentKey,
  parseKeyPacket,
  importWrappingPublicKey,
} from './key-crypto';
import { validateEnvelope } from './protocol';

async function fixture() {
  const old = generateRecoveryKey(),
    next = generateRecoveryKey(),
    identity = await generateWrappingIdentity();
  const context = {
    rotation_id: crypto.randomUUID(),
    account_id: crypto.randomUUID(),
    server_epoch: crypto.randomUUID(),
    issuer_id: crypto.randomUUID(),
    from_epoch: 1,
    key_epoch: 2,
  };
  const recipient = await proveIdentity(old, context.account_id, context.server_epoch, {
    device_id: crypto.randomUUID(),
    public_key: identity.public_key,
    proof_epoch: 1,
  });
  const packet = await wrapContentKey(old, next, context, recipient);
  const expected = { ...context, recipient_id: recipient.device_id };
  return { old, next, identity, recipient, context, packet, expected };
}
describe('installation-specific future content keys', () => {
  it('retained installation unwraps the fresh root; old shared key and another private key cannot', async () => {
    const f = await fixture();
    expect(await unwrapContentKey(f.old, f.identity, f.packet, f.expected)).toBe(f.next);
    const removed = await generateWrappingIdentity();
    // Even pretending to have the retained public key cannot compensate for a different private scalar.
    await expect(
      unwrapContentKey(
        f.old,
        { ...removed, public_key: f.identity.public_key },
        f.packet,
        f.expected,
      ),
    ).rejects.toThrow();
    const envelope = await encryptDiagnostic(
      f.next,
      {
        protocol_version: 1,
        operation_id: crypto.randomUUID(),
        account_id: f.context.account_id,
        device_id: f.context.issuer_id,
        counter: 1,
        domain: 'diagnostic',
        key_epoch: 2,
      },
      { kind: 'diagnostic', note: 'Future private content', created_at: new Date().toISOString() },
    );
    await expect(decryptDiagnostic(f.old, envelope)).rejects.toThrow();
    expect((await decryptDiagnostic(f.next, envelope)).note).toBe('Future private content');
    expect(JSON.stringify(f.packet)).not.toContain(f.next);
    expect(JSON.stringify(f.packet)).not.toContain(f.identity.private_key.d);
  });
  it('authenticates installation, account, relay epoch, public point and proof epoch', async () => {
    const f = await fixture();
    await verifyIdentity(f.old, f.context.account_id, f.context.server_epoch, f.recipient);
    for (const changed of [
      { ...f.recipient, device_id: crypto.randomUUID() },
      { ...f.recipient, public_key: (await generateWrappingIdentity()).public_key },
      { ...f.recipient, proof_epoch: 2 },
    ])
      await expect(
        verifyIdentity(f.old, f.context.account_id, f.context.server_epoch, changed),
      ).rejects.toThrow();
    await expect(
      verifyIdentity(f.old, crypto.randomUUID(), f.context.server_epoch, f.recipient),
    ).rejects.toThrow();
    await expect(
      verifyIdentity(f.old, f.context.account_id, crypto.randomUUID(), f.recipient),
    ).rejects.toThrow();
    await expect(
      verifyIdentity(
        generateRecoveryKey(),
        f.context.account_id,
        f.context.server_epoch,
        f.recipient,
      ),
    ).rejects.toThrow();
  });
  it('rejects tampered packet metadata, ciphertext, nonce, ephemeral point and proof', async () => {
    const f = await fixture();
    const alterations = {
      rotation_id: crypto.randomUUID(),
      account_id: crypto.randomUUID(),
      server_epoch: crypto.randomUUID(),
      issuer_id: crypto.randomUUID(),
      recipient_id: crypto.randomUUID(),
      recipient_public_key: (await generateWrappingIdentity()).public_key,
      ephemeral_public_key: (await generateWrappingIdentity()).public_key,
      nonce: base64(new Uint8Array(12)),
      ciphertext: base64(new Uint8Array(48)),
      proof: base64(new Uint8Array(32)),
      from_epoch: 2,
      key_epoch: 3,
    };
    for (const [field, value] of Object.entries(alterations))
      await expect(
        unwrapContentKey(f.old, f.identity, { ...f.packet, [field]: value }, f.expected),
      ).rejects.toThrow();
    await expect(
      unwrapContentKey(generateRecoveryKey(), f.identity, f.packet, f.expected),
    ).rejects.toThrow();
  });
  it('rejects relay-chosen public keys and roots without the account-key proof', async () => {
    const f = await fixture();
    const fake = { ...f.recipient, public_key: (await generateWrappingIdentity()).public_key };
    await expect(wrapContentKey(f.old, f.next, f.context, fake)).rejects.toThrow('authentication');
    const replacement = await wrapContentKey(
      generateRecoveryKey(),
      generateRecoveryKey(),
      f.context,
      f.recipient,
      f.old,
    );
    await expect(unwrapContentKey(f.old, f.identity, replacement, f.expected)).rejects.toThrow(
      'authentication',
    );
  });
  it('uses fresh independent installation and ephemeral keys/nonces; preserves old identity proofs across rotations', async () => {
    const f = await fixture();
    expect((await generateWrappingIdentity()).public_key).not.toBe(f.identity.public_key);
    const again = await wrapContentKey(f.old, f.next, f.context, f.recipient);
    expect(again.ephemeral_public_key).not.toBe(f.packet.ephemeral_public_key);
    expect(again.nonce).not.toBe(f.packet.nonce);
    expect(again.ciphertext).not.toBe(f.packet.ciphertext);
    const context = { ...f.context, rotation_id: crypto.randomUUID(), from_epoch: 2, key_epoch: 3 };
    const root3 = generateRecoveryKey();
    const packet3 = await wrapContentKey(f.next, root3, context, f.recipient, f.old);
    expect(
      await unwrapContentKey(f.next, f.identity, packet3, {
        ...context,
        recipient_id: f.recipient.device_id,
      }),
    ).toBe(root3);
  });
  it('rejects invalid/off-curve encodings and mismatched private/public scalars', async () => {
    const f = await fixture();
    await validateWrappingIdentity(f.identity);
    const other = await generateWrappingIdentity();
    await expect(
      validateWrappingIdentity({ ...f.identity, private_key: other.private_key }),
    ).rejects.toThrow();
    await expect(
      validateWrappingIdentity({
        ...f.identity,
        private_key: { ...f.identity.private_key, d: other.private_key.d },
      }),
    ).rejects.toThrow();
    await expect(
      importWrappingPublicKey(base64(Uint8Array.from([4, ...new Uint8Array(64)]))),
    ).rejects.toThrow();
    for (const value of ['', f.packet.nonce.slice(0, -1), f.packet.nonce + ' '])
      expect(() => parseKeyPacket({ ...f.packet, nonce: value })).toThrow();
    expect(parseKeyPacket({ ...f.packet, recovery_key: f.next })).toEqual(f.packet);
  });
  it('bounds epochs and requires one-step rotation while keeping protocol-1 AAD epoch-specific', async () => {
    const f = await fixture();
    for (const epoch of [0, 256, 1.5, NaN]) {
      expect(() => parseKeyPacket({ ...f.packet, key_epoch: epoch })).toThrow();
      expect(() =>
        validateEnvelope({
          protocol_version: 1,
          operation_id: crypto.randomUUID(),
          account_id: f.context.account_id,
          device_id: f.context.issuer_id,
          counter: 1,
          domain: 'diagnostic',
          key_epoch: epoch,
          nonce: '',
          ciphertext: '',
        }),
      ).toThrow();
    }
    expect(() => parseKeyPacket({ ...f.packet, key_epoch: 3 })).toThrow();
    const envelope = await encryptDiagnostic(
      f.old,
      {
        protocol_version: 1,
        operation_id: crypto.randomUUID(),
        account_id: f.context.account_id,
        device_id: f.context.issuer_id,
        counter: 1,
        domain: 'diagnostic',
        key_epoch: 1,
      },
      { kind: 'diagnostic', note: 'Epoch bound', created_at: new Date().toISOString() },
    );
    await expect(decryptDiagnostic(f.old, { ...envelope, key_epoch: 2 })).rejects.toThrow();
  });
});
