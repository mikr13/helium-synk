import { balancedPositions, comparePositions, parsePosition, type Position } from './position';
import {
  addVersion,
  canonicalUuid,
  compareText,
  validateRevision,
  validateRevisionSet,
  winner,
  type Revision,
  type VectorClock,
  type Versioned,
} from './revision';

export const BOOKMARK_ROOTS = {
  root: '00000000-0000-0000-0000-000000000000',
  bar: '00000000-0000-0000-0000-000000000001',
  other: '00000000-0000-0000-0000-000000000002',
  mobile: '00000000-0000-0000-0000-000000000003',
  recovered: '00000000-0000-0000-0000-000000000004',
} as const;
export type BookmarkType = 'bookmark' | 'folder';
export interface Placement {
  parent: string;
  position: Position;
}
export type BookmarkAction =
  | {
      type: 'create';
      node_id: string;
      node_type: BookmarkType;
      title: string;
      url?: string;
      placement: Placement;
      restored_from?: string;
    }
  | { type: 'edit'; node_id: string; title?: string; url?: string }
  | { type: 'move'; node_id: string; placement: Placement }
  | { type: 'remove'; node_id: string; observed_descendants: string[] }
  | { type: 'reorder'; parent: string; children: { node_id: string; position: Position }[] };
export interface BookmarkOperation {
  kind: 'bookmark';
  schema_version: 1;
  operation_id: string;
  revision: Revision;
  action: BookmarkAction;
}
export interface BookmarkNode {
  id: string;
  type: BookmarkType;
  title: string;
  url?: string;
  parent: string;
  position: Position;
  children: string[];
  restored_from?: string;
  original_placement?: Placement;
  versions: { title?: string; url?: string; placement?: string };
  system?: boolean;
}
export interface BookmarkConflict {
  node_id: string;
  field: 'title' | 'url' | 'placement' | 'identity' | 'deleted' | 'projection';
  reason: 'concurrent' | 'deleted' | 'missing-parent' | 'invalid-parent' | 'cycle';
  winner?: string;
  alternatives: { operation_id: string; value: unknown }[];
}
export interface BookmarkProjection {
  nodes: Record<string, BookmarkNode>;
  deleted: Record<string, BookmarkNode>;
  conflicts: BookmarkConflict[];
  frontier: VectorClock;
  logical: number;
}
const reserved = new Set<string>(Object.values(BOOKMARK_ROOTS));
function identity(id: unknown, mutable = true): asserts id is string {
  if (!canonicalUuid(id) || (mutable && reserved.has(id)))
    throw new Error('Invalid bookmark identity.');
}
function title(value: unknown): void {
  if (typeof value !== 'string' || value.length > 16_384)
    throw new Error('Invalid bookmark title.');
}
function url(value: unknown): void {
  if (typeof value !== 'string' || !value || value.length > 16_384)
    throw new Error('Invalid bookmark URL.');
}
function placement(value: Placement): void {
  if (!value) throw new Error('Missing bookmark placement.');
  identity(value.parent, false);
  parsePosition(value.position);
}
export function validateBookmarkOperation(op: BookmarkOperation): void {
  if (
    !op ||
    op.kind !== 'bookmark' ||
    op.schema_version !== 1 ||
    !canonicalUuid(op.operation_id) ||
    !op.action
  )
    throw new Error('Unsupported bookmark operation.');
  validateRevision(op.revision);
  const action = op.action;
  if (action.type === 'create') {
    identity(action.node_id);
    title(action.title);
    placement(action.placement);
    if (action.node_type !== 'bookmark' && action.node_type !== 'folder')
      throw new Error('Invalid bookmark type.');
    if (action.node_type === 'bookmark') url(action.url);
    else if (action.url !== undefined) throw new Error('A folder cannot have a URL.');
    if (action.restored_from !== undefined) {
      identity(action.restored_from);
      if (action.restored_from === action.node_id)
        throw new Error('Restoration needs a new identity.');
    }
  } else if (action.type === 'edit') {
    identity(action.node_id);
    if (action.title === undefined && action.url === undefined)
      throw new Error('Empty bookmark edit.');
    if (action.title !== undefined) title(action.title);
    if (action.url !== undefined) url(action.url);
  } else if (action.type === 'move') {
    identity(action.node_id);
    placement(action.placement);
  } else if (action.type === 'remove') {
    identity(action.node_id);
    if (
      !Array.isArray(action.observed_descendants) ||
      action.observed_descendants.length > 1_500 ||
      new Set(action.observed_descendants).size !== action.observed_descendants.length
    )
      throw new Error('Invalid observed deletion set.');
    for (const id of action.observed_descendants) {
      identity(id);
      if (id === action.node_id) throw new Error('Deletion root is repeated.');
    }
  } else if (action.type === 'reorder') {
    identity(action.parent, false);
    if (
      !Array.isArray(action.children) ||
      !action.children.length ||
      action.children.length > 1_500 ||
      new Set(action.children.map((c) => c.node_id)).size !== action.children.length
    )
      throw new Error('Invalid bookmark reorder.');
    for (const child of action.children) {
      identity(child.node_id);
      parsePosition(child.position);
    }
  } else throw new Error('Unsupported bookmark action.');
}
interface Entity {
  births: Versioned<Extract<BookmarkAction, { type: 'create' }>>[];
  title: Versioned<string>[];
  url: Versioned<string>[];
  placement: Versioned<Placement>[];
  deletions: string[];
}
function entity(): Entity {
  return { births: [], title: [], url: [], placement: [], deletions: [] };
}
function version<T>(op: BookmarkOperation, value: T): Versioned<T> {
  return { operation_id: op.operation_id, revision: op.revision, value };
}
function system(id: string, name: string, parent: string, position: Position): BookmarkNode {
  return {
    id,
    type: 'folder',
    title: name,
    parent,
    position,
    children: [],
    versions: {},
    system: true,
  };
}
/** Replay the immutable journal; results depend only on its operation set, never delivery order/time. */
export function projectBookmarks(input: readonly BookmarkOperation[]): BookmarkProjection {
  const byId = new Map<string, BookmarkOperation>();
  for (const op of input) {
    validateBookmarkOperation(op);
    const old = byId.get(op.operation_id);
    if (old && JSON.stringify(old) !== JSON.stringify(op))
      throw new Error('Bookmark operation identity was reused.');
    byId.set(op.operation_id, op);
  }
  const operations = [...byId.values()];
  validateRevisionSet(operations);
  const entities = new Map<string, Entity>();
  const get = (id: string): Entity => {
    const e = entities.get(id) ?? entity();
    entities.set(id, e);
    return e;
  };
  const frontier: VectorClock = {};
  let logical = 0;
  for (const op of operations) {
    frontier[op.revision.author] = Math.max(frontier[op.revision.author] ?? 0, op.revision.counter);
    logical = Math.max(logical, op.revision.logical);
    const action = op.action;
    if (action.type === 'create') {
      const e = get(action.node_id);
      e.births = addVersion(e.births, version(op, action));
      e.title = addVersion(e.title, version(op, action.title));
      if (action.url !== undefined) e.url = addVersion(e.url, version(op, action.url));
      e.placement = addVersion(e.placement, version(op, action.placement));
    } else if (action.type === 'edit') {
      const e = get(action.node_id);
      if (action.title !== undefined) e.title = addVersion(e.title, version(op, action.title));
      if (action.url !== undefined) e.url = addVersion(e.url, version(op, action.url));
    } else if (action.type === 'move') {
      const e = get(action.node_id);
      e.placement = addVersion(e.placement, version(op, action.placement));
    } else if (action.type === 'remove') {
      for (const id of [action.node_id, ...action.observed_descendants])
        get(id).deletions.push(op.operation_id);
    } else {
      for (const child of action.children) {
        const e = get(child.node_id);
        e.placement = addVersion(
          e.placement,
          version(op, { parent: action.parent, position: child.position }),
        );
      }
    }
  }
  const result: BookmarkProjection = {
    nodes: {},
    deleted: {},
    conflicts: [],
    frontier: Object.fromEntries(Object.entries(frontier).sort(([a], [b]) => compareText(a, b))),
    logical,
  };
  result.nodes[BOOKMARK_ROOTS.root] = system(BOOKMARK_ROOTS.root, 'Bookmarks', '', '0/1');
  result.nodes[BOOKMARK_ROOTS.bar] = system(
    BOOKMARK_ROOTS.bar,
    'Bookmarks bar',
    BOOKMARK_ROOTS.root,
    '1/1',
  );
  result.nodes[BOOKMARK_ROOTS.other] = system(
    BOOKMARK_ROOTS.other,
    'Other bookmarks',
    BOOKMARK_ROOTS.root,
    '2/1',
  );
  result.nodes[BOOKMARK_ROOTS.mobile] = system(
    BOOKMARK_ROOTS.mobile,
    'Mobile bookmarks',
    BOOKMARK_ROOTS.root,
    '3/1',
  );
  for (const [id, e] of [...entities.entries()].sort(([a], [b]) => compareText(a, b))) {
    // Retain edit/delete records even when their creation has not arrived yet.
    if (!e.births.length) continue;
    const birth = winner(e.births).value;
    const chosen = winner(e.placement);
    const node: BookmarkNode = {
      id,
      type: birth.node_type,
      title: winner(e.title).value,
      ...(birth.node_type === 'bookmark' ? { url: winner(e.url).value } : {}),
      parent: chosen.value.parent,
      position: chosen.value.position,
      original_placement: { ...chosen.value },
      children: [],
      restored_from: birth.restored_from,
      versions: {
        title: winner(e.title).operation_id,
        url: e.url.length ? winner(e.url).operation_id : undefined,
        placement: chosen.operation_id,
      },
    };
    (e.deletions.length ? result.deleted : result.nodes)[id] = node;
    for (const [field, candidates] of Object.entries({
      title: e.title,
      url: e.url,
      placement: e.placement,
      identity: e.births,
    })) {
      if (candidates.length > 1)
        result.conflicts.push({
          node_id: id,
          field: field as BookmarkConflict['field'],
          reason: 'concurrent',
          winner: candidates[candidates.length - 1]!.operation_id,
          alternatives: candidates
            .slice(0, -1)
            .map((c) => ({ operation_id: c.operation_id, value: c.value })),
        });
    }
    if (e.deletions.length)
      result.conflicts.push({
        node_id: id,
        field: 'deleted',
        reason: 'deleted',
        alternatives: [...new Set(e.deletions)]
          .sort(compareText)
          .map((operation_id) => ({ operation_id, value: node })),
      });
  }
  const recover = (node: BookmarkNode, reason: 'missing-parent' | 'invalid-parent' | 'cycle') => {
    node.parent = BOOKMARK_ROOTS.recovered;
    result.conflicts.push({
      node_id: node.id,
      field: 'projection',
      reason,
      alternatives: [{ operation_id: node.versions.placement!, value: node.original_placement }],
    });
  };
  for (const node of Object.values(result.nodes)) {
    if (node.system || node.parent === BOOKMARK_ROOTS.recovered) continue;
    const parent = result.nodes[node.parent];
    if (!parent) recover(node, 'missing-parent');
    else if (parent.type !== 'folder' || parent.id === BOOKMARK_ROOTS.root)
      recover(node, 'invalid-parent');
  }
  const visited = new Set<string>();
  for (const start of Object.keys(result.nodes).sort(compareText)) {
    if (visited.has(start)) continue;
    const path: string[] = [],
      indexes = new Map<string, number>();
    let current: string | undefined = start;
    while (current && result.nodes[current] && !visited.has(current)) {
      if (indexes.has(current)) {
        const cycle = path.slice(indexes.get(current));
        recover(result.nodes[cycle.sort(compareText)[0]!]!, 'cycle');
        break;
      }
      indexes.set(current, path.length);
      path.push(current);
      current = result.nodes[current]!.parent;
    }
    for (const id of path) visited.add(id);
  }
  if (Object.values(result.nodes).some((node) => node.parent === BOOKMARK_ROOTS.recovered)) {
    result.nodes[BOOKMARK_ROOTS.recovered] = system(
      BOOKMARK_ROOTS.recovered,
      'Recovered bookmarks',
      BOOKMARK_ROOTS.other,
      '0/1',
    );
  }
  for (const node of Object.values(result.nodes)) {
    if (node.parent) result.nodes[node.parent]!.children.push(node.id);
  }
  for (const node of Object.values(result.nodes)) {
    node.children.sort(
      (a, b) =>
        comparePositions(result.nodes[a]!.position, result.nodes[b]!.position) || compareText(a, b),
    );
  }
  result.conflicts.sort(
    (a, b) =>
      compareText(a.node_id, b.node_id) ||
      compareText(a.field, b.field) ||
      compareText(a.reason, b.reason),
  );
  return result;
}
export function bookmarkReorder(parent: string, orderedIds: readonly string[]): BookmarkAction {
  return { type: 'reorder', parent, children: balancedPositions(orderedIds) };
}
export function restoreBookmark(
  projection: BookmarkProjection,
  deletedId: string,
  newId: string,
  target?: Placement,
): BookmarkAction {
  identity(newId);
  const node = projection.deleted[deletedId];
  if (!node) throw new Error('Deleted bookmark is not available for recovery.');
  return {
    type: 'create',
    node_id: newId,
    node_type: node.type,
    title: node.title,
    url: node.url,
    placement: target ?? { parent: BOOKMARK_ROOTS.recovered, position: node.position },
    restored_from: deletedId,
  };
}

/** Every prior value remains in the immutable journal, even after a conflict is resolved. */
export function bookmarkRecoveryVersions(
  input: readonly BookmarkOperation[],
  nodeId: string,
  field: 'title' | 'url' | 'placement',
): Versioned<unknown>[] {
  identity(nodeId);
  const values = new Map<string, Versioned<unknown>>();
  for (const op of input) {
    validateBookmarkOperation(op);
    const action = op.action;
    let value: unknown;
    if (action.type === 'create' && action.node_id === nodeId)
      value = field === 'placement' ? action.placement : action[field];
    else if (action.type === 'edit' && action.node_id === nodeId && field !== 'placement')
      value = action[field];
    else if (action.type === 'move' && action.node_id === nodeId && field === 'placement')
      value = action.placement;
    else if (action.type === 'reorder' && field === 'placement') {
      const child = action.children.find((c) => c.node_id === nodeId);
      if (child) value = { parent: action.parent, position: child.position };
    }
    if (value !== undefined) values.set(op.operation_id, version(op, structuredClone(value)));
  }
  return [...values.values()].sort(
    (a, b) =>
      a.revision.logical - b.revision.logical ||
      compareText(a.revision.author, b.revision.author) ||
      compareText(a.operation_id, b.operation_id),
  );
}
