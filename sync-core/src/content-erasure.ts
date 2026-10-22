import type { BookmarkCompaction } from './bookmarks';
import type { Envelope } from './protocol';
import type { Payload } from './payload';
import type { HistoryErasure } from './history-erasure';
import { historyErasureTargetHeader } from './history-erasure';
import type { SessionErasure } from './sessions';
export type ContentErasure = HistoryErasure | SessionErasure | BookmarkCompaction;
export function isContentErasure(
  payload: Payload | { kind: string; schema_version?: number },
): payload is ContentErasure {
  return (
    (payload.kind === 'bookmark' && payload.schema_version === 2) ||
    payload.kind === 'history-erasure' ||
    (payload.kind === 'session' && payload.schema_version === 3)
  );
}
export function erasureTargetHeader(
  envelope: Envelope,
  target: ContentErasure['targets'][number],
): Omit<Envelope, 'nonce' | 'ciphertext'> {
  if (target.receipt.kind === 'bookmark')
    return {
      protocol_version: 1,
      operation_id: target.receipt.operation_id,
      account_id: envelope.account_id,
      device_id: target.receipt.revision.author,
      counter: target.receipt.revision.counter,
      domain: 'bookmark',
      key_epoch: target.key_epoch,
    };
  if (target.receipt.kind === 'history')
    return historyErasureTargetHeader(envelope, target as HistoryErasure['targets'][number]);
  const r = target.receipt;
  return {
    protocol_version: 1,
    operation_id: r.operation_id,
    account_id: envelope.account_id,
    device_id: r.source_id,
    counter: r.source_revision + r.part,
    domain: 'session',
    key_epoch: target.key_epoch,
  };
}
