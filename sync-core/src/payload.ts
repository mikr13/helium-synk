import { validateBookmarkOperation, type BookmarkOperation } from './bookmarks';
import type { Diagnostic, Envelope } from './protocol';
export type Payload = Diagnostic | BookmarkOperation;
export type EnvelopeHeader = Omit<Envelope, 'nonce' | 'ciphertext'>;
export const MAX_PLAINTEXT_BYTES = 65_536 - 16;
export function validatePayload(payload: Payload, header: EnvelopeHeader): void {
  if (!payload || payload.kind !== header.domain)
    throw new Error('Record domain does not match its envelope.');
  if (payload.kind === 'diagnostic') {
    if (
      typeof payload.note !== 'string' ||
      !payload.note.trim() ||
      payload.note.length > 2_000 ||
      typeof payload.created_at !== 'string' ||
      !Number.isFinite(Date.parse(payload.created_at))
    )
      throw new Error('Invalid diagnostic payload.');
  } else {
    validateBookmarkOperation(payload);
    if (
      payload.operation_id !== header.operation_id ||
      payload.revision.author !== header.device_id ||
      payload.revision.counter !== header.counter
    )
      throw new Error('Bookmark author/revision does not match its envelope.');
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_PLAINTEXT_BYTES)
    throw new Error(
      'Record exceeds the encrypted payload limit; split the operation into smaller batches.',
    );
}
