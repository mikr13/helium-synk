import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  historyVisitId,
  validHistoryVisitId,
  projectHistory,
  historyGeneration,
  searchHistory,
  validateHistoryOperation,
  type HistoryAction,
  type HistoryOperation,
  type HistoryVisit,
} from './history';
import type { VectorClock } from './revision';
const A = crypto.randomUUID(),
  B = crypto.randomUUID(),
  C = crypto.randomUUID(),
  D = crypto.randomUUID(),
  I = crypto.randomUUID();
const tag = (url: string) => createHash('sha256').update(url).digest('hex');
let logical = 100;
function operation(
  author: string,
  counter: number,
  action: HistoryAction,
  context: VectorClock = {},
): HistoryOperation {
  return {
    kind: 'history',
    schema_version: 1,
    operation_id: crypto.randomUUID(),
    revision: { author, counter, logical: Math.max(++logical, counter), context },
    action,
  };
}
function visit(
  source = A,
  native = '1',
  time = 1000,
  generation: VectorClock = {},
  url = 'https://example.com/research',
): HistoryVisit {
  return {
    id: historyVisitId(source, I, native, time),
    source_id: source,
    source_name: source === A ? 'Laptop' : 'Desktop',
    incarnation: I,
    native_id: native,
    visited_at: time,
    url,
    url_tag: tag(url),
    title: 'Research notes',
    transition: 'typed',
    referring_native_id: '0',
    generation,
  };
}
function permutations<T>(items: T[]): T[][] {
  return items.length
    ? items.flatMap((item, index) =>
        permutations(items.filter((_, i) => i !== index)).map((rest) => [item, ...rest]),
      )
    : [[]];
}
describe('history visits, search and privacy clear barriers', () => {
  it('namespaces native IDs and original timestamps, preserves repeated visits, and handles opaque IDs and native reuse', () => {
    const a = visit(A, 'same/id', 1000.25),
      b = visit(B, 'same/id', 1000.25),
      later = visit(A, 'same/id', 1001);
    expect(validHistoryVisitId(a.id)).toBe(true);
    expect(a.id).not.toBe(b.id);
    expect(a.id).not.toBe(later.id);
    expect(historyVisitId(A, crypto.randomUUID(), a.native_id, a.visited_at)).not.toBe(a.id);
    const p = projectHistory([
      operation(A, 1, { type: 'visit', visit: a }),
      operation(B, 1, { type: 'visit', visit: b }),
      operation(A, 2, { type: 'visit', visit: later }),
    ]);
    expect(Object.values(p.visits)).toHaveLength(3);
    expect(p.visits[a.id]!.visited_at).toBe(1000.25);
    expect(p.visits[a.id]!.transition).toBe('typed');
    expect(validHistoryVisitId(a.id.replace('1000.25', '01000.25'))).toBe(false);
  });
  it('deduplicates the same operation and repeated capture while retaining the earliest observed title', () => {
    const v = visit(),
      first = operation(A, 1, { type: 'visit', visit: v }),
      duplicate = operation(A, 2, { type: 'visit', visit: { ...v, title: 'Later URL title' } });
    const p = projectHistory([duplicate, first, first]);
    expect(Object.values(p.visits)).toHaveLength(1);
    expect(p.visits[v.id]!.title).toBe('Research notes');
  });
  it('makes selected deletion permanent in every delivery order while preserving a separate later visit to the same URL', () => {
    const v = visit(),
      a = operation(A, 1, { type: 'visit', visit: v }),
      deletion = operation(B, 1, { type: 'delete', visit_ids: [v.id] }, { [A]: 1 }),
      again = operation(A, 2, { type: 'visit', visit: visit(A, '2', 2000) });
    for (const order of permutations([a, deletion, again])) {
      const p = projectHistory(order);
      expect(p.visits[v.id]).toBeUndefined();
      expect(p.deleted[v.id]).toEqual([deletion.operation_id]);
      expect(Object.values(p.visits)).toHaveLength(1);
    }
  });
  it('blocks delayed offline uploads after a source clear but permits new visits in the acknowledged generation', () => {
    const old = operation(A, 1, { type: 'visit', visit: visit(A, '1', 1000) }),
      delayed = operation(A, 2, { type: 'visit', visit: visit(A, '2', 9000) }),
      other = operation(B, 1, { type: 'visit', visit: visit(B) }),
      clear = operation(C, 1, { type: 'clear', scope: 'source', source_id: A });
    const generation = historyGeneration(
        projectHistory([clear]),
        A,
        'https://example.com/research',
      ),
      fresh = operation(
        A,
        3,
        { type: 'visit', visit: visit(A, '3', 5000, generation) },
        { [C]: 1 },
      );
    const expected = projectHistory([old, delayed, other, clear, fresh]);
    expect(
      Object.values(expected.visits)
        .map((v) => v.native_id)
        .sort(),
    ).toEqual(['1', '3']);
    expect(Object.keys(expected.stale)).toHaveLength(2);
    for (const order of permutations([old, delayed, other, clear, fresh]))
      expect(projectHistory(order)).toEqual(expected);
  });
  it('requires every concurrent matching clear barrier and does not use unrelated URL clear counters as a generation', () => {
    const global = operation(C, 1, { type: 'clear', scope: 'all' }),
      source = operation(D, 1, { type: 'clear', scope: 'source', source_id: A }),
      unrelated = operation(B, 1, {
        type: 'clear',
        scope: 'url',
        source_id: A,
        url_tag: tag('https://elsewhere.test/'),
      });
    const p = projectHistory([global, source, unrelated]),
      generation = historyGeneration(p, A, tag('https://example.com/research'));
    expect(generation).toEqual({ [C]: 1, [D]: 1 });
    const partial = operation(
        A,
        1,
        { type: 'visit', visit: visit(A, '1', 1000, { [C]: 1 }) },
        { [C]: 1 },
      ),
      complete = operation(
        A,
        2,
        { type: 'visit', visit: visit(A, '2', 2000, generation) },
        { [C]: 1, [D]: 1 },
      );
    const after = projectHistory([global, source, unrelated, partial, complete]);
    expect(Object.values(after.visits)).toHaveLength(1);
    expect(after.stale[visit().id]).toEqual([source.operation_id]);
  });
  it('limits URL clears to exact URLs on one source and allows future visits after learning the URL barrier', () => {
    const old = operation(A, 1, { type: 'visit', visit: visit() }),
      otherUrl = operation(A, 2, {
        type: 'visit',
        visit: visit(A, '2', 1001, {}, 'https://example.com/other'),
      }),
      otherSource = operation(B, 1, { type: 'visit', visit: visit(B) }),
      clear = operation(C, 1, {
        type: 'clear',
        scope: 'url',
        source_id: A,
        url_tag: tag(visit().url),
      });
    const fresh = operation(
      A,
      3,
      { type: 'visit', visit: visit(A, '3', 3000, { [C]: 1 }) },
      { [C]: 1 },
    );
    const p = projectHistory([old, otherUrl, otherSource, clear, fresh]);
    expect(Object.values(p.visits)).toHaveLength(3);
    expect(Object.keys(p.stale)).toEqual([visit().id]);
  });
  it('never retags an old visit into a new generation during a later reconciliation scan', () => {
    const v = visit(),
      old = operation(A, 1, { type: 'visit', visit: v }),
      clear = operation(B, 1, { type: 'clear', scope: 'all' }),
      recaptured = operation(
        A,
        2,
        { type: 'visit', visit: { ...v, generation: { [B]: 1 }, title: 'Re-imported title' } },
        { [B]: 1 },
      );
    for (const order of permutations([old, clear, recaptured])) {
      const p = projectHistory(order);
      expect(p.visits[v.id]).toBeUndefined();
      expect(p.stale[v.id]).toEqual([clear.operation_id]);
    }
  });
  it('searches the local decrypted timeline with original times, profile filters and bounded pages', () => {
    const visits = Array.from({ length: 5 }, (_, n) =>
      operation(A, n + 1, { type: 'visit', visit: visit(A, String(n), 1000 + n) }),
    );
    visits.push(
      operation(B, 1, { type: 'visit', visit: { ...visit(B), title: 'Different page' } }),
    );
    const p = projectHistory(visits),
      page = searchHistory(p, {
        text: 'RESEARCH',
        source_id: A,
        start_time: 1001,
        end_time: 1005,
        limit: 2,
      });
    expect(page.visits.map((v) => v.visited_at)).toEqual([1004, 1003]);
    expect(page.total).toBe(4);
    expect(page.has_more).toBe(true);
    expect(
      searchHistory(p, {
        text: 'research',
        source_id: A,
        start_time: 1001,
        end_time: 1005,
        offset: 2,
        limit: 2,
      }).visits.map((v) => v.visited_at),
    ).toEqual([1002, 1001]);
    expect(searchHistory(p, { source_id: B }).total).toBe(1);
    expect(() => searchHistory(p, { limit: 201 })).toThrow('search');
  });
  it('rejects changed operation/native identities, author counter reuse and generation claims outside causal context', () => {
    const v = visit(),
      old = operation(A, 1, { type: 'visit', visit: v });
    expect(() =>
      projectHistory([
        old,
        { ...old, action: { type: 'visit', visit: { ...v, title: 'Changed' } } },
      ]),
    ).toThrow('identity');
    expect(() =>
      projectHistory([
        old,
        operation(A, 2, { type: 'visit', visit: { ...v, url: 'https://changed.test/' } }),
      ]),
    ).toThrow('native history identity');
    expect(() =>
      projectHistory([old, operation(A, 1, { type: 'visit', visit: visit(A, '2') })]),
    ).toThrow('counter');
    expect(() =>
      validateHistoryOperation(
        operation(A, 2, { type: 'visit', visit: { ...v, generation: { [B]: 1 } } }),
      ),
    ).toThrow('generation');
    expect(() => validateHistoryOperation(operation(B, 2, { type: 'visit', visit: v }))).toThrow(
      'visit',
    );
  });
});
