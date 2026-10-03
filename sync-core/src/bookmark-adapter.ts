import { SynkDatabase } from './database';
import { BOOKMARK_ROOTS, type BookmarkAction, type BookmarkProjection } from './bookmarks';
import { balancedPositions, comparePositions, positionBetween } from './position';
import {
  baseline,
  flattenBookmarks,
  nativeFingerprint,
  previewBookmarkImport,
  replicaFingerprint,
  type BookmarkBinding,
  type BookmarkBrowser,
  type BookmarkEffect,
  type BookmarkEvent,
  type BookmarkImport,
  type NativeBookmark,
  type RootSelection,
} from './bookmark-native';

const ROOT_IDS = new Set<string>(Object.values(BOOKMARK_ROOTS));
function deletionActions(ids: string[]): BookmarkAction[] {
  const result: BookmarkAction[] = [];
  for (let i = 0; i < ids.length; i += 1001)
    result.push({
      type: 'remove',
      node_id: ids[i]!,
      observed_descendants: ids.slice(i + 1, i + 1001),
    });
  return result;
}
function writable(node: NativeBookmark): boolean {
  return !node.unmodifiable && !node.folderType;
}
/** All browser effects are serialized; event capture itself persists independently in an inbox. */
export class BookmarkAdapter {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private db: SynkDatabase,
    private native: BookmarkBrowser,
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  private tables() {
    return [
      ...this.db.captureBudgetTables(),
      this.db.state,
      this.db.operations,
      this.db.drafts,
      this.db.replicas,
      this.db.bookmarkSetup,
      this.db.bookmarkBindings,
      this.db.bookmarkInbox,
      this.db.bookmarkEffects,
    ];
  }
  async capture(event: BookmarkEvent): Promise<boolean> {
    return this.db.transaction(
      'rw',
      [...this.db.captureBudgetTables(), this.db.bookmarkSetup, this.db.bookmarkBindings],
      async () => {
        if ((await this.db.bookmarkSetup.get('bookmark'))?.phase !== 'active') return false;
        if (event.type !== 'removed')
          await this.db.assertCaptureCapacity(1, JSON.stringify(event).length * 4);
        const native_id = event.type === 'created' ? event.node.id : event.id;
        const binding = await this.db.bookmarkBindings.where('native_id').equals(native_id).first();
        const previous = await this.db.bookmarkInbox.where('native_id').equals(native_id).last();
        let before = binding?.baseline;
        if (previous?.event.type === 'changed' && before)
          before = {
            ...before,
            title: previous.event.title,
            url: previous.event.url ?? before.url,
          };
        const context = (await this.db.state.get('local'))?.context;
        const count =
          event.type === 'removed'
            ? Math.max(1, Math.ceil(flattenBookmarks([event.node]).size / 1001))
            : event.type === 'reordered'
              ? Math.max(1, Math.ceil(event.childIds.length / 1000))
              : 1;
        const revisions = await this.db.reserveBookmarkClocks(count);
        await this.db.bookmarkInbox.add({
          event: structuredClone(event),
          native_id,
          before,
          context: structuredClone(context ?? {}),
          revisions,
        });
        return true;
      },
    );
  }
  preview(roots: RootSelection = {}): Promise<BookmarkImport> {
    return this.serial(async () => {
      if (!(await this.db.state.get('local'))) throw new Error('Connect this device first.');
      const old = await this.db.bookmarkSetup.get('bookmark'),
        marker = await this.native.getMarker();
      if (marker && marker !== old?.incarnation)
        throw new Error(
          'Bookmark mapping metadata was lost. Export local data and re-enroll; no deletions were inferred.',
        );
      if (old?.phase === 'active') throw new Error('Bookmark synchronization is already enabled.');
      const preview = previewBookmarkImport(
        await this.native.getTree(),
        await this.db.bookmarkProjection(),
        roots,
      );
      const incarnation = old?.incarnation ?? crypto.randomUUID();
      await this.db.bookmarkSetup.put({
        id: 'bookmark',
        incarnation,
        phase: 'preview',
        roots: preview.roots,
        preview,
      });
      await this.native.setMarker(incarnation);
      return preview;
    });
  }
  confirm(id: string): Promise<void> {
    return this.serial(async () => {
      const setup = await this.db.bookmarkSetup.get('bookmark'),
        preview = setup?.preview;
      if (!setup || !preview || preview.id !== id || setup.phase !== 'preview')
        throw new Error('Import preview expired. Review a fresh preview.');
      if ((await this.native.getMarker()) !== setup.incarnation)
        throw new Error('Bookmark profile identity changed. Import was not applied.');
      const tree = await this.native.getTree();
      await this.db.transaction('rw', this.tables(), async () => {
        if (
          nativeFingerprint(tree) !== preview.native_fingerprint ||
          replicaFingerprint(await this.db.bookmarkProjection()) !== preview.replica_fingerprint
        )
          throw new Error(
            'Bookmarks changed after the preview. Review a fresh preview before merging.',
          );
        await this.db.stageBookmarks(preview.actions);
        await this.db.bookmarkBindings.bulkAdd(preview.bindings);
        await this.db.bookmarkSetup.put({
          id: 'bookmark',
          incarnation: setup.incarnation,
          phase: 'active',
          roots: preview.roots,
          backup: preview.backup,
          applied_context: preview.backup.replica.frontier,
        });
      });
      await this.run();
    });
  }
  reconcile(): Promise<void> {
    return this.serial(() => this.run());
  }
  private async identity(): Promise<boolean> {
    const setup = await this.db.bookmarkSetup.get('bookmark');
    if (!setup || setup.phase !== 'active') return false;
    if ((await this.native.getMarker()) !== setup.incarnation)
      throw new Error(
        'Bookmark profile identity changed. Application is paused; export local data before recovery.',
      );
    const nodes = flattenBookmarks(await this.native.getTree());
    for (const [role, id] of Object.entries(setup.roots)) {
      const node = nodes.get(id),
        expected = role === 'bar' ? 'bookmarks-bar' : role;
      if (!node || node.folderType !== expected || node.unmodifiable)
        throw new Error(
          'A selected bookmark root changed or became unavailable. Application is paused; no mass deletion was inferred.',
        );
    }
    return true;
  }
  private async run(): Promise<void> {
    if (!(await this.identity())) return;
    await this.recover();
    await this.drain();
    await this.captureTree(await this.native.getTree());
    for (let i = 0; i < 100; i++) {
      await this.drain();
      const tree = await this.native.getTree();
      // Reconcile missed edits before issuing the next effect, including edits during remote application.
      await this.captureTree(tree);
      const projection = await this.db.bookmarkProjection();
      const next = await this.plan(tree, projection);
      if (!next) {
        await this.db.transaction('rw', this.db.bookmarkSetup, async () => {
          const setup = (await this.db.bookmarkSetup.get('bookmark'))!;
          await this.db.bookmarkSetup.put({ ...setup, applied_context: projection.frontier });
        });
        return;
      }
      await this.db.bookmarkEffects.add(next);
      await this.issue(next);
    }
    throw new Error('More bookmark application work remains. Reconcile again to continue.');
  }
  private async recover(): Promise<void> {
    const nodes = flattenBookmarks(await this.native.getTree());
    for (const effect of await this.db.bookmarkEffects
      .where('status')
      .anyOf('prepared', 'issued', 'blocked')
      .toArray()) {
      if (effect.status === 'blocked')
        throw new Error(effect.error ?? 'An interrupted bookmark effect needs review.');
      if (effect.status === 'prepared') {
        await this.db.bookmarkEffects.update(effect.id, { status: 'done', echo_consumed: true });
        continue;
      }
      if (effect.type === 'create' && !effect.native_id) {
        const candidates = [...nodes.values()].filter(
          (n) =>
            n.parentId === effect.desired.parentId &&
            n.title === effect.desired.title &&
            n.url === effect.desired.url &&
            !effect.before_children?.includes(n.id),
        );
        if (candidates.length) {
          await this.db.bookmarkEffects.update(effect.id, {
            status: 'blocked',
            error:
              'An interrupted create has possible matching bookmarks. Review it before retrying to preserve intentional duplicates.',
          });
          throw new Error('An interrupted bookmark create needs review.');
        }
        await this.db.bookmarkEffects.update(effect.id, { status: 'done', echo_consumed: true });
        continue;
      }
      const actual = effect.native_id ? nodes.get(effect.native_id) : undefined;
      if (effect.type === 'remove' && !actual) await this.finish(effect);
      else if (
        actual &&
        ((effect.type === 'update' &&
          (effect.desired.title === undefined || actual.title === effect.desired.title) &&
          (effect.desired.url === undefined || actual.url === effect.desired.url)) ||
          (effect.type === 'move' && actual.parentId === effect.desired.parentId))
      )
        await this.finish(effect, actual);
      else await this.db.bookmarkEffects.update(effect.id, { status: 'done', echo_consumed: true }); // Capture a genuine later edit, then replan from current logical state.
    }
  }
  /** Explicit review can associate an existing candidate, or preserve it and create a separate copy. */
  resolveCreate(effectId: string, nativeId?: string): Promise<void> {
    return this.serial(async () => {
      if (!(await this.identity())) throw new Error('Bookmark synchronization is not enabled.');
      const effect = await this.db.bookmarkEffects.get(effectId);
      if (!effect || effect.status !== 'blocked' || effect.type !== 'create' || effect.native_id)
        throw new Error('No interrupted create to review.');
      if (nativeId) {
        const n = flattenBookmarks(await this.native.getTree()).get(nativeId);
        if (
          !n ||
          n.parentId !== effect.desired.parentId ||
          n.title !== effect.desired.title ||
          n.url !== effect.desired.url ||
          effect.before_children?.includes(n.id) ||
          (await this.db.bookmarkBindings.where('native_id').equals(nativeId).count())
        )
          throw new Error('The selected candidate no longer matches.');
        await this.finish(effect, n);
      } else
        await this.db.bookmarkEffects.update(effect.id, { status: 'done', echo_consumed: true });
      await this.run();
    });
  }
  private echo(effect: BookmarkEffect, event: BookmarkEvent): boolean {
    if (
      effect.status !== 'done' ||
      effect.echo_consumed ||
      effect.native_id !== (event.type === 'created' ? event.node.id : event.id)
    )
      return false;
    if (effect.type === 'create' && event.type === 'created')
      return (
        event.node.title === effect.observed?.title &&
        event.node.url === effect.observed?.url &&
        event.node.parentId === effect.observed?.parentId
      );
    if (effect.type === 'update' && event.type === 'changed')
      return (
        event.title === effect.observed?.title &&
        (event.url === undefined
          ? effect.desired.url === undefined
          : event.url === effect.observed?.url)
      );
    if (effect.type === 'move' && event.type === 'moved')
      return event.parentId === effect.observed?.parentId && event.index === effect.observed?.index;
    return effect.type === 'remove' && event.type === 'removed';
  }
  private async drain(): Promise<void> {
    for (const item of await this.db.bookmarkInbox.orderBy('id').limit(200).toArray()) {
      const event = item.event;
      await this.db.transaction('rw', this.tables(), async () => {
        const effects = await this.db.bookmarkEffects
          .where('native_id')
          .equals(item.native_id)
          .toArray();
        const expected = effects.find((effect) => this.echo(effect, event));
        if (expected) {
          await this.finish(expected, expected.observed);
          await this.db.bookmarkEffects.update(expected.id, { echo_consumed: true });
        } else {
          const id = event.type === 'created' ? event.node.id : event.id;
          const binding = await this.db.bookmarkBindings.where('native_id').equals(id).first();
          if (binding && !binding.system && event.type === 'changed') {
            const action: Extract<BookmarkAction, { type: 'edit' }> = {
              type: 'edit',
              node_id: binding.logical_id,
            };
            if (!item.before || item.before.title !== event.title) action.title = event.title;
            if (event.url !== undefined && (!item.before || item.before.url !== event.url))
              action.url = event.url;
            if (action.title !== undefined || action.url !== undefined)
              await this.db.stageBookmark(action, item.context, item.revisions);
            await this.db.bookmarkBindings.update(binding.logical_id, {
              baseline: {
                ...binding.baseline,
                ...(action.title === undefined ? {} : { title: action.title }),
                ...(action.url === undefined ? {} : { url: action.url }),
              },
            });
          } else if (binding && event.type === 'removed') {
            const removed = flattenBookmarks([event.node]),
              bindings = await this.db.bookmarkBindings.toArray();
            const deleted = bindings
              .filter((b) => removed.has(b.native_id) && !b.system)
              .map((b) => b.logical_id);
            await this.db.stageBookmarks(deletionActions(deleted), item.context, item.revisions);
            await this.db.bookmarkBindings.bulkDelete(
              bindings.filter((b) => removed.has(b.native_id)).map((b) => b.logical_id),
            );
            for (const b of bindings)
              if (b.baseline.children.includes(id))
                await this.db.bookmarkBindings.update(b.logical_id, {
                  baseline: {
                    ...b.baseline,
                    children: b.baseline.children.filter((child) => child !== id),
                  },
                });
          } else if (binding && !binding.system && event.type === 'moved') {
            const parent = await this.db.bookmarkBindings
              .where('native_id')
              .equals(event.parentId)
              .first();
            if (!parent)
              throw new Error(
                'A synchronized bookmark moved outside the selected roots. Application is paused until it returns or the roots are reviewed.',
              );
            if (parent) {
              const replica = await this.db.bookmarkProjection();
              const ids = parent.baseline.children.filter((child) => child !== id),
                bindings = await this.db.bookmarkBindings.toArray();
              const byNative = new Map(bindings.map((b) => [b.native_id, b.logical_id]));
              const neighbors = ids.map((native) => replica.nodes[byNative.get(native) ?? '']);
              const left = neighbors
                  .slice(0, event.index)
                  .reverse()
                  .find((n) => n?.parent === parent.logical_id),
                right = neighbors.slice(event.index).find((n) => n?.parent === parent.logical_id);
              let position;
              try {
                position = positionBetween(left?.position, right?.position);
              } catch {
                position = positionBetween(
                  replica.nodes[parent.logical_id]?.children
                    .map((child) => replica.nodes[child]!.position)
                    .at(-1),
                );
              }
              await this.db.stageBookmark(
                {
                  type: 'move',
                  node_id: binding.logical_id,
                  placement: { parent: parent.logical_id, position },
                },
                item.context,
                item.revisions,
              );
              await this.db.bookmarkBindings.update(binding.logical_id, {
                baseline: { ...binding.baseline, parentId: event.parentId },
              });
              await this.placementBaseline(id, event.parentId, event.index);
            }
          } else if (binding && event.type === 'reordered') {
            const bindings = await this.db.bookmarkBindings.toArray(),
              byNative = new Map(bindings.map((b) => [b.native_id, b]));
            const ids = event.childIds
              .map((native) => byNative.get(native))
              .filter((b): b is BookmarkBinding => !!b && !b.system)
              .map((b) => b.logical_id);
            if (ids.length)
              await this.db.stageBookmarks(
                this.reorders(binding.logical_id, ids),
                item.context,
                item.revisions,
              );
            await this.db.bookmarkBindings.update(binding.logical_id, {
              baseline: { ...binding.baseline, children: event.childIds },
            });
          }
        }
        await this.db.bookmarkInbox.delete(item.id!);
      });
      // Creation and unknown parents are reconciled from the authoritative tree, never guessed from a lost ID.
      if (event.type === 'created' || event.type === 'moved')
        await this.captureTree(await this.native.getTree());
    }
    if (await this.db.bookmarkInbox.count())
      throw new Error('More captured bookmark events remain. Reconcile again to continue.');
  }
  private reorders(parent: string, ids: string[]): BookmarkAction[] {
    const children = balancedPositions(ids),
      result: BookmarkAction[] = [];
    for (let i = 0; i < children.length; i += 1000)
      result.push({ type: 'reorder', parent, children: children.slice(i, i + 1000) });
    return result;
  }
  private async captureTree(tree: NativeBookmark[]): Promise<void> {
    const actual = flattenBookmarks(tree);
    await this.db.transaction('rw', this.tables(), async () => {
      const setup = (await this.db.bookmarkSetup.get('bookmark'))!,
        replica = await this.db.bookmarkProjection();
      const bindings = await this.db.bookmarkBindings.toArray(),
        byNative = new Map(bindings.map((b) => [b.native_id, b]));
      const nativeIds = new Set(bindings.map((b) => b.native_id)),
        visited = new Set<string>();
      const actions: BookmarkAction[] = [],
        changed = new Map<string, BookmarkBinding>();
      const positions = new Map(Object.values(replica.nodes).map((n) => [n.id, n.position]));
      const walk = (node: NativeBookmark, binding: BookmarkBinding) => {
        visited.add(node.id);
        const editable = (node.children ?? [])
          .map((child) => actual.get(child.id)!)
          .filter(writable);
        for (const child of editable)
          if (!byNative.has(child.id)) {
            const b: BookmarkBinding = {
              logical_id: crypto.randomUUID(),
              native_id: child.id,
              baseline: baseline(child),
            };
            byNative.set(child.id, b);
            changed.set(b.logical_id, b);
          }
        const ids = editable.map((c) => byNative.get(c.id)!.logical_id);
        let rebalance = false;
        for (let index = 0; index < editable.length; index++) {
          const child = editable[index]!,
            b = byNative.get(child.id)!;
          visited.add(child.id);
          if (b.system) continue;
          const known = nativeIds.has(child.id);
          if (!known || b.baseline.parentId !== child.parentId) {
            const left = ids
                .slice(0, index)
                .reverse()
                .find((id) => positions.has(id)),
              right = ids.slice(index + 1).find((id) => positions.has(id));
            let position;
            try {
              position = positionBetween(
                left ? positions.get(left) : undefined,
                right ? positions.get(right) : undefined,
              );
            } catch {
              position = positionBetween(
                ids
                  .map((id) => positions.get(id))
                  .filter((p): p is string => !!p)
                  .sort(comparePositions)
                  .at(-1),
              );
              rebalance = true;
            }
            positions.set(b.logical_id, position);
            if (!known)
              actions.push({
                type: 'create',
                node_id: b.logical_id,
                node_type: child.url === undefined ? 'folder' : 'bookmark',
                title: child.title,
                url: child.url,
                placement: { parent: binding.logical_id, position },
              });
            else
              actions.push({
                type: 'move',
                node_id: b.logical_id,
                placement: { parent: binding.logical_id, position },
              });
          }
          if (known && (b.baseline.title !== child.title || b.baseline.url !== child.url)) {
            if ((b.baseline.url === undefined) !== (child.url === undefined))
              throw new Error(
                'Native bookmark identity changed type. Export before re-enrollment.',
              );
            actions.push({
              type: 'edit',
              node_id: b.logical_id,
              ...(b.baseline.title === child.title ? {} : { title: child.title }),
              ...(b.baseline.url === child.url ? {} : { url: child.url }),
            });
          }
          if (child.url === undefined) walk(child, b);
          changed.set(b.logical_id, { ...b, baseline: baseline(child) });
        }
        const oldOrder = binding.baseline.children.filter(
          (id) => byNative.has(id) && !byNative.get(id)!.system,
        );
        const currentOrder = editable
          .filter((c) => nativeIds.has(c.id) && !byNative.get(c.id)!.system)
          .map((c) => c.id);
        const comparable = oldOrder.filter((id) => currentOrder.includes(id));
        if (
          rebalance ||
          JSON.stringify(comparable) !==
            JSON.stringify(currentOrder.filter((id) => oldOrder.includes(id)))
        ) {
          actions.push(
            ...this.reorders(
              binding.logical_id,
              ids.filter((id) => !ROOT_IDS.has(id)),
            ),
          );
        }
        changed.set(binding.logical_id, { ...binding, baseline: baseline(node) });
      };
      for (const native of Object.values(setup.roots)) {
        const b = byNative.get(native);
        if (!b) throw new Error('Bookmark root mapping was lost. Export before recovery.');
        walk(actual.get(native)!, b);
      }
      // Synthetic role folders are also roots for capture, even when moved by the user.
      for (const b of bindings.filter(
        (b) => b.system && !Object.values(setup.roots).includes(b.native_id),
      )) {
        const node = actual.get(b.native_id);
        if (node) walk(node, b);
      }
      if (bindings.some((b) => !b.system && actual.has(b.native_id) && !visited.has(b.native_id)))
        throw new Error(
          'A synchronized bookmark moved outside the selected roots or became managed. Application is paused; existing entries were preserved.',
        );
      const missing = bindings.filter((b) => !actual.has(b.native_id) && !b.system);
      const missingIds = new Set(missing.map((b) => b.native_id));
      for (const b of missing.filter(
        (b) => !b.baseline.parentId || !missingIds.has(b.baseline.parentId),
      )) {
        const descendants: string[] = [],
          visit = (n: BookmarkBinding) => {
            if (!replica.deleted[n.logical_id]) descendants.push(n.logical_id);
            for (const child of n.baseline.children) {
              const c = byNative.get(child);
              if (c && missingIds.has(c.native_id)) visit(c);
            }
          };
        visit(b);
        actions.push(...deletionActions(descendants));
      }
      await this.db.stageBookmarks(actions, setup.applied_context);
      await this.db.bookmarkBindings.bulkPut([...changed.values()]);
      await this.db.bookmarkBindings.bulkDelete(
        bindings.filter((b) => !actual.has(b.native_id)).map((b) => b.logical_id),
      );
    });
  }
  private async plan(
    tree: NativeBookmark[],
    replica: BookmarkProjection,
  ): Promise<BookmarkEffect | undefined> {
    const nodes = flattenBookmarks(tree),
      bindings = await this.db.bookmarkBindings.toArray(),
      byLogical = new Map(bindings.map((b) => [b.logical_id, b]));
    const effect = (
      logical: string,
      type: BookmarkEffect['type'],
      desired: BookmarkEffect['desired'],
      binding?: BookmarkBinding,
    ): BookmarkEffect => ({
      id: crypto.randomUUID(),
      logical_id: logical,
      type,
      status: 'prepared',
      native_id: binding?.native_id,
      before: binding?.baseline,
      desired,
    });
    const other = byLogical.get(BOOKMARK_ROOTS.other)!;
    for (const [id, title] of [
      [BOOKMARK_ROOTS.bar, 'Synk bookmarks bar'],
      [BOOKMARK_ROOTS.mobile, 'Synk mobile bookmarks'],
      [BOOKMARK_ROOTS.recovered, 'Synk recovered bookmarks'],
    ] as const)
      if (!byLogical.has(id) && !!replica.nodes[id]?.children.length) {
        const e = effect(id, 'create', { parentId: other.native_id, title });
        e.before_children = nodes.get(other.native_id)?.children?.map((c) => c.id) ?? [];
        return e;
      }
    const ordinary = Object.values(replica.nodes).filter((n) => !n.system);
    for (const node of ordinary)
      if (!byLogical.has(node.id)) {
        const parent = byLogical.get(node.parent);
        if (!parent) continue;
        const e = effect(node.id, 'create', {
          title: node.title,
          url: node.url,
          parentId: parent.native_id,
        });
        e.before_children = nodes.get(parent.native_id)?.children?.map((c) => c.id) ?? [];
        return e;
      }
    for (const node of ordinary) {
      const b = byLogical.get(node.id),
        n = b ? nodes.get(b.native_id) : undefined;
      if (!b || !n) continue;
      if (!writable(n))
        throw new Error('A synchronized bookmark became managed. Application is paused.');
      if (n.title !== node.title || n.url !== node.url)
        return effect(
          node.id,
          'update',
          {
            ...(n.title !== node.title ? { title: node.title } : {}),
            ...(n.url !== node.url ? { url: node.url } : {}),
          },
          b,
        );
    }
    const isDescendant = (id: string, parent: string): boolean => {
      let n = nodes.get(parent);
      while (n) {
        if (n.id === id) return true;
        n = n.parentId ? nodes.get(n.parentId) : undefined;
      }
      return false;
    };
    for (const node of ordinary) {
      const b = byLogical.get(node.id),
        parent = byLogical.get(node.parent),
        n = b ? nodes.get(b.native_id) : undefined;
      if (!b || !parent || !n || isDescendant(b.native_id, parent.native_id)) continue;
      if (n.parentId !== parent.native_id)
        return effect(
          node.id,
          'move',
          { parentId: parent.native_id, index: nodes.get(parent.native_id)?.children?.length ?? 0 },
          b,
        );
    }
    // Delete only empty folders/leaves. Unseen surviving children move out before their parent is removed.
    for (const b of bindings)
      if (!b.system && replica.deleted[b.logical_id]) {
        const node = nodes.get(b.native_id);
        if (node && !node.children?.length) return effect(b.logical_id, 'remove', {}, b);
      }
    for (const parent of Object.values(replica.nodes).filter((n) => n.type === 'folder')) {
      const b = byLogical.get(parent.id);
      if (!b) continue;
      const children = nodes.get(b.native_id)?.children ?? [],
        desired = parent.children
          .map((id) => byLogical.get(id)?.native_id)
          .filter((id): id is string => !!id);
      const relevant = children.filter((c) => desired.includes(c.id));
      for (let rank = 0; rank < desired.length; rank++)
        if (relevant[rank]?.id !== desired[rank]) {
          const target = bindings.find((b) => b.native_id === desired[rank]);
          if (!target || target.system) continue;
          const index = children.findIndex((c) => c.id === relevant[rank]?.id);
          return effect(
            target.logical_id,
            'move',
            { parentId: b.native_id, index: index < 0 ? children.length : index },
            target,
          );
        }
    }
    return undefined;
  }
  private async placementBaseline(
    nativeId: string,
    parentId?: string,
    index?: number,
  ): Promise<void> {
    for (const b of await this.db.bookmarkBindings.toArray()) {
      const children = b.baseline.children.filter((id) => id !== nativeId);
      if (b.native_id === parentId)
        children.splice(Math.min(index ?? children.length, children.length), 0, nativeId);
      if (JSON.stringify(children) !== JSON.stringify(b.baseline.children))
        await this.db.bookmarkBindings.update(b.logical_id, {
          baseline: { ...b.baseline, children },
        });
    }
  }
  private async finish(effect: BookmarkEffect, observed?: NativeBookmark): Promise<void> {
    await this.db.transaction(
      'rw',
      [this.db.bookmarkBindings, this.db.bookmarkEffects],
      async () => {
        const nativeId = observed?.id ?? effect.native_id;
        if (effect.type === 'remove') {
          await this.db.bookmarkBindings.delete(effect.logical_id);
          await this.placementBaseline(nativeId!);
        } else if (observed) {
          const old = await this.db.bookmarkBindings.get(effect.logical_id);
          const value = old ? { ...old.baseline } : baseline(observed);
          if (effect.type === 'create' || effect.type === 'update') {
            if (effect.desired.title !== undefined) value.title = effect.desired.title;
            if (effect.desired.url !== undefined) value.url = effect.desired.url;
          }
          if (effect.type === 'create' || effect.type === 'move')
            value.parentId = observed.parentId;
          await this.db.bookmarkBindings.put({
            logical_id: effect.logical_id,
            native_id: nativeId!,
            baseline: value,
            system: ROOT_IDS.has(effect.logical_id),
          });
          if (effect.type === 'create' || effect.type === 'move')
            await this.placementBaseline(nativeId!, observed.parentId, observed.index);
        }
        await this.db.bookmarkEffects.put({
          ...effect,
          status: 'done',
          native_id: nativeId,
          observed,
          error: undefined,
        });
      },
    );
  }
  private async issue(effect: BookmarkEffect): Promise<void> {
    await this.db.bookmarkEffects.update(effect.id, { status: 'issued' });
    try {
      const desired = effect.desired;
      if (effect.type === 'remove') {
        await this.native.remove(effect.native_id!);
        await this.finish(effect);
      } else {
        const observed =
          effect.type === 'create'
            ? await this.native.create({
                parentId: desired.parentId!,
                title: desired.title!,
                url: desired.url,
              })
            : effect.type === 'update'
              ? await this.native.update(effect.native_id!, {
                  title: desired.title,
                  url: desired.url,
                })
              : await this.native.move(effect.native_id!, {
                  parentId: desired.parentId!,
                  index: desired.index!,
                });
        await this.finish(effect, observed);
      }
    } catch (cause) {
      // An API error may follow a completed mutation. Leave the issued intent for actual-state recovery.
      await this.db.bookmarkEffects.update(effect.id, {
        error: cause instanceof Error ? cause.message : 'Browser bookmark mutation failed.',
      });
      throw cause;
    }
  }
}
