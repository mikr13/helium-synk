import Dexie from 'dexie';
import type { SynkDatabase } from './database';

const DAY = 86_400_000;
export interface HistoryRetentionPolicy {
  enabled: boolean;
  days: number;
}
export const DEFAULT_HISTORY_RETENTION: Readonly<HistoryRetentionPolicy> = {
  enabled: false,
  days: 90,
};
export interface HistoryRetentionProgress {
  visited_at: number;
  id: string;
}
export function historyRetentionPolicy(value: unknown): HistoryRetentionPolicy {
  const policy = value as HistoryRetentionPolicy;
  if (
    !policy ||
    Object.keys(policy).length !== 2 ||
    typeof policy.enabled !== 'boolean' ||
    !Number.isSafeInteger(policy.days) ||
    policy.days < 1 ||
    policy.days > 3650
  )
    throw new Error('Choose a history retention period from 1 to 3,650 days.');
  return { ...policy };
}
/** Owner-driven expiry creates ordinary permanent deletion proofs; pending copies are protected. */
export async function expireHistory(db: SynkDatabase, now = Date.now()) {
  if (!Number.isFinite(now) || now < 0 || now > 8_640_000_000_000_000)
    throw new Error('Invalid history retention time.');
  return db.transaction(
    'rw',
    [
      ...db.captureBudgetTables(),
      db.historyReplicas,
      db.historyVisits,
      ...db.historyCaptureTables(),
    ],
    async () => {
      const local = await db.state.get('local');
      const policy = historyRetentionPolicy(local?.history_retention ?? DEFAULT_HISTORY_RETENTION);
      if (!local || !policy.enabled) return { examined: 0, expired: 0, protected: 0, more: false };
      const cutoff = Math.max(0, now - policy.days * DAY);
      const source = local.credentials.device_id;
      const cursor =
        local.history_retention_cursor && local.history_retention_cursor.visited_at < cutoff
          ? local.history_retention_cursor
          : undefined;
      const rows = await db.historyVisits
        .where('[source_id+visited_at+id]')
        .between(
          [source, cursor?.visited_at ?? 0, cursor?.id ?? Dexie.minKey],
          [source, cutoff, Dexie.minKey],
          !cursor,
          false,
        )
        .limit(500)
        .toArray();
      if (!rows.length) {
        await db.state.update('local', {
          history_retention_cursor: undefined,
          history_retention_last: { at: now, examined: 0, expired: 0, protected: 0 },
        });
        return { examined: 0, expired: 0, protected: 0, more: false };
      }

      // The same native identity may have more than one journal copy. One unacknowledged
      // copy protects all of them, even when the visible projection points to an older ACK.
      const outgoing = new Set(await db.outbox.toCollection().primaryKeys());
      const protectedIds = new Set<string>();
      await db.drafts
        .where('header.domain')
        .equals('history')
        .each((record) => {
          if (record.payload.kind === 'history' && record.payload.action.type === 'visit')
            protectedIds.add(record.payload.action.visit.id);
        });
      await db.operations
        .where('envelope.domain')
        .equals('history')
        .each((record) => {
          if (
            record.payload.kind === 'history' &&
            record.payload.action.type === 'visit' &&
            (record.sequence === undefined || outgoing.has(record.operation_id))
          )
            protectedIds.add(record.payload.action.visit.id);
        });
      const ids: string[] = [];
      let examined = 0,
        protectedCount = 0;
      for (const visit of rows) {
        examined++;
        const record = await db.operations.get(visit.operation_id);
        if (
          protectedIds.has(visit.id) ||
          !record ||
          record.payload.kind !== 'history' ||
          record.payload.action.type !== 'visit' ||
          record.payload.action.visit.id !== visit.id ||
          !Number.isSafeInteger(record.sequence) ||
          record.sequence! <= 0
        )
          protectedCount++;
        else ids.push(visit.id);
        if (ids.length === 100) break;
      }
      if (ids.length)
        await db.stageHistories(
          [ids.slice(0, 80), ids.slice(80)]
            .filter((visit_ids) => visit_ids.length)
            .map((visit_ids) => ({ type: 'delete', visit_ids })),
        );
      const last = rows[examined - 1];
      const more = examined < rows.length || rows.length === 500;
      await db.state.update('local', {
        history_retention_cursor:
          more && last ? { visited_at: last.visited_at, id: last.id } : undefined,
        history_retention_last: {
          at: now,
          examined,
          expired: ids.length,
          protected: protectedCount,
        },
      });
      return { examined, expired: ids.length, protected: protectedCount, more };
    },
  );
}
