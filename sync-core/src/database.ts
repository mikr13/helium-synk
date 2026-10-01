import Dexie, { type Table } from 'dexie';
import { encryptDiagnostic, encryptPayload, validateRecoveryKey } from './crypto';
import {
  parseCredentials,
  MAX_BATCH,
  type Credentials,
  type Diagnostic,
  type Envelope,
} from './protocol';
import {
  projectBookmarks,
  type BookmarkAction,
  type BookmarkOperation,
  type BookmarkProjection,
} from './bookmarks';
import { validatePayload, type EnvelopeHeader } from './payload';
import type { VectorClock } from './revision';

export interface LocalState {
  id: 'local';
  credentials: Credentials;
  recovery_key: string;
  next_counter: number;
  cursor: number;
  server_epoch?: string;
  last_synced?: string;
  logical?: number;
  context?: VectorClock;
}
export interface LocalRecord {
  operation_id: string;
  envelope: Envelope;
  payload: Diagnostic;
  sequence?: number;
}
export interface StoredOperation {
  operation_id: string;
  envelope: Envelope;
  payload: BookmarkOperation;
  sequence?: number;
}
export interface DraftOperation {
  operation_id: string;
  header: EnvelopeHeader;
  payload: BookmarkOperation;
}
export interface Replica {
  domain: 'bookmark';
  value: BookmarkProjection;
}
export interface QuarantinedRecord {
  operation_id: string;
  sequence: number;
  envelope: Envelope;
  reason: string;
}
export class SynkDatabase extends Dexie {
  state!: Table<LocalState, string>;
  outbox!: Table<Envelope, string>;
  records!: Table<LocalRecord, string>;
  operations!: Table<StoredOperation, string>;
  drafts!: Table<DraftOperation, string>;
  replicas!: Table<Replica, string>;
  quarantine!: Table<QuarantinedRecord, string>;
  private encrypting?: Promise<void>;

  constructor(name = 'helium-synk-v1') {
    super(name);
    this.version(1).stores({
      state: 'id',
      outbox: 'operation_id, counter',
      records: 'operation_id, sequence, envelope.device_id',
    });
    this.version(2).stores({
      operations: 'operation_id, sequence, envelope.domain, envelope.device_id',
      drafts: 'operation_id, header.counter',
      replicas: 'domain',
      quarantine: 'operation_id, sequence',
    });
  }
  async enroll(credentials: Credentials, recoveryKey: string): Promise<void> {
    const parsed = parseCredentials(credentials);
    validateRecoveryKey(recoveryKey);
    await this.transaction('rw', this.state, async () => {
      if (await this.state.get('local')) throw new Error('This profile is already enrolled.');
      await this.state.add({
        id: 'local',
        credentials: parsed,
        recovery_key: recoveryKey,
        next_counter: 1,
        cursor: 0,
        logical: 0,
        context: {},
      });
    });
  }
  async queueDiagnostic(note: string): Promise<string> {
    if (!note.trim() || note.length > 2_000)
      throw new Error('Enter a test note of up to 2,000 characters.');
    const state = await this.transaction('rw', this.state, async () => {
      const current = await this.state.get('local');
      if (!current) throw new Error('Connect this device first.');
      if (current.next_counter >= Number.MAX_SAFE_INTEGER)
        throw new Error('Device counter exhausted.');
      await this.state.update('local', { next_counter: current.next_counter + 1 });
      return current;
    });
    const payload: Diagnostic = {
      kind: 'diagnostic',
      note: note.trim(),
      created_at: new Date().toISOString(),
    };
    const envelope = await encryptDiagnostic(
      state.recovery_key,
      {
        protocol_version: 1,
        operation_id: crypto.randomUUID(),
        account_id: state.credentials.account_id,
        device_id: state.credentials.device_id,
        counter: state.next_counter,
        domain: 'diagnostic',
        key_epoch: 1,
      },
      payload,
    );
    await this.transaction('rw', this.records, this.outbox, async () => {
      await this.records.add({ operation_id: envelope.operation_id, envelope, payload });
      await this.outbox.add(envelope);
    });
    return envelope.operation_id;
  }
  /** Persist capture intent and logical state before async encryption; startup resumes any draft. */
  async stageBookmark(action: BookmarkAction): Promise<string> {
    return this.transaction(
      'rw',
      [this.state, this.operations, this.drafts, this.replicas],
      async () => {
        const local = await this.state.get('local');
        if (!local) throw new Error('Connect this device first.');
        const counter = local.next_counter;
        const logical = Math.max((local.logical ?? 0) + 1, counter);
        if (!Number.isSafeInteger(logical) || counter >= Number.MAX_SAFE_INTEGER)
          throw new Error('Logical clock exhausted.');
        const operation_id = crypto.randomUUID();
        const header: EnvelopeHeader = {
          protocol_version: 1,
          operation_id,
          account_id: local.credentials.account_id,
          device_id: local.credentials.device_id,
          counter,
          domain: 'bookmark',
          key_epoch: 1,
        };
        const payload: BookmarkOperation = {
          kind: 'bookmark',
          schema_version: 1,
          operation_id,
          revision: { author: header.device_id, counter, logical, context: { ...local.context } },
          action: structuredClone(action),
        };
        validatePayload(payload, header);
        const previous = await this.bookmarkOperations();
        const value = projectBookmarks([...previous, payload]);
        await this.drafts.add({ operation_id, header, payload });
        await this.replicas.put({ domain: 'bookmark', value });
        await this.state.update('local', {
          next_counter: counter + 1,
          logical,
          context: value.frontier,
        });
        return operation_id;
      },
    );
  }
  async queueBookmark(action: BookmarkAction): Promise<string> {
    const id = await this.stageBookmark(action);
    await this.flushDrafts();
    return id;
  }
  flushDrafts(): Promise<void> {
    if (this.encrypting) return this.encrypting;
    this.encrypting = this.prepareDrafts().finally(() => {
      this.encrypting = undefined;
    });
    return this.encrypting;
  }
  private async prepareDrafts(): Promise<void> {
    const local = await this.state.get('local');
    if (!local) return;
    const drafts = await this.drafts.orderBy('header.counter').limit(MAX_BATCH).toArray();
    for (const draft of drafts) {
      const envelope = await encryptPayload(local.recovery_key, draft.header, draft.payload);
      await this.transaction('rw', [this.drafts, this.operations, this.outbox], async () => {
        // Another worker/database instance may have committed ciphertext while encryption was running.
        if (!(await this.drafts.get(draft.operation_id))) return;
        await this.operations.add({
          operation_id: draft.operation_id,
          envelope,
          payload: draft.payload,
        });
        await this.outbox.add(envelope);
        await this.drafts.delete(draft.operation_id);
      });
    }
  }
  async bookmarkOperations(): Promise<BookmarkOperation[]> {
    return this.transaction('r', [this.operations, this.drafts], async () => [
      ...(await this.operations.where('envelope.domain').equals('bookmark').toArray()).map(
        (o) => o.payload,
      ),
      ...(await this.drafts.toArray()).map((d) => d.payload),
    ]);
  }
  async bookmarkProjection(): Promise<BookmarkProjection> {
    return (await this.replicas.get('bookmark'))?.value ?? projectBookmarks([]);
  }
  async pendingCount(): Promise<number> {
    return this.transaction(
      'r',
      [this.outbox, this.drafts],
      async () => (await this.outbox.count()) + (await this.drafts.count()),
    );
  }
  async exportReplica(): Promise<unknown> {
    return this.transaction(
      'r',
      [
        this.state,
        this.records,
        this.operations,
        this.drafts,
        this.outbox,
        this.replicas,
        this.quarantine,
      ],
      async () => {
        const state = await this.state.get('local');
        if (!state) throw new Error('Connect this device first.');
        // No API token or root key in ordinary logical-state exports. Recovery-key export is separate.
        const { credentials, recovery_key: _key, ...progress } = state;
        return {
          format: 'helium-synk-replica',
          version: 1,
          account_id: credentials.account_id,
          device_id: credentials.device_id,
          progress,
          records: await this.records.toArray(),
          operations: await this.operations.toArray(),
          drafts: await this.drafts.toArray(),
          outbox: await this.outbox.toArray(),
          replicas: await this.replicas.toArray(),
          quarantine: await this.quarantine.toArray(),
        };
      },
    );
  }
}
