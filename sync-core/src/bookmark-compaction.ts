import Dexie from 'dexie';
import type { SynkDatabase } from './database';
import {
  projectBookmarks,
  eraseBookmarkOperation,
  type BookmarkCompaction,
  type BookmarkOperation,
} from './bookmarks';
import { envelopeDigest } from './protocol';
import { validatePayload, MAX_PLAINTEXT_BYTES } from './payload';
import { historyPurgeTables } from './history-purge';

/** Only causally superseded, acknowledged edits/moves; retain births, removals and every concurrent value. */
export async function compactBookmarks(db: SynkDatabase): Promise<number> {
  return db.transaction('rw', [...historyPurgeTables(db), db.replicas], async () => {
    const local = await db.state.get('local');
    if (!local?.server_epoch) throw new Error('Connect to the relay before compacting bookmarks.');
    if (await db.quarantine.count())
      throw new Error('Resolve quarantined records before compaction.');
    const outgoing = new Set(await db.outbox.toCollection().primaryKeys());
    const acknowledged = (
      await db.operations.where('envelope.domain').equals('bookmark').toArray()
    ).filter((r) => r.sequence !== undefined && !outgoing.has(r.operation_id));
    const projection = projectBookmarks(
      acknowledged.map((r) => r.payload as Parameters<typeof projectBookmarks>[0][number]),
    );
    const keep = new Set<string>();
    for (const n of [...Object.values(projection.nodes), ...Object.values(projection.deleted)])
      for (const id of Object.values(n.versions)) if (id) keep.add(id);
    for (const conflict of projection.conflicts) {
      if (conflict.winner) keep.add(conflict.winner);
      for (const alternative of conflict.alternatives) keep.add(alternative.operation_id);
    }
    const candidates = acknowledged.filter(
      (r) =>
        !r.redacted &&
        !keep.has(r.operation_id) &&
        r.payload.kind === 'bookmark' &&
        r.payload.schema_version === 1 &&
        ['edit', 'move', 'reorder'].includes(r.payload.action.type),
    );
    if (!candidates.length) return 0;
    if (local.next_counter >= Number.MAX_SAFE_INTEGER) throw new Error('Device counter exhausted.');
    const certificate: BookmarkCompaction = {
      kind: 'bookmark',
      schema_version: 2,
      operation_id: crypto.randomUUID(),
      revision: {
        author: local.credentials.device_id,
        counter: local.next_counter,
        logical: Math.max(local.next_counter, (local.logical ?? 0) + 1, projection.logical + 1),
        context: { ...projection.frontier },
      },
      targets: [],
    };
    for (const record of candidates) {
      if (await db.historyPurgeClaims.get(record.operation_id)) continue;
      certificate.targets.push({
        receipt: eraseBookmarkOperation(record.payload as BookmarkOperation),
        digest: await Dexie.waitFor(envelopeDigest(record.envelope)),
        key_epoch: record.envelope.key_epoch,
      });
      if (new TextEncoder().encode(JSON.stringify(certificate)).byteLength > MAX_PLAINTEXT_BYTES) {
        certificate.targets.pop();
        break;
      }
      if (certificate.targets.length === 100) break;
    }
    if (!certificate.targets.length) return 0;
    const header = {
      protocol_version: 1 as const,
      operation_id: certificate.operation_id,
      account_id: local.credentials.account_id,
      device_id: local.credentials.device_id,
      counter: local.next_counter,
      domain: 'bookmark' as const,
      key_epoch: local.key_epoch ?? 1,
    };
    validatePayload(certificate, header);
    await db.drafts.add({
      operation_id: certificate.operation_id,
      header,
      payload: certificate,
      erasure_epoch: local.server_epoch,
    });
    await db.historyPurgeClaims.bulkAdd(
      certificate.targets.map((t) => ({
        operation_id: t.receipt.operation_id,
        certificate_operation_id: certificate.operation_id,
      })),
    );
    // Selection and intent commit together. Native values do not change; clocks include the new proof.
    const next = projectBookmarks(await db.bookmarkOperations());
    await db.replicas.put({ domain: 'bookmark', value: next });
    await db.state.update('local', {
      next_counter: local.next_counter + 1,
      logical: next.logical,
      context: next.frontier,
    });
    return certificate.targets.length;
  });
}
