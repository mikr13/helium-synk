import { validateBookmarkOperation, type BookmarkOperation } from './bookmarks';
import { validateSessionPart, type SessionPart } from './sessions';
import type { Diagnostic, Envelope } from './protocol';
export type Payload = Diagnostic | BookmarkOperation | SessionPart;
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
  } else if (payload.kind === 'session') {
    validateSessionPart(payload);
    if (
      payload.operation_id !== header.operation_id ||
      payload.source_id !== header.device_id ||
      payload.source_revision + payload.part !== header.counter
    )
      throw new Error('Session source/revision does not match its envelope.');
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
