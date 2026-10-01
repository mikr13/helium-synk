import { validateRecoveryKey } from './crypto';
import { isUuid, validKeyEpoch } from './protocol';
import type { WrappingIdentity, PublicIdentity, KeyPacket } from './key-crypto';

export interface KeyRing {
  key_epoch: number;
  roots: Record<number, string>;
}
export interface EnrollmentKeys extends KeyRing {
  server_epoch?: string;
}
export interface KeySecrets {
  id: 'keys';
  account_id: string;
  device_id: string;
  server_epoch?: string;
  roots: Record<number, string>;
  identity?: WrappingIdentity;
  public_identity?: PublicIdentity;
}
export interface KeyDevice {
  device_id: string;
  name: string;
  revoked: boolean;
  public_key: string | null;
  proof_epoch: number | null;
  proof: string | null;
}
export interface KeyState {
  account_id: string;
  server_epoch: string;
  key_epoch: number;
  devices: KeyDevice[];
  packets: KeyPacket[];
  has_more: boolean;
  author_counter: number;
  author_operation_id: string | null;
}
export interface RotationRequest {
  rotation_id: string;
  server_epoch: string;
  from_epoch: number;
  key_epoch: number;
  revoke_ids: string[];
  packets: KeyPacket[];
}
export interface RotationPending {
  id: 'rotation';
  request: RotationRequest;
  new_root: string;
}
export interface RotationReply {
  server_epoch: string;
  rotation_id: string;
  key_epoch: number;
}
export interface RekeyReply {
  server_epoch: string;
  key_epoch: number;
  committed: { operation_id: string; sequence: number }[];
  missing: string[];
}
export interface KeyTransport {
  state(after: number): Promise<KeyState>;
  identity(
    identity: PublicIdentity,
    serverEpoch: string,
  ): Promise<PublicIdentity & { server_epoch: string }>;
  rotate(request: RotationRequest): Promise<RotationReply>;
  rekeyCheck(
    envelopes: import('./protocol').Envelope[],
    serverEpoch: string,
    keyEpoch: number,
  ): Promise<RekeyReply>;
}
export function parseKeyRing(value: unknown): KeyRing {
  const ring = value as KeyRing;
  if (
    !ring ||
    !validKeyEpoch(ring.key_epoch) ||
    !ring.roots ||
    typeof ring.roots !== 'object' ||
    Array.isArray(ring.roots) ||
    Object.keys(ring.roots).length !== ring.key_epoch
  )
    throw new Error('Invalid or incomplete content-key ring.');
  const roots: Record<number, string> = {};
  for (let epoch = 1; epoch <= ring.key_epoch; epoch++) {
    const root = ring.roots[epoch];
    if (typeof root !== 'string') throw new Error('Missing historical content key.');
    validateRecoveryKey(root);
    roots[epoch] = root;
  }
  return { key_epoch: ring.key_epoch, roots };
}
export function checkKeyServer(
  local: { credentials: { account_id: string }; server_epoch?: string },
  state: KeyState,
): void {
  if (
    !state ||
    state.account_id !== local.credentials.account_id ||
    !isUuid(state.server_epoch) ||
    (local.server_epoch && local.server_epoch !== state.server_epoch)
  )
    throw new Error('Key account or server epoch changed. Preserve local work for recovery.');
}
