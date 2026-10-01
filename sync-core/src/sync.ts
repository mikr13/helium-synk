import { decryptPayload } from './crypto';
import { projectBookmarks } from './bookmarks';
import { type LocalState, type LocalRecord, type StoredOperation, SynkDatabase } from './database';
import { MAX_BATCH, sameEnvelope, type Envelope, type PullPage, type PushReply } from './protocol';

export interface Transport {
  pull(cursor: number): Promise<PullPage>;
  push(envelopes: Envelope[], epoch: string): Promise<PushReply>;
}
export class HttpTransport implements Transport {
  constructor(private state: LocalState) {}
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.state.credentials.server_url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${this.state.credentials.token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
      redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 401)
        throw new Error('Device credentials were rejected. Check enrollment or revocation.');
      if (response.status === 409)
        throw new Error(
          'Server rejected a conflicting operation identity. Pending work was retained.',
        );
      throw new Error(`Server request failed (${response.status}). Pending work was retained.`);
    }
    return response.json() as Promise<T>;
  }
  pull(cursor: number): Promise<PullPage> {
    return this.request(`/v1/sync/pull?cursor=${cursor}`);
  }
  push(envelopes: Envelope[], epoch: string): Promise<PushReply> {
    return this.request('/v1/sync/push', { envelopes, expected_epoch: epoch });
  }
}

function checkEpoch(state: LocalState, epoch: string): void {
  if (typeof epoch !== 'string' || !epoch) throw new Error('Invalid server epoch.');
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
      for (const entry of page.records) {
        if (
          !Number.isSafeInteger(entry.sequence) ||
          entry.sequence <= previous ||
          entry.sequence > page.next_cursor ||
          entry.envelope.account_id !== state.credentials.account_id
        )
          throw new Error('Invalid record sequence or account.');
        previous = entry.sequence;
        try {
          const payload = await decryptPayload(state.recovery_key, entry.envelope);
          const record = {
            operation_id: entry.envelope.operation_id,
            envelope: entry.envelope,
            sequence: entry.sequence,
          };
          if (payload.kind === 'diagnostic') records.push({ ...record, payload });
          else operations.push({ ...record, payload });
        } catch (cause) {
          await this.db.quarantine.put({
            operation_id: entry.envelope.operation_id,
            sequence: entry.sequence,
            envelope: entry.envelope,
            reason: cause instanceof Error ? cause.message : 'Unable to validate encrypted record.',
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
            this.db.records,
            this.db.operations,
            this.db.drafts,
            this.db.replicas,
            this.db.state,
            this.db.quarantine,
          ],
          async () => {
            for (const record of [...records, ...operations]) {
              const existing =
                (await this.db.records.get(record.operation_id)) ??
                (await this.db.operations.get(record.operation_id));
              if (existing && !sameEnvelope(existing.envelope, record.envelope)) {
                validationFailure = new Error('Received operation identity was reused.');
                throw validationFailure;
              }
            }
            const bookmarkOperations = await this.db.bookmarkOperations();
            const byId = new Map(bookmarkOperations.map((op) => [op.operation_id, op]));
            for (const record of operations) byId.set(record.operation_id, record.payload);
            let projection;
            try {
              projection = projectBookmarks([...byId.values()]);
            } catch (cause) {
              validationFailure =
                cause instanceof Error ? cause : new Error('Invalid bookmark journal.');
              throw validationFailure;
            }
            await this.db.records.bulkPut(records);
            await this.db.operations.bulkPut(operations);
            await this.db.replicas.put({ domain: 'bookmark', value: projection });
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
      if (!page.has_more) return;
    }
    throw new Error('More data remains to download. Sync again to continue.');
  }
  private async perform(): Promise<void> {
    const state = await this.db.state.get('local');
    if (!state) return;
    const transport = this.makeTransport(state);
    // Establish/check epoch before acknowledging any queued work.
    await this.pull(transport);
    for (let batchNumber = 0; batchNumber < 20; batchNumber++) {
      await this.db.flushDrafts();
      const batch = await this.db.outbox.orderBy('counter').limit(MAX_BATCH).toArray();
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
    if (await this.db.pendingCount())
      throw new Error('More pending work remains. Sync again to continue.');
    await this.db.state.update('local', { last_synced: new Date().toISOString() });
  }
}
