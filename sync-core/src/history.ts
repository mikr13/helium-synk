import {
  canonicalUuid,
  compareText,
  validateRevision,
  validateRevisionSet,
  type Revision,
  type VectorClock,
} from './revision';

export interface HistoryVisit {
  id: string;
  source_id: string;
  source_name: string;
  incarnation: string;
  native_id: string;
  visited_at: number;
  url: string;
  /** Account-scoped opaque URL tag; clear metadata does not retain plaintext URLs. */
  url_tag: string;
  /** URL-level title available when captured; the native API does not expose historical per-visit titles. */
  title: string;
  transition?: string;
  referring_native_id?: string;
  generation: VectorClock;
}
export type HistoryAction =
  | { type: 'visit'; visit: HistoryVisit }
  | { type: 'delete'; visit_ids: string[] }
  | { type: 'clear'; scope: 'all' }
  | { type: 'clear'; scope: 'source'; source_id: string }
  | { type: 'clear'; scope: 'url'; source_id: string; url_tag: string };
export interface HistoryOperation {
  kind: 'history';
  schema_version: 1;
  operation_id: string;
  revision: Revision;
  action: HistoryAction;
}
export type HistoryClear = HistoryOperation & { action: Extract<HistoryAction, { type: 'clear' }> };
/** Suppression receipt; ordinary history wire payloads reject it. Certificates carry minimal receipts. */
export interface ErasedHistoryOperation extends Omit<HistoryOperation, 'action'> {
  action: {
    type: 'erased-visit';
    visit: Pick<HistoryVisit, 'id' | 'source_id' | 'url_tag' | 'generation'>;
  };
}
export type HistoryJournalOperation = HistoryOperation | ErasedHistoryOperation;
export function isErasedHistoryOperation(value: {
  kind: string;
  action?: { type: string };
}): value is ErasedHistoryOperation {
  return value.kind === 'history' && value.action?.type === 'erased-visit';
}
export function eraseHistoryVisit(operation: HistoryJournalOperation): ErasedHistoryOperation {
  if (operation.action.type !== 'visit') throw new Error('Expected a history visit to erase.');
  const { id, source_id, url_tag, generation } = operation.action.visit;
  const { author, counter, logical, context } = operation.revision;
  return {
    kind: 'history',
    schema_version: 1,
    operation_id: operation.operation_id,
    revision: { author, counter, logical, context: { ...context } },
    action: {
      type: 'erased-visit',
      visit: { id, source_id, url_tag, generation: { ...generation } },
    },
  };
}
export interface HistoryProjection {
  visits: Record<string, HistoryVisit & { operation_id: string }>;
  deleted: Record<string, string[]>;
  stale: Record<string, string[]>;
  barriers: HistoryClear[];
  frontier: VectorClock;
  logical: number;
}
function urlTag(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function nativeId(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && new TextEncoder().encode(value).length <= 128
  );
}
function visitTime(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 8_640_000_000_000_000
  );
}
function text(value: unknown, limit: number, nonempty = false): value is string {
  return typeof value === 'string' && value.length <= limit && (!nonempty || !!value);
}
/** Native IDs are scoped to their source/profile incarnation and original time, including native ID reuse after clearing. */
export function historyVisitId(
  source: string,
  incarnation: string,
  native: string,
  time: number,
): string {
  if (
    !canonicalUuid(source) ||
    !canonicalUuid(incarnation) ||
    !nativeId(native) ||
    !visitTime(time)
  )
    throw new Error('Invalid native history identity.');
  return `${source}/${incarnation}/${encodeURIComponent(native)}/${String(time)}`;
}
export function validHistoryVisitId(id: unknown): id is string {
  if (typeof id !== 'string' || id.length > 512) return false;
  const parts = id.split('/');
  if (parts.length !== 4) return false;
  try {
    return (
      historyVisitId(parts[0]!, parts[1]!, decodeURIComponent(parts[2]!), Number(parts[3])) === id
    );
  } catch {
    return false;
  }
}
function validateGeneration(generation: VectorClock, revision: Revision): void {
  if (
    !generation ||
    typeof generation !== 'object' ||
    Array.isArray(generation) ||
    Object.keys(generation).length > 256
  )
    throw new Error('Invalid history generation.');
  for (const [author, counter] of Object.entries(generation)) {
    if (
      !canonicalUuid(author) ||
      !Number.isSafeInteger(counter) ||
      counter < 1 ||
      (author === revision.author
        ? counter >= revision.counter
        : counter > (revision.context[author] ?? 0))
    )
      throw new Error('History generation exceeds observed causal context.');
  }
}
export function validateHistoryOperation(op: HistoryOperation): void {
  if (
    !op ||
    op.kind !== 'history' ||
    op.schema_version !== 1 ||
    !canonicalUuid(op.operation_id) ||
    !op.action
  )
    throw new Error('Unsupported history operation.');
  validateRevision(op.revision);
  const a = op.action;
  if (a.type === 'visit') {
    const v = a.visit;
    if (
      !v ||
      v.source_id !== op.revision.author ||
      !text(v.source_name, 100, true) ||
      !text(v.url, 16_384, true) ||
      !urlTag(v.url_tag) ||
      !text(v.title, 4_000) ||
      (v.transition !== undefined && !text(v.transition, 64, true)) ||
      (v.referring_native_id !== undefined && !nativeId(v.referring_native_id)) ||
      historyVisitId(v.source_id, v.incarnation, v.native_id, v.visited_at) !== v.id ||
      !v.generation ||
      typeof v.generation !== 'object' ||
      Array.isArray(v.generation) ||
      Object.keys(v.generation).length > 256
    )
      throw new Error('Invalid history visit.');
    validateGeneration(v.generation, op.revision);
  } else if (a.type === 'delete') {
    if (
      !Array.isArray(a.visit_ids) ||
      a.visit_ids.length < 1 ||
      a.visit_ids.length > 80 ||
      new Set(a.visit_ids).size !== a.visit_ids.length ||
      !a.visit_ids.every(validHistoryVisitId)
    )
      throw new Error('Invalid selected history deletion.');
  } else if (a.type === 'clear') {
    if (
      !['all', 'source', 'url'].includes(a.scope) ||
      (a.scope !== 'all' && !canonicalUuid(a.source_id)) ||
      (a.scope === 'url' && !urlTag(a.url_tag))
    )
      throw new Error('Invalid history clear scope.');
  } else throw new Error('Unsupported history action.');
}
function matches(clear: HistoryClear, source: string, url_tag: string): boolean {
  const a = clear.action;
  return (
    a.scope === 'all' || (a.source_id === source && (a.scope === 'source' || a.url_tag === url_tag))
  );
}
/** Only matching clear barriers contribute a visit's generation, not unrelated traffic or receipt clocks. */
export function historyGeneration(
  projection: HistoryProjection,
  source: string,
  url_tag: string,
): VectorClock {
  const generation: VectorClock = {};
  for (const b of projection.barriers)
    if (matches(b, source, url_tag))
      generation[b.revision.author] = Math.max(
        generation[b.revision.author] ?? 0,
        b.revision.counter,
      );
  return generation;
}
/** Replay immutable visits, permanent selected-record tombstones and source/global/URL generation barriers. */
export function projectHistory(input: readonly HistoryJournalOperation[]): HistoryProjection {
  const byId = new Map<string, HistoryJournalOperation>();
  for (const op of input) {
    if (isErasedHistoryOperation(op)) {
      const v = op.action.visit;
      if (
        op.schema_version !== 1 ||
        !canonicalUuid(op.operation_id) ||
        !v ||
        !validHistoryVisitId(v.id) ||
        v.source_id !== op.revision?.author ||
        !v.id.startsWith(v.source_id + '/') ||
        !urlTag(v.url_tag)
      )
        throw new Error('Invalid erased history receipt.');
      validateRevision(op.revision);
      validateGeneration(v.generation, op.revision);
    } else validateHistoryOperation(op);
    const old = byId.get(op.operation_id);
    if (old && JSON.stringify(old) !== JSON.stringify(op))
      throw new Error('History operation identity was reused.');
    byId.set(op.operation_id, op);
  }
  const operations = [...byId.values()].sort((a, b) => compareText(a.operation_id, b.operation_id));
  validateRevisionSet(operations);
  const result: HistoryProjection = {
      visits: {},
      deleted: {},
      stale: {},
      barriers: [],
      frontier: {},
      logical: 0,
    },
    visits = new Map<
      string,
      HistoryJournalOperation & {
        action: Extract<HistoryAction, { type: 'visit' }> | ErasedHistoryOperation['action'];
      }
    >();
  for (const op of operations) {
    result.frontier[op.revision.author] = Math.max(
      result.frontier[op.revision.author] ?? 0,
      op.revision.counter,
    );
    result.logical = Math.max(result.logical, op.revision.logical);
    if (op.action.type === 'clear') result.barriers.push(structuredClone(op) as HistoryClear);
    else if (op.action.type === 'delete')
      for (const id of op.action.visit_ids) (result.deleted[id] ??= []).push(op.operation_id);
    else {
      const next = op as HistoryJournalOperation & {
          action: Extract<HistoryAction, { type: 'visit' }> | ErasedHistoryOperation['action'];
        },
        old = visits.get(next.action.visit.id);
      if (
        old &&
        (old.action.visit.url_tag !== next.action.visit.url_tag ||
          (old.action.type === 'visit' &&
            next.action.type === 'visit' &&
            old.action.visit.url !== next.action.visit.url))
      )
        throw new Error('A native history identity was reused with a different URL.');
      // Reconciliation may observe a newer URL-level title. It must never retag an old visit into a new clear generation.
      if (!old || next.revision.counter < old.revision.counter)
        visits.set(next.action.visit.id, next);
    }
  }
  for (const [id, op] of [...visits.entries()].sort(([a], [b]) => compareText(a, b))) {
    const v = op.action.visit;
    if (result.deleted[id]) continue;
    const stale = result.barriers
      .filter(
        (b) =>
          matches(b, v.source_id, v.url_tag) &&
          (v.generation[b.revision.author] ?? 0) < b.revision.counter,
      )
      .map((b) => b.operation_id);
    if (stale.length) result.stale[id] = stale;
    else if (op.action.type === 'erased-visit')
      throw new Error('Erased history receipt has no deletion or clear proof.');
    else result.visits[id] = { ...structuredClone(op.action.visit), operation_id: op.operation_id };
  }
  return result;
}
export interface HistoryQuery {
  text?: string;
  source_id?: string;
  start_time?: number;
  end_time?: number;
  offset?: number;
  limit?: number;
}
/** Search is local; exact original visit timestamps and separate repeated visits remain intact. */
export function searchHistory(projection: HistoryProjection, query: HistoryQuery = {}) {
  const needle = (query.text ?? '').trim().toLowerCase();
  const offset = query.offset ?? 0,
    limit = query.limit ?? 100;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200 ||
    (query.source_id !== undefined && !canonicalUuid(query.source_id)) ||
    (query.start_time !== undefined && !visitTime(query.start_time)) ||
    (query.end_time !== undefined && !visitTime(query.end_time))
  )
    throw new Error('Invalid history search.');
  const matches = Object.values(projection.visits)
    .filter(
      (v) =>
        (!query.source_id || v.source_id === query.source_id) &&
        (query.start_time === undefined || v.visited_at >= query.start_time) &&
        (query.end_time === undefined || v.visited_at < query.end_time) &&
        (!needle ||
          v.url.toLowerCase().includes(needle) ||
          v.title.toLowerCase().includes(needle) ||
          v.source_name.toLowerCase().includes(needle)),
    )
    .sort((a, b) => b.visited_at - a.visited_at || compareText(a.id, b.id));
  return {
    visits: matches.slice(offset, offset + limit),
    total: matches.length,
    has_more: matches.length > offset + limit,
  };
}
