import { BOOKMARK_ROOTS, type BookmarkAction, type BookmarkProjection } from './bookmarks';
import { compareText, type VectorClock, type Revision } from './revision';
import { positionBetween } from './position';

export interface NativeBookmark {
  id: string;
  title: string;
  url?: string;
  parentId?: string;
  index?: number;
  children?: NativeBookmark[];
  folderType?: 'bookmarks-bar' | 'other' | 'mobile' | 'managed';
  syncing?: boolean;
  unmodifiable?: string;
}
export interface BookmarkBrowser {
  getTree(): Promise<NativeBookmark[]>;
  create(details: {
    parentId: string;
    index?: number;
    title: string;
    url?: string;
  }): Promise<NativeBookmark>;
  update(id: string, changes: { title?: string; url?: string }): Promise<NativeBookmark>;
  move(id: string, destination: { parentId: string; index: number }): Promise<NativeBookmark>;
  remove(id: string): Promise<void>;
  getMarker(): Promise<string | undefined>;
  setMarker(value: string): Promise<void>;
}
export type BookmarkEvent =
  | { type: 'created'; node: NativeBookmark }
  | { type: 'changed'; id: string; title: string; url?: string }
  | { type: 'moved'; id: string; parentId: string; index: number }
  | { type: 'removed'; id: string; node: NativeBookmark }
  | { type: 'reordered'; id: string; childIds: string[] };
export interface BookmarkInbox {
  id?: number;
  native_id: string;
  before?: NativeBaseline;
  context?: VectorClock;
  revisions?: Revision[];
  event: BookmarkEvent;
}
export interface NativeBaseline {
  title: string;
  url?: string;
  parentId?: string;
  children: string[];
}
export interface BookmarkBinding {
  logical_id: string;
  native_id: string;
  baseline: NativeBaseline;
  system?: boolean;
}
export type RootSelection = Partial<Record<'bar' | 'other' | 'mobile', string>>;
export interface BookmarkImport {
  id: string;
  native_fingerprint: string;
  replica_fingerprint: string;
  roots: RootSelection;
  bindings: BookmarkBinding[];
  actions: BookmarkAction[];
  matches: number;
  imports: number;
  remote: number;
  skipped: number;
  backup: {
    format: 'helium-synk-bookmark-backup';
    version: 1;
    created_at: string;
    tree: NativeBookmark[];
    replica: BookmarkProjection;
  };
}
export interface BookmarkSetup {
  id: 'bookmark';
  incarnation: string;
  phase: 'preview' | 'active';
  applied_context?: VectorClock;
  roots: RootSelection;
  preview?: BookmarkImport;
  backup?: BookmarkImport['backup'];
}
export interface BookmarkEffect {
  id: string;
  logical_id: string;
  type: 'create' | 'update' | 'move' | 'remove';
  status: 'prepared' | 'issued' | 'done' | 'blocked';
  native_id?: string;
  before?: NativeBaseline;
  desired: { title?: string; url?: string; parentId?: string; index?: number };
  before_children?: string[];
  observed?: Omit<NativeBookmark, 'children'>;
  error?: string;
  echo_consumed?: boolean;
}
export function baseline(node: NativeBookmark): NativeBaseline {
  return {
    title: node.title,
    url: node.url,
    parentId: node.parentId,
    children: (node.children ?? []).map((n) => n.id),
  };
}
export function flattenBookmarks(tree: readonly NativeBookmark[]): Map<string, NativeBookmark> {
  const nodes = new Map<string, NativeBookmark>();
  const walk = (node: NativeBookmark, parentId?: string, index?: number) => {
    if (
      !node ||
      typeof node.id !== 'string' ||
      typeof node.title !== 'string' ||
      nodes.has(node.id)
    )
      throw new Error('Invalid native bookmark tree.');
    const copy = { ...node, parentId: node.parentId ?? parentId, index: node.index ?? index };
    nodes.set(node.id, copy);
    (node.children ?? []).forEach((child, i) => walk(child, node.id, i));
  };
  tree.forEach((node) => walk(node));
  return nodes;
}
export function nativeFingerprint(tree: readonly NativeBookmark[]): string {
  return JSON.stringify(
    [...flattenBookmarks(tree).values()]
      .sort((a, b) => compareText(a.id, b.id))
      .map((n) => ({
        id: n.id,
        title: n.title,
        url: n.url,
        parentId: n.parentId,
        index: n.index,
        children: (n.children ?? []).map((c) => c.id),
        folderType: n.folderType,
        syncing: n.syncing,
        unmodifiable: n.unmodifiable,
      })),
  );
}
export function replicaFingerprint(replica: BookmarkProjection): string {
  return JSON.stringify({
    nodes: replica.nodes,
    deleted: replica.deleted,
    frontier: replica.frontier,
  });
}
export function selectBookmarkRoots(
  tree: readonly NativeBookmark[],
  selected: RootSelection = {},
): RootSelection {
  const nodes = [...flattenBookmarks(tree).values()];
  const roots: RootSelection = {};
  for (const [role, type] of [
    ['bar', 'bookmarks-bar'],
    ['other', 'other'],
    ['mobile', 'mobile'],
  ] as const) {
    const candidates = nodes.filter(
      (n) => n.folderType === type && !n.unmodifiable && n.url === undefined,
    );
    const preferred = candidates.filter((n) => n.syncing !== true);
    const id = selected[role];
    const chosen = id
      ? candidates.find((n) => n.id === id)
      : preferred.length === 1
        ? preferred[0]
        : candidates.length === 1
          ? candidates[0]
          : undefined;
    if (id && !chosen) throw new Error('Selected bookmark root is unavailable or managed.');
    if (!chosen && candidates.length)
      throw new Error('Multiple writable bookmark roots need an explicit selection.');
    if (chosen) roots[role] = chosen.id;
  }
  if (!roots.other)
    throw new Error(
      'No writable Other Bookmarks root. This adapter requires Chromium folderType support (134+).',
    );
  return roots;
}
/** Exact, unique matches within the same logical folder; duplicates always remain distinct. */
export function previewBookmarkImport(
  tree: NativeBookmark[],
  replica: BookmarkProjection,
  selected: RootSelection = {},
): BookmarkImport {
  const roots = selectBookmarkRoots(tree, selected),
    nodes = flattenBookmarks(tree);
  const bindings: BookmarkBinding[] = [],
    actions: BookmarkAction[] = [];
  let matches = 0,
    skipped = 0;
  const signature = (node: NativeBookmark): string =>
    JSON.stringify([
      node.url === undefined ? 'folder' : 'bookmark',
      node.title,
      node.url,
      node.url === undefined
        ? (node.children ?? [])
            .filter((c) => !c.unmodifiable)
            .map(signature)
            .sort()
        : undefined,
    ]);
  const remoteSignature = (id: string): string => {
    const n = replica.nodes[id]!;
    return JSON.stringify([
      n.type,
      n.title,
      n.url,
      n.type === 'folder'
        ? n.children
            .filter((c) => !replica.nodes[c]?.system)
            .map(remoteSignature)
            .sort()
        : undefined,
    ]);
  };
  const walk = (native: NativeBookmark, logical: string) => {
    bindings.push({
      logical_id: logical,
      native_id: native.id,
      baseline: baseline(native),
      system: Object.values<string>(BOOKMARK_ROOTS).includes(logical),
    });
    const children = (native.children ?? []).filter((c) => {
      if (c.unmodifiable || c.folderType) {
        skipped++;
        return false;
      }
      return true;
    });
    const remoteChildren = (replica.nodes[logical]?.children ?? []).filter(
      (id) => !replica.nodes[id]?.system,
    );
    const nativeSignatures = children.map(signature),
      remoteSignatures = remoteChildren.map(remoteSignature);
    let last = remoteChildren.length ? replica.nodes[remoteChildren.at(-1)!]!.position : undefined;
    children.forEach((child, index) => {
      const sig = nativeSignatures[index]!,
        candidates = remoteChildren.filter((_, i) => remoteSignatures[i] === sig);
      const match =
        candidates.length === 1 && nativeSignatures.filter((s) => s === sig).length === 1
          ? candidates[0]
          : undefined;
      const id = match ?? crypto.randomUUID();
      if (match) matches++;
      else {
        last = positionBetween(last);
        actions.push({
          type: 'create',
          node_id: id,
          node_type: child.url === undefined ? 'folder' : 'bookmark',
          title: child.title,
          url: child.url,
          placement: { parent: logical, position: last },
        });
      }
      walk(nodes.get(child.id)!, id);
    });
  };
  for (const role of ['bar', 'other', 'mobile'] as const)
    if (roots[role]) walk(nodes.get(roots[role]!)!, BOOKMARK_ROOTS[role]);
  return {
    id: crypto.randomUUID(),
    native_fingerprint: nativeFingerprint(tree),
    replica_fingerprint: replicaFingerprint(replica),
    roots,
    bindings,
    actions,
    matches,
    imports: actions.length,
    remote: Object.values(replica.nodes).filter((n) => !n.system).length,
    skipped,
    backup: {
      format: 'helium-synk-bookmark-backup',
      version: 1,
      created_at: new Date().toISOString(),
      tree: structuredClone(tree),
      replica: structuredClone(replica),
    },
  };
}
