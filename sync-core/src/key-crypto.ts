import { base64, unbase64, validateRecoveryKey } from './crypto';
import { isUuid, validKeyEpoch } from './protocol';

/** Independent installation secret. Never derive this from an account content key. */
export interface WrappingIdentity {
  public_key: string;
  private_key: JsonWebKey;
}
export interface PublicIdentity {
  device_id: string;
  public_key: string;
  proof_epoch: number;
  proof: string;
}
export interface KeyPacket {
  version: 1;
  rotation_id: string;
  account_id: string;
  server_epoch: string;
  issuer_id: string;
  from_epoch: number;
  key_epoch: number;
  recipient_id: string;
  recipient_public_key: string;
  ephemeral_public_key: string;
  nonce: string;
  ciphertext: string;
  proof: string;
}
export type PacketContext = Pick<
  KeyPacket,
  'rotation_id' | 'account_id' | 'server_epoch' | 'issuer_id' | 'from_epoch' | 'key_epoch'
>;
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
function bytes(value: unknown, size: number): Uint8Array<ArrayBuffer> {
  if (typeof value !== 'string') throw new Error('Invalid wrapped-key encoding.');
  try {
    const decoded = unbase64(value);
    if (decoded.length === size && base64(decoded) === value) return decoded;
  } catch {
    /* Report no secret values. */
  }
  throw new Error('Invalid wrapped-key encoding.');
}
export async function importWrappingPublicKey(value: string): Promise<CryptoKey> {
  const raw = bytes(value, 65);
  if (raw[0] !== 4) throw new Error('Expected an uncompressed P-256 public key.');
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}
export async function generateWrappingIdentity(): Promise<WrappingIdentity> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);
  return {
    public_key: base64(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
    private_key: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
}
export async function validateWrappingIdentity(identity: WrappingIdentity): Promise<void> {
  await importWrappingPublicKey(identity.public_key);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    identity.private_key,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
  if (
    base64(new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))) !== identity.public_key
  )
    throw new Error('Installation wrapping keys do not match. Preserve them for recovery.');
  // Some JWK importers retain supplied x/y even when d does not match them.
  // Verify actual ECDH agreement as well as the public-key serialization.
  const probe = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveBits',
  ]);
  const left = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: probe.publicKey }, privateKey, 256),
  );
  const right = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, probe.privateKey, 256),
  );
  let different = 0;
  for (let i = 0; i < left.length; i++) different |= left[i]! ^ right[i]!;
  if (different)
    throw new Error('Installation wrapping keys do not match. Preserve them for recovery.');
}
async function proofKey(root: string, account: string, purpose: string): Promise<CryptoKey> {
  validateRecoveryKey(root);
  const material = await crypto.subtle.importKey('raw', unbase64(root), 'HKDF', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encode(account),
      info: encode(['helium-synk:v1', purpose]),
    },
    material,
    { name: 'HMAC', hash: 'SHA-256', length: 256 },
    false,
    ['sign', 'verify'],
  );
}
function identityData(account: string, server: string, identity: Omit<PublicIdentity, 'proof'>) {
  if (
    !isUuid(account) ||
    !isUuid(server) ||
    !isUuid(identity.device_id) ||
    !validKeyEpoch(identity.proof_epoch)
  )
    throw new Error('Invalid installation key context.');
  return encode([
    1,
    account,
    server,
    identity.device_id,
    identity.public_key,
    identity.proof_epoch,
  ]);
}
export async function proveIdentity(
  root: string,
  account: string,
  server: string,
  identity: Omit<PublicIdentity, 'proof'>,
): Promise<PublicIdentity> {
  await importWrappingPublicKey(identity.public_key);
  const proof = base64(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        await proofKey(root, account, 'installation-key-proof'),
        identityData(account, server, identity),
      ),
    ),
  );
  return { ...identity, proof };
}
export async function verifyIdentity(
  root: string,
  account: string,
  server: string,
  identity: PublicIdentity,
): Promise<void> {
  await importWrappingPublicKey(identity.public_key);
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      await proofKey(root, account, 'installation-key-proof'),
      bytes(identity.proof, 32),
      identityData(account, server, identity),
    ))
  )
    throw new Error('Installation public key failed authentication.');
}
function packetHeader(packet: KeyPacket) {
  return [
    packet.version,
    packet.rotation_id,
    packet.account_id,
    packet.server_epoch,
    packet.issuer_id,
    packet.from_epoch,
    packet.key_epoch,
    packet.recipient_id,
    packet.recipient_public_key,
    packet.ephemeral_public_key,
  ];
}
function packetProofData(packet: KeyPacket) {
  return encode([...packetHeader(packet), packet.nonce, packet.ciphertext]);
}
export function parseKeyPacket(value: unknown): KeyPacket {
  const p = value as KeyPacket;
  if (
    !p ||
    p.version !== 1 ||
    ![p.rotation_id, p.account_id, p.server_epoch, p.issuer_id, p.recipient_id].every(isUuid) ||
    !validKeyEpoch(p.from_epoch) ||
    !validKeyEpoch(p.key_epoch) ||
    p.key_epoch !== p.from_epoch + 1
  )
    throw new Error('Invalid content-key packet context.');
  for (const pub of [p.recipient_public_key, p.ephemeral_public_key]) {
    if (bytes(pub, 65)[0] !== 4) throw new Error('Invalid wrapping public key.');
  }
  bytes(p.nonce, 12);
  bytes(p.ciphertext, 48);
  bytes(p.proof, 32);
  // Do not retain unknown fields (particularly accidental plaintext keys).
  return {
    version: 1,
    rotation_id: p.rotation_id,
    account_id: p.account_id,
    server_epoch: p.server_epoch,
    issuer_id: p.issuer_id,
    from_epoch: p.from_epoch,
    key_epoch: p.key_epoch,
    recipient_id: p.recipient_id,
    recipient_public_key: p.recipient_public_key,
    ephemeral_public_key: p.ephemeral_public_key,
    nonce: p.nonce,
    ciphertext: p.ciphertext,
    proof: p.proof,
  };
}
async function wrapKey(
  privateJwk: JsonWebKey,
  publicKey: string,
  packet: KeyPacket,
): Promise<CryptoKey> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const shared = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: await importWrappingPublicKey(publicKey) },
    privateKey,
    256,
  );
  const material = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encode([packet.account_id, packet.server_epoch]),
      info: encode(['helium-synk:v1:root-wrap', ...packetHeader(packet)]),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}
export async function wrapContentKey(
  oldRoot: string,
  newRoot: string,
  context: PacketContext,
  recipient: PublicIdentity,
  identityRoot: string = oldRoot,
): Promise<KeyPacket> {
  validateRecoveryKey(newRoot);
  if (recipient.proof_epoch > context.from_epoch)
    throw new Error('Installation identity proof is ahead of the rotation.');
  await verifyIdentity(identityRoot, context.account_id, context.server_epoch, recipient);
  const ephemeral = await generateWrappingIdentity();
  const packet: KeyPacket = {
    ...context,
    version: 1,
    recipient_id: recipient.device_id,
    recipient_public_key: recipient.public_key,
    ephemeral_public_key: ephemeral.public_key,
    nonce: base64(crypto.getRandomValues(new Uint8Array(12))),
    ciphertext: base64(new Uint8Array(48)),
    proof: base64(new Uint8Array(32)),
  };
  parseKeyPacket(packet);
  packet.ciphertext = base64(
    new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: unbase64(packet.nonce),
          additionalData: encode(packetHeader(packet)),
          tagLength: 128,
        },
        await wrapKey(ephemeral.private_key, recipient.public_key, packet),
        unbase64(newRoot),
      ),
    ),
  );
  packet.proof = base64(
    new Uint8Array(
      await crypto.subtle.sign(
        'HMAC',
        await proofKey(oldRoot, packet.account_id, 'content-rotation-proof'),
        packetProofData(packet),
      ),
    ),
  );
  return packet;
}
export async function unwrapContentKey(
  oldRoot: string,
  identity: WrappingIdentity,
  value: unknown,
  expected: PacketContext & { recipient_id: string },
): Promise<string> {
  const packet = parseKeyPacket(value);
  for (const field of [
    'rotation_id',
    'account_id',
    'server_epoch',
    'issuer_id',
    'from_epoch',
    'key_epoch',
    'recipient_id',
  ] as const)
    if (packet[field] !== expected[field])
      throw new Error('Content-key packet does not match this installation or epoch.');
  if (packet.recipient_public_key !== identity.public_key)
    throw new Error('Content-key packet uses a different installation public key.');
  await validateWrappingIdentity(identity);
  if (
    !(await crypto.subtle.verify(
      'HMAC',
      await proofKey(oldRoot, packet.account_id, 'content-rotation-proof'),
      bytes(packet.proof, 32),
      packetProofData(packet),
    ))
  )
    throw new Error('Content-key rotation failed authentication.');
  const root = base64(
    new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: unbase64(packet.nonce),
          additionalData: encode(packetHeader(packet)),
          tagLength: 128,
        },
        await wrapKey(identity.private_key, packet.ephemeral_public_key, packet),
        unbase64(packet.ciphertext),
      ),
    ),
  );
  validateRecoveryKey(root);
  return root;
}
