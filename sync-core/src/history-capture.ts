import { SynkDatabase } from './database';
import { historyGeneration, historyVisitId, type HistoryVisit, type HistoryClear } from './history';
import { historyUrlTag } from './crypto';
import { cleanHistoryLookup, unseenHistoryClear } from './history-capture-cleanup';
import {
  exclusionDomains,
  excludedHistoryUrl,
  type HistoryBrowser,
  type HistorySetup,
  type HistoryInbox,
  type HistoryScan,
  type HistoryLookup,
  type HistorySeen,
  type NativeHistoryItem,
} from './history-native';
const MAX_END = 8_640_000_000_000_001;
/** Durable intent precedes lookups. Remote history is never injected into the browser. */
export class HistoryCapture {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private db: SynkDatabase,
    private native: HistoryBrowser,
    private now = () => Date.now(),
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const p = this.tail.then(work);
    this.tail = p.catch(() => {});
    return p;
  }
  private tables() {
    return [
      this.db.state,
      this.db.operations,
      this.db.drafts,
      this.db.historyReplicas,
      this.db.historyErasedDrafts,
      this.db.historyVisits,
      this.db.historySetup,
      this.db.historyInbox,
      this.db.historySeen,
      this.db.historyScans,
      this.db.historyLookups,
      this.db.historyUrlEpochs,
      this.db.historyScanUrls,
    ];
  }
  enable(days = 90, exclusions: string[] = []): Promise<void> {
    return this.serial(async () => {
      if (!Number.isSafeInteger(days) || days < 0 || days > 365)
        throw new Error('Choose an initial import window from 0 to 365 days.');
      const domains = exclusionDomains(exclusions);
      const local = await this.db.state.get('local');
      if (!local) throw new Error('Connect this device first.');
      await this.db.ensureHistoryIndexKey();
      const marker = await this.native.getMarker(),
        old = await this.db.historySetup.get('history');
      if (!old && marker?.author === local.credentials.device_id)
        throw new Error(
          'History mapping metadata is missing. Export surviving data and re-enroll with a new installation identity.',
        );
      if (
        old &&
        marker &&
        (marker.id !== old.marker || marker.author !== local.credentials.device_id)
      )
        throw new Error('History profile identity changed. Export surviving data before recovery.');
      const resume = !!old && (!old.enabled || old.phase === 'blocked');
      const setup: HistorySetup = old
        ? {
            ...old,
            enabled: true,
            phase: resume ? 'baseline' : old.phase,
            error: undefined,
            exclusions: domains,
          }
        : {
            id: 'history',
            enabled: true,
            phase: 'active',
            marker: crypto.randomUUID(),
            incarnation: crypto.randomUUID(),
            exclusions: domains,
            applied: [],
            last_audit: this.now(),
          };
      await this.db.transaction('rw', this.tables(), async () => {
        await this.db.historySetup.put(setup);
        if (
          resume &&
          !(await this.db.historyScans.toArray()).some((s) => s.kind === 'baseline' && !s.url_tag)
        )
          await this.addScan('baseline', 0, MAX_END, setup);
        else if (!old && days)
          await this.addScan(
            'import',
            Math.max(0, this.now() - days * 86400000),
            this.now() + 1,
            setup,
          );
      });
      await this.native.setMarker({ author: local.credentials.device_id, id: setup.marker });
    });
  }
  pause(): Promise<void> {
    return this.serial(async () => {
      await this.db.transaction('rw', this.tables(), async () => {
        const setup = await this.db.historySetup.get('history');
        if (!setup) return;
        await this.db.historySetup.put({ ...setup, enabled: false, phase: 'paused' });
        // Pause cancels uncaptured native import/audit queries. Per-visit batches already retrieved,
        // event/removal intents and encrypted outgoing work stay durable.
        for (const lookup of await this.db.historyLookups.toArray()) {
          if (lookup.kind === 'event' || lookup.records !== undefined)
            await this.db.historyLookups.put({ ...lookup, preserve_captured: true });
          else await this.db.historyLookups.delete(lookup.id);
        }
        await this.db.historyScans.clear();
        await this.db.historyScanUrls.clear();
      });
    });
  }
  capture(event: HistoryInbox['event']): Promise<boolean> {
    // Start the small transaction immediately, independently of native lookup/discovery work.
    // Raw intent and its observed generation persist before HMAC, API lookup or encryption.
    return this.db.transaction('rw', this.tables(), async () => {
      const initial = await this.db.historySetup.get('history');
      if (!initial?.enabled || initial.phase === 'blocked') return false;
      await this.applyBarriers();
      const setup = (await this.db.historySetup.get('history'))!;
      if (
        event.type === 'visited' &&
        (!event.item.url ||
          excludedHistoryUrl(event.item.url, setup.exclusions) ||
          setup.phase === 'baseline')
      )
        return false;
      if ((await this.db.historyInbox.count()) >= 10_000) {
        await this.db.historySetup.put({
          ...setup,
          phase: 'blocked',
          error:
            'History event queue reached 10,000 items. Collection paused; drain saved work and resume.',
        });
        return false;
      }
      const meta = await this.db.historyMetadata();
      await this.db.historyInbox.add({
        event: structuredClone(event),
        context: meta.frontier,
        barriers: meta.barriers,
        incarnation: setup.incarnation,
        created_at: this.now(),
      });
      return true;
    });
  }
  /** Audit captured URLs too: completely removed URLs no longer appear in native search results. */
  audit(): Promise<void> {
    return this.serial(async () => {
      const setup = await this.db.historySetup.get('history');
      if (!setup?.enabled || setup.phase !== 'active') return;
      await this.db.transaction('rw', this.tables(), async () => {
        if (!(await this.db.historyScans.toArray()).some((s) => s.kind === 'audit'))
          await this.addScan('audit', 0, MAX_END, setup);
        await this.db.historySetup.update('history', { last_audit: this.now() });
      });
    });
  }
  reconcile(): Promise<void> {
    return this.serial(async () => {
      let setup = await this.db.historySetup.get('history');
      if (!setup?.enabled) return;
      const local = (await this.db.state.get('local'))!,
        marker = await this.native.getMarker();
      if (marker && (marker.id !== setup.marker || marker.author !== local.credentials.device_id)) {
        await this.db.historySetup.put({
          ...setup,
          phase: 'blocked',
          error: 'History profile marker changed. Export surviving data before recovery.',
        });
        return;
      }
      if (!marker)
        await this.native.setMarker({ author: local.credentials.device_id, id: setup.marker });
      await this.applyBarriers();
      setup = (await this.db.historySetup.get('history'))!;
      const errors: string[] = [];
      for (const row of await this.db.historyInbox
        .orderBy('id')
        .filter((i) => (i.retry_at ?? 0) <= this.now())
        .limit(20)
        .toArray()) {
        try {
          await this.inbox(row, setup);
        } catch {
          const error =
            'A saved history event could not be processed. Its intent was retained for retry.';
          const attempts = (row.attempts ?? 0) + 1;
          await this.db.historyInbox.update(row.id!, {
            error,
            attempts,
            retry_at: this.now() + Math.min(300_000, 1000 * 2 ** Math.min(attempts, 8)),
          });
          errors.push(error);
        }
      }
      // Other URLs continue even if one lookup is temporarily unavailable.
      for (const lookup of await this.db.historyLookups
        .filter((l) => (l.retry_at ?? 0) <= this.now())
        .limit(5)
        .toArray()) {
        if ((lookup.retry_at ?? 0) > this.now()) continue;
        try {
          await this.lookup(lookup, setup);
        } catch (cause) {
          const error =
            cause instanceof Error
              ? cause.message
              : 'Native history lookup failed; saved intent was retained.';
          await this.db.historyLookups.update(lookup.id, {
            error,
            attempts: lookup.attempts + 1,
            retry_at: this.now() + Math.min(300_000, 1000 * 2 ** Math.min(lookup.attempts + 1, 8)),
          });
          errors.push(error);
        }
        if (errors.length >= 5) break;
      }
      // Finish pre-pause bounded scans before a resume baseline can suppress their captured records.
      const scans = await this.db.historyScans.orderBy('created_at').toArray();
      const scan = scans.find((s) => s.kind !== 'baseline') ?? scans[0];
      if (scan && (scan.retry_at ?? 0) <= this.now()) {
        try {
          if (!scan.discovery_done) await this.discover(scan, setup);
          else if (!(await this.db.historyLookups.where('job_id').equals(scan.id).count()))
            await this.finishScan(scan);
        } catch (cause) {
          const error =
            cause instanceof Error
              ? cause.message
              : 'History discovery failed; its range was retained.';
          await this.db.historyScans.update(scan.id, { error, retry_at: this.now() + 30_000 });
          errors.push(error);
        }
      }
      const baselines = (await this.db.historyScans.toArray()).filter(
        (s) => s.kind === 'baseline' && !s.url_tag,
      );
      setup = (await this.db.historySetup.get('history'))!;
      if (setup.phase === 'baseline' && !baselines.length) {
        setup = { ...setup, phase: 'active', last_scan: this.now() };
        await this.db.historySetup.put(setup);
      }
      const retainedError =
        (await this.db.historyInbox.toArray()).find((i) => i.error)?.error ??
        (await this.db.historyLookups.toArray()).find((l) => l.error)?.error ??
        (await this.db.historyScans.toArray()).find((s) => s.error)?.error;
      if (
        setup.phase === 'active' &&
        (setup.last_audit === undefined ||
          this.now() - setup.last_audit >= 86_400_000 ||
          this.now() < setup.last_audit)
      ) {
        await this.db.transaction('rw', this.tables(), async () => {
          if (!(await this.db.historyScans.toArray()).some((s) => s.kind === 'audit'))
            await this.addScan('audit', 0, MAX_END, setup!);
          await this.db.historySetup.update('history', { last_audit: this.now() });
        });
      }
      if (setup.phase !== 'blocked')
        await this.db.historySetup.update('history', { error: errors[0] ?? retainedError });
      if (
        setup.phase === 'active' &&
        !(await this.db.historyScans.count()) &&
        (!setup.last_scan || this.now() - setup.last_scan >= 30_000 || this.now() < setup.last_scan)
      ) {
        await this.db.transaction('rw', this.tables(), async () => {
          await this.addScan(
            'overlap',
            Math.max(
              0,
              (setup!.last_scan && setup!.last_scan <= this.now() ? setup!.last_scan : this.now()) -
                300_000,
            ),
            this.now() + 1,
            setup!,
          );
          await this.db.historySetup.update('history', { last_scan: this.now() });
        });
      }
    });
  }
  private async addScan(
    kind: HistoryScan['kind'],
    start: number,
    end: number,
    setup: HistorySetup,
    url_tag?: string,
    incarnation = setup.incarnation,
  ): Promise<HistoryScan> {
    const meta = await this.db.historyMetadata();
    const scan: HistoryScan = {
      id: crypto.randomUUID(),
      kind,
      start,
      end,
      ranges: url_tag || kind === 'audit' ? [] : [{ start, end }],
      context: meta.frontier,
      barriers: meta.barriers,
      incarnation,
      url_tag,
      created_at: this.now(),
      discovery_done: !!url_tag,
    };
    await this.db.historyScans.add(scan);
    return scan;
  }
  private unseenClear(
    barriers: HistoryClear[],
    source: string,
    tag: string,
    old: HistoryClear[],
  ): boolean {
    return unseenHistoryClear(barriers, source, tag, old);
  }
  private async currentInbox(row: HistoryInbox): Promise<boolean> {
    return JSON.stringify(await this.db.historyInbox.get(row.id!)) === JSON.stringify(row);
  }
  private async applyBarriers(): Promise<void> {
    const local = (await this.db.state.get('local'))!;
    await this.db.transaction('rw', this.tables(), async () => {
      const meta = await this.db.historyMetadata(),
        setup = (await this.db.historySetup.get('history'))!;
      const relevant = meta.barriers.filter(
        (b) =>
          !setup.applied.includes(b.operation_id) &&
          (b.action.scope === 'all' || b.action.source_id === local.credentials.device_id),
      );
      if (!relevant.length) return;
      const full = relevant.some((b) => b.action.scope !== 'url');
      const next: HistorySetup = {
        ...setup,
        phase: full ? 'baseline' : setup.phase,
        incarnation: full ? crypto.randomUUID() : setup.incarnation,
        applied: [...setup.applied, ...relevant.map((b) => b.operation_id)],
      };
      await this.db.historySetup.put(next);
      if (full) {
        await this.db.historyScans.clear();
        await this.db.historyScanUrls.clear();
        await this.db.historyUrlEpochs.clear();
        await this.addScan('baseline', 0, MAX_END, next);
      } else
        for (const b of relevant)
          if (b.action.scope === 'url') {
            await this.db.historyUrlEpochs.put({
              url_tag: b.action.url_tag,
              incarnation: crypto.randomUUID(),
              baseline_pending: true,
            });
            for (const scan of await this.db.historyScans.toArray())
              if (scan.url_tag === b.action.url_tag) {
                await this.db.historyScans.delete(scan.id);
                await this.db.historyScanUrls.where('job_id').equals(scan.id).delete();
              }
          }
      // Cancel only work intentionally erased by a newly observed clear; preserve unrelated saved jobs.
      for (const lookup of await this.db.historyLookups.toArray())
        if (
          this.unseenClear(
            meta.barriers,
            local.credentials.device_id,
            lookup.url_tag,
            lookup.barriers,
          )
        )
          await this.db.historyLookups.delete(lookup.id);
      if (!full) {
        const operations = await this.db.historyOperations();
        for (const b of relevant)
          if (b.action.scope === 'url') {
            const tag = b.action.url_tag;
            const known = operations.find(
              (o) =>
                o.action.type === 'visit' &&
                o.action.visit.source_id === local.credentials.device_id &&
                o.action.visit.url_tag === tag,
            );
            if (known?.action.type === 'visit')
              await this.ensureUrlBaseline(tag, {
                id: 'baseline',
                url: known.action.visit.url,
                title: '',
              });
          }
      }
    });
  }
  private async ensureUrlBaseline(tag: string, item: NativeHistoryItem): Promise<void> {
    if (!item.url) return;
    await this.db.transaction('rw', this.tables(), async () => {
      const epoch = await this.db.historyUrlEpochs.get(tag);
      if (
        !epoch?.baseline_pending ||
        (await this.db.historyScans.toArray()).some((s) => s.url_tag === tag)
      )
        return;
      const setup = (await this.db.historySetup.get('history'))!;
      const scan = await this.addScan('baseline', 0, MAX_END, setup, tag, epoch.incarnation);
      await this.enqueueLookup(scan, item, tag, epoch.incarnation);
    });
  }
  private async inbox(row: HistoryInbox, setup: HistorySetup): Promise<void> {
    const key = await this.db.ensureHistoryIndexKey(),
      local = (await this.db.state.get('local'))!;
    if (row.event.type === 'removed') {
      if (row.event.all) {
        await this.db.transaction('rw', this.tables(), async () => {
          if (!(await this.currentInbox(row))) return;
          await this.db.stageHistory({
            type: 'clear',
            scope: 'source',
            source_id: local.credentials.device_id,
          });
          await this.db.historyInbox.delete(row.id!);
        });
        await this.applyBarriers();
        return;
      }
      const position = row.url_position ?? 0,
        url = row.event.urls[position];
      if (!url) {
        await this.db.historyInbox.delete(row.id!);
        return;
      }
      const tag = await historyUrlTag(key, url);
      if (!row.removal_ids) {
        const records = await this.native.getVisits(url);
        if (
          records.length > 100_000 ||
          records.some((v) => v.isLocal === undefined || (v.isLocal && v.visitTime === undefined))
        )
          throw new Error('Native removal lookup is incomplete. The removal intent remains saved.');
        if (!records.length) {
          await this.db.transaction('rw', this.tables(), async () => {
            if (!(await this.currentInbox(row))) return;
            await this.db.stageHistory({
              type: 'clear',
              scope: 'url',
              source_id: local.credentials.device_id,
              url_tag: tag,
            });
            await this.advanceRemoved(row);
          });
          await this.applyBarriers();
          return;
        }
        const actual = new Set(
          records
            .filter((v) => v.isLocal && !v.incognito)
            .map((v) => JSON.stringify([v.visitId, v.visitTime])),
        );
        const missing = (await this.db.historyVisits.where('url_tag').equals(tag).toArray())
          .filter(
            (v) =>
              v.source_id === local.credentials.device_id &&
              !actual.has(JSON.stringify([v.native_id, v.visited_at])),
          )
          .map((v) => v.id);
        const original = row;
        const saved = await this.db.transaction('rw', this.tables(), async () => {
          if (!(await this.currentInbox(original))) return false;
          row = { ...original, removal_ids: missing };
          await this.db.historyInbox.put(row);
          return true;
        });
        if (!saved) return;
      }
      await this.db.transaction('rw', this.tables(), async () => {
        if (!(await this.currentInbox(row))) return;
        const ids = row.removal_ids!.slice(0, 800);
        if (ids.length)
          await this.db.stageHistories(
            Array.from({ length: Math.ceil(ids.length / 80) }, (_, i) => ({
              type: 'delete' as const,
              visit_ids: ids.slice(i * 80, (i + 1) * 80),
            })),
          );
        if (row.removal_ids!.length > 800)
          await this.db.historyInbox.put({ ...row, removal_ids: row.removal_ids!.slice(800) });
        else await this.advanceRemoved(row);
      });
      return;
    }
    const item = row.event.item;
    if (!item.url || excludedHistoryUrl(item.url, setup.exclusions)) {
      await this.db.historyInbox.delete(row.id!);
      return;
    }
    const tag = await historyUrlTag(key, item.url),
      meta = await this.db.historyMetadata();
    if (this.unseenClear(meta.barriers, local.credentials.device_id, tag, row.barriers)) {
      await this.db.historyInbox.delete(row.id!);
      return;
    }
    if (item.lastVisitTime === undefined)
      throw new Error('Native event time is missing; saved intent was retained.');
    const epoch = await this.db.historyUrlEpochs.get(tag);
    if (epoch?.baseline_pending) {
      await this.db.transaction('rw', this.tables(), async () => {
        if (!(await this.currentInbox(row))) return;
        const current = await this.db.historyMetadata();
        if (this.unseenClear(current.barriers, local.credentials.device_id, tag, row.barriers))
          return;
        await this.ensureUrlBaseline(tag, item);
      });
      return;
    }
    await this.db.transaction('rw', this.tables(), async () => {
      if (!(await this.currentInbox(row))) return;
      const current = await this.db.historyMetadata();
      if (this.unseenClear(current.barriers, local.credentials.device_id, tag, row.barriers)) {
        await this.db.historyInbox.delete(row.id!);
        return;
      }
      if ((await this.db.historyLookups.count()) >= 20_000)
        throw new Error('History lookup queue is full. Saved events will retry as it drains.');
      await this.db.historyLookups.put({
        id: `event/${row.id}`,
        job_id: 'event',
        item: { ...item, url: item.url! },
        url_tag: tag,
        kind: 'event',
        preserve_captured: true,
        start: item.lastVisitTime!,
        end: item.lastVisitTime! + 1,
        context: row.context,
        barriers: row.barriers,
        incarnation: epoch?.incarnation ?? row.incarnation,
        position: 0,
        attempts: 0,
      });
      await this.db.historyInbox.delete(row.id!);
    });
  }
  private async advanceRemoved(row: HistoryInbox): Promise<void> {
    if (row.event.type !== 'removed') return;
    if (!(await this.currentInbox(row))) return;
    const next = (row.url_position ?? 0) + 1;
    if (next === row.event.urls.length) await this.db.historyInbox.delete(row.id!);
    else
      await this.db.historyInbox.put({
        ...row,
        event: { ...row.event, urls: row.event.urls.slice(next) },
        url_position: 0,
        removal_ids: undefined,
      });
  }
  private async enqueueLookup(
    scan: HistoryScan,
    item: NativeHistoryItem,
    tag: string,
    incarnation: string,
  ): Promise<void> {
    if (!item.url) return;
    const id = `${scan.id}/${tag}`;
    if (await this.db.historyScanUrls.get(id)) return;
    if ((await this.db.historyLookups.count()) >= 20_000)
      throw new Error(
        'History lookup queue reached 20,000 URLs. Discovery retained its range and will retry as saved work drains.',
      );
    await this.db.historyLookups.add({
      id,
      job_id: scan.id,
      item: { ...item, url: item.url },
      url_tag: tag,
      kind: scan.kind,
      start: scan.start,
      end: scan.end,
      context: scan.context,
      barriers: scan.barriers,
      incarnation,
      position: 0,
      attempts: 0,
    });
    await this.db.historyScanUrls.add({ id, job_id: scan.id });
  }
  private async discover(scan: HistoryScan, setup: HistorySetup): Promise<void> {
    if (scan.kind === 'audit') {
      const source = (await this.db.state.get('local'))!.credentials.device_id;
      const page = await this.db.localHistoryUrls(source, scan.audit_cursor);
      await this.db.transaction('rw', this.tables(), async () => {
        if (!(await this.db.historyScans.get(scan.id))) return;
        const meta = await this.db.historyMetadata();
        for (const visit of page.items) {
          if (this.unseenClear(meta.barriers, source, visit.url_tag, scan.barriers)) continue;
          await this.enqueueLookup(
            scan,
            { id: visit.native_id, url: visit.url, title: visit.title },
            visit.url_tag,
            visit.incarnation,
          );
        }
        await this.db.historyScans.update(scan.id, {
          audit_cursor: page.cursor,
          discovery_done: !page.has_more,
          error: undefined,
          retry_at: undefined,
        });
      });
      return;
    }
    const range = scan.ranges[0];
    if (!range) {
      await this.db.historyScans.update(scan.id, {
        discovery_done: true,
        error: undefined,
        retry_at: undefined,
      });
      return;
    }
    const limit = range.end - range.start <= 1 ? 10_001 : 1_001;
    const items = await this.native.search(range.start, range.end, limit);
    if (items.length >= limit) {
      if (range.end - range.start <= 1)
        throw new Error(
          'Native history has more than 10,000 URLs at one timestamp. Import retained its range; narrow the initial import or resume after recovery.',
        );
      const mid = range.start + Math.floor((range.end - range.start) / 2);
      await this.db.historyScans.update(scan.id, {
        ranges: [
          { start: range.start, end: mid },
          { start: mid, end: range.end },
          ...scan.ranges.slice(1),
        ],
        error: undefined,
        retry_at: undefined,
      });
      return;
    }
    const key = await this.db.ensureHistoryIndexKey(),
      local = (await this.db.state.get('local'))!;
    const prepared: { item: NativeHistoryItem; tag: string; incarnation: string }[] = [];
    for (const item of items)
      if (item.url && !excludedHistoryUrl(item.url, setup.exclusions)) {
        const tag = await historyUrlTag(key, item.url),
          epoch = await this.db.historyUrlEpochs.get(tag);
        if (
          scan.kind !== 'baseline' &&
          this.unseenClear(
            (await this.db.historyMetadata()).barriers,
            local.credentials.device_id,
            tag,
            scan.barriers,
          )
        )
          continue;
        prepared.push({ item, tag, incarnation: epoch?.incarnation ?? scan.incarnation });
      }
    await this.db.transaction('rw', this.tables(), async () => {
      if (!(await this.db.historyScans.get(scan.id))) return;
      const meta = await this.db.historyMetadata();
      for (const p of prepared) {
        if (this.unseenClear(meta.barriers, local.credentials.device_id, p.tag, scan.barriers))
          continue;
        const epoch = await this.db.historyUrlEpochs.get(p.tag);
        if (scan.kind !== 'baseline' && epoch?.baseline_pending) {
          await this.ensureUrlBaseline(p.tag, p.item);
          continue;
        }
        await this.enqueueLookup(scan, p.item, p.tag, p.incarnation);
      }
      await this.db.historyScans.update(scan.id, {
        ranges: scan.ranges.slice(1),
        discovery_done: scan.ranges.length === 1,
        error: undefined,
        retry_at: undefined,
      });
    });
  }
  private async finishScan(scan: HistoryScan): Promise<void> {
    await this.db.transaction('rw', this.tables(), async () => {
      if (!(await this.db.historyScans.get(scan.id))) return;
      if (scan.kind === 'baseline' && scan.url_tag) {
        const epoch = await this.db.historyUrlEpochs.get(scan.url_tag);
        if (epoch?.incarnation === scan.incarnation)
          await this.db.historyUrlEpochs.put({ ...epoch, baseline_pending: false });
      }
      if (scan.kind === 'baseline' && !scan.url_tag)
        await this.db.historyUrlEpochs.toCollection().modify({ baseline_pending: false });
      await this.db.historyScans.delete(scan.id);
      await this.db.historyScanUrls.where('job_id').equals(scan.id).delete();
    });
  }
  private async lookup(lookup: HistoryLookup, setup: HistorySetup): Promise<void> {
    if (excludedHistoryUrl(lookup.item.url, setup.exclusions)) {
      await this.db.historyLookups.delete(lookup.id);
      return;
    }
    if (!lookup.records) {
      const original = lookup;
      const checked_counter = (await this.db.state.get('local'))!.next_counter;
      const records = await this.native.getVisits(lookup.item.url);
      if (records.length > 100_000)
        throw new Error(
          'Native URL lookup exceeds 100,000 visits. Saved progress was retained; this URL needs recovery.',
        );
      if (lookup.kind === 'event' && !records.some((v) => v.visitTime === lookup.start))
        throw new Error(
          'An event visit is unavailable in native history. Saved intent will retry.',
        );
      const saved = await this.db.transaction('rw', this.tables(), async () => {
        if (
          JSON.stringify(await this.db.historyLookups.get(original.id)) !== JSON.stringify(original)
        )
          return false;
        const local = (await this.db.state.get('local'))!;
        const cleaned = cleanHistoryLookup(
          { ...original, records, checked_counter, error: undefined, retry_at: undefined },
          await this.db.historyMetadata(),
          local.credentials.device_id,
        );
        if (!cleaned) {
          await this.db.historyLookups.delete(original.id);
          return false;
        }
        lookup = cleaned;
        await this.db.historyLookups.put(lookup);
        return true;
      });
      if (!saved) return;
    }
    const local = (await this.db.state.get('local'))!;
    await this.db.transaction('rw', this.tables(), async () => {
      const meta = await this.db.historyMetadata();
      const current = await this.db.historyLookups.get(lookup.id);
      if (!current) return;
      lookup = current;
      if (
        this.unseenClear(
          meta.barriers,
          local.credentials.device_id,
          lookup.url_tag,
          lookup.barriers,
        )
      ) {
        await this.db.historyLookups.delete(lookup.id);
        return;
      }
      const generation = historyGeneration(
        { ...meta, barriers: lookup.barriers, visits: {} },
        local.credentials.device_id,
        lookup.url_tag,
      );
      const visits: HistoryVisit[] = [],
        seen: HistorySeen[] = [],
        records = lookup.records!;
      for (const v of records.slice(lookup.position, lookup.position + 100)) {
        if (v.isLocal === undefined)
          throw new Error(
            'Native history locality is unavailable. Saved intent was retained without assigning a source.',
          );
        if (!v.isLocal || v.incognito) continue;
        if (v.visitTime === undefined)
          throw new Error('Native visit time is unavailable. Saved intent was retained.');
        if (
          v.visitTime < lookup.start ||
          v.visitTime >= lookup.end ||
          (lookup.kind === 'event' && v.visitTime !== lookup.start)
        )
          continue;
        const id = historyVisitId(
          local.credentials.device_id,
          lookup.incarnation,
          v.visitId,
          v.visitTime,
        );
        if (v.erased || meta.deleted[id]) continue;
        const priorSeen = await this.db.historySeen.get(id);
        if (priorSeen && !(lookup.preserve_captured && priorSeen.suppressed)) continue;
        if (lookup.kind !== 'audit')
          seen.push({
            id,
            url_tag: lookup.url_tag,
            native_id: v.visitId,
            visited_at: v.visitTime,
            incarnation: lookup.incarnation,
            suppressed: lookup.kind === 'baseline',
          });
        if (lookup.kind !== 'baseline' && lookup.kind !== 'audit')
          visits.push({
            id,
            source_id: local.credentials.device_id,
            source_name: local.credentials.name,
            incarnation: lookup.incarnation,
            native_id: v.visitId,
            visited_at: v.visitTime,
            url: lookup.item.url,
            url_tag: lookup.url_tag,
            title: (lookup.item.title ?? '').slice(0, 4000),
            transition: v.transition,
            referring_native_id: v.referringVisitId,
            generation,
          });
      }
      if (visits.length)
        await this.db.stageHistories(
          visits.map((visit) => ({ type: 'visit', visit })),
          lookup.context,
        );
      await this.db.historySeen.bulkPut(seen);
      const position = Math.min(records.length, lookup.position + 100);
      if (position === records.length && lookup.kind !== 'baseline') {
        if (lookup.removal_ids === undefined) {
          const actual = new Set(
            records
              .filter((v) => v.isLocal && !v.incognito)
              .map((v) => JSON.stringify([v.visitId, v.visitTime])),
          );
          const missing: string[] = [];
          for (const old of await this.db.historyVisits
            .where('[source_id+url_tag]')
            .equals([local.credentials.device_id, lookup.url_tag])
            .toArray()) {
            const prior =
              (await this.db.drafts.get(old.operation_id)) ??
              (await this.db.operations.get(old.operation_id));
            const counter =
              prior && ('header' in prior ? prior.header.counter : prior.envelope.counter);
            if (
              counter !== undefined &&
              counter < (lookup.checked_counter ?? 0) &&
              !actual.has(JSON.stringify([old.native_id, old.visited_at]))
            )
              missing.push(old.id);
          }
          if (missing.length && !actual.size) {
            await this.db.stageHistory({
              type: 'clear',
              scope: 'url',
              source_id: local.credentials.device_id,
              url_tag: lookup.url_tag,
            });
            await this.db.historyLookups.delete(lookup.id);
            return;
          }
          lookup = { ...lookup, removal_ids: missing };
        }
        const ids = lookup.removal_ids!.slice(0, 800);
        if (ids.length)
          await this.db.stageHistories(
            Array.from({ length: Math.ceil(ids.length / 80) }, (_, i) => ({
              type: 'delete' as const,
              visit_ids: ids.slice(i * 80, (i + 1) * 80),
            })),
          );
        const remaining = lookup.removal_ids!.slice(800);
        if (remaining.length)
          await this.db.historyLookups.put({
            ...lookup,
            position,
            removal_ids: remaining,
            error: undefined,
            retry_at: undefined,
          });
        else await this.db.historyLookups.delete(lookup.id);
      } else if (position === records.length) await this.db.historyLookups.delete(lookup.id);
      else
        await this.db.historyLookups.put({
          ...lookup,
          position,
          error: undefined,
          retry_at: undefined,
        });
    });
  }
}
