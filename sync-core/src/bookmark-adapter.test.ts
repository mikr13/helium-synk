import { afterEach, describe, expect, it, vi } from 'vitest';
import { SynkDatabase } from './database';
import { BookmarkAdapter } from './bookmark-adapter';
import { BOOKMARK_ROOTS } from './bookmarks';
import { generateRecoveryKey, encryptPayload } from './crypto';
import { SyncCoordinator, type Transport } from './sync';
import type { Envelope } from './protocol';
import {
  flattenBookmarks,
  previewBookmarkImport,
  selectBookmarkRoots,
  type BookmarkBrowser,
  type BookmarkEvent,
  type NativeBookmark,
} from './bookmark-native';

const databases: SynkDatabase[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) await db.delete();
});
class FakeBrowser implements BookmarkBrowser {
  marker?: string;
  tree: NativeBookmark[] = [
    {
      id: 'root',
      title: 'Bookmarks',
      children: [
        {
          id: 'bar-native',
          title: 'Localized bar',
          folderType: 'bookmarks-bar',
          syncing: false,
          children: [],
        },
        {
          id: 'other-native',
          title: 'Localized other',
          folderType: 'other',
          syncing: false,
          children: [],
        },
      ],
    },
  ];
  events?: (event: BookmarkEvent) => Promise<unknown>;
  afterMutation?: (event: BookmarkEvent) => Promise<void>;
  beforeUpdate?: () => Promise<void>;
  calls: string[] = [];
  next = 0;
  async getTree() {
    return structuredClone(this.tree);
  }
  async getMarker() {
    return this.marker;
  }
  async setMarker(value: string) {
    this.marker = value;
  }
  private nodes() {
    return flattenBookmarks(this.tree);
  }
  private actual(id: string): NativeBookmark {
    const visit = (nodes: NativeBookmark[]): NativeBookmark | undefined => {
      for (const n of nodes) {
        if (n.id === id) return n;
        const found = visit(n.children ?? []);
        if (found) return found;
      }
    };
    const found = visit(this.tree);
    if (!found) throw new Error('No native bookmark');
    return found;
  }
  private copy(id: string): NativeBookmark {
    return structuredClone(this.nodes().get(id)!);
  }
  private async emit(event: BookmarkEvent) {
    await this.events?.(event);
    await this.afterMutation?.(event);
  }
  async create(details: { parentId: string; index?: number; title: string; url?: string }) {
    this.calls.push('create');
    const parent = this.actual(details.parentId),
      node: NativeBookmark = {
        id: `native-${++this.next}`,
        title: details.title,
        url: details.url,
        ...(details.url === undefined ? { children: [] } : {}),
      };
    (parent.children ??= []).splice(details.index ?? parent.children.length, 0, node);
    const observed = this.copy(node.id);
    await this.emit({ type: 'created', node: observed });
    return observed;
  }
  async update(id: string, changes: { title?: string; url?: string }) {
    this.calls.push('update');
    await this.beforeUpdate?.();
    const node = this.actual(id);
    if (changes.title !== undefined) node.title = changes.title;
    if (changes.url !== undefined) node.url = changes.url;
    const observed = this.copy(id);
    await this.emit({
      type: 'changed',
      id,
      title: node.title,
      ...(changes.url === undefined ? {} : { url: node.url }),
    });
    return observed;
  }
  async move(id: string, destination: { parentId: string; index: number }) {
    this.calls.push('move');
    const old = this.copy(id),
      node = this.actual(id),
      parent = this.actual(old.parentId!);
    parent.children = parent.children!.filter((c) => c.id !== id);
    const target = this.actual(destination.parentId);
    (target.children ??= []).splice(Math.min(destination.index, target.children.length), 0, node);
    const observed = this.copy(id);
    await this.emit({ type: 'moved', id, parentId: observed.parentId!, index: observed.index! });
    return observed;
  }
  async remove(id: string) {
    this.calls.push('remove');
    const node = this.copy(id);
    if (node.children?.length) throw new Error('Folder is not empty');
    const parent = this.actual(node.parentId!);
    parent.children = parent.children!.filter((c) => c.id !== id);
    await this.emit({ type: 'removed', id, node });
  }
  async add(title: string, url?: string, parentId = 'bar-native') {
    return this.create({ title, url, parentId });
  }
  async removeTree(id: string) {
    const node = this.copy(id),
      parent = this.actual(node.parentId!);
    parent.children = parent.children!.filter((c) => c.id !== id);
    await this.emit({ type: 'removed', id, node });
  }
  async reorder(parentId: string, ids: string[]) {
    const p = this.actual(parentId);
    p.children = ids.map((id) => this.actual(id));
    await this.emit({ type: 'reordered', id: parentId, childIds: ids });
  }
  async nativeNode(id: string) {
    return this.copy(id);
  }
}
async function local(browser = new FakeBrowser()) {
  const db = new SynkDatabase(`native-${crypto.randomUUID()}`);
  databases.push(db);
  await db.enroll(
    {
      account_id: crypto.randomUUID(),
      device_id: crypto.randomUUID(),
      token: 'f'.repeat(64),
      server_url: 'http://127.0.0.1:4318',
      name: 'Native adapter test',
    },
    generateRecoveryKey(),
  );
  const adapter = new BookmarkAdapter(db, browser);
  browser.events = (event) => adapter.capture(event);
  return { db, browser, adapter };
}
async function enabled(browser = new FakeBrowser()) {
  const state = await local(browser);
  const p = await state.adapter.preview();
  await state.adapter.confirm(p.id);
  return state;
}
const remoteCreate = (id: string, title: string, parent = BOOKMARK_ROOTS.bar) => ({
  type: 'create' as const,
  node_id: id,
  node_type: 'bookmark' as const,
  title,
  url: 'https://remote.example',
  placement: { parent, position: '1/1' },
});

describe('native bookmark integration', () => {
  it('discovers roles independent of root IDs/names and refuses ambiguous or managed roots', () => {
    const b = new FakeBrowser();
    expect(selectBookmarkRoots(b.tree)).toEqual({ bar: 'bar-native', other: 'other-native' });
    b.tree[0]!.children!.push({
      id: 'account',
      title: 'Account',
      folderType: 'bookmarks-bar',
      syncing: true,
    });
    expect(selectBookmarkRoots(b.tree).bar).toBe('bar-native');
    b.tree[0]!.children!.push({
      id: 'second-local',
      title: 'Bar 2',
      folderType: 'bookmarks-bar',
      syncing: false,
    });
    expect(() => selectBookmarkRoots(b.tree)).toThrow('Multiple');
    expect(selectBookmarkRoots(b.tree, { bar: 'second-local' }).bar).toBe('second-local');
    expect(() => selectBookmarkRoots(b.tree, { bar: 'root' })).toThrow('unavailable');
    b.tree[0]!.children![1]!.unmodifiable = 'managed';
    expect(() => selectBookmarkRoots(b.tree, { bar: 'bar-native' })).toThrow('No writable');
  });
  it('bootstraps a nested native tree with a durable recovery copy and no redundant browser writes', async () => {
    const browser = new FakeBrowser(),
      folder = await browser.add('Folder');
    await browser.add('A', 'https://a.example', folder.id);
    await browser.add('A', 'https://a.example', folder.id);
    const { db, adapter } = await local(browser),
      preview = await adapter.preview();
    expect(preview.imports).toBe(3);
    expect(preview.matches).toBe(0);
    browser.calls = [];
    await adapter.confirm(preview.id);
    expect(browser.calls).toEqual([]);
    expect(
      Object.values((await db.bookmarkProjection()).nodes).filter((n) => !n.system),
    ).toHaveLength(3);
    expect((await db.bookmarkSetup.get('bookmark'))?.backup?.tree).toEqual(preview.backup.tree);
    expect(await db.bookmarkBindings.count()).toBe(5);
    expect(await db.drafts.count()).toBe(3);
  });
  it('matches unique exact entries in the same folder but preserves every ambiguous duplicate', async () => {
    const { db } = await local(),
      id = crypto.randomUUID();
    await db.stageBookmark(remoteCreate(id, 'A'));
    const browser = new FakeBrowser();
    await browser.add('A', 'https://remote.example');
    const first = previewBookmarkImport(browser.tree, await db.bookmarkProjection());
    expect(first.matches).toBe(1);
    expect(first.imports).toBe(0);
    await browser.add('A', 'https://remote.example');
    const ambiguous = previewBookmarkImport(browser.tree, await db.bookmarkProjection());
    expect(ambiguous.matches).toBe(0);
    expect(ambiguous.imports).toBe(2);
    const other = new FakeBrowser();
    await other.add('A', 'https://remote.example', 'other-native');
    expect(previewBookmarkImport(other.tree, await db.bookmarkProjection()).matches).toBe(0);
  });
  it('rejects stale native or remote previews without partially committing import', async () => {
    const { db, browser, adapter } = await local();
    await browser.add('Local', 'https://local.example');
    const p = await adapter.preview();
    await browser.add('Later', 'https://later.example');
    await expect(adapter.confirm(p.id)).rejects.toThrow('changed after');
    expect(await db.drafts.count()).toBe(0);
    expect(await db.bookmarkBindings.count()).toBe(0);
    const p2 = await adapter.preview();
    await db.stageBookmark(remoteCreate(crypto.randomUUID(), 'Remote'));
    await expect(adapter.confirm(p2.id)).rejects.toThrow('changed after');
    expect(await db.bookmarkBindings.count()).toBe(0);
  });
  it('captures native edits, moves, ordering and recursive removal while retaining intentional duplicates', async () => {
    const browser = new FakeBrowser(),
      a = await browser.add('A', 'https://a.example'),
      b = await browser.add('B', 'https://b.example');
    const { db, adapter } = await enabled(browser);
    const binding = await db.bookmarkBindings.where('native_id').equals(a.id).first();
    await browser.update(a.id, { title: 'Renamed', url: 'https://edited.example' });
    await browser.move(a.id, { parentId: 'other-native', index: 0 });
    await adapter.reconcile();
    expect((await db.bookmarkProjection()).nodes[binding!.logical_id]).toMatchObject({
      title: 'Renamed',
      url: 'https://edited.example',
      parent: BOOKMARK_ROOTS.other,
    });
    await browser.move(a.id, { parentId: 'bar-native', index: 0 });
    await browser.reorder('bar-native', [b.id, a.id]);
    await adapter.reconcile();
    const proj = await db.bookmarkProjection();
    expect(proj.nodes[BOOKMARK_ROOTS.bar].children.map((id) => proj.nodes[id]!.title)).toEqual([
      'B',
      'Renamed',
    ]);
    const folder = await browser.add('Delete folder');
    const child = await browser.add('Child', 'https://child.example', folder.id);
    await adapter.reconcile();
    const ids = (await db.bookmarkBindings.toArray())
      .filter((v) => [folder.id, child.id].includes(v.native_id))
      .map((v) => v.logical_id);
    await browser.removeTree(folder.id);
    await adapter.reconcile();
    const deleted = (await db.bookmarkProjection()).deleted;
    expect(ids.every((id) => !!deleted[id])).toBe(true);
  });
  it('applies remote creation/title/URL/move/delete once without echo operations', async () => {
    const { db, browser, adapter } = await enabled(),
      id = crypto.randomUUID();
    await db.stageBookmark(remoteCreate(id, 'Remote'));
    await adapter.reconcile();
    const binding = await db.bookmarkBindings.get(id);
    expect(binding).toBeDefined();
    expect(await db.drafts.count()).toBe(1);
    await db.stageBookmark({ type: 'edit', node_id: id, title: 'Updated' });
    await adapter.reconcile();
    expect(await db.drafts.count()).toBe(2);
    await db.stageBookmark({ type: 'edit', node_id: id, url: 'https://changed.example' });
    await adapter.reconcile();
    expect(await db.drafts.count()).toBe(3);
    await db.stageBookmark({
      type: 'move',
      node_id: id,
      placement: { parent: BOOKMARK_ROOTS.other, position: '1/1' },
    });
    await adapter.reconcile();
    expect((await browser.nativeNode(binding!.native_id)).parentId).toBe('other-native');
    expect(await db.drafts.count()).toBe(4);
    await db.stageBookmark({ type: 'remove', node_id: id, observed_descendants: [] });
    await adapter.reconcile();
    await adapter.reconcile();
    expect(await db.drafts.count()).toBe(5);
    expect(await db.bookmarkBindings.get(id)).toBeUndefined();
    expect(await db.bookmarkInbox.count()).toBe(0);
  });
  it('captures a genuine URL edit during remote title application without reverting the remote title', async () => {
    const { db, browser, adapter } = await enabled(),
      id = crypto.randomUUID();
    await db.stageBookmark(remoteCreate(id, 'Original'));
    await adapter.reconcile();
    const binding = (await db.bookmarkBindings.get(id))!;
    await db.stageBookmark({ type: 'edit', node_id: id, title: 'Remote title' });
    browser.afterMutation = async (event) => {
      if (event.type === 'changed') {
        browser.afterMutation = undefined;
        await browser.update(binding.native_id, { url: 'https://user-edit.example' });
      }
    };
    await adapter.reconcile();
    const node = (await db.bookmarkProjection()).nodes[id];
    expect(node).toMatchObject({ title: 'Remote title', url: 'https://user-edit.example' });
    expect((await browser.nativeNode(binding.native_id)).url).toBe('https://user-edit.example');
    expect(await db.drafts.count()).toBe(3);
  });
  it('preserves a genuine rename made just before the remote API update completes', async () => {
    const { db, browser, adapter } = await enabled(),
      id = crypto.randomUUID();
    await db.stageBookmark(remoteCreate(id, 'Original'));
    await adapter.reconcile();
    const binding = (await db.bookmarkBindings.get(id))!;
    await db.stageBookmark({ type: 'edit', node_id: id, title: 'Remote title' });
    browser.beforeUpdate = async () => {
      browser.beforeUpdate = undefined;
      await browser.update(binding.native_id, { title: 'User title' });
    };
    await adapter.reconcile();
    expect((await db.bookmarkProjection()).nodes[id]!.title).toBe('User title');
    expect((await browser.nativeNode(binding.native_id)).title).toBe('User title');
    expect(await db.drafts.count()).toBe(3);
  });
  it('captures only the changed URL when an event also repeats the old unchanged title', async () => {
    const { db, browser, adapter } = await enabled(),
      id = crypto.randomUUID();
    await db.stageBookmark(remoteCreate(id, 'Original'));
    await adapter.reconcile();
    const binding = (await db.bookmarkBindings.get(id))!;
    await db.stageBookmark({ type: 'edit', node_id: id, title: 'Remote title' });
    browser.beforeUpdate = async () => {
      browser.beforeUpdate = undefined;
      await browser.update(binding.native_id, { url: 'https://before-completion.example' });
    };
    await adapter.reconcile();
    expect((await db.bookmarkProjection()).nodes[id]).toMatchObject({
      title: 'Remote title',
      url: 'https://before-completion.example',
    });
    expect(await db.drafts.count()).toBe(3);
  });
  it('records a quick rename and revert before either event is processed', async () => {
    const browser = new FakeBrowser(),
      node = await browser.add('Original', 'https://original.example');
    const { db, adapter } = await enabled(browser);
    await browser.update(node.id, { title: 'Temporary' });
    await browser.update(node.id, { title: 'Original' });
    await adapter.reconcile();
    expect(await db.drafts.count()).toBe(3);
    expect(Object.values((await db.bookmarkProjection()).nodes).find((n) => !n.system)?.title).toBe(
      'Original',
    );
  });
  it('reconciles missed native changes after worker/database reopen', async () => {
    const browser = new FakeBrowser(),
      original = await browser.add('Before', 'https://before.example');
    const { db, adapter } = await enabled(browser);
    const name = db.name;
    browser.events = undefined;
    await browser.update(original.id, { title: 'While worker stopped' });
    await browser.add('Missed new', 'https://new.example');
    db.close();
    const reopened = new SynkDatabase(name);
    databases.push(reopened);
    const revived = new BookmarkAdapter(reopened, browser);
    browser.events = (e) => revived.capture(e);
    await revived.reconcile();
    const values = Object.values((await reopened.bookmarkProjection()).nodes).filter(
      (n) => !n.system,
    );
    expect(values.map((n) => n.title).sort()).toEqual(['Missed new', 'While worker stopped']);
  });
  it('recovers an interrupted update from actual state and does not repeat its effect', async () => {
    const { db, browser, adapter } = await enabled(),
      id = crypto.randomUUID();
    await db.stageBookmark(remoteCreate(id, 'Before'));
    await adapter.reconcile();
    await db.stageBookmark({ type: 'edit', node_id: id, title: 'After' });
    browser.afterMutation = async (e) => {
      if (e.type === 'changed') {
        browser.afterMutation = undefined;
        throw new Error('Worker terminated after update');
      }
    };
    await expect(adapter.reconcile()).rejects.toThrow('Worker terminated');
    const count = browser.calls.filter((c) => c === 'update').length;
    await new BookmarkAdapter(db, browser).reconcile();
    expect(browser.calls.filter((c) => c === 'update')).toHaveLength(count);
    expect(await db.drafts.count()).toBe(2);
  });
  it('blocks an interrupted unbound create, then explicitly preserves its candidate and creates a distinct copy', async () => {
    const { db, browser, adapter } = await enabled(),
      id = crypto.randomUUID();
    await db.stageBookmark(remoteCreate(id, 'Ambiguous'));
    browser.afterMutation = async (e) => {
      if (e.type === 'created') {
        browser.afterMutation = undefined;
        throw new Error('Worker terminated after create');
      }
    };
    await expect(adapter.reconcile()).rejects.toThrow('Worker terminated');
    await expect(adapter.reconcile()).rejects.toThrow('needs review');
    expect(browser.calls.filter((c) => c === 'create')).toHaveLength(1);
    const pending = (await db.bookmarkEffects.where('status').equals('blocked').toArray())[0]!;
    await adapter.resolveCreate(pending.id);
    const tree = flattenBookmarks(await browser.getTree());
    expect([...tree.values()].filter((n) => n.title === 'Ambiguous')).toHaveLength(2);
    expect(
      Object.values((await db.bookmarkProjection()).nodes).filter((n) => n.title === 'Ambiguous'),
    ).toHaveLength(2);
  });
  it('can associate a reviewed interrupted create without creating a duplicate', async () => {
    const { db, browser, adapter } = await enabled(),
      id = crypto.randomUUID();
    await db.stageBookmark(remoteCreate(id, 'Candidate'));
    browser.afterMutation = async (e) => {
      if (e.type === 'created') {
        browser.afterMutation = undefined;
        throw new Error('Interrupted');
      }
    };
    await expect(adapter.reconcile()).rejects.toThrow();
    await expect(adapter.reconcile()).rejects.toThrow();
    const pending = (await db.bookmarkEffects.where('status').equals('blocked').toArray())[0]!,
      candidate = [...flattenBookmarks(await browser.getTree()).values()].find(
        (n) => n.title === 'Candidate',
      )!;
    await adapter.resolveCreate(pending.id, candidate.id);
    expect((await db.bookmarkBindings.get(id))?.native_id).toBe(candidate.id);
    expect(browser.calls.filter((c) => c === 'create')).toHaveLength(1);
  });
  it('moves an unseen surviving child into recovery before deleting its observed parent', async () => {
    const browser = new FakeBrowser(),
      folder = await browser.add('Folder');
    const { db, adapter } = await enabled(browser);
    const parent = (await db.bookmarkBindings.where('native_id').equals(folder.id).first())!;
    await db.stageBookmark({
      type: 'remove',
      node_id: parent.logical_id,
      observed_descendants: [],
    });
    await browser.add('Unseen child', 'https://survives.example', folder.id);
    await adapter.reconcile();
    const replica = await db.bookmarkProjection(),
      child = Object.values(replica.nodes).find((n) => n.title === 'Unseen child')!;
    expect(child.parent).toBe(BOOKMARK_ROOTS.recovered);
    const recovered = (await db.bookmarkBindings.get(BOOKMARK_ROOTS.recovered))!;
    expect(
      (await browser.nativeNode((await db.bookmarkBindings.get(child.id))!.native_id)).parentId,
    ).toBe(recovered.native_id);
    expect(await db.bookmarkBindings.get(parent.logical_id)).toBeUndefined();
  });
  it('retains the event-time causal context when a peer edit downloads before capture processing', async () => {
    const browser = new FakeBrowser(),
      node = await browser.add('Original', 'https://original.example');
    const { db, adapter } = await enabled(browser),
      binding = (await db.bookmarkBindings.where('native_id').equals(node.id).first())!,
      localState = (await db.state.get('local'))!;
    await browser.update(node.id, { title: 'Local pending edit' });
    const author = crypto.randomUUID(),
      operation_id = crypto.randomUUID(),
      epoch = crypto.randomUUID();
    const envelope = await encryptPayload(
      localState.recovery_key,
      {
        protocol_version: 1,
        operation_id,
        account_id: localState.credentials.account_id,
        device_id: author,
        counter: 1,
        domain: 'bookmark',
        key_epoch: 1,
      },
      {
        kind: 'bookmark',
        schema_version: 1,
        operation_id,
        revision: {
          author,
          counter: 1,
          logical: 2,
          context: { [localState.credentials.device_id]: 1 },
        },
        action: { type: 'edit', node_id: binding.logical_id, title: 'Peer edit' },
      },
    );
    const transport: Transport = {
      acknowledge: async (cursor, epoch) => ({ server_epoch: epoch, processed_cursor: cursor }),
      async pull(cursor) {
        return {
          server_epoch: epoch,
          records: cursor ? [] : [{ sequence: 1, envelope }],
          next_cursor: 1,
          has_more: false,
        };
      },
      async push(envelopes) {
        return {
          server_epoch: epoch,
          acknowledgements: envelopes.map((e, i) => ({
            operation_id: e.operation_id,
            sequence: i + 2,
          })),
        };
      },
    };
    const reserved = (await db.bookmarkInbox.toArray())[0]!.revisions![0]!;
    await new SyncCoordinator(db, () => transport).sync();
    await db.stageBookmark(remoteCreate(crypto.randomUUID(), 'Later local addition'));
    await adapter.reconcile();
    const captured = (await db.bookmarkOperations()).find(
      (op) => op.action.type === 'edit' && op.action.title === 'Local pending edit',
    )!;
    expect(captured.revision).toEqual(reserved);
    const replica = await db.bookmarkProjection();
    expect(['Local pending edit', 'Peer edit']).toContain(replica.nodes[binding.logical_id]!.title);
    expect(
      replica.conflicts.some(
        (c) => c.node_id === binding.logical_id && c.field === 'title' && c.reason === 'concurrent',
      ),
    ).toBe(true);
  });
  it('captures only a missed title edit while retaining an unapplied peer URL change', async () => {
    const browser = new FakeBrowser(),
      node = await browser.add('Original', 'https://original.example');
    const { db, adapter } = await enabled(browser),
      binding = (await db.bookmarkBindings.where('native_id').equals(node.id).first())!,
      localState = (await db.state.get('local'))!;
    browser.events = undefined;
    await browser.update(node.id, { title: 'Missed local rename' });
    browser.events = (e) => adapter.capture(e);
    const author = crypto.randomUUID(),
      operation_id = crypto.randomUUID(),
      epoch = crypto.randomUUID();
    const envelope = await encryptPayload(
      localState.recovery_key,
      {
        protocol_version: 1,
        operation_id,
        account_id: localState.credentials.account_id,
        device_id: author,
        counter: 1,
        domain: 'bookmark',
        key_epoch: 1,
      },
      {
        kind: 'bookmark',
        schema_version: 1,
        operation_id,
        revision: {
          author,
          counter: 1,
          logical: 2,
          context: { [localState.credentials.device_id]: 1 },
        },
        action: { type: 'edit', node_id: binding.logical_id, url: 'https://peer.example' },
      },
    );
    const transport: Transport = {
      acknowledge: async (cursor, epoch) => ({ server_epoch: epoch, processed_cursor: cursor }),
      async pull(cursor) {
        return {
          server_epoch: epoch,
          records: cursor ? [] : [{ sequence: 1, envelope }],
          next_cursor: 1,
          has_more: false,
        };
      },
      async push(envelopes) {
        return {
          server_epoch: epoch,
          acknowledgements: envelopes.map((e, i) => ({
            operation_id: e.operation_id,
            sequence: i + 2,
          })),
        };
      },
    };
    await new SyncCoordinator(db, () => transport).sync();
    await adapter.reconcile();
    expect((await db.bookmarkProjection()).nodes[binding.logical_id]).toMatchObject({
      title: 'Missed local rename',
      url: 'https://peer.example',
    });
    expect(await browser.nativeNode(node.id)).toMatchObject({
      title: 'Missed local rename',
      url: 'https://peer.example',
    });
  });
  it('retains a failed local capture event and its old mapping until storage recovers', async () => {
    const browser = new FakeBrowser(),
      node = await browser.add('Before', 'https://before.example');
    const { db, adapter } = await enabled(browser);
    const binding = (await db.bookmarkBindings.where('native_id').equals(node.id).first())!;
    await browser.update(node.id, { title: 'After' });
    const failure = vi
      .spyOn(db, 'stageBookmarks')
      .mockRejectedValueOnce(new DOMException('Storage exhausted', 'QuotaExceededError'));
    await expect(adapter.reconcile()).rejects.toThrow('Storage exhausted');
    expect(await db.bookmarkInbox.count()).toBe(1);
    expect((await db.bookmarkBindings.get(binding.logical_id))!.baseline.title).toBe('Before');
    expect((await db.bookmarkProjection()).nodes[binding.logical_id]!.title).toBe('Before');
    failure.mockRestore();
    await adapter.reconcile();
    expect(await db.bookmarkInbox.count()).toBe(0);
    expect((await db.bookmarkProjection()).nodes[binding.logical_id]!.title).toBe('After');
  });
  it('pauses for a mapped node moved to an excluded root instead of moving it back', async () => {
    const browser = new FakeBrowser();
    browser.tree[0]!.children!.push({
      id: 'account-root',
      title: 'Account',
      folderType: 'other',
      syncing: true,
      children: [],
    });
    const node = await browser.add('Keep', 'https://keep.example');
    const { adapter } = await enabled(browser);
    await browser.move(node.id, { parentId: 'account-root', index: 0 });
    await expect(adapter.reconcile()).rejects.toThrow('outside the selected roots');
    expect((await browser.nativeNode(node.id)).parentId).toBe('account-root');
  });
  it('breaks native ancestry dependencies in the correct order when applying a valid remote tree', async () => {
    const browser = new FakeBrowser(),
      a = await browser.add('A'),
      b = await browser.add('B', undefined, a.id);
    const { db, adapter } = await enabled(browser),
      bindings = await db.bookmarkBindings.toArray(),
      aId = bindings.find((v) => v.native_id === a.id)!.logical_id,
      bId = bindings.find((v) => v.native_id === b.id)!.logical_id;
    await db.stageBookmarks([
      { type: 'move', node_id: aId, placement: { parent: bId, position: '1/1' } },
      { type: 'move', node_id: bId, placement: { parent: BOOKMARK_ROOTS.bar, position: '1/1' } },
    ]);
    await adapter.reconcile();
    expect((await browser.nativeNode(b.id)).parentId).toBe('bar-native');
    expect((await browser.nativeNode(a.id)).parentId).toBe(b.id);
  });
  it('converges two independent native trees after offline rename/move and client database reopen', async () => {
    const aBrowser = new FakeBrowser(),
      aNative = await aBrowser.add('Shared', 'https://remote.example'),
      a = await enabled(aBrowser),
      bBrowser = new FakeBrowser();
    bBrowser.next = 100;
    const bNative = await bBrowser.add('Shared', 'https://remote.example'),
      b = await local(bBrowser);
    const aState = (await a.db.state.get('local'))!,
      bState = (await b.db.state.get('local'))!;
    await b.db.state.update('local', {
      credentials: { ...bState.credentials, account_id: aState.credentials.account_id },
      recovery_key: aState.recovery_key,
    });
    const epoch = crypto.randomUUID(),
      rows: Envelope[] = [];
    const transport: Transport = {
      acknowledge: async (cursor, epoch) => ({ server_epoch: epoch, processed_cursor: cursor }),
      async pull(cursor) {
        return {
          server_epoch: epoch,
          records: rows
            .slice(cursor, cursor + 100)
            .map((envelope, i) => ({ sequence: cursor + i + 1, envelope })),
          next_cursor: Math.min(cursor + 100, rows.length),
          has_more: rows.length > cursor + 100,
        };
      },
      async push(envelopes) {
        const acknowledgements = envelopes.map((e) => {
          let index = rows.findIndex((old) => old.operation_id === e.operation_id);
          if (index < 0) {
            index = rows.length;
            rows.push(e);
          }
          return { operation_id: e.operation_id, sequence: index + 1 };
        });
        return { server_epoch: epoch, acknowledgements };
      },
    };
    await new SyncCoordinator(a.db, () => transport).sync();
    await new SyncCoordinator(b.db, () => transport).sync();
    const preview = await b.adapter.preview();
    expect(preview.matches).toBe(1);
    expect(preview.imports).toBe(0);
    await b.adapter.confirm(preview.id);
    await aBrowser.update(aNative.id, { title: 'Offline rename' });
    await bBrowser.move(bNative.id, { parentId: 'other-native', index: 0 });
    await a.adapter.reconcile();
    await b.adapter.reconcile();
    a.db.close();
    const revivedDb = new SynkDatabase(a.db.name);
    databases.push(revivedDb);
    const revived = new BookmarkAdapter(revivedDb, aBrowser);
    aBrowser.events = (e) => revived.capture(e);
    await new SyncCoordinator(b.db, () => transport).sync();
    await new SyncCoordinator(revivedDb, () => transport).sync();
    await revived.reconcile();
    await new SyncCoordinator(b.db, () => transport).sync();
    await b.adapter.reconcile();
    expect(await revivedDb.bookmarkProjection()).toEqual(await b.db.bookmarkProjection());
    expect(await aBrowser.nativeNode(aNative.id)).toMatchObject({
      title: 'Offline rename',
      parentId: 'other-native',
    });
    expect(await bBrowser.nativeNode(bNative.id)).toMatchObject({
      title: 'Offline rename',
      parentId: 'other-native',
    });
    expect(await revivedDb.pendingCount()).toBe(0);
    expect(await b.db.pendingCount()).toBe(0);
    expect(rows).toHaveLength(3);
  });
  it('refuses lost mappings or changed profile/root identity before inferring deletion', async () => {
    const browser = new FakeBrowser();
    await browser.add('Keep', 'https://keep.example');
    const { db, adapter } = await enabled(browser);
    const before = await db.drafts.count();
    browser.marker = 'different-profile';
    await expect(adapter.reconcile()).rejects.toThrow('identity changed');
    expect(await db.drafts.count()).toBe(before);
    browser.marker = (await db.bookmarkSetup.get('bookmark'))!.incarnation;
    browser.tree[0]!.children = browser.tree[0]!.children!.filter((n) => n.id !== 'bar-native');
    await expect(adapter.reconcile()).rejects.toThrow('root changed');
    expect(await db.drafts.count()).toBe(before);
    await db.bookmarkSetup.delete('bookmark');
    await expect(adapter.preview()).rejects.toThrow('metadata was lost');
  });
});
