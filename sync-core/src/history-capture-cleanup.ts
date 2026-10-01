import Dexie, { type Transaction } from 'dexie';
import { deriveHistoryIndexKey, historyUrlTag } from './crypto';
import {
  historyGeneration,
  historyVisitId,
  type HistoryClear,
  type HistoryProjection,
} from './history';
import type { HistoryInbox, HistoryLookup, HistoryScan } from './history-native';
import type { LocalState } from './database';

export function unseenHistoryClear(
  barriers: HistoryClear[],
  source: string,
  tag: string,
  observed: HistoryClear[],
): boolean {
  const base = { visits: {}, deleted: {}, stale: {}, frontier: {}, logical: 0 };
  const current = historyGeneration({ ...base, barriers }, source, tag);
  const old = historyGeneration({ ...base, barriers: observed }, source, tag);
  return Object.entries(current).some(([author, counter]) => (old[author] ?? 0) < counter);
}

/** Retain native identity for deduplication, but discard metadata for selected erased records. */
export function cleanHistoryLookup(
  lookup: HistoryLookup,
  metadata: Omit<HistoryProjection, 'visits'>,
  source: string,
): HistoryLookup | undefined {
  if (unseenHistoryClear(metadata.barriers, source, lookup.url_tag, lookup.barriers)) return;
  if (!lookup.records) return lookup;
  let changed = false;
  const records = lookup.records.map((record) => {
    if (!record.isLocal || record.incognito || record.visitTime === undefined) return record;
    const id = historyVisitId(source, lookup.incarnation, record.visitId, record.visitTime);
    if (!metadata.deleted[id] || record.erased) return record;
    changed = true;
    return {
      visitId: record.visitId,
      visitTime: record.visitTime,
      isLocal: true,
      erased: true as const,
    };
  });
  if (!changed) return lookup;
  if (records.every((r) => r.erased || r.isLocal === false || r.incognito)) return;
  // A shared URL is still needed by unrelated saved visits; its old observed title is optional.
  const { title: _title, ...item } = lookup.item;
  return { ...lookup, item, records };
}

/** Run in the deletion/pull/migration transaction, including while capture is paused. */
export async function cleanHistoryCapture(
  tx: Transaction,
  metadata: Omit<HistoryProjection, 'visits'>,
): Promise<void> {
  const local: LocalState | undefined = await tx.table('state').get('local');
  if (!local) return;
  const source = local.credentials.device_id;
  const relevant = metadata.barriers.filter(
    (b) => b.action.scope === 'all' || b.action.source_id === source,
  );
  if (!relevant.length && !Object.keys(metadata.deleted).length) return;
  for (const lookup of (await tx.table('historyLookups').toArray()) as HistoryLookup[]) {
    const cleaned = cleanHistoryLookup(lookup, metadata, source);
    if (!cleaned) await tx.table('historyLookups').delete(lookup.id);
    else if (JSON.stringify(cleaned) !== JSON.stringify(lookup))
      await tx.table('historyLookups').put(cleaned);
  }
  for (const scan of (await tx.table('historyScans').toArray()) as HistoryScan[]) {
    // A general scan retains unrelated URLs; discovery rechecks each tag before enqueueing.
    if (unseenHistoryClear(relevant, source, scan.url_tag ?? '', scan.barriers)) {
      await tx.table('historyScans').delete(scan.id);
      await tx.table('historyScanUrls').where('job_id').equals(scan.id).delete();
    }
  }
  if (!relevant.length) return;
  let key = local.history_index_key;
  const tags = new Map<string, string>();
  const tagFor = async (url: string): Promise<string> => {
    if (tags.has(url)) return tags.get(url)!;
    if (!key) {
      key = await Dexie.waitFor(
        deriveHistoryIndexKey(local.recovery_key, local.credentials.account_id),
      );
      await tx.table('state').update('local', { history_index_key: key });
    }
    // Only WebCrypto runs during waitFor; transaction writes resume after it settles.
    const tag = await Dexie.waitFor(historyUrlTag(key, url));
    tags.set(url, tag);
    return tag;
  };
  for (const row of (await tx.table('historyInbox').toArray()) as HistoryInbox[]) {
    if (unseenHistoryClear(relevant, source, '', row.barriers)) {
      await tx.table('historyInbox').delete(row.id!);
      continue;
    }
    if (row.event.type === 'visited') {
      if (
        row.event.item.url &&
        unseenHistoryClear(relevant, source, await tagFor(row.event.item.url), row.barriers)
      )
        await tx.table('historyInbox').delete(row.id!);
    } else if (!row.event.all) {
      const pending = row.event.urls.slice(row.url_position ?? 0);
      const urls: string[] = [];
      for (const url of pending)
        if (!unseenHistoryClear(relevant, source, await tagFor(url), row.barriers)) urls.push(url);
      if (!urls.length) await tx.table('historyInbox').delete(row.id!);
      else if (urls.length !== pending.length)
        await tx.table('historyInbox').put({
          ...row,
          event: { ...row.event, urls },
          url_position: 0,
          removal_ids: urls[0] === pending[0] ? row.removal_ids : undefined,
        });
    }
  }
}
