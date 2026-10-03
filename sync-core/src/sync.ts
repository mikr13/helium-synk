import { decryptPayload } from './crypto';
import { KeyManager, keySnapshot } from './key-manager';
import type { KeyTransport } from './key-state';
import { projectHistory } from './history';
import { expireHistory } from './history-retention';
import { expireSessions } from './session-retention';
import { projectSessions } from './sessions';
import { projectBookmarks } from './bookmarks';
import { LocalCapacityError } from './local-storage';
import { historyErasureTargetHeader } from './history-erasure';
import {
  HistoryPurger,
  applyHistoryErasure,
  historyPurgeTables,
  preserveHistoryIdentity,
  sameHistoryHeader,
  validateAuthorCounters,
} from './history-purge';
import { type LocalState, type LocalRecord, type StoredOperation, SynkDatabase } from './database';
import {
  MAX_BATCH,
  envelopeBatch,
  isUuid,
  sameEnvelope,
  validateEnvelope,
  type Envelope,
  type HistoryPurgeRequest,
  type HistoryPurgeReply,
  type PullPage,
  type PushReply,
  type ProgressReply,
} from './protocol';

export interface Transport {
  keys?: KeyTransport;
  purge?(request: HistoryPurgeRequest): Promise<HistoryPurgeReply>;
  pull(cursor: number): Promise<PullPage>;
  push(envelopes: Envelope[], epoch: string): Promise<PushReply>;
  acknowledge(cursor: number, epoch: string): Promise<ProgressReply>;
}
export class HttpTransport implements Transport {
  constructor(private state: LocalState) {}
  keys: KeyTransport = {
    state: (after) => this.request(`/v1/keys/state?after_epoch=${after}`),
    identity: (identity, serverEpoch) =>
      this.request('/v1/keys/identity', {
        server_epoch: serverEpoch,
        public_key: identity.public_key,
        proof_epoch: identity.proof_epoch,
        proof: identity.proof,
      }),
    rotate: (request) => this.request('/v1/keys/rotate', request),
    rekeyCheck: (envelopes, serverEpoch, keyEpoch) =>
      this.request('/v1/sync/rekey-check', {
        envelopes,
        server_epoch: serverEpoch,
        key_epoch: keyEpoch,
      }),
  };
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.state.credentials.server_url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.state.credentials.token}`,
        'X-Synk-History-Erasure': '1',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 507)
        throw new Error(
          'Relay storage is full or its account quota was reached. Pending work was retained; check relay storage and budgets before retrying.',
        );
      if (response.status === 401)
        throw new Error('Device credentials were rejected. Check enrollment or revocation.');
      if (response.status === 409)
        throw new Error(
          'Server history or an operation identity conflicts with local state. Pending work was retained; export local data before recovery.',
        );
      if (response.status === 412)
        throw new Error(
          'Content-key epoch changed. Pending work was retained; refresh installation keys before retrying.',
        );
      if (response.status === 404)
        throw new Error(
          'Relay lacks a required API. Upgrade the relay; pending work was retained.',
        );
      if (response.status === 426)
        throw new Error(
          'Client and relay versions are incompatible. Upgrade to compatible versions; pending work was retained.',
        );
      throw new Error(`Server request failed (${response.status}). Pending work was retained.`);
    }
    return response.json() as Promise<T>;
  }
  pull(cursor: number): Promise<PullPage> {
    return this.request(`/v1/sync/pull?cursor=${cursor}`);
  }
  purge(request: HistoryPurgeRequest): Promise<HistoryPurgeReply> {
    return this.request('/v1/history/purge', request);
  }
  push(envelopes: Envelope[], epoch: string): Promise<PushReply> {
    return this.request('/v1/sync/push', { envelopes, expected_epoch: epoch });
  }
  acknowledge(cursor: number, epoch: string): Promise<ProgressReply> {
    return this.request('/v1/sync/ack', { cursor, server_epoch: epoch });
  }
}

function checkEpoch(state: LocalState, epoch: string): void {
  if (!isUuid(epoch)) throw new Error('Invalid server epoch.');
  if (state.server_epoch && state.server_epoch !== epoch) {
    throw new Error(
      'Server history changed. Synchronization is paused; export local data before recovery.',
    );
  }
}

export class SyncCoordinator {
  private running?: Promise<void>;
  private requested = false;
  constructor(
    private db: SynkDatabase,
    private makeTransport: (s: LocalState) => Transport = (s) => new HttpTransport(s),
  ) {}
  sync(): Promise<void> {
    if (this.running) {
      this.requested = true;
      return this.running;
    }
    this.running = (async () => {
      for (let pass = 0; pass < 3; pass++) {
        this.requested = false;
        await this.perform();
        if (!this.requested) break;
      }
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async pull(transport: Transport): Promise<void> {
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const state = (await this.db.state.get('local'))!;
      const page = await transport.pull(state.cursor);
      checkEpoch(state, page.server_epoch);
      // A lost ACK reply or worker exit leaves cursor > acknowledged_cursor durably.
      // Check the live epoch before retrying; a later bad page cannot erase prior progress.
      await this.acknowledgeProgress(transport);
      if (
        !Array.isArray(page.records) ||
        page.records.length > MAX_BATCH ||
        typeof page.has_more !== 'boolean' ||
        !Number.isSafeInteger(page.next_cursor) ||
        page.next_cursor < state.cursor
      )
        throw new Error('Invalid server cursor page.');
      let previous = state.cursor;
      const records: LocalRecord[] = [];
      const operations: StoredOperation[] = [];
      const byOperation = new Map<string, StoredOperation>();
      const addOperation = (record: StoredOperation) => {
        const existing = byOperation.get(record.operation_id);
        if (existing) {
          if (
            existing.sequence !== record.sequence ||
            !sameEnvelope(existing.envelope, record.envelope)
          )
            throw new Error('Conflicting repeated operation in a cursor page.');
          return;
        }
        byOperation.set(record.operation_id, record);
        operations.push(record);
      };
      const redactedSequences = new Map<string, number>();
      const { secrets } = await keySnapshot(this.db);
      for (const entry of page.records) {
        if (
          !Number.isSafeInteger(entry.sequence) ||
          entry.sequence <= previous ||
          entry.sequence > page.next_cursor
        )
          throw new Error('Invalid record sequence or account.');
        previous = entry.sequence;
        const envelope = 'redacted' in entry ? entry.redacted?.certificate : entry.envelope;
        try {
          validateEnvelope(envelope);
          if (envelope.account_id !== state.credentials.account_id)
            throw new Error('Invalid record account.');
          const root = secrets.roots[envelope.key_epoch];
          if (!root)
            throw new Error('This content-key epoch is unavailable. Refresh keys before retrying.');
          const payload = await decryptPayload(root, envelope, state.history_index_key);
          const record = {
            operation_id: envelope.operation_id,
            envelope,
            sequence: entry.sequence,
          };
          if ('redacted' in entry) {
            const { header, digest, certificate_sequence } = entry.redacted;
            validateEnvelope({ ...header, nonce: '', ciphertext: '' });
            if (
              payload.kind !== 'history-erasure' ||
              !Number.isSafeInteger(certificate_sequence) ||
              certificate_sequence <= 0 ||
              certificate_sequence === entry.sequence
            )
              throw new Error('Invalid certified history slot.');
            const target = payload.targets.find(
              (t) => t.receipt.operation_id === header.operation_id,
            );
            if (
              !target ||
              target.digest !== digest ||
              !sameHistoryHeader(header, historyErasureTargetHeader(envelope, target))
            )
              throw new Error('Certified history slot differs from its encrypted proof.');
            addOperation({ ...record, sequence: certificate_sequence, payload });
            addOperation({
              operation_id: header.operation_id,
              envelope: {
                ...historyErasureTargetHeader(envelope, target),
                nonce: '',
                ciphertext: '',
              },
              payload: target.receipt,
              sequence: entry.sequence,
              redacted: { digest, certificate_operation_id: envelope.operation_id },
            });
            redactedSequences.set(header.operation_id, entry.sequence);
          } else if (payload.kind === 'diagnostic') records.push({ ...record, payload });
          else addOperation({ ...record, payload });
        } catch (cause) {
          if (envelope && isUuid(envelope.operation_id))
            await this.db.quarantine.put({
              operation_id: envelope.operation_id,
              sequence: entry.sequence,
              envelope,
              reason:
                cause instanceof Error ? cause.message : 'Unable to validate encrypted record.',
            });
          throw cause;
        }
      }
      if (
        (page.records.length === 0 && page.next_cursor !== state.cursor) ||
        (page.records.length > 0 && previous !== page.next_cursor) ||
        (page.has_more && page.records.length === 0)
      ) {
        throw new Error('Server cursor skipped unprocessed records.');
      }
      // Decrypt outside the transaction; no cursor moves on authentication/decryption failure.
      let validationFailure: Error | undefined;
      try {
        await this.db.transaction(
          'rw',
          [
            ...historyPurgeTables(this.db),
            ...this.db.captureBudgetTables(),
            this.db.replicas,
            this.db.sessionReplicas,
            this.db.sessionRestores,
          ],
          async () => {
            let newContent = 0,
              newBytes = 0;
            const erasedIds = new Set(
              operations.flatMap((r) =>
                r.payload.kind === 'history-erasure'
                  ? r.payload.targets.map((t) => t.receipt.operation_id)
                  : [],
              ),
            );
            for (const record of [...records, ...operations]) {
              const payload = record.payload;
              if (
                ('redacted' in record && record.redacted) ||
                erasedIds.has(record.operation_id) ||
                payload.kind === 'history-erasure' ||
                (payload.kind === 'session' && payload.schema_version === 2) ||
                (payload.kind === 'history' && payload.action.type !== 'visit') ||
                (payload.kind === 'bookmark' && payload.action.type === 'remove')
              )
                continue;
              if (
                !(await this.db.records.get(record.operation_id)) &&
                !(await this.db.operations.get(record.operation_id))
              ) {
                newContent++;
                newBytes += JSON.stringify(record).length * 4;
              }
            }
            await this.db.assertDownloadCapacity(newContent, newBytes);
            for (const record of records) {
              const existing =
                (await this.db.records.get(record.operation_id)) ??
                (await this.db.operations.get(record.operation_id));
              if (existing && !sameEnvelope(existing.envelope, record.envelope)) {
                validationFailure = new Error('Received operation identity was reused.');
                throw validationFailure;
              }
              if (await this.db.historyErasedDrafts.get(record.operation_id)) {
                validationFailure = new Error('Received an unpublished erased history identity.');
                throw validationFailure;
              }
            }
            await this.db.records.bulkPut(records);
            for (const record of operations) {
              let checked: StoredOperation;
              try {
                if (await this.db.historyErasedDrafts.get(record.operation_id))
                  throw new Error('Received an unpublished erased history identity.');
                checked = await preserveHistoryIdentity(this.db, record);
              } catch (cause) {
                validationFailure =
                  cause instanceof Error ? cause : new Error('Invalid operation identity.');
                throw validationFailure;
              }
              await this.db.operations.put(checked);
            }
            for (const record of operations)
              if (record.payload.kind === 'history-erasure')
                await applyHistoryErasure(this.db, record, redactedSequences);
            const bookmarkOperations = await this.db.bookmarkOperations();
            const sessionOperations = await this.db.sessionOperations();
            const historyOperations = await this.db.historyOperations();
            let projection, sessions, history;
            try {
              projection = projectBookmarks(bookmarkOperations);
              sessions = projectSessions(sessionOperations);
              history = projectHistory(historyOperations);
              await validateAuthorCounters(this.db);
            } catch (cause) {
              validationFailure =
                cause instanceof Error ? cause : new Error('Invalid replicated journal.');
              throw validationFailure;
            }
            await this.db.replicas.put({ domain: 'bookmark', value: projection });
            await this.db.persistSessions(sessions);
            await this.db.persistHistory(history);
            await this.db.quarantine.bulkDelete(
              [...records, ...operations].map((r) => r.operation_id),
            );
            const current = (await this.db.state.get('local'))!;
            await this.db.state.update('local', {
              cursor: page.next_cursor,
              server_epoch: page.server_epoch,
              logical: Math.max(current.logical ?? 0, projection.logical),
              context: projection.frontier,
            });
          },
        );
      } catch (cause) {
        if (cause instanceof LocalCapacityError)
          await this.db.transaction('rw', this.db.state, async () => {
            const current = (await this.db.state.get('local'))!;
            checkEpoch(current, page.server_epoch);
            // Epoch was authenticated/checked; no required record or cursor is skipped.
            if (!current.server_epoch)
              await this.db.state.update('local', { server_epoch: page.server_epoch });
          });
        if (validationFailure)
          await this.db.quarantine.bulkPut(
            [...records, ...operations].map((record) => ({
              operation_id: record.operation_id,
              sequence: record.sequence!,
              envelope: record.envelope,
              reason: validationFailure!.message,
            })),
          );
        throw cause;
      }
      await this.acknowledgeProgress(transport);
      if (!page.has_more) return;
    }
    throw new Error('More data remains to download. Sync again to continue.');
  }
  private async acknowledgeProgress(transport: Transport): Promise<void> {
    const state = (await this.db.state.get('local'))!;
    if (!state.server_epoch || state.cursor <= (state.acknowledged_cursor ?? 0)) return;
    const reply = await transport.acknowledge(state.cursor, state.server_epoch);
    checkEpoch(state, reply.server_epoch);
    if (!Number.isSafeInteger(reply.processed_cursor) || reply.processed_cursor !== state.cursor)
      throw new Error('Invalid processed-cursor acknowledgement. Local progress was retained.');
    await this.db.transaction('rw', this.db.state, async () => {
      const current = (await this.db.state.get('local'))!;
      if (current.server_epoch !== state.server_epoch || current.cursor < state.cursor)
        throw new Error('Local progress changed during acknowledgement.');
      await this.db.state.update('local', { acknowledged_cursor: state.cursor });
    });
  }
  private async perform(): Promise<void> {
    const state = await this.db.state.get('local');
    if (!state) return;
    const transport = this.makeTransport(state);
    const keys = transport.keys ? new KeyManager(this.db, transport.keys) : undefined;
    if (keys) {
      await keys.refresh();
      await keys.resumePending();
    } else if ((state.key_epoch ?? 1) > 1)
      throw new Error('Transport lacks required content-key APIs. Pending work was retained.');
    // Establish/check epoch before acknowledging any queued work.
    try {
      await this.pull(transport);
    } catch (cause) {
      // A full replica may still release queued duplicate copies through committed uploads.
      // Bad records, network failures and epoch changes continue to stop the pass.
      if (!(cause instanceof LocalCapacityError)) throw cause;
    }
    await expireHistory(this.db);
    await expireSessions(this.db);
    const purger = transport.purge ? new HistoryPurger(this.db, transport.keys) : undefined;
    if (purger) {
      const purge = (request: HistoryPurgeRequest) => transport.purge!(request);
      // Finish saved requests first; retries retain their original target digests.
      await purger.resume(purge);
      for (let batchNumber = 0; batchNumber < 20; batchNumber++) {
        const staged = await purger.prepare();
        await this.db.flushDrafts();
        await purger.resume(purge);
        const savedDraft = await this.db.drafts
          .where('header.domain')
          .equals('history-erasure')
          .count();
        if (!staged && !savedDraft && !(await purger.remaining())) break;
      }
      if (
        (await purger.remaining()) ||
        (await this.db.drafts.where('header.domain').equals('history-erasure').count())
      )
        throw new Error('More history erasure remains. Sync again to continue.');
    }
    for (let batchNumber = 0; batchNumber < 20; batchNumber++) {
      await this.db.flushDrafts();
      if (keys) await keys.rekeyOutbox();
      const batch = envelopeBatch(
        await this.db.outbox.orderBy('counter').limit(MAX_BATCH).toArray(),
      );
      if (batch.length === 0) break;
      const reply = await transport.push(batch, (await this.db.state.get('local'))!.server_epoch!);
      checkEpoch((await this.db.state.get('local'))!, reply.server_epoch);
      const expected = new Set(batch.map((e) => e.operation_id));
      if (!Array.isArray(reply.acknowledgements) || reply.acknowledgements.length !== expected.size)
        throw new Error('Incomplete acknowledgement.');
      for (const ack of reply.acknowledgements) {
        if (
          !expected.delete(ack.operation_id) ||
          !Number.isSafeInteger(ack.sequence) ||
          ack.sequence <= 0
        )
          throw new Error('Invalid acknowledgement.');
      }
      await this.db.transaction(
        'rw',
        [this.db.outbox, this.db.records, this.db.operations],
        async () => {
          for (const ack of reply.acknowledgements) {
            await this.db.records.update(ack.operation_id, { sequence: ack.sequence });
            await this.db.operations.update(ack.operation_id, { sequence: ack.sequence });
            await this.db.outbox.delete(ack.operation_id);
          }
        },
      );
    }
    await this.pull(transport);
    if (purger && (await purger.remaining()))
      throw new Error('New history erasure remains. Sync again to continue.');
    if (await this.db.pendingCount())
      throw new Error('More pending work remains. Sync again to continue.');
    await this.db.state.update('local', { last_synced: new Date().toISOString() });
  }
}
