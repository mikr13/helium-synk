import type { SynkDatabase } from './database';
import type { SessionExpirationTarget, SessionProjection, SessionSnapshot } from './sessions';

const DAY = 86_400_000;
export interface SessionRetentionPolicy {
  enabled: boolean;
  days: number;
  max_archives: number;
  max_bytes: number;
}
export const DEFAULT_SESSION_RETENTION: Readonly<SessionRetentionPolicy> = {
  enabled: false,
  days: 30,
  max_archives: 100,
  max_bytes: 50 * 1024 * 1024,
};
export function sessionRetentionPolicy(value: unknown): SessionRetentionPolicy {
  const policy = value as SessionRetentionPolicy;
  if (
    !policy ||
    Object.keys(policy).length !== 4 ||
    typeof policy.enabled !== 'boolean' ||
    !Number.isSafeInteger(policy.days) ||
    policy.days < 1 ||
    policy.days > 3650 ||
    !Number.isSafeInteger(policy.max_archives) ||
    policy.max_archives < 1 ||
    policy.max_archives > 10_000 ||
    !Number.isSafeInteger(policy.max_bytes) ||
    policy.max_bytes < 1024 * 1024 ||
    policy.max_bytes > 1024 * 1024 * 1024
  )
    throw new Error(
      'Choose 1–3,650 days, 1–10,000 archives and 1–1,024 MiB for session retention.',
    );
  return { ...policy };
}
function validTime(now: number): void {
  if (!Number.isFinite(now) || now < 0 || now > 8_640_000_000_000_000)
    throw new Error('Invalid session retention time.');
}
/** Limits cover one owner's closed/previous archives, including superseded current snapshots. */
export function selectSessionExpiry(
  projection: SessionProjection,
  source: string,
  value: SessionRetentionPolicy,
  protectedIds: ReadonlySet<string>,
  now: number,
) {
  validTime(now);
  const policy = sessionRetentionPolicy(value);
  const archives = Object.values(projection.snapshots)
    .filter(
      (snapshot) => snapshot.source_id === source && projection.current[source] !== snapshot.id,
    )
    .sort(
      (a, b) =>
        Date.parse(a.captured_at) - Date.parse(b.captured_at) ||
        a.source_revision - b.source_revision ||
        a.id.localeCompare(b.id),
    );
  const sizes = new Map(
    archives.map((snapshot) => [
      snapshot.id,
      new TextEncoder().encode(JSON.stringify(snapshot)).byteLength,
    ]),
  );
  let count = archives.length,
    bytes = [...sizes.values()].reduce((sum, n) => sum + n, 0),
    protectedCount = 0,
    more = false;
  const ids: string[] = [];
  if (policy.enabled)
    for (const snapshot of archives) {
      if (protectedIds.has(snapshot.id)) {
        protectedCount++;
        continue;
      }
      if (
        Date.parse(snapshot.captured_at) < now - policy.days * DAY ||
        count > policy.max_archives ||
        bytes > policy.max_bytes
      ) {
        if (ids.length === 100) {
          more = true;
          continue;
        }
        ids.push(snapshot.id);
        count--;
        bytes -= sizes.get(snapshot.id)!;
      }
    }
  return {
    ids,
    examined: policy.enabled ? archives.length : 0,
    protected: protectedCount,
    more,
    retained_count: count,
    retained_bytes: bytes,
  };
}

/** Atomic selection/proof/counter commit; queued multipart content and active jobs stay protected. */
export async function expireSessions(db: SynkDatabase, now = Date.now()) {
  validTime(now);
  return db.transaction(
    'rw',
    [...db.captureBudgetTables(), db.sessionReplicas, db.sessionRestores, db.sessionClosedSeen],
    async () => {
      const local = await db.state.get('local'),
        policy = sessionRetentionPolicy(local?.session_retention ?? DEFAULT_SESSION_RETENTION);
      if (!local || !policy.enabled) return { examined: 0, expired: 0, protected: 0, more: false };
      const source = local.credentials.device_id,
        projection = await db.sessionProjection(),
        outgoing = new Set(await db.outbox.toCollection().primaryKeys()),
        protectedIds = new Set<string>();
      const parts = new Map<string, SessionExpirationTarget>();
      const acknowledged = new Map<string, Set<number>>();
      await db.drafts
        .where('header.domain')
        .equals('session')
        .each((record) => {
          if (record.payload.kind === 'session' && record.payload.schema_version === 1)
            protectedIds.add(record.payload.snapshot_id);
        });
      await db.operations
        .where('envelope.domain')
        .equals('session')
        .each((record) => {
          const part = record.payload;
          if (part.kind !== 'session' || part.schema_version !== 1 || part.source_id !== source)
            return;
          parts.set(part.snapshot_id, {
            snapshot_id: part.snapshot_id,
            source_revision: part.source_revision,
            snapshot_kind: part.snapshot_kind,
            total: part.total,
          });
          if (
            !Number.isSafeInteger(record.sequence) ||
            record.sequence! <= 0 ||
            outgoing.has(record.operation_id)
          )
            protectedIds.add(part.snapshot_id);
          else {
            const indexes = acknowledged.get(part.snapshot_id) ?? new Set<number>();
            indexes.add(part.part);
            acknowledged.set(part.snapshot_id, indexes);
          }
        });
      // Preserve the last published current state while its replacement still has queued parts.
      let publishedCurrent: SessionSnapshot | undefined;
      for (const snapshot of Object.values(projection.snapshots)) {
        if (snapshot.source_id !== source) continue;
        const target = parts.get(snapshot.id);
        if (!target || acknowledged.get(snapshot.id)?.size !== target.total) {
          protectedIds.add(snapshot.id);
          continue;
        }
        if (
          snapshot.kind === 'current' &&
          (!publishedCurrent || publishedCurrent.source_revision < snapshot.source_revision)
        )
          publishedCurrent = snapshot;
      }
      if (publishedCurrent) protectedIds.add(publishedCurrent.id);
      await db.sessionRestores
        .where('status')
        .anyOf('running', 'blocked')
        .each((job) => {
          protectedIds.add(job.snapshot_id);
        });
      const selected = selectSessionExpiry(projection, source, policy, protectedIds, now);
      if (selected.ids.length)
        await db.stageSessionExpiration(selected.ids.map((id) => parts.get(id)!));
      await db.state.update('local', {
        session_retention_last: {
          at: now,
          examined: selected.examined,
          expired: selected.ids.length,
          protected: selected.protected,
        },
      });
      return {
        examined: selected.examined,
        expired: selected.ids.length,
        protected: selected.protected,
        more: selected.more,
      };
    },
  );
}
