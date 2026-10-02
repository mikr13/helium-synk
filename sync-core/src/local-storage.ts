import Dexie from 'dexie';
import type { SynkDatabase } from './database';

export interface LocalStoragePolicy {
  max_bytes: number;
  max_pending: number;
  max_journal: number;
  max_capture_tasks: number;
}
export const DEFAULT_LOCAL_STORAGE: Readonly<LocalStoragePolicy> = {
  max_bytes: 512 * 1024 * 1024,
  max_pending: 100_000,
  max_journal: 500_000,
  max_capture_tasks: 30_000,
};
export interface LocalStorageEstimate {
  usage?: number;
  quota?: number;
}
export interface LocalStorageStatus {
  policy: LocalStoragePolicy;
  estimated_bytes?: number;
  browser_quota?: number;
  queued_operations: number;
  capture_tasks: number;
  pending: number;
  journal_records: number;
  blocked: boolean;
  warning?: string;
}
export function storagePolicy(value: unknown): LocalStoragePolicy {
  const policy = value as LocalStoragePolicy;
  const ranges: Record<keyof LocalStoragePolicy, [number, number]> = {
    max_bytes: [16 * 1024 * 1024, 8 * 1024 * 1024 * 1024],
    max_pending: [100, 1_000_000],
    max_journal: [1000, 5_000_000],
    max_capture_tasks: [100, 500_000],
  };
  if (
    !policy ||
    Object.keys(policy).length !== 4 ||
    Object.entries(ranges).some(([key, [min, max]]) => {
      const n = policy[key as keyof LocalStoragePolicy];
      return !Number.isSafeInteger(n) || n < min || n > max;
    })
  )
    throw new Error('Invalid local storage limits.');
  return { ...policy };
}
export function localStorageTables(db: SynkDatabase) {
  return [
    db.state,
    db.records,
    db.operations,
    db.drafts,
    db.outbox,
    db.historyErasedDrafts,
    db.historyPurgePending,
    db.bookmarkInbox,
    db.historyInbox,
    db.historyLookups,
    db.historyScans,
  ];
}
export async function localStorageCounts(db: SynkDatabase) {
  const queued_operations =
    (await db.outbox.count()) + (await db.drafts.count()) + (await db.historyPurgePending.count());
  const capture_tasks =
    (await db.bookmarkInbox.count()) +
    (await db.historyInbox.count()) +
    (await db.historyLookups.count()) +
    (await db.historyScans.count());
  const journal_records =
    (await db.records.count()) +
    (await db.operations.count()) +
    (await db.drafts.count()) +
    (await db.historyErasedDrafts.count());
  return {
    queued_operations,
    capture_tasks,
    pending: queued_operations + capture_tasks,
    journal_records,
  };
}
export class LocalCapacityError extends Error {
  constructor(reason: string) {
    super(
      `${reason} New collection is paused. Saved work was retained; sync, export local data or increase the limit before retrying.`,
    );
    this.name = 'LocalCapacityError';
  }
}
/** Native usage is an origin estimate, not a physical disk-space reservation. */
export class StorageMeter {
  private estimate: LocalStorageEstimate = {};
  private sampled = 0;
  constructor(
    private probe: () => Promise<LocalStorageEstimate> = async () => {
      return typeof navigator !== 'undefined' && navigator.storage?.estimate
        ? navigator.storage.estimate()
        : {};
    },
  ) {}
  async read(force = false): Promise<LocalStorageEstimate> {
    if (force || !this.sampled || Date.now() - this.sampled >= 5000) {
      try {
        const estimate = await Dexie.waitFor(this.probe());
        const number = (value: unknown) =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
        this.estimate = { usage: number(estimate.usage), quota: number(estimate.quota) };
      } catch {
        this.estimate = {};
      }
      this.sampled = Date.now();
    }
    return this.estimate;
  }
}
export function capacityReason(
  status: LocalStorageStatus,
  additional = 0,
  bytes = 0,
): string | undefined {
  if (
    status.pending + additional > status.policy.max_pending ||
    (!additional && status.pending >= status.policy.max_pending)
  )
    return `Local pending-work limit (${status.policy.max_pending.toLocaleString()}) reached.`;
  if (
    status.journal_records + additional > status.policy.max_journal ||
    (!additional && status.journal_records >= status.policy.max_journal)
  )
    return `Local journal limit (${status.policy.max_journal.toLocaleString()}) reached.`;
  if (
    status.capture_tasks + additional > status.policy.max_capture_tasks ||
    (!additional && status.capture_tasks >= status.policy.max_capture_tasks)
  )
    return `Local capture-task limit (${status.policy.max_capture_tasks.toLocaleString()}) reached.`;
  const measured = status.estimated_bytes;
  const budget = Math.min(status.policy.max_bytes, status.browser_quota || Infinity);
  if (measured !== undefined && measured + bytes >= budget)
    return 'Local storage estimate reached its limit.';
}
export async function localStorageStatus(
  db: SynkDatabase,
  estimate: LocalStorageEstimate,
): Promise<LocalStorageStatus> {
  return db.transaction('r', localStorageTables(db), async () => {
    const state = await db.state.get('local');
    const status: LocalStorageStatus = {
      policy: storagePolicy(state?.storage_policy ?? DEFAULT_LOCAL_STORAGE),
      ...(await localStorageCounts(db)),
      estimated_bytes: estimate.usage,
      browser_quota: estimate.quota,
      blocked: false,
    };
    const reason = capacityReason(status);
    status.blocked = !!reason;
    status.warning = reason ? new LocalCapacityError(reason).message : undefined;
    if (
      !status.warning &&
      (status.pending >= status.policy.max_pending * 0.8 ||
        status.journal_records >= status.policy.max_journal * 0.8 ||
        status.capture_tasks >= status.policy.max_capture_tasks * 0.8 ||
        (status.estimated_bytes !== undefined &&
          status.estimated_bytes >=
            Math.min(status.policy.max_bytes, status.browser_quota || Infinity) * 0.8))
    )
      status.warning =
        'Local storage is approaching its limit. Sync saved work or review storage limits.';
    return status;
  });
}
