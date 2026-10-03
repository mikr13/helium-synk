import { describe, expect, it } from 'vite-plus/test';
import {
  BOOKMARK_ROOTS as roots,
  bookmarkReorder,
  bookmarkRecoveryVersions,
  projectBookmarks,
  restoreBookmark,
  validateBookmarkOperation,
  type BookmarkAction,
  type BookmarkOperation,
} from './bookmarks';
import { balancedPositions, comparePositions, parsePosition, positionBetween } from './position';
import type { VectorClock } from './revision';

const uuid = (n: number) => `00000001-0000-0000-0000-${String(n).padStart(12, '0')}`;
const A = uuid(101),
  B = uuid(102),
  C = uuid(103);
const folder = uuid(1),
  bookmark = uuid(2),
  destination = uuid(3),
  child = uuid(4);
function op(
  id: number,
  author: string,
  counter: number,
  logical: number,
  context: VectorClock,
  action: BookmarkAction,
): BookmarkOperation {
  return {
    kind: 'bookmark',
    schema_version: 1,
    operation_id: uuid(10_000 + id),
    revision: { author, counter, logical, context },
    action,
  };
}
function create(
  node_id: string,
  parent = roots.bar as string,
  position = '1/1',
  name = 'Original',
  type: 'folder' | 'bookmark' = 'bookmark',
): BookmarkAction {
  return {
    type: 'create',
    node_id,
    node_type: type,
    title: name,
    ...(type === 'bookmark' ? { url: 'https://example.test/original' } : {}),
    placement: { parent, position },
  };
}
const base = () => op(1, A, 1, 1, {}, create(bookmark));
function permutations<T>(items: T[]): T[][] {
  if (!items.length) return [[]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
      item,
      ...rest,
    ]),
  );
}
function verifyTree(projection: ReturnType<typeof projectBookmarks>) {
  for (const node of Object.values(projection.nodes)) {
    if (node.id === roots.root) continue;
    const ancestors = new Set<string>([node.id]);
    let parent = node.parent;
    while (parent) {
      expect(ancestors.has(parent)).toBe(false);
      ancestors.add(parent);
      expect(projection.nodes[parent]?.type).toBe('folder');
      parent = projection.nodes[parent].parent;
    }
    expect(projection.nodes[node.parent].children).toContain(node.id);
  }
}

describe('causal bookmark merge', () => {
  it('preserves independent title, URL and atomic placement edits on separate installations', () => {
    const operations = [
      base(),
      op(2, A, 2, 2, { [A]: 1 }, { type: 'edit', node_id: bookmark, title: 'Renamed on A' }),
      op(
        3,
        B,
        1,
        2,
        { [A]: 1 },
        { type: 'edit', node_id: bookmark, url: 'https://example.test/changed' },
      ),
      op(
        4,
        B,
        2,
        3,
        { [A]: 1, [B]: 1 },
        { type: 'move', node_id: bookmark, placement: { parent: roots.other, position: '7/3' } },
      ),
    ];
    const expected = projectBookmarks(operations);
    expect(expected.nodes[bookmark]).toMatchObject({
      title: 'Renamed on A',
      url: 'https://example.test/changed',
      parent: roots.other,
      position: '7/3',
    });
    expect(expected.conflicts).toEqual([]);
    for (const order of permutations(operations)) expect(projectBookmarks(order)).toEqual(expected);
  });
  it('keeps concurrent same-field alternatives and deterministically chooses logical revision/author', () => {
    const a = op(2, A, 2, 2, { [A]: 1 }, { type: 'edit', node_id: bookmark, title: 'A title' });
    const b = op(3, B, 1, 2, { [A]: 1 }, { type: 'edit', node_id: bookmark, title: 'B title' });
    const projection = projectBookmarks([b, a, base()]);
    expect(projection.nodes[bookmark].title).toBe('B title');
    expect(projection.conflicts).toMatchObject([
      {
        field: 'title',
        reason: 'concurrent',
        winner: b.operation_id,
        alternatives: [{ operation_id: a.operation_id, value: 'A title' }],
      },
    ]);
    const chosen = op(
      4,
      C,
      1,
      3,
      { [A]: 2, [B]: 1 },
      { type: 'edit', node_id: bookmark, title: 'Chosen after seeing both' },
    );
    expect(projectBookmarks([chosen, b, base(), a]).conflicts).toEqual([]);
    expect(
      bookmarkRecoveryVersions([chosen, b, base(), a], bookmark, 'title').map((v) => v.value),
    ).toEqual(['Original', 'A title', 'B title', 'Chosen after seeing both']);
    expect(projectBookmarks([chosen, b, base(), a]).nodes[bookmark].title).toBe(
      'Chosen after seeing both',
    );
  });
  it('uses logical revisions rather than author-counter magnitude, delivery sequence or wall time', () => {
    const a = op(
      2,
      A,
      2,
      5,
      { [A]: 1 },
      { type: 'edit', node_id: bookmark, title: 'Higher logical' },
    );
    const b = op(
      3,
      B,
      4,
      4,
      { [A]: 1 },
      { type: 'edit', node_id: bookmark, title: 'Higher author counter' },
    );
    expect(projectBookmarks([base(), a, b]).nodes[bookmark].title).toBe('Higher logical');
  });
  it('retains tombstones permanently, keeps edited deleted data, and restores with a new identity', () => {
    const deletion = op(
      2,
      A,
      2,
      2,
      { [A]: 1 },
      { type: 'remove', node_id: bookmark, observed_descendants: [] },
    );
    const edit = op(
      3,
      B,
      1,
      2,
      { [A]: 1 },
      { type: 'edit', node_id: bookmark, title: 'Recover this edit' },
    );
    for (const operations of permutations([base(), deletion, edit])) {
      const state = projectBookmarks(operations);
      expect(state.nodes[bookmark]).toBeUndefined();
      expect(state.deleted[bookmark].title).toBe('Recover this edit');
      expect(state.conflicts.some((c) => c.reason === 'deleted')).toBe(true);
      const restoration = restoreBookmark(state, bookmark, uuid(20));
      const restored = projectBookmarks([
        ...operations,
        op(4, C, 1, 3, { [A]: 2, [B]: 1 }, restoration),
      ]);
      expect(restored.nodes[uuid(20)]).toMatchObject({
        title: 'Recover this edit',
        restored_from: bookmark,
        parent: roots.recovered,
      });
      expect(restored.nodes[bookmark]).toBeUndefined();
      expect(restored.deleted[bookmark]).toBeDefined();
      verifyTree(restored);
    }
  });
  it('deletes only the observed folder subtree and recovers unseen concurrent children', () => {
    const operations = [
      op(1, A, 1, 1, {}, create(folder, roots.bar, '1/1', 'Folder', 'folder')),
      op(2, A, 2, 2, { [A]: 1 }, create(bookmark, folder)),
      op(
        3,
        A,
        3,
        3,
        { [A]: 2 },
        { type: 'remove', node_id: folder, observed_descendants: [bookmark] },
      ),
      op(4, B, 1, 2, { [A]: 1 }, create(child, folder, '2/1', 'Unseen child')),
    ];
    const expected = projectBookmarks(operations);
    expect(Object.keys(expected.deleted).sort()).toEqual([folder, bookmark].sort());
    expect(expected.nodes[child]).toMatchObject({
      title: 'Unseen child',
      parent: roots.recovered,
      original_placement: { parent: folder, position: '2/1' },
    });
    expect(expected.nodes[roots.recovered].parent).toBe(roots.other);
    for (const order of permutations(operations)) {
      expect(projectBookmarks(order)).toEqual(expected);
      verifyTree(projectBookmarks(order));
    }
  });
  it('breaks concurrent folder cycles identically and retains the requested placements', () => {
    const operations = [
      op(1, A, 1, 1, {}, create(folder, roots.bar, '1/1', 'F1', 'folder')),
      op(2, A, 2, 2, { [A]: 1 }, create(destination, roots.bar, '2/1', 'F2', 'folder')),
      op(
        3,
        B,
        1,
        3,
        { [A]: 2 },
        { type: 'move', node_id: folder, placement: { parent: destination, position: '1/1' } },
      ),
      op(
        4,
        C,
        1,
        3,
        { [A]: 2 },
        { type: 'move', node_id: destination, placement: { parent: folder, position: '1/1' } },
      ),
    ];
    const expected = projectBookmarks(operations);
    expect(expected.nodes[folder].parent).toBe(roots.recovered);
    expect(expected.nodes[destination].parent).toBe(folder);
    expect(expected.conflicts.filter((c) => c.reason === 'cycle')).toHaveLength(1);
    for (const order of permutations(operations)) {
      expect(projectBookmarks(order)).toEqual(expected);
      verifyTree(projectBookmarks(order));
    }
  });
  it('temporarily recovers children with unknown parents and repairs projection when creation arrives', () => {
    const parent = op(1, A, 1, 1, {}, create(folder, roots.bar, '1/1', 'Arriving later', 'folder'));
    const creation = op(2, B, 1, 2, { [A]: 1 }, create(child, folder));
    expect(projectBookmarks([creation]).nodes[child].parent).toBe(roots.recovered);
    const state = projectBookmarks([creation, parent]);
    expect(state.nodes[child].parent).toBe(folder);
    expect(state.nodes[roots.recovered]).toBeUndefined();
    verifyTree(state);
  });
  it('keeps early edits and deletions even when their creation is delivered later', () => {
    const edit = op(
      2,
      B,
      1,
      2,
      { [A]: 1 },
      { type: 'edit', node_id: bookmark, title: 'Late creation, early edit' },
    );
    expect(projectBookmarks([edit]).nodes[bookmark]).toBeUndefined();
    expect(projectBookmarks([edit, base()]).nodes[bookmark].title).toBe(
      'Late creation, early edit',
    );
    const removed = op(
      3,
      C,
      1,
      3,
      { [A]: 1, [B]: 1 },
      { type: 'remove', node_id: bookmark, observed_descendants: [] },
    );
    expect(projectBookmarks([removed, edit, base()]).deleted[bookmark].title).toBe(
      'Late creation, early edit',
    );
  });
  it('routes invalid parent types and attempts to place directly under the browser root to recovery', () => {
    const invalid = op(2, A, 2, 2, { [A]: 1 }, create(child, bookmark));
    const directRoot = op(3, B, 1, 1, {}, create(uuid(20), roots.root));
    const state = projectBookmarks([base(), invalid, directRoot]);
    expect(state.nodes[child].parent).toBe(roots.recovered);
    expect(state.nodes[uuid(20)].parent).toBe(roots.recovered);
    expect(state.conflicts.filter((c) => c.reason === 'invalid-parent')).toHaveLength(2);
    verifyTree(state);
  });
  it('orders concurrent inserts at the same token by stable logical identity', () => {
    const one = op(1, A, 1, 1, {}, create(child, roots.bar, '1/2'));
    const two = op(2, B, 1, 1, {}, create(bookmark, roots.bar, '1/2'));
    expect(projectBookmarks([one, two]).nodes[roots.bar].children).toEqual([bookmark, child]);
    expect(projectBookmarks([two, one])).toEqual(projectBookmarks([one, two]));
  });
  it('converges after a deterministic rebalance concurrent with an offline insert and move', () => {
    const operations = [
      op(1, A, 1, 1, {}, create(folder, roots.bar, '1/1', 'Folder', 'folder')),
      op(2, A, 2, 2, { [A]: 1 }, create(bookmark, folder, '1/3')),
      op(3, A, 3, 3, { [A]: 2 }, create(destination, roots.bar, '2/1', 'Target', 'folder')),
      op(4, A, 4, 4, { [A]: 3 }, bookmarkReorder(folder, [bookmark])),
      op(5, B, 1, 4, { [A]: 3 }, create(child, folder, '1/2')),
      op(
        6,
        C,
        1,
        4,
        { [A]: 3 },
        { type: 'move', node_id: bookmark, placement: { parent: destination, position: '1/1' } },
      ),
    ];
    const expected = projectBookmarks(operations);
    expect(expected.nodes[bookmark].parent).toBe(destination);
    expect(expected.nodes[child].parent).toBe(folder);
    expect(
      expected.conflicts.find((c) => c.node_id === bookmark && c.field === 'placement')
        ?.alternatives,
    ).toHaveLength(1);
    for (const order of permutations(operations)) {
      expect(projectBookmarks(order)).toEqual(expected);
      verifyTree(projectBookmarks(order));
    }
  });
  it('preserves intentionally duplicated bookmarks with distinct logical UUIDs', () => {
    const state = projectBookmarks([base(), op(2, B, 1, 1, {}, create(child))]);
    expect(state.nodes[roots.bar].children).toHaveLength(2);
    expect(state.nodes[bookmark].url).toBe(state.nodes[child].url);
  });
  it('deduplicates a retry but rejects changed contents, reused counters and false causal clocks', () => {
    expect(projectBookmarks([base(), base()])).toEqual(projectBookmarks([base()]));
    expect(() => projectBookmarks([base(), { ...base(), action: create(child) }])).toThrow(
      'identity',
    );
    expect(() => projectBookmarks([base(), op(2, A, 1, 2, {}, create(child))])).toThrow('counter');
    expect(() => projectBookmarks([base(), op(2, B, 1, 1, { [A]: 1 }, create(child))])).toThrow(
      'causal',
    );
  });
  it('rejects mutation of reserved root identities and malformed tokens', () => {
    for (const action of [
      create(roots.bar),
      { type: 'edit', node_id: roots.other, title: 'Bad' },
      { type: 'remove', node_id: roots.mobile, observed_descendants: [] },
      { type: 'move', node_id: bookmark, placement: { parent: roots.bar, position: '2/4' } },
    ] as BookmarkAction[]) {
      expect(() => validateBookmarkOperation(op(1, A, 1, 1, {}, action))).toThrow();
    }
  });
  it('collapses a long sequential edit history without inventing concurrent conflicts', () => {
    const operations = [base()];
    for (let i = 2; i <= 1_000; i++)
      operations.push(
        op(i, A, i, i, { [A]: i - 1 }, { type: 'edit', node_id: bookmark, title: `Revision ${i}` }),
      );
    const state = projectBookmarks(operations.reverse());
    expect(state.nodes[bookmark].title).toBe('Revision 1000');
    expect(state.conflicts).toEqual([]);
    expect(state.frontier[A]).toBe(1_000);
  });
});

describe('exact positions', () => {
  it('creates canonical tokens strictly inside bounds without floating point rounding', () => {
    expect(positionBetween()).toBe('0/1');
    expect(positionBetween(undefined, '0/1')).toBe('-1/1');
    expect(positionBetween('0/1')).toBe('1/1');
    let upper = '1/1';
    for (let i = 0; i < 5_000; i++) {
      const next = positionBetween('0/1', upper);
      expect(comparePositions(next, '0/1')).toBe(1);
      expect(comparePositions(next, upper)).toBe(-1);
      upper = next;
    }
    expect(upper).toBe('1/5001');
  });
  it('rejects non-canonical, oversized, zero-denominator and non-increasing positions', () => {
    for (const token of ['1/0', '01/2', '-0/1', '2/4', '0/2', 'NaN/1', `${'9'.repeat(1024)}/1`])
      expect(() => parsePosition(token)).toThrow();
    expect(() => positionBetween('1/1', '1/1')).toThrow();
    expect(() => positionBetween('2/1', '1/1')).toThrow();
    expect(() => balancedPositions([bookmark, bookmark])).toThrow();
    expect(balancedPositions([bookmark, child])).toEqual([
      { node_id: bookmark, position: '1/1' },
      { node_id: child, position: '2/1' },
    ]);
  });
});
