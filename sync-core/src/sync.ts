import { decryptDiagnostic } from './crypto';
import { type LocalState, type LocalRecord, SynkDatabase } from './database';
import { MAX_BATCH, type Envelope, type PullPage, type PushReply } from './protocol';

export interface Transport {
  pull(cursor: number): Promise<PullPage>;
  push(envelopes: Envelope[], epoch: string): Promise<PushReply>;
}
export class HttpTransport implements Transport {
  constructor(private state: LocalState) {}
  private async request<T>(path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.state.credentials.server_url}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.state.credentials.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000), cache: 'no-store', redirect: 'error',
    });
    if (!response.ok) {
      if (response.status === 401) throw new Error('Device credentials were rejected. Check enrollment or revocation.');
      if (response.status === 409) throw new Error('Server rejected a conflicting operation identity. Pending work was retained.');
      throw new Error(`Server request failed (${response.status}). Pending work was retained.`);
    }
    return response.json() as Promise<T>;
  }
  pull(cursor: number): Promise<PullPage> { return this.request(`/v1/sync/pull?cursor=${cursor}`); }
  push(envelopes: Envelope[], epoch: string): Promise<PushReply> { return this.request('/v1/sync/push', { envelopes, expected_epoch: epoch }); }
}

function checkEpoch(state: LocalState, epoch: string): void {
  if (typeof epoch !== 'string' || !epoch) throw new Error('Invalid server epoch.');
  if (state.server_epoch && state.server_epoch !== epoch) {
    throw new Error('Server history changed. Synchronization is paused; export local data before recovery.');
  }
}

export class SyncCoordinator {
  private running?: Promise<void>;
  constructor(private db: SynkDatabase, private makeTransport: (s: LocalState) => Transport = s => new HttpTransport(s)) {}
  sync(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.perform().finally(() => { this.running = undefined; });
    return this.running;
  }
  private async pull(transport: Transport): Promise<void> {
    for (let pageNumber = 0; pageNumber < 20; pageNumber++) {
      const state = (await this.db.state.get('local'))!;
      const page = await transport.pull(state.cursor);
      checkEpoch(state, page.server_epoch);
      if (!Array.isArray(page.records) || page.records.length > MAX_BATCH || typeof page.has_more !== 'boolean' ||
          !Number.isSafeInteger(page.next_cursor) || page.next_cursor < state.cursor) throw new Error('Invalid server cursor page.');
      let previous = state.cursor;
      const records: LocalRecord[] = [];
      for (const entry of page.records) {
        if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= previous || entry.sequence > page.next_cursor ||
            entry.envelope.account_id !== state.credentials.account_id) throw new Error('Invalid record sequence or account.');
        previous = entry.sequence;
        records.push({ operation_id: entry.envelope.operation_id, envelope: entry.envelope,
          payload: await decryptDiagnostic(state.recovery_key, entry.envelope), sequence: entry.sequence });
      }
      if ((page.records.length === 0 && page.next_cursor !== state.cursor) ||
          (page.records.length > 0 && previous !== page.next_cursor) || (page.has_more && page.records.length === 0)) {
        throw new Error('Server cursor skipped unprocessed records.');
      }
      // Decrypt outside the transaction; no cursor moves on authentication/decryption failure.
      await this.db.transaction('rw', this.db.records, this.db.state, async () => {
        await this.db.records.bulkPut(records);
        await this.db.state.update('local', { cursor: page.next_cursor, server_epoch: page.server_epoch });
      });
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
      const batch = await this.db.outbox.orderBy('counter').limit(MAX_BATCH).toArray();
      if (batch.length === 0) break;
      const reply = await transport.push(batch, (await this.db.state.get('local'))!.server_epoch!);
      checkEpoch((await this.db.state.get('local'))!, reply.server_epoch);
      const expected = new Set(batch.map(e => e.operation_id));
      if (!Array.isArray(reply.acknowledgements) || reply.acknowledgements.length !== expected.size) throw new Error('Incomplete acknowledgement.');
      for (const ack of reply.acknowledgements) {
        if (!expected.delete(ack.operation_id) || !Number.isSafeInteger(ack.sequence) || ack.sequence <= 0) throw new Error('Invalid acknowledgement.');
      }
      await this.db.transaction('rw', this.db.outbox, this.db.records, async () => {
        for (const ack of reply.acknowledgements) {
          await this.db.records.update(ack.operation_id, { sequence: ack.sequence });
          await this.db.outbox.delete(ack.operation_id);
        }
      });
    }
    await this.pull(transport);
    if (await this.db.outbox.count()) throw new Error('More pending work remains. Sync again to continue.');
    await this.db.state.update('local', { last_synced: new Date().toISOString() });
  }
}
