import { describe, expect, it } from 'vitest';
import { envelopeDigest, type Envelope } from './protocol';

describe('immutable envelope digest', () => {
  const envelope: Envelope = {
    protocol_version: 1,
    operation_id: '00000000-0000-0000-0000-000000000001',
    account_id: '00000000-0000-0000-0000-000000000002',
    device_id: '00000000-0000-0000-0000-000000000003',
    counter: 7,
    domain: 'history',
    key_epoch: 1,
    nonce: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  };
  it('matches the Rust/Python SHA-256 fixture independently of member order', async () => {
    expect(await envelopeDigest(envelope)).toBe(
      '4871be609e10a88680c288a39a7d7312c706c795e963e2dcb5a7480b57f9c428',
    );
    const reordered = Object.fromEntries(Object.entries(envelope).reverse()) as unknown as Envelope;
    expect(await envelopeDigest(reordered)).toBe(await envelopeDigest(envelope));
    expect(await envelopeDigest({ ...envelope, counter: 8 })).not.toBe(
      await envelopeDigest(envelope),
    );
    expect(
      await envelopeDigest({
        ...envelope,
        ciphertext: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=',
      }),
    ).not.toBe(await envelopeDigest(envelope));
  });
});
