import Dexie, { type Table } from 'dexie';
import type { PairingCandidate } from './pairing';
import {
  parseKeyRing,
  type EnrollmentKeys,
  type KeySecrets,
  type RotationPending,
} from './key-state';
import type {
  HistorySetup,
  HistoryInbox,
  HistorySeen,
  HistoryScan,
  HistoryLookup,
  HistoryUrlEpoch,
  HistoryScanUrl,
} from './history-native';
import type { SessionRestoreJob } from './session-restore';
import {
  encryptDiagnostic,
  encryptPayload,
  validateRecoveryKey,
  deriveHistoryIndexKey,
} from './crypto';
import {
  projectHistory,
  validHistoryVisitId,
  type HistoryOperation,
  type HistoryAction,
  type HistoryProjection,
  type HistoryVisit,
} from './history';
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
import {
  splitSession,
  projectSessions,
  type SessionContent,
  type SessionPart,
  type SessionProjection,
} from './sessions';
import { validatePayload, type EnvelopeHeader } from './payload';
import { canonicalUuid, type VectorClock, type Revision } from './revision';
import type {
  SessionSetup,
  SessionIdentity,
  SessionWindowCache,
  SessionClosedSeen,
} from './session-native';
import type {
  BookmarkBinding,
  BookmarkEffect,
  BookmarkInbox,
  BookmarkSetup,
} from './bookmark-native';

export interface LocalState {
  id: 'local';
  credentials: Credentials;
  recovery_key: string;
  key_epoch?: number;
  next_counter: number;
  cursor: number;
  /** Confirmed relay ACK of the durable journal cursor; never native browser application. */
  acknowledged_cursor?: number;
  server_epoch?: string;
  last_synced?: string;
  logical?: number;
  context?: VectorClock;
  history_index_key?: string;
  history_logical?: number;
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
  payload: BookmarkOperation | SessionPart | HistoryOperation;
  sequence?: number;
}
export interface DraftOperation {
  operation_id: string;
  header: EnvelopeHeader;
  payload: BookmarkOperation | SessionPart | HistoryOperation;
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
  pairingPending!: Table<PairingCandidate, string>;
  keySecrets!: Table<KeySecrets, string>;
  rotationPending!: Table<RotationPending, string>;
  outbox!: Table<Envelope, string>;
  records!: Table<LocalRecord, string>;
  operations!: Table<StoredOperation, string>;
  drafts!: Table<DraftOperation, string>;
  replicas!: Table<Replica, string>;
  quarantine!: Table<QuarantinedRecord, string>;
  sessionReplicas!: Table<{ id: 'session'; value: SessionProjection }, string>;
  sessionSetup!: Table<SessionSetup, string>;
  sessionRestores!: Table<SessionRestoreJob, string>;
  sessionIdentities!: Table<SessionIdentity, string>;
  sessionWindows!: Table<SessionWindowCache, number>;
  sessionClosedSeen!: Table<SessionClosedSeen, string>;
  bookmarkSetup!: Table<BookmarkSetup, string>;
  bookmarkBindings!: Table<BookmarkBinding, string>;
  bookmarkInbox!: Table<BookmarkInbox, number>;
  bookmarkEffects!: Table<BookmarkEffect, string>;
  historyReplicas!: Table<{ id: 'history'; value: Omit<HistoryProjection, 'visits'> }, string>;
  historyVisits!: Table<HistoryVisit & { operation_id: string }, string>;
  historySetup!: Table<HistorySetup, string>;
  historyInbox!: Table<HistoryInbox, number>;
  historySeen!: Table<HistorySeen, string>;
  historyScans!: Table<HistoryScan, string>;
  historyLookups!: Table<HistoryLookup, string>;
  historyUrlEpochs!: Table<HistoryUrlEpoch, string>;
  historyScanUrls!: Table<HistoryScanUrl, string>;
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
    this.version(3).stores({
      bookmarkSetup: 'id',
      bookmarkBindings: 'logical_id, &native_id',
      bookmarkInbox: '++id, native_id',
      bookmarkEffects: 'id, status, native_id',
    });
    this.version(4).stores({
      drafts: 'operation_id, header.counter, header.domain',
      sessionReplicas: 'id',
      sessionSetup: 'id',
      sessionRestores: 'id, status, created_at',
      sessionIdentities: 'key, &logical_id',
      sessionWindows: 'runtime_id',
      sessionClosedSeen: 'id, fingerprint',
    });
    this.version(5).stores({
      historyReplicas: 'id',
      historySetup: 'id',
      historyInbox: '++id',
      historySeen: 'id, url_tag',
      historyScans: 'id, created_at',
      historyLookups: 'id, job_id',
      historyUrlEpochs: 'url_tag',
      historyScanUrls: 'id, job_id',
      historyVisits:
        'id, [visited_at+id], [source_id+visited_at+id], [source_id+url_tag], url_tag, source_id',
    });
    this.version(6).stores({ pairingPending: 'id' });
    this.version(7).stores({ keySecrets: 'id', rotationPending: 'id' });
  }
  async enroll(
    credentials: Credentials,
    recoveryKey: string,
    historyIndexKey?: string,
    keys?: EnrollmentKeys,
  ): Promise<void> {
    const parsed = parseCredentials(credentials);
    validateRecoveryKey(recoveryKey);
    const indexKey =
      historyIndexKey ?? (await deriveHistoryIndexKey(recoveryKey, parsed.account_id));
    validateRecoveryKey(indexKey);
    const ring = parseKeyRing(keys ?? { key_epoch: 1, roots: { 1: recoveryKey } });
    if (
      ring.roots[ring.key_epoch] !== recoveryKey ||
      (keys?.server_epoch && !canonicalUuid(keys.server_epoch))
    )
      throw new Error('Enrollment keys are inconsistent.');
    await this.transaction('rw', [this.state, this.pairingPending, this.keySecrets], async () => {
      if (await this.pairingPending.get('pairing'))
        throw new Error('Retry the pending pairing claim first.');
      if (await this.state.get('local')) throw new Error('This profile is already enrolled.');
      await this.state.add({
        id: 'local',
        credentials: parsed,
        recovery_key: recoveryKey,
        key_epoch: ring.key_epoch,
        server_epoch: keys?.server_epoch,
        history_index_key: indexKey,
        next_counter: 1,
        cursor: 0,
        acknowledged_cursor: 0,
        logical: 0,
        context: {},
      });
      await this.keySecrets.add({
        id: 'keys',
        account_id: parsed.account_id,
        device_id: parsed.device_id,
        server_epoch: keys?.server_epoch,
        roots: ring.roots,
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
        key_epoch: state.key_epoch ?? 1,
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
  async reserveBookmarkClocks(count: number): Promise<Revision[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 10000)
      throw new Error('Invalid capture clock reservation.');
    return this.transaction('rw', this.state, async () => {
      const local = await this.state.get('local');
      if (!local) throw new Error('Connect this device first.');
      let counter = local.next_counter,
        logical = local.logical ?? 0;
      const revisions: Revision[] = [];
      for (let i = 0; i < count; i++) {
        logical = Math.max(logical + 1, counter);
        if (!Number.isSafeInteger(logical) || counter >= Number.MAX_SAFE_INTEGER)
          throw new Error('Logical clock exhausted.');
        revisions.push({
          author: local.credentials.device_id,
          counter: counter++,
          logical,
          context: { ...local.context },
        });
      }
      await this.state.update('local', { next_counter: counter, logical });
      return revisions;
    });
  }
  async stageBookmark(
    action: BookmarkAction,
    observedContext?: VectorClock,
    reserved?: Revision[],
  ): Promise<string> {
    return (await this.stageBookmarks([action], observedContext, reserved))[0]!;
  }
  /** Batch capture/import commits once, without replaying the entire journal for every node. */
  async stageBookmarks(
    actions: readonly BookmarkAction[],
    observedContext?: VectorClock,
    reserved?: Revision[],
  ): Promise<string[]> {
    if (!actions.length) return [];
    if (reserved && reserved.length < actions.length)
      throw new Error('Captured revision reservation is too small.');
    return this.transaction(
      'rw',
      [this.state, this.operations, this.drafts, this.replicas],
      async () => {
        const local = await this.state.get('local');
        if (!local) throw new Error('Connect this device first.');
        let counter = local.next_counter,
          logical = local.logical ?? 0;
        const context = { ...(observedContext ?? local.context) };
        const drafts: (DraftOperation & { payload: BookmarkOperation })[] = [];
        for (let index = 0; index < actions.length; index++) {
          const action = actions[index]!;
          let revision: Revision;
          if (reserved) {
            revision = structuredClone(reserved[index]!);
            if (
              revision.author !== local.credentials.device_id ||
              revision.counter >= local.next_counter
            )
              throw new Error('Invalid captured revision.');
            if (index > 0) revision.context[revision.author] = reserved[index - 1]!.counter;
          } else {
            logical = Math.max(logical + 1, counter);
            if (!Number.isSafeInteger(logical) || counter >= Number.MAX_SAFE_INTEGER)
              throw new Error('Logical clock exhausted.');
            revision = {
              author: local.credentials.device_id,
              counter: counter++,
              logical,
              context: { ...context },
            };
            context[revision.author] = revision.counter;
          }
          const operation_id = crypto.randomUUID();
          const header: EnvelopeHeader = {
            protocol_version: 1,
            operation_id,
            account_id: local.credentials.account_id,
            device_id: revision.author,
            counter: revision.counter,
            domain: 'bookmark',
            key_epoch: local.key_epoch ?? 1,
          };
          const payload: BookmarkOperation = {
            kind: 'bookmark',
            schema_version: 1,
            operation_id,
            revision,
            action: structuredClone(action),
          };
          validatePayload(payload, header);
          drafts.push({ operation_id, header, payload });
        }
        const value = projectBookmarks([
          ...(await this.bookmarkOperations()),
          ...drafts.map((d) => d.payload),
        ]);
        await this.drafts.bulkAdd(drafts);
        await this.replicas.put({ domain: 'bookmark', value });
        await this.state.update('local', {
          next_counter: counter,
          logical: Math.max(logical, value.logical),
          context: value.frontier,
        });
        return drafts.map((d) => d.operation_id);
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
    if (!(await this.state.get('local'))) return;
    const drafts = await this.drafts.orderBy('header.counter').limit(MAX_BATCH).toArray();
    for (const draft of drafts) {
      const local = (await this.state.get('local'))!;
      // Unencrypted drafts have never entered the relay, so adopt the current epoch directly.
      const header = { ...draft.header, key_epoch: local.key_epoch ?? 1 };
      const envelope = await encryptPayload(
        local.recovery_key,
        header,
        draft.payload,
        local.history_index_key,
      );
      await this.transaction(
        'rw',
        [this.state, this.drafts, this.operations, this.outbox],
        async () => {
          // Another worker/database instance may have committed ciphertext while encryption was running.
          const saved = await this.drafts.get(draft.operation_id);
          if (!saved || JSON.stringify(saved) !== JSON.stringify(draft)) return;
          if (((await this.state.get('local'))?.key_epoch ?? 1) !== header.key_epoch) return;
          await this.operations.add({
            operation_id: draft.operation_id,
            envelope,
            payload: draft.payload,
          });
          await this.outbox.add(envelope);
          await this.drafts.delete(draft.operation_id);
        },
      );
    }
  }
  async bookmarkOperations(): Promise<BookmarkOperation[]> {
    return this.transaction('r', [this.operations, this.drafts], async () => [
      ...(await this.operations.where('envelope.domain').equals('bookmark').toArray()).map(
        (o) => o.payload as BookmarkOperation,
      ),
      ...(await this.drafts.toArray())
        .map((d) => d.payload)
        .filter((p): p is BookmarkOperation => p.kind === 'bookmark'),
    ]);
  }
  async sessionParts(): Promise<SessionPart[]> {
    return this.transaction('r', [this.operations, this.drafts], async () => [
      ...(await this.operations.where('envelope.domain').equals('session').toArray()).map(
        (o) => o.payload as SessionPart,
      ),
      ...(await this.drafts.where('header.domain').equals('session').toArray()).map(
        (d) => d.payload as SessionPart,
      ),
    ]);
  }
  async sessionProjection(): Promise<SessionProjection> {
    return (await this.sessionReplicas.get('session'))?.value ?? projectSessions([]);
  }
  async stageSession(content: SessionContent): Promise<string> {
    return this.transaction(
      'rw',
      [this.state, this.operations, this.drafts, this.sessionReplicas],
      async () => {
        const local = await this.state.get('local');
        if (!local) throw new Error('Connect this device first.');
        const snapshot = {
          ...structuredClone(content),
          id: crypto.randomUUID(),
          source_id: local.credentials.device_id,
          source_name: local.credentials.name,
          source_revision: local.next_counter,
        };
        const parts = splitSession(snapshot);
        if (local.next_counter + parts.length >= Number.MAX_SAFE_INTEGER)
          throw new Error('Device counter exhausted.');
        if (content.kind === 'current') {
          const drafts = (
            await this.drafts.where('header.domain').equals('session').toArray()
          ).filter((d) => d.payload.kind === 'session' && d.payload.snapshot_kind === 'current');
          const persisted = new Set(
            (await this.operations.where('envelope.domain').equals('session').toArray()).map(
              (o) => (o.payload as SessionPart).snapshot_id,
            ),
          );
          // Coalesce only wholly unencrypted current snapshots; never mutate ciphertext, closed or saved snapshots.
          await this.drafts.bulkDelete(
            drafts
              .filter((d) => !persisted.has((d.payload as SessionPart).snapshot_id))
              .map((d) => d.operation_id),
          );
        }
        const drafts = parts.map((payload) => ({
          operation_id: payload.operation_id,
          payload,
          header: {
            protocol_version: 1 as const,
            operation_id: payload.operation_id,
            account_id: local.credentials.account_id,
            device_id: local.credentials.device_id,
            counter: payload.source_revision + payload.part,
            domain: 'session' as const,
            key_epoch: local.key_epoch ?? 1,
          },
        }));
        for (const d of drafts) validatePayload(d.payload, d.header);
        const projection = projectSessions([...(await this.sessionParts()), ...parts]);
        await this.drafts.bulkAdd(drafts);
        await this.sessionReplicas.put({ id: 'session', value: projection });
        await this.state.update('local', { next_counter: local.next_counter + parts.length });
        return snapshot.id;
      },
    );
  }
  async ensureHistoryIndexKey(): Promise<string> {
    const local = await this.state.get('local');
    if (!local) throw new Error('Connect this device first.');
    if (local.history_index_key) return local.history_index_key;
    const key = await deriveHistoryIndexKey(local.recovery_key, local.credentials.account_id);
    return this.transaction('rw', this.state, async () => {
      const current = (await this.state.get('local'))!;
      if (current.history_index_key) return current.history_index_key;
      await this.state.update('local', { history_index_key: key });
      return key;
    });
  }
  async historyOperations(): Promise<HistoryOperation[]> {
    return this.transaction('r', [this.operations, this.drafts], async () => [
      ...(await this.operations.where('envelope.domain').equals('history').toArray()).map(
        (o) => o.payload as HistoryOperation,
      ),
      ...(await this.drafts.where('header.domain').equals('history').toArray()).map(
        (o) => o.payload as HistoryOperation,
      ),
    ]);
  }
  async historyMetadata(): Promise<Omit<HistoryProjection, 'visits'>> {
    const old = await this.historyReplicas.get('history');
    if (old) return old.value;
    const { visits: _visits, ...metadata } = projectHistory([]);
    return metadata;
  }
  async historyProjection(): Promise<HistoryProjection> {
    return this.transaction('r', [this.historyReplicas, this.historyVisits], async () => ({
      ...(await this.historyMetadata()),
      visits: Object.fromEntries((await this.historyVisits.toArray()).map((v) => [v.id, v])),
    }));
  }
  /** Caller transaction includes history tables. Rewrite only changed rows, keeping the timeline index small. */
  async persistHistory(projection: HistoryProjection): Promise<void> {
    const existing = new Map((await this.historyVisits.toArray()).map((v) => [v.id, v]));
    await this.historyVisits.bulkDelete(
      [...existing.keys()].filter((id) => !projection.visits[id]),
    );
    await this.historyVisits.bulkPut(
      Object.values(projection.visits).filter(
        (v) => JSON.stringify(existing.get(v.id)) !== JSON.stringify(v),
      ),
    );
    const { visits: _visits, ...value } = projection;
    await this.historyReplicas.put({ id: 'history', value });
  }
  async stageHistory(action: HistoryAction, observedContext?: VectorClock): Promise<string> {
    return (await this.stageHistories([action], observedContext))[0]!;
  }
  async stageHistories(actions: HistoryAction[], observedContext?: VectorClock): Promise<string[]> {
    if (!actions.length || actions.length > MAX_BATCH)
      throw new Error('Invalid history capture batch.');
    return this.transaction(
      'rw',
      [this.state, this.operations, this.drafts, this.historyReplicas, this.historyVisits],
      async () => {
        const local = await this.state.get('local');
        if (!local) throw new Error('Connect this device first.');
        const old = await this.historyMetadata();
        let counter = local.next_counter,
          logical = Math.max(local.history_logical ?? 0, old.logical);
        const context = { ...(observedContext ?? old.frontier) },
          drafts: DraftOperation[] = [];
        for (const action of actions) {
          if (counter >= Number.MAX_SAFE_INTEGER) throw new Error('Device counter exhausted.');
          logical = Math.max(logical + 1, counter);
          if (!Number.isSafeInteger(logical)) throw new Error('History logical clock exhausted.');
          const operation_id = crypto.randomUUID(),
            revision = {
              author: local.credentials.device_id,
              counter: counter++,
              logical,
              context: { ...context },
            };
          const payload: HistoryOperation = {
            kind: 'history',
            schema_version: 1,
            operation_id,
            revision,
            action: structuredClone(action),
          };
          const header: EnvelopeHeader = {
            protocol_version: 1,
            operation_id,
            account_id: local.credentials.account_id,
            device_id: revision.author,
            counter: revision.counter,
            domain: 'history',
            key_epoch: local.key_epoch ?? 1,
          };
          validatePayload(payload, header);
          drafts.push({ operation_id, header, payload });
          context[revision.author] = revision.counter;
        }
        const projection = projectHistory([
          ...(await this.historyOperations()),
          ...drafts.map((d) => d.payload as HistoryOperation),
        ]);
        await this.drafts.bulkAdd(drafts);
        await this.persistHistory(projection);
        await this.state.update('local', { next_counter: counter, history_logical: logical });
        return drafts.map((d) => d.operation_id);
      },
    );
  }
  async localHistoryUrls(source: string, after?: string) {
    const keys = await this.historyVisits
      .where('[source_id+url_tag]')
      .between([source, after ?? Dexie.minKey], [source, Dexie.maxKey], !after, true)
      .limit(51)
      .uniqueKeys();
    const tags = keys.map((key) => {
      if (!Array.isArray(key) || typeof key[1] !== 'string')
        throw new Error('Invalid local history URL index.');
      return key[1];
    });
    const items: (HistoryVisit & { operation_id: string })[] = [];
    for (const tag of tags.slice(0, 50)) {
      const visit = await this.historyVisits
        .where('[source_id+url_tag]')
        .equals([source, tag])
        .first();
      if (visit) items.push(visit);
    }
    return { items, has_more: tags.length > 50, cursor: tags[Math.min(50, tags.length) - 1] };
  }
  async historySources(): Promise<{ id: string; name: string }[]> {
    const ids = await this.historyVisits.orderBy('source_id').uniqueKeys();
    const sources: { id: string; name: string }[] = [];
    for (const id of ids.slice(0, 256)) {
      const visit = await this.historyVisits.where('source_id').equals(id).first();
      if (visit) sources.push({ id: visit.source_id, name: visit.source_name });
    }
    return sources;
  }
  /** Bounded indexed scan. Resume after the last examined row, including rows excluded by filters. */
  async queryHistory(
    query: {
      text?: string;
      source_id?: string;
      start_time?: number;
      end_time?: number;
      limit?: number;
      cursor?: { visited_at: number; id: string };
    } = {},
  ) {
    const limit = query.limit ?? 100,
      start = query.start_time ?? 0,
      end = query.end_time ?? 8_640_000_000_000_000;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start < 0 ||
      end < start ||
      end > 8_640_000_000_000_000 ||
      (query.text !== undefined && (typeof query.text !== 'string' || query.text.length > 1000)) ||
      (query.source_id !== undefined && !canonicalUuid(query.source_id)) ||
      (query.cursor &&
        (!Number.isFinite(query.cursor.visited_at) ||
          query.cursor.visited_at < start ||
          query.cursor.visited_at > end ||
          !validHistoryVisitId(query.cursor.id)))
    )
      throw new Error('Invalid history query.');
    if (start === end) return { visits: [], examined: 0, has_more: false, cursor: undefined };
    if (query.source_id && query.cursor && !query.cursor.id.startsWith(query.source_id + '/'))
      throw new Error('History cursor does not match its source.');
    const prefix = query.source_id ? [query.source_id] : [];
    const lower = [...prefix, start, Dexie.minKey],
      upper = query.cursor
        ? [...prefix, query.cursor.visited_at, query.cursor.id]
        : [...prefix, end, query.end_time === undefined ? Dexie.maxKey : Dexie.minKey];
    const rows = await this.historyVisits
      .where(query.source_id ? '[source_id+visited_at+id]' : '[visited_at+id]')
      .between(lower, upper, true, !query.cursor && query.end_time === undefined)
      .reverse()
      .limit(2000)
      .toArray();
    const text = (query.text ?? '').trim().toLowerCase(),
      visits = [];
    let examined = 0;
    for (const row of rows) {
      examined++;
      if (
        !text ||
        row.url.toLowerCase().includes(text) ||
        row.title.toLowerCase().includes(text) ||
        row.source_name.toLowerCase().includes(text)
      )
        visits.push(row);
      if (visits.length === limit) break;
    }
    const last = rows[examined - 1],
      has_more = examined < rows.length || rows.length === 2000;
    return {
      visits,
      examined,
      has_more,
      cursor: has_more && last ? { visited_at: last.visited_at, id: last.id } : undefined,
    };
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
        this.sessionReplicas,
        this.sessionSetup,
        this.sessionIdentities,
        this.sessionWindows,
        this.sessionClosedSeen,
        this.sessionRestores,
        this.historyReplicas,
        this.historyVisits,
        this.historySetup,
        this.historyInbox,
        this.historySeen,
        this.historyScans,
        this.historyLookups,
        this.historyUrlEpochs,
        this.historyScanUrls,
        this.bookmarkSetup,
        this.bookmarkBindings,
        this.bookmarkInbox,
        this.bookmarkEffects,
      ],
      async () => {
        const state = await this.state.get('local');
        if (!state) throw new Error('Connect this device first.');
        // No API token or root key in ordinary logical-state exports. Recovery-key export is separate.
        const {
          credentials,
          recovery_key: _key,
          history_index_key: _indexKey,
          ...progress
        } = state;
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
          sessions: await this.sessionReplicas.toArray(),
          session_setup: await this.sessionSetup.toArray(),
          session_identities: await this.sessionIdentities.toArray(),
          session_windows: await this.sessionWindows.toArray(),
          session_closed_seen: await this.sessionClosedSeen.toArray(),
          session_restores: await this.sessionRestores.toArray(),
          history_metadata: await this.historyReplicas.toArray(),
          history_visits: await this.historyVisits.toArray(),
          history_setup: await this.historySetup.toArray(),
          history_inbox: await this.historyInbox.toArray(),
          history_seen: await this.historySeen.toArray(),
          history_scans: await this.historyScans.toArray(),
          history_lookups: await this.historyLookups.toArray(),
          history_url_epochs: await this.historyUrlEpochs.toArray(),
          history_scan_urls: await this.historyScanUrls.toArray(),
          bookmark_setup: await this.bookmarkSetup.toArray(),
          bookmark_bindings: await this.bookmarkBindings.toArray(),
          bookmark_inbox: await this.bookmarkInbox.toArray(),
          bookmark_effects: await this.bookmarkEffects.toArray(),
        };
      },
    );
  }
}
