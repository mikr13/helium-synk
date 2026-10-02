import Dexie from 'dexie';
import type { SynkDatabase, StoredOperation } from './database';
import { encryptPayload } from './crypto';
import { keySnapshot } from './key-manager';
import type { KeyTransport } from './key-state';
import { eraseHistoryVisit, isErasedHistoryOperation, projectHistory } from './history';
import {
  historyErasureTargetHeader,
  sameHistoryReceipt,
  validateHistoryErasure,
  type HistoryErasure,
} from './history-erasure';
import { MAX_PLAINTEXT_BYTES, validatePayload } from './payload';
import {
  envelopeDigest,
  isUuid,
  sameEnvelope,
  type Envelope,
  type HistoryPurgeRequest,
  type HistoryPurgeReply,
} from './protocol';

export function historyPurgeTables(db: SynkDatabase) {
  return [
    db.state,
    db.records,
    db.operations,
    db.drafts,
    db.outbox,
    db.quarantine,
    db.historyPurgePending,
    db.historyPurgeClaims,
    db.historyErasedDrafts,
    db.historyReplicas,
    db.historyVisits,
    ...db.historyCaptureTables(),
  ];
}
export function sameHistoryHeader(
  a: Omit<Envelope, 'nonce' | 'ciphertext'>,
  b: Omit<Envelope, 'nonce' | 'ciphertext'>,
): boolean {
  return [
    'protocol_version',
    'operation_id',
    'account_id',
    'device_id',
    'counter',
    'domain',
    'key_epoch',
  ].every((field) => a[field as keyof typeof a] === b[field as keyof typeof b]);
}
function validSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
/** Transaction-local identity check; crypto work uses Dexie's short lifetime helper. */
export async function preserveHistoryIdentity(
  db: SynkDatabase,
  next: StoredOperation,
): Promise<StoredOperation> {
  if (await db.records.get(next.operation_id))
    throw new Error('Received operation identity was reused across domains.');
  const existing = await db.operations.get(next.operation_id);
  if (!existing) return next;
  if (
    existing.sequence !== undefined &&
    next.sequence !== undefined &&
    existing.sequence !== next.sequence
  )
    throw new Error('Received history sequence was reused.');
  if (!existing.redacted && !next.redacted) {
    if (!sameEnvelope(existing.envelope, next.envelope))
      throw new Error('Received operation identity was reused.');
    return next;
  }
  if (
    existing.payload.kind !== 'history' ||
    next.payload.kind !== 'history' ||
    !sameHistoryHeader(existing.envelope, next.envelope)
  )
    throw new Error('History erasure header conflicts.');
  const a = existing.redacted?.digest ?? (await Dexie.waitFor(envelopeDigest(existing.envelope)));
  const b = next.redacted?.digest ?? (await Dexie.waitFor(envelopeDigest(next.envelope)));
  if (a !== b) throw new Error('History erasure digest conflicts with original ciphertext.');
  const receipt = (record: StoredOperation) => {
    if (isErasedHistoryOperation(record.payload)) return record.payload;
    if (record.payload.kind === 'history' && record.payload.action.type === 'visit')
      return eraseHistoryVisit(record.payload);
    throw new Error('History erasure target is not a visit.');
  };
  if (!sameHistoryReceipt(receipt(existing), receipt(next)))
    throw new Error('History erasure receipt conflicts.');
  return next.redacted ? next : { ...existing, sequence: next.sequence ?? existing.sequence };
}

/** Cross-domain identities include unpublished receipts and certified original headers. */
export async function validateAuthorCounters(db: SynkDatabase): Promise<void> {
  const counters = new Map<string, string>();
  const headers = [
    ...(await db.records.toArray()).map((r) => r.envelope),
    ...(await db.operations.toArray()).map((r) => r.envelope),
    ...(await db.drafts.toArray()).map((r) => r.header),
    ...(await db.historyErasedDrafts.toArray()).map((r) => r.header),
  ];
  for (const header of headers) {
    const key = `${header.device_id}/${header.counter}`;
    if (counters.has(key) && counters.get(key) !== header.operation_id)
      throw new Error('Received author counter was reused across domains.');
    counters.set(key, header.operation_id);
  }
}

/** Certificate authentication/shape validation precedes this caller-owned transaction. */
export async function applyHistoryErasure(
  db: SynkDatabase,
  record: StoredOperation,
  sequences = new Map<string, number>(),
): Promise<void> {
  if (record.payload.kind !== 'history-erasure')
    throw new Error('Expected an erasure certificate.');
  validatePayload(record.payload, record.envelope);
  if (!validSequence(record.sequence)) throw new Error('History certificate is not committed.');
  const certificate = record.payload;
  const pending = await db.historyPurgePending.get(record.operation_id);
  if (
    pending &&
    (!sameEnvelope(pending.request.certificate, record.envelope) ||
      pending.request.targets.length !== certificate.targets.length ||
      certificate.targets.some(
        (target) =>
          !pending.request.targets.some(
            (saved) =>
              saved.digest === target.digest &&
              sameHistoryHeader(saved.header, historyErasureTargetHeader(record.envelope, target)),
          ),
      ))
  )
    throw new Error('Committed certificate differs from saved purge intent.');
  for (const target of certificate.targets) {
    const header = historyErasureTargetHeader(record.envelope, target);
    if (
      (await db.historyErasedDrafts.get(header.operation_id)) ||
      (await db.drafts.get(header.operation_id))
    )
      throw new Error('Certificate reuses an unpublished local draft identity.');
    const old = await db.operations.get(header.operation_id);
    const next: StoredOperation = {
      operation_id: header.operation_id,
      envelope: { ...header, nonce: '', ciphertext: '' },
      payload: target.receipt,
      sequence: sequences.get(header.operation_id) ?? old?.sequence,
      redacted: {
        digest: target.digest,
        certificate_operation_id:
          old?.redacted?.certificate_operation_id ?? certificate.operation_id,
      },
    };
    const checked = await preserveHistoryIdentity(db, next);
    await db.operations.put(checked);
    await db.outbox.delete(header.operation_id);
    await db.quarantine.delete(header.operation_id);
  }
  await db.historyPurgePending.delete(certificate.operation_id);
  await db.historyPurgeClaims
    .where('certificate_operation_id')
    .equals(certificate.operation_id)
    .delete();
}

export class HistoryPurger {
  constructor(
    private db: SynkDatabase,
    private keys?: KeyTransport,
  ) {}
  async remaining(): Promise<boolean> {
    return !!(await this.db.operations
      .where('envelope.domain')
      .equals('history')
      .filter((record) => isErasedHistoryOperation(record.payload) && !record.redacted)
      .first());
  }
  /** Reserve counter, content-free proof and target claims before asynchronous encryption. */
  async prepare(): Promise<boolean> {
    const candidates = await this.db.operations
      .where('envelope.domain')
      .equals('history')
      .filter((record) => isErasedHistoryOperation(record.payload) && !record.redacted)
      .limit(100)
      .toArray();
    const prepared: { record: StoredOperation; digest: string }[] = [];
    for (const record of candidates)
      if (!(await this.db.historyPurgeClaims.get(record.operation_id)))
        prepared.push({ record, digest: await envelopeDigest(record.envelope) });
    if (!prepared.length) return false;
    return this.db.transaction('rw', historyPurgeTables(this.db), async () => {
      const local = (await this.db.state.get('local'))!,
        metadata = await this.db.historyMetadata();
      if (!isUuid(local.server_epoch))
        throw new Error('Establish the server epoch before erasure.');
      if (local.next_counter >= Number.MAX_SAFE_INTEGER)
        throw new Error('Device counter exhausted.');
      const certificate: HistoryErasure = {
        kind: 'history-erasure',
        schema_version: 1,
        operation_id: crypto.randomUUID(),
        revision: {
          author: local.credentials.device_id,
          counter: local.next_counter,
          logical: Math.max(
            local.next_counter,
            metadata.logical + 1,
            (local.history_logical ?? 0) + 1,
          ),
          context: { ...metadata.frontier },
        },
        targets: [],
      };
      for (const candidate of prepared) {
        const saved = await this.db.operations.get(candidate.record.operation_id);
        if (
          !saved ||
          saved.redacted ||
          !isErasedHistoryOperation(saved.payload) ||
          (await this.db.historyPurgeClaims.get(saved.operation_id))
        )
          continue;
        if (!sameEnvelope(saved.envelope, candidate.record.envelope)) continue;
        const next = {
          receipt: saved.payload,
          digest: candidate.digest,
          key_epoch: saved.envelope.key_epoch,
        };
        certificate.targets.push(next);
        if (
          new Set(certificate.targets.map((target) => target.receipt.action.visit.id)).size > 80 ||
          new TextEncoder().encode(JSON.stringify(certificate)).byteLength > MAX_PLAINTEXT_BYTES
        ) {
          certificate.targets.pop();
          if (!certificate.targets.length)
            throw new Error(
              'A history erasure proof exceeds the payload limit. Preserve local data for recovery.',
            );
          break;
        }
      }
      if (!certificate.targets.length) return false;
      const header = {
        protocol_version: 1 as const,
        operation_id: certificate.operation_id,
        account_id: local.credentials.account_id,
        device_id: local.credentials.device_id,
        counter: certificate.revision.counter,
        domain: 'history-erasure' as const,
        key_epoch: local.key_epoch ?? 1,
      };
      validatePayload(certificate, header);
      await this.db.drafts.add({
        operation_id: certificate.operation_id,
        header,
        payload: certificate,
        erasure_epoch: local.server_epoch,
      });
      await this.db.historyPurgeClaims.bulkAdd(
        certificate.targets.map((target) => ({
          operation_id: target.receipt.operation_id,
          certificate_operation_id: certificate.operation_id,
        })),
      );
      await this.db.state.update('local', {
        next_counter: local.next_counter + 1,
        history_logical: certificate.revision.logical,
      });
      await this.db.persistHistory(projectHistory(await this.db.historyOperations()));
      return true;
    });
  }
  private async rekey(pending: {
    operation_id: string;
    request: HistoryPurgeRequest;
  }): Promise<typeof pending> {
    const { local } = await keySnapshot(this.db),
      epoch = local.key_epoch ?? 1;
    const old = pending.request.certificate;
    if (old.key_epoch >= epoch) return pending;
    if (!this.keys) throw new Error('History erasure requires key proofs before replacement.');
    const proof = await this.keys.rekeyCheck([old], pending.request.expected_epoch, epoch);
    if (
      !proof ||
      proof.server_epoch !== pending.request.expected_epoch ||
      proof.key_epoch !== epoch ||
      !Array.isArray(proof.committed) ||
      !Array.isArray(proof.missing) ||
      proof.committed.length + proof.missing.length !== 1
    )
      throw new Error('Invalid history erasure rekey proof. Intent was retained.');
    if (proof.committed.length) {
      if (
        proof.committed[0]!.operation_id !== old.operation_id ||
        !validSequence(proof.committed[0]!.sequence)
      )
        throw new Error('Invalid committed history certificate proof.');
      return pending; // Exact old request remains retryable, including after rotation.
    }
    if (proof.missing[0] !== old.operation_id)
      throw new Error('Incomplete history erasure rekey proof.');
    const record = await this.db.operations.get(old.operation_id);
    if (
      !record ||
      record.payload.kind !== 'history-erasure' ||
      record.sequence !== undefined ||
      !sameEnvelope(record.envelope, old)
    )
      throw new Error('Saved history certificate changed during rekey.');
    const envelope = await encryptPayload(
      local.recovery_key,
      { ...old, key_epoch: epoch },
      record.payload,
    );
    const replacement = { ...pending, request: { ...pending.request, certificate: envelope } };
    await this.db.transaction(
      'rw',
      [this.db.state, this.db.operations, this.db.historyPurgePending],
      async () => {
        const latest = (await this.db.state.get('local'))!,
          current = await this.db.historyPurgePending.get(pending.operation_id);
        const saved = await this.db.operations.get(old.operation_id);
        if (
          latest.server_epoch !== pending.request.expected_epoch ||
          (latest.key_epoch ?? 1) !== epoch ||
          JSON.stringify(current) !== JSON.stringify(pending) ||
          !saved ||
          saved.sequence !== undefined ||
          !sameEnvelope(saved.envelope, old)
        )
          throw new Error('Keys or purge intent changed during rekey.');
        await this.db.operations.update(old.operation_id, { envelope });
        await this.db.historyPurgePending.put(replacement);
      },
    );
    return replacement;
  }
  async resume(purge: (request: HistoryPurgeRequest) => Promise<HistoryPurgeReply>): Promise<void> {
    for (let pass = 0; pass < 20; pass++) {
      let pending = await this.db.historyPurgePending.toCollection().first();
      if (!pending) return;
      pending = await this.rekey(pending);
      const local = (await this.db.state.get('local'))!;
      if (local.server_epoch !== pending.request.expected_epoch)
        throw new Error('Purge server epoch changed; preserve the saved intent.');
      const reply = await purge(pending.request);
      if (
        !reply ||
        reply.server_epoch !== pending.request.expected_epoch ||
        !validSequence(reply.certificate_sequence) ||
        !Array.isArray(reply.redactions) ||
        reply.redactions.length !== pending.request.targets.length
      )
        throw new Error('Invalid history purge acknowledgement. Intent was retained.');
      const ids = new Set(pending.request.targets.map((target) => target.header.operation_id));
      const sequences = new Map<string, number>();
      const used = new Set<number>([reply.certificate_sequence]);
      for (const ack of reply.redactions) {
        const target = pending.request.targets.find(
          (t) => t.header.operation_id === ack.operation_id,
        );
        if (
          !target ||
          !ids.delete(ack.operation_id) ||
          target.digest !== ack.digest ||
          !validSequence(ack.sequence) ||
          !isUuid(ack.certificate_operation_id) ||
          used.has(ack.sequence)
        )
          throw new Error('Invalid history purge target acknowledgement.');
        sequences.set(ack.operation_id, ack.sequence);
        used.add(ack.sequence);
      }
      await this.db.transaction('rw', historyPurgeTables(this.db), async () => {
        const current = await this.db.historyPurgePending.get(pending!.operation_id);
        if (!current) return; // An authenticated pull already completed this same intent.
        if (JSON.stringify(current) !== JSON.stringify(pending))
          throw new Error('Saved purge intent changed during request.');
        const stored = (await this.db.operations.get(pending!.operation_id))!;
        if (!sameEnvelope(stored.envelope, pending!.request.certificate))
          throw new Error('Saved certificate changed.');
        validateHistoryErasure(stored.payload as HistoryErasure);
        const committed = { ...stored, sequence: reply.certificate_sequence };
        await this.db.operations.put(await preserveHistoryIdentity(this.db, committed));
        await applyHistoryErasure(this.db, committed, sequences);
        await validateAuthorCounters(this.db);
        await this.db.persistHistory(projectHistory(await this.db.historyOperations()));
      });
    }
    if (await this.db.historyPurgePending.count())
      throw new Error('More purge intents remain. Sync again to continue.');
  }
}
