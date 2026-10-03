import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { SynkDatabase } from './database';
import Dexie from 'dexie';
import { historyVisitId } from './history';
import { generateRecoveryKey, historyUrlTag } from './crypto';
import { HistoryCapture } from './history-capture';
import {
  exclusionDomains,
  excludedHistoryUrl,
  type HistoryBrowser,
  type HistoryMarker,
  type NativeHistoryItem,
  type NativeHistoryVisit,
} from './history-native';
const dbs: SynkDatabase[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const db of dbs.splice(0)) await db.delete();
});
const URL_A = 'https://example.com/research',
  URL_B = 'https://other.example.org/second';
class Native implements HistoryBrowser {
  marker?: HistoryMarker;
  records = new Map<string, NativeHistoryVisit[]>();
  titles = new Map<string, string>();
  calls: string[] = [];
  searchCalls: [number, number, number][] = [];
  fail = new Set<string>();
  customSearch?: (start: number, end: number, limit: number) => NativeHistoryItem[];
  add(url: string, id: string, time: number, extra: Partial<NativeHistoryVisit> = {}) {
    const records = this.records.get(url) ?? [];
    records.push({
      visitId: id,
      visitTime: time,
      isLocal: true,
      transition: 'link',
      referringVisitId: '0',
      ...extra,
    });
    this.records.set(url, records);
    return { ...this.item(url), lastVisitTime: time };
  }
  item(url: string): NativeHistoryItem {
    return {
      id: 'url-' + url,
      url,
      title: this.titles.get(url) ?? 'Observed title',
      lastVisitTime: Math.max(...(this.records.get(url) ?? []).map((v) => v.visitTime ?? 0)),
    };
  }
  async search(start: number, end: number, limit: number) {
    this.searchCalls.push([start, end, limit]);
    return structuredClone(
      this.customSearch?.(start, end, limit) ??
        [...this.records.keys()]
          .map((url) => this.item(url))
          .filter((i) => i.lastVisitTime! >= start && i.lastVisitTime! <= end)
          .sort((a, b) => b.lastVisitTime! - a.lastVisitTime!)
          .slice(0, limit),
    );
  }
  async getVisits(url: string) {
    this.calls.push(url);
    if (this.fail.has(url)) throw new Error('Native lookup unavailable');
    return structuredClone(this.records.get(url) ?? []);
  }
  async getMarker() {
    return this.marker;
  }
  async setMarker(marker: HistoryMarker) {
    this.marker = structuredClone(marker);
  }
}
async function fixture(days = 0, initial?: (n: Native) => void, now = 1_000_000) {
  const db = new SynkDatabase(`history-capture-${crypto.randomUUID()}`);
  dbs.push(db);
  await db.enroll(
    {
      account_id: crypto.randomUUID(),
      device_id: crypto.randomUUID(),
      name: 'Laptop',
      token: 'a'.repeat(64),
      server_url: 'http://127.0.0.1:4318',
    },
    generateRecoveryKey(),
  );
  const clock = { time: now },
    native = new Native();
  initial?.(native);
  const capture = new HistoryCapture(db, native, () => clock.time);
  await capture.enable(days);
  const source = (await db.state.get('local'))!.credentials.device_id;
  return { db, native, capture, clock, source };
}
async function drain(db: SynkDatabase, capture: HistoryCapture, max = 100) {
  for (let i = 0; i < max; i++) {
    await capture.reconcile();
    if (
      !(await db.historyInbox.count()) &&
      !(await db.historyLookups.count()) &&
      !(await db.historyScans.count())
    )
      return;
  }
  throw new Error('Capture did not drain: ' + JSON.stringify(await db.historySetup.get('history')));
}
async function event(
  f: Awaited<ReturnType<typeof fixture>>,
  url: string,
  id: string,
  time: number,
) {
  const item = f.native.add(url, id, time);
  expect(await f.capture.capture({ type: 'visited', item })).toBe(true);
  await drain(f.db, f.capture);
}
describe('durable native history capture', () => {
  it('imports individual visits in the selected window with original fractional times and excludes imported/private visits', async () => {
    const { db, native, capture } = await fixture(
      1,
      (n) => {
        n.add(URL_A, 'old', 0.25);
        n.add(URL_A, 'recent', 172_799_900.25);
        n.add(URL_A, 'remote', 172_799_901, { isLocal: false });
        n.add(URL_A, 'private', 172_799_902, { incognito: true });
      },
      172_800_000,
    );
    await drain(db, capture);
    const visits = (await db.queryHistory()).visits;
    expect(visits.map((v) => v.native_id)).toEqual(['recent']);
    expect(visits[0]).toMatchObject({
      visited_at: 172_799_900.25,
      transition: 'link',
      referring_native_id: '0',
      title: 'Observed title',
    });
    const count = await db.drafts.count();
    await capture.enable(1);
    await capture.reconcile();
    expect(await db.drafts.count()).toBe(count);
    expect(native.calls.filter((u) => u === URL_A)).toHaveLength(2); // initial plus bounded overlap; no duplicate publications
    expect(await db.historySeen.count()).toBe(1);
  });
  it('persists an event before lookup and resumes exact visit identities after worker/database reopening', async () => {
    const f = await fixture();
    const item = f.native.add(URL_A, '1', 999_900.125);
    await f.capture.capture({ type: 'visited', item });
    expect(await f.db.historyInbox.count()).toBe(1);
    expect(f.native.calls).toHaveLength(0);
    f.db.close();
    const db = new SynkDatabase(f.db.name);
    dbs.push(db);
    const capture = new HistoryCapture(db, f.native, () => f.clock.time);
    await drain(db, capture);
    const first = (await db.queryHistory()).visits[0]!;
    await capture.capture({ type: 'visited', item });
    await drain(db, capture);
    expect((await db.queryHistory()).visits.map((v) => v.id)).toEqual([first.id]);
    expect(await db.drafts.count()).toBe(1);
    expect(await db.historyInbox.count()).toBe(0);
  });
  it('retains unavailable event lookups and lets unrelated URLs proceed while delayed native visibility retries', async () => {
    const f = await fixture();
    const item = { id: 'url', url: URL_A, title: 'Delayed', lastVisitTime: 999_900 };
    await f.capture.capture({ type: 'visited', item });
    const other = f.native.add(URL_B, '2', 999_901);
    await f.capture.capture({ type: 'visited', item: other });
    await f.capture.reconcile();
    expect((await f.db.queryHistory()).visits.map((v) => v.url)).toEqual([URL_B]);
    expect(await f.db.historyLookups.count()).toBe(1);
    expect((await f.db.historySetup.get('history'))?.error).toContain('unavailable');
    await f.capture.reconcile();
    expect(f.native.calls.filter((u) => u === URL_A)).toHaveLength(1);
    f.native.add(URL_A, '1', 999_900);
    f.clock.time += 2000;
    await drain(f.db, f.capture);
    expect((await f.db.queryHistory()).visits).toHaveLength(2);
    expect((await f.db.historySetup.get('history'))?.error).toBeUndefined();
  });
  it('ignores nonlocal event visits without creating an endless unavailable queue and stops when locality is unknown', async () => {
    const f = await fixture();
    const item = f.native.add(URL_A, 'remote', 999_900, { isLocal: false });
    await f.capture.capture({ type: 'visited', item });
    await drain(f.db, f.capture);
    expect(await f.db.historyVisits.count()).toBe(0);
    const unknown = f.native.add(URL_B, 'unknown', 999_901, { isLocal: undefined });
    await f.capture.capture({ type: 'visited', item: unknown });
    await f.capture.reconcile();
    expect(await f.db.historyVisits.count()).toBe(0);
    expect(await f.db.historyLookups.count()).toBe(1);
    expect((await f.db.historySetup.get('history'))?.error).toContain('locality');
  });
  it('keeps captured visits and saved event jobs on pause, excludes paused visits on resume, and continues future capture', async () => {
    const f = await fixture(1, (n) => n.add(URL_B, 'import', 999_800));
    const item = f.native.add(URL_A, 'saved', 999_900);
    f.native.fail.add(URL_A);
    await f.capture.capture({ type: 'visited', item });
    await f.capture.reconcile();
    await f.capture.reconcile(); // The native import batch is captured before the pause.
    const events = (await f.db.historyLookups.toArray())
      .filter((l) => l.kind === 'event')
      .map((l) => l.id);
    await f.capture.pause();
    expect(
      (await f.db.historyLookups.toArray()).filter((l) => l.kind === 'event').map((l) => l.id),
    ).toEqual(events);
    expect(await f.db.historyScans.count()).toBe(0);
    f.clock.time += 1000;
    const ignored = f.native.add(URL_A, 'paused', f.clock.time);
    expect(await f.capture.capture({ type: 'visited', item: ignored })).toBe(false);
    f.clock.time += 3000;
    f.native.fail.clear();
    await f.capture.enable(1);
    await drain(f.db, f.capture);
    expect((await f.db.queryHistory()).visits.map((v) => v.native_id).sort()).toEqual([
      'import',
      'saved',
    ]);
    await event(f, URL_A, 'future', f.clock.time + 1);
    expect((await f.db.queryHistory()).visits.map((v) => v.native_id).sort()).toEqual([
      'future',
      'import',
      'saved',
    ]);
    expect(
      (await f.db.historySeen.toArray()).find((v) => v.native_id === 'paused')?.suppressed,
    ).toBe(true);
  });
  it('does not retag old captured or uncaptured native records after a source clear and permits reused IDs after baseline', async () => {
    const f = await fixture();
    await event(f, URL_A, 'same', 999_900);
    const old = (await f.db.queryHistory()).visits[0]!,
      setup = (await f.db.historySetup.get('history'))!;
    f.native.add(URL_B, 'uncaptured', 999_901);
    const item = f.native.add(URL_A, 'pending', 999_902);
    await f.capture.capture({ type: 'visited', item });
    await f.db.stageHistory({ type: 'clear', scope: 'source', source_id: f.source });
    await drain(f.db, f.capture);
    expect(await f.db.historyVisits.count()).toBe(0);
    expect((await f.db.historySetup.get('history'))!.incarnation).not.toBe(setup.incarnation);
    expect((await f.db.historySeen.toArray()).filter((v) => v.suppressed)).toHaveLength(3);
    f.native.records.set(URL_A, []);
    // Native databases can reuse an ID and timestamp. The URL clear creates a new incarnation.
    const tag = await historyUrlTag(await f.db.ensureHistoryIndexKey(), URL_A);
    await f.db.stageHistory({ type: 'clear', scope: 'url', source_id: f.source, url_tag: tag });
    await drain(f.db, f.capture);
    await event(f, URL_A, 'same', 999_900);
    expect((await f.db.queryHistory()).visits[0]!.id).not.toBe(old.id);
    expect((await f.db.queryHistory()).visits[0]!.generation).not.toEqual({});
  });
  it('pauses new capture as soon as an unapplied global clear is observed and resumes after its inventory', async () => {
    const f = await fixture();
    f.native.add(URL_A, 'old', 999_900);
    await f.db.stageHistory({ type: 'clear', scope: 'all' });
    const item = f.native.add(URL_A, 'during-baseline', 999_901);
    expect(await f.capture.capture({ type: 'visited', item })).toBe(false);
    expect((await f.db.historySetup.get('history'))?.phase).toBe('baseline');
    await drain(f.db, f.capture);
    await event(f, URL_A, 'after-baseline', f.clock.time + 1);
    expect((await f.db.queryHistory()).visits.map((v) => v.native_id)).toEqual(['after-baseline']);
  });
  it('baselines an unknown URL after a URL clear before its old native records can be imported in the new generation', async () => {
    const f = await fixture();
    f.native.add(URL_A, 'uncaptured-old', 999_900);
    f.native.customSearch = () => []; // The URL has not appeared in any discovery page yet.
    const tag = await historyUrlTag(await f.db.ensureHistoryIndexKey(), URL_A);
    await f.db.stageHistory({ type: 'clear', scope: 'url', source_id: f.source, url_tag: tag });
    await drain(f.db, f.capture);
    expect((await f.db.historyUrlEpochs.get(tag))?.baseline_pending).toBe(true);
    const item = f.native.add(URL_A, 'trigger-baseline', f.clock.time);
    expect(await f.capture.capture({ type: 'visited', item })).toBe(true);
    await drain(f.db, f.capture);
    expect((await f.db.historyUrlEpochs.get(tag))?.baseline_pending).toBe(false);
    expect((await f.db.queryHistory()).visits.map((v) => v.native_id)).toEqual([
      'trigger-baseline',
    ]);
    await event(f, URL_A, 'new', f.clock.time + 1);
    expect((await f.db.queryHistory()).visits.map((v) => v.native_id)).toEqual([
      'new',
      'trigger-baseline',
    ]);
  });
  it('keeps unrelated saved URL events when applying a URL clear and discards only intentionally erased generation work', async () => {
    const f = await fixture();
    await event(f, URL_A, 'old', 999_800);
    const a = f.native.add(URL_A, 'erased', 999_900),
      b = f.native.add(URL_B, 'retained', 999_901);
    f.native.fail.add(URL_A);
    f.native.fail.add(URL_B);
    await f.capture.capture({ type: 'visited', item: a });
    await f.capture.capture({ type: 'visited', item: b });
    await f.capture.reconcile();
    const tag = await historyUrlTag(await f.db.ensureHistoryIndexKey(), URL_A);
    await f.db.stageHistory({ type: 'clear', scope: 'url', source_id: f.source, url_tag: tag });
    f.native.fail.clear();
    f.clock.time += 2000;
    await drain(f.db, f.capture);
    expect((await f.db.queryHistory()).visits.map((v) => v.native_id)).toEqual(['retained']);
  });
  it('reconciles partial native removals against individual IDs and retains other visits and sources', async () => {
    const f = await fixture();
    await event(f, URL_A, 'one', 999_800);
    await event(f, URL_A, 'two', 999_900);
    f.native.records.set(
      URL_A,
      f.native.records.get(URL_A)!.filter((v) => v.visitId === 'two'),
    );
    await f.capture.capture({ type: 'removed', all: false, urls: [URL_A] });
    await drain(f.db, f.capture);
    expect((await f.db.queryHistory()).visits.map((v) => v.native_id)).toEqual(['two']);
    expect(Object.keys((await f.db.historyProjection()).deleted)).toHaveLength(1);
    expect((await f.db.historyMetadata()).barriers).toHaveLength(0);
    f.native.records.set(URL_A, []);
    await f.capture.capture({ type: 'removed', all: false, urls: [URL_A] });
    await drain(f.db, f.capture);
    expect(await f.db.historyVisits.count()).toBe(0);
    expect((await f.db.historyMetadata()).barriers[0]?.action).toMatchObject({
      scope: 'url',
      source_id: f.source,
    });
  });
  it('persists progress across multiple removed URLs and turns native clear-all into a source-only barrier', async () => {
    const f = await fixture();
    await event(f, URL_A, 'one', 999_800);
    await event(f, URL_B, 'two', 999_900);
    f.native.records.clear();
    await f.capture.capture({ type: 'removed', all: false, urls: [URL_A, URL_B] });
    await f.capture.reconcile();
    expect((await f.db.historyInbox.toArray())[0]).toMatchObject({
      event: { urls: [URL_B] },
      url_position: 0,
    }); // Completed removal URLs are erased rather than retained before a position cursor.
    expect(await f.db.historyVisits.count()).toBe(1);
    await drain(f.db, f.capture);
    await f.capture.capture({ type: 'removed', all: true, urls: [] });
    await drain(f.db, f.capture);
    expect(
      (await f.db.historyMetadata()).barriers.some(
        (b) => b.action.scope === 'source' && b.action.source_id === f.source,
      ),
    ).toBe(true);
    expect((await f.db.historyMetadata()).barriers.some((b) => b.action.scope === 'all')).toBe(
      false,
    );
  });
  it('retains lookup progress and rolls back draft, index, seen and counter writes on storage failure', async () => {
    const f = await fixture();
    const item = f.native.add(URL_A, 'one', 999_900);
    await f.capture.capture({ type: 'visited', item });
    const before = (await f.db.state.get('local'))!.next_counter;
    vi.spyOn(f.db.historySeen, 'bulkPut').mockRejectedValueOnce(new Error('Storage full'));
    await f.capture.reconcile();
    expect(await f.db.drafts.count()).toBe(0);
    expect(await f.db.historyVisits.count()).toBe(0);
    expect(await f.db.historySeen.count()).toBe(0);
    expect((await f.db.state.get('local'))!.next_counter).toBe(before);
    expect((await f.db.historyLookups.toArray())[0]!.position).toBe(0);
    f.clock.time += 2000;
    await drain(f.db, f.capture);
    expect(await f.db.historyVisits.count()).toBe(1);
  });
  it('processes at most 100 native records per lookup pass and resumes cached records without another API call', async () => {
    const f = await fixture(1, (n) => {
      for (let i = 0; i < 250; i++) n.add(URL_A, String(i), 999_000 + i);
    });
    await f.capture.reconcile(); // discover
    await f.capture.reconcile(); // first 100
    expect(await f.db.historyVisits.count()).toBe(100);
    expect((await f.db.historyLookups.toArray())[0]!.position).toBe(100);
    const calls = f.native.calls.length;
    await f.capture.reconcile();
    expect(await f.db.historyVisits.count()).toBe(200);
    await f.capture.reconcile();
    expect(await f.db.historyVisits.count()).toBe(250);
    expect(f.native.calls.length).toBe(calls);
  });
  it('bisects truncated native ranges, does not repeat a URL within the job, and retains overflowing timestamp ranges', async () => {
    const f = await fixture(1, (n) => n.add(URL_A, 'one', 999_900));
    let first = true;
    f.native.customSearch = (_start, _end, limit) => {
      if (first) {
        first = false;
        return Array.from({ length: limit }, () => f.native.item(URL_A));
      }
      return [f.native.item(URL_A)]; // native endpoints may repeat one URL at a split boundary
    };
    await drain(f.db, f.capture);
    expect(await f.db.historyVisits.count()).toBe(1);
    expect(f.native.calls.filter((u) => u === URL_A)).toHaveLength(2); // one per import/overlap job
    const overflow = await fixture(1);
    const scan = (await overflow.db.historyScans.toArray())[0]!;
    await overflow.db.historyScans.update(scan.id, { ranges: [{ start: 100, end: 101 }] });
    overflow.native.customSearch = (_s, _e, limit) =>
      Array.from({ length: limit }, () => ({ id: 'overflow', url: URL_A, lastVisitTime: 100 }));
    await overflow.capture.reconcile();
    expect((await overflow.db.historyScans.get(scan.id))?.ranges).toEqual([
      { start: 100, end: 101 },
    ]);
    expect((await overflow.db.historySetup.get('history'))?.error).toContain('10,000');
  });
  it('guards lost/profile-swapped metadata and exports surviving jobs without secret keys', async () => {
    const f = await fixture();
    const item = f.native.add(URL_A, 'one', 999_900);
    await f.capture.capture({ type: 'visited', item });
    const replica = await f.db.exportReplica(),
      text = JSON.stringify(replica);
    expect(text).toContain('history_inbox');
    expect(text).toContain('history_scan_urls');
    expect(text).not.toContain((await f.db.state.get('local'))!.recovery_key);
    expect(text).not.toContain(await f.db.ensureHistoryIndexKey());
    f.native.marker!.id = crypto.randomUUID();
    await f.capture.reconcile();
    expect((await f.db.historySetup.get('history'))?.phase).toBe('blocked');
    expect(await f.db.historyInbox.count()).toBe(1);
    f.native.marker!.id = (await f.db.historySetup.get('history'))!.marker;
    await f.db.historySetup.delete('history');
    await expect(f.capture.enable()).rejects.toThrow('metadata is missing');
  });
  it('normalizes domain exclusions and excludes entire subdomains without matching unrelated suffixes', async () => {
    const f = await fixture();
    await f.capture.enable(0, ['Example.COM.', 'example.com']);
    expect(exclusionDomains(['Example.COM.', 'example.com'])).toEqual(['example.com']);
    expect(excludedHistoryUrl('https://www.example.com/secret', ['example.com'])).toBe(true);
    expect(excludedHistoryUrl('https://notexample.com/', ['example.com'])).toBe(false);
    expect(
      await f.capture.capture({ type: 'visited', item: f.native.add(URL_A, 'secret', 999_900) }),
    ).toBe(false);
    await event(f, URL_B, 'public', 999_900);
    expect((await f.db.queryHistory()).visits.map((v) => v.url)).toEqual([URL_B]);
    await expect(f.capture.enable(0, ['https://example.com'])).rejects.toThrow('hostnames');
  });
  it('audits partial and completely missed native removals without importing uncaptured native visits', async () => {
    const f = await fixture();
    await event(f, URL_A, 'one', 999_800);
    await event(f, URL_A, 'two', 999_900);
    await event(f, URL_B, 'three', 999_901);
    f.native.records.set(
      URL_A,
      f.native.records.get(URL_A)!.filter((v) => v.visitId === 'two'),
    );
    f.native.records.delete(URL_B);
    f.native.add(URL_A, 'not-captured', 999_950);
    await f.capture.audit();
    await drain(f.db, f.capture);
    expect((await f.db.queryHistory()).visits.map((v) => v.native_id)).toEqual(['two']);
    expect((await f.db.historyMetadata()).barriers.some((b) => b.action.scope === 'url')).toBe(
      true,
    );
    expect(Object.keys((await f.db.historyProjection()).deleted)).toHaveLength(1);
  });
  it('does not erase a newly captured visit that appeared after an audit fetched its native snapshot', async () => {
    const f = await fixture();
    await event(f, URL_A, 'old', 999_800);
    await f.capture.audit();
    await f.capture.reconcile();
    const original = f.native.getVisits.bind(f.native);
    const get = vi.spyOn(f.native, 'getVisits').mockImplementationOnce(async (url) => {
      const cached = await original(url);
      const local = (await f.db.state.get('local'))!;
      const base = (await f.db.queryHistory()).visits[0]!;
      await f.db.stageHistory({
        type: 'visit',
        visit: {
          ...base,
          native_id: 'racing',
          visited_at: 999_901,
          id: base.source_id + '/' + base.incarnation + '/racing/999901',
          source_name: local.credentials.name,
        },
      });
      return cached;
    });
    await f.capture.reconcile();
    get.mockRestore();
    expect((await f.db.queryHistory()).visits.map((v) => v.native_id)).toEqual(['racing', 'old']);
  });
  it('pages an audit by distinct local URLs and preserves duplicate visits and other sources', async () => {
    const f = await fixture(),
      key = await f.db.ensureHistoryIndexKey(),
      setup = (await f.db.historySetup.get('history'))!;
    const { historyVisitId } = await import('./history');
    const actions = [];
    for (let i = 0; i < 52; i++) {
      const url = 'https://audit.example/' + i,
        url_tag = await historyUrlTag(key, url);
      for (let n = 0; n < 2; n++)
        actions.push({
          type: 'visit' as const,
          visit: {
            id: historyVisitId(f.source, setup.incarnation, `${i}-${n}`, 999_900),
            source_id: f.source,
            source_name: 'Laptop',
            incarnation: setup.incarnation,
            native_id: `${i}-${n}`,
            visited_at: 999_900,
            url,
            url_tag,
            title: 'Audit',
            generation: {},
          },
        });
    }
    await f.db.stageHistories(actions.slice(0, 100));
    await f.db.stageHistories(actions.slice(100));
    const first = await f.db.localHistoryUrls(f.source);
    expect(first.items).toHaveLength(50);
    expect(first.has_more).toBe(true);
    const second = await f.db.localHistoryUrls(f.source, first.cursor);
    expect(second.items).toHaveLength(2);
    expect(second.has_more).toBe(false);
    expect(new Set([...first.items, ...second.items].map((v) => v.url)).size).toBe(52);
  });
  it('cancels unfetched imports on pause so backdated paused visits cannot enter their old time window', async () => {
    const f = await fixture(1, (n) => n.add(URL_A, 'initial', 999_800));
    await f.capture.reconcile(); // URL discovery is saved, individual visit records are not captured yet.
    expect(await f.db.historyLookups.count()).toBe(1);
    await f.capture.pause();
    expect(await f.db.historyLookups.count()).toBe(0);
    f.native.add(URL_A, 'backdated-during-pause', 999_700);
    await f.capture.enable();
    await drain(f.db, f.capture);
    expect(await f.db.historyVisits.count()).toBe(0);
    expect((await f.db.historySeen.toArray()).every((v) => v.suppressed)).toBe(true);
    await event(f, URL_A, 'new', 999_600); // Genuine fresh event remains valid even when the native clock moves back.
    expect((await f.db.queryHistory()).visits.map((v) => v.native_id)).toEqual(['new']);
  });
  it('preserves cached visit batches when a resume baseline finishes before their lookup retry', async () => {
    const f = await fixture(1, (n) => {
      for (let i = 0; i < 201; i++) n.add(URL_A, String(i), 999_000 + i);
    });
    await f.capture.reconcile();
    await f.capture.reconcile(); // 100 published, 101 captured in the saved batch.
    const lookup = (await f.db.historyLookups.toArray())[0]!;
    await f.capture.pause();
    await f.db.historyLookups.update(lookup.id, { retry_at: f.clock.time + 10_000 });
    f.native.add(URL_A, 'paused', 999_050.5);
    await f.capture.enable();
    for (let i = 0; i < 10; i++) await f.capture.reconcile();
    expect((await f.db.historySetup.get('history'))?.phase).toBe('active');
    expect(await f.db.historyVisits.count()).toBe(100);
    f.clock.time += 10_000;
    await drain(f.db, f.capture);
    expect(await f.db.historyVisits.count()).toBe(201);
    expect(
      (await f.db.historySeen.toArray()).find((v) => v.native_id === 'paused')?.suppressed,
    ).toBe(true);
  });
  it('erases obsolete inbox, lookup and scan copies in the clear transaction even while capture is paused', async () => {
    const f = await fixture(1, (n) => n.add(URL_A, 'initial', 999_800));
    await f.capture.reconcile(); // Persist an import lookup containing a URL/title.
    const item = f.native.add(URL_B, 'queued', 999_900);
    await f.capture.capture({ type: 'visited', item });
    await f.capture.pause();
    expect(await f.db.historyInbox.count()).toBe(1);
    await f.db.stageHistory({ type: 'clear', scope: 'all' });
    expect(await f.db.historyInbox.count()).toBe(0);
    expect(await f.db.historyLookups.count()).toBe(0);
    expect(await f.db.historyScans.count()).toBe(0);
    const exported = JSON.stringify(await f.db.exportReplica());
    expect(exported).not.toContain(URL_A);
    expect(exported).not.toContain(URL_B);
    expect((await f.db.historySetup.get('history'))?.enabled).toBe(false);
  });
  it('erases only an obsolete URL generation and preserves unrelated and newly observed work', async () => {
    const f = await fixture();
    f.native.fail.add(URL_A);
    f.native.fail.add(URL_B);
    await f.capture.capture({ type: 'visited', item: f.native.add(URL_A, 'old', 999_800) });
    await f.capture.capture({ type: 'visited', item: f.native.add(URL_B, 'other', 999_801) });
    await f.capture.reconcile();
    await f.capture.capture({ type: 'visited', item: f.native.add(URL_A, 'queued', 999_802) });
    await f.capture.capture({ type: 'removed', all: false, urls: [URL_A, URL_B] });
    const tag = await historyUrlTag(await f.db.ensureHistoryIndexKey(), URL_A);
    await f.db.stageHistory({ type: 'clear', scope: 'url', source_id: f.source, url_tag: tag });
    expect((await f.db.historyLookups.toArray()).map((l) => l.item.url)).toEqual([URL_B]);
    expect(await f.db.historyInbox.toArray()).toMatchObject([
      { event: { type: 'removed', urls: [URL_B] }, url_position: 0 },
    ]);
    expect(JSON.stringify(await f.db.exportReplica())).not.toContain(URL_A);
    // Capture now observes the URL barrier. Cleanup of older work must not delete this intent.
    await f.capture.capture({ type: 'visited', item: f.native.add(URL_A, 'new', 999_803) });
    await f.db.stageHistory({
      type: 'clear',
      scope: 'source',
      source_id: crypto.randomUUID(),
    });
    expect((await f.db.historyInbox.toArray()).some((r) => r.event.type === 'visited')).toBe(true);
    expect(await f.db.historyLookups.count()).toBe(1);
  });
  it('scrubs selected native metadata in a cached batch without dropping its unrelated visits or position', async () => {
    const f = await fixture(1, (n) => {
      for (let i = 0; i < 201; i++) n.add(URL_A, String(i), 999_000 + i);
    });
    await f.capture.reconcile();
    await f.capture.reconcile(); // First 100 records published; the rest are saved.
    const before = (await f.db.historyLookups.toArray())[0]!;
    const erased = (await f.db.queryHistory({ limit: 200 })).visits.find(
      (v) => v.native_id === '0',
    )!;
    await f.db.stageHistory({ type: 'delete', visit_ids: [erased.id] });
    const cleaned = (await f.db.historyLookups.get(before.id))!;
    expect(cleaned.position).toBe(100);
    expect(cleaned.records).toHaveLength(201);
    expect(cleaned.records![0]).toEqual({
      visitId: '0',
      visitTime: 999_000,
      isLocal: true,
      erased: true,
    });
    expect(cleaned.item.title).toBeUndefined();
    await drain(f.db, f.capture);
    expect(await f.db.historyVisits.count()).toBe(200);
    expect((await f.db.historyMetadata()).deleted[erased.id]).toBeDefined();
  });
  it('does not resurrect a cleared lookup when native I/O finishes after deletion', async () => {
    const f = await fixture();
    await f.db.historySetup.update('history', { last_scan: f.clock.time });
    await f.capture.capture({ type: 'visited', item: f.native.add(URL_A, 'racing', 999_900) });
    const original = f.native.getVisits.bind(f.native);
    vi.spyOn(f.native, 'getVisits').mockImplementationOnce(async (url) => {
      const records = await original(url);
      await f.db.stageHistory({ type: 'clear', scope: 'source', source_id: f.source });
      expect(await f.db.historyLookups.count()).toBe(0);
      return records;
    });
    await f.capture.reconcile();
    expect(await f.db.historyLookups.count()).toBe(0);
    expect(await f.db.historyInbox.count()).toBe(0);
    expect(await f.db.historyVisits.count()).toBe(0);
    expect(JSON.stringify(await f.db.exportReplica())).not.toContain(URL_A);
  });
  it('does not persist selected native content returned after its deletion proof', async () => {
    const f = await fixture();
    await f.db.historySetup.update('history', { last_scan: f.clock.time });
    const setup = (await f.db.historySetup.get('history'))!;
    await f.capture.capture({ type: 'visited', item: f.native.add(URL_A, 'racing', 999_900) });
    const id = historyVisitId(f.source, setup.incarnation, 'racing', 999_900);
    const original = f.native.getVisits.bind(f.native);
    vi.spyOn(f.native, 'getVisits').mockImplementationOnce(async (url) => {
      const records = await original(url);
      await f.db.stageHistory({ type: 'delete', visit_ids: [id] });
      return records;
    });
    await f.capture.reconcile();
    expect(await f.db.historyLookups.count()).toBe(0);
    expect(await f.db.historyVisits.count()).toBe(0);
    expect(JSON.stringify(await f.db.exportReplica())).not.toContain(URL_A);
    expect((await f.db.historyMetadata()).deleted[id]).toBeDefined();
  });
  it('rechecks a discovery job and URL generations after native search returns', async () => {
    const f = await fixture(1, (n) => {
      n.add(URL_A, 'erased', 999_800);
      n.add(URL_B, 'other', 999_801);
    });
    const original = f.native.search.bind(f.native);
    const tag = await historyUrlTag(await f.db.ensureHistoryIndexKey(), URL_A);
    vi.spyOn(f.native, 'search').mockImplementationOnce(async (...args) => {
      const items = await original(...args);
      await f.db.stageHistory({ type: 'clear', scope: 'url', source_id: f.source, url_tag: tag });
      return items;
    });
    await f.capture.reconcile();
    expect((await f.db.historyLookups.toArray()).map((l) => l.item.url)).toEqual([URL_B]);
    const full = await fixture(1, (n) => n.add(URL_A, 'erased', 999_800));
    const search = full.native.search.bind(full.native);
    vi.spyOn(full.native, 'search').mockImplementationOnce(async (...args) => {
      const items = await search(...args);
      await full.db.stageHistory({ type: 'clear', scope: 'all' });
      return items;
    });
    await full.capture.reconcile();
    expect(await full.db.historyLookups.count()).toBe(0);
    expect(JSON.stringify(await full.db.exportReplica())).not.toContain(URL_A);
  });
  it('rolls back capture cleanup, deletion proof and counter on a failed cleanup write', async () => {
    const f = await fixture();
    await f.capture.capture({ type: 'visited', item: f.native.add(URL_A, 'queued', 999_900) });
    const state = (await f.db.state.get('local'))!;
    const before = await f.db.exportReplica();
    const fail = () => {
      throw new Error('Storage failure');
    };
    f.db.historyInbox.hook('deleting', fail);
    await expect(f.db.stageHistory({ type: 'clear', scope: 'all' })).rejects.toThrow(
      'Storage failure',
    );
    expect(await f.db.exportReplica()).toEqual(before);
    expect((await f.db.state.get('local'))!.next_counter).toBe(state.next_counter);
    f.db.historyInbox.hook('deleting').unsubscribe(fail);
  });
  it('upgrades v8 saved capture copies with existing deletion proofs without altering pending ciphertext', async () => {
    const f = await fixture();
    await event(f, URL_A, 'old', 999_800);
    await f.db.flushDrafts();
    await f.capture.capture({ type: 'visited', item: f.native.add(URL_A, 'queued', 999_900) });
    const inbox = await f.db.historyInbox.toArray();
    await f.db.stageHistory({ type: 'clear', scope: 'all' });
    const legacy = new Dexie(`history-capture-v8-${crypto.randomUUID()}`);
    legacy
      .version(8)
      .stores(
        Object.fromEntries(
          f.db.tables.map((t) => [
            t.name,
            [t.schema.primKey.src, ...t.schema.indexes.map((i) => i.src)].join(','),
          ]),
        ),
      );
    for (const table of f.db.tables) await legacy.table(table.name).bulkPut(await table.toArray());
    // The old schema retained these plaintext jobs after the clear.
    await legacy.table('historyInbox').bulkPut(inbox);
    const bytes = await legacy.table('outbox').toArray();
    const state = await legacy.table('state').get('local');
    legacy.close();
    const upgraded = new SynkDatabase(legacy.name);
    dbs.push(upgraded);
    expect(await upgraded.historyInbox.count()).toBe(0);
    expect(await upgraded.outbox.toArray()).toEqual(bytes);
    expect(await upgraded.state.get('local')).toEqual(state);
    expect(JSON.stringify(await upgraded.exportReplica())).not.toContain(URL_A);
  });
});
