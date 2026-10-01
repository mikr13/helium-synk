import { SynkDatabase } from './database';
import { canonicalUuid } from './revision';
import {
  restoreUrl,
  validateSessionSnapshot,
  type SessionSnapshot,
  type SessionWindow,
  type SessionTab,
  type SessionGroup,
} from './sessions';
import type { NativeSessionWindow, NativeSessionTab, SessionBrowser } from './session-native';

export interface SessionRestoreBrowser extends SessionBrowser {
  marker(job: string, item: string): string;
  createWindow(marker: string): Promise<NativeSessionWindow>;
  createTab(windowId: number, marker: string): Promise<NativeSessionTab>;
  navigateTab(id: number, url: string, pinned: boolean): Promise<void>;
  moveTab(id: number, index: number): Promise<void>;
  groupTabs(windowId: number, ids: number[]): Promise<number>;
  updateGroup(id: number, group: SessionGroup): Promise<void>;
  activateTab(id: number): Promise<void>;
  focusWindow(id: number): Promise<void>;
  removeMarkerTab(id: number): Promise<void>;
}
export type RestoreSelection =
  | { mode: 'all' }
  | { mode: 'window'; window_id: string }
  | { mode: 'tab'; window_id: string; tab_id: string };
interface RestoreTab {
  source: SessionTab;
  url: string;
  phase: 'pending' | 'creating' | 'created' | 'navigating' | 'loaded';
  native_id?: number;
}
interface RestoreGroup {
  source: SessionGroup;
  phase: 'pending' | 'creating' | 'done';
  native_id?: number;
}
interface RestoreWindow {
  source: SessionWindow;
  tabs: RestoreTab[];
  groups: RestoreGroup[];
  phase: 'pending' | 'creating' | 'tabs' | 'groups' | 'order' | 'activate' | 'cleanup' | 'done';
  owned: boolean;
  native_id?: number;
  sentinel_id?: number;
  order_index: number;
}
export interface SessionRestoreJob {
  id: string;
  snapshot_id: string;
  selection: RestoreSelection;
  incarnation: string;
  created_at: string;
  status: 'running' | 'blocked' | 'complete' | 'cancelled';
  windows: RestoreWindow[];
  skipped: { title: string; reason: string }[];
  error?: string;
}
export interface SessionRestoreSummary {
  id: string;
  snapshot_id: string;
  created_at: string;
  status: SessionRestoreJob['status'];
  opened: number;
  total: number;
  windows_done: number;
  windows_total: number;
  skipped: number;
  error?: string;
}
export function restoreSummary(j: SessionRestoreJob): SessionRestoreSummary {
  return {
    id: j.id,
    snapshot_id: j.snapshot_id,
    created_at: j.created_at,
    status: j.status,
    opened: j.windows.reduce((n, w) => n + w.tabs.filter((t) => t.phase === 'loaded').length, 0),
    total: j.windows.reduce((n, w) => n + w.tabs.length, 0),
    windows_done: j.windows.filter((w) => w.phase === 'done').length,
    windows_total: j.windows.length,
    skipped: j.skipped.length,
    error: j.error,
  };
}
/** Each browser mutation has a durable intent. Marker URLs bridge the non-atomic browser/IndexedDB boundary. */
export class SessionRestorer {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private db: SynkDatabase,
    private native: SessionRestoreBrowser,
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const p = this.tail.then(work);
    this.tail = p.catch(() => {});
    return p;
  }
  private save(job: SessionRestoreJob) {
    return this.db.sessionRestores.put(job);
  }
  begin(
    id: string,
    snapshot: SessionSnapshot,
    selection: RestoreSelection,
  ): Promise<SessionRestoreJob> {
    return this.serial(async () => {
      if (!canonicalUuid(id)) throw new Error('Invalid restoration request identity.');
      validateSessionSnapshot(snapshot);
      if (
        !selection ||
        !['all', 'window', 'tab'].includes(selection.mode) ||
        (selection.mode !== 'all' && !canonicalUuid(selection.window_id)) ||
        (selection.mode === 'tab' && !canonicalUuid(selection.tab_id))
      )
        throw new Error('Invalid restoration selection.');
      const old = await this.db.sessionRestores.get(id);
      if (old) {
        if (
          old.snapshot_id !== snapshot.id ||
          JSON.stringify(old.selection) !== JSON.stringify(selection)
        )
          throw new Error('Restoration identity was reused.');
        return old;
      }
      const sourceWindows =
        selection.mode === 'all'
          ? snapshot.windows
          : snapshot.windows.filter((w) => w.id === selection.window_id);
      if (!sourceWindows.length) throw new Error('No session window selected.');
      const job: SessionRestoreJob = {
        id,
        snapshot_id: snapshot.id,
        selection,
        incarnation: await this.native.getIncarnation(),
        created_at: new Date().toISOString(),
        status: 'running',
        windows: [],
        skipped: [],
      };
      for (const w of sourceWindows) {
        const selected =
          selection.mode === 'tab' ? w.tabs.filter((t) => t.id === selection.tab_id) : w.tabs;
        if (selection.mode === 'tab' && !selected.length)
          throw new Error('No session tab selected.');
        const tabs: RestoreTab[] = [];
        for (const t of selected) {
          const url = restoreUrl(t.url);
          if (url) tabs.push({ source: t, url, phase: 'pending' });
          else
            job.skipped.push({
              title: t.title || t.url,
              reason: 'Only HTTP/HTTPS URLs without embedded credentials can be restored.',
            });
        }
        if (tabs.length)
          job.windows.push({
            source: w,
            tabs,
            groups:
              selection.mode === 'tab'
                ? []
                : w.groups
                    .filter((g) => tabs.some((t) => t.source.group_id === g.id))
                    .map((source) => ({ source, phase: 'pending' })),
            phase: 'pending',
            owned: selection.mode !== 'tab',
            order_index: 0,
          });
      }
      if (!job.windows.length) job.status = 'complete';
      await this.save(job);
      return job;
    });
  }
  cancel(id: string): Promise<void> {
    return this.serial(async () => {
      const j = await this.db.sessionRestores.get(id);
      if (j && j.status !== 'complete')
        await this.save({ ...j, status: 'cancelled', error: undefined });
    });
  }
  resume(id: string): Promise<void> {
    return this.serial(async () => {
      const j = await this.db.sessionRestores.get(id);
      if (!j || j.status !== 'blocked') return;
      if (j.incarnation !== (await this.native.getIncarnation()))
        throw new Error(
          'The browser restarted. Saved runtime IDs cannot be safely reused; cancel this job to keep its opened tabs.',
        );
      await this.save({ ...j, status: 'running', error: undefined });
    });
  }
  run(id: string, limit = 40): Promise<SessionRestoreJob | undefined> {
    return this.serial(async () => {
      const j = await this.db.sessionRestores.get(id);
      if (!j || j.status !== 'running') return j;
      try {
        if (j.incarnation !== (await this.native.getIncarnation()))
          throw new Error(
            'The browser restarted during restoration. Opened tabs were preserved; cancel this job before starting another restore.',
          );
        for (let step = 0; step < Math.min(100, Math.max(1, limit)); step++) {
          const w = j.windows.find((w) => w.phase !== 'done');
          if (!w) {
            // Focus one new destination after restoration, never the source window.
            const target = j.windows.find((w) => w.source.focused) ?? j.windows[0];
            if (target?.native_id !== undefined) await this.native.focusWindow(target.native_id);
            j.status = 'complete';
            await this.save(j);
            break;
          }
          await this.step(j, w);
          await this.save(j);
        }
      } catch (cause) {
        j.status = 'blocked';
        j.error =
          cause instanceof Error
            ? cause.message
            : 'Restoration interrupted. Opened tabs were retained.';
        await this.save(j);
      }
      return j;
    });
  }
  private async live(w: RestoreWindow): Promise<NativeSessionWindow> {
    if (w.native_id === undefined) throw new Error('Restoration destination is missing.');
    const live = await this.native.getWindow(w.native_id);
    if (live.incognito || live.type !== 'normal')
      throw new Error('Restoration destination is no longer a regular window.');
    return live;
  }
  private async knownTab(w: RestoreWindow, t: RestoreTab): Promise<NativeSessionTab> {
    const found = (await this.live(w)).tabs.find((tab) => tab.id === t.native_id);
    if (!found || found.incognito)
      throw new Error(
        'A restored tab was closed or moved. Opened tabs were retained; review before resuming.',
      );
    return found;
  }
  private async step(j: SessionRestoreJob, w: RestoreWindow): Promise<void> {
    if (w.phase === 'pending' || w.phase === 'creating') {
      if (w.phase === 'pending' && !w.owned) {
        const existing = (await this.native.getWindows()).filter(
          (v) => !v.incognito && v.type === 'normal',
        );
        const target = existing.find((v) => v.focused) ?? existing[0];
        if (target) {
          w.native_id = target.id;
          w.phase = 'tabs';
          return;
        }
        w.owned = true;
      }
      const marker = this.native.marker(j.id, `window/${w.source.id}`),
        matches = (await this.native.getWindows()).filter((v) =>
          v.tabs.some((t) => (t.pendingUrl ?? t.url) === marker),
        );
      if (matches.length > 1)
        throw new Error('Multiple restoration window markers found. Review them before resuming.');
      let created = matches[0];
      if (!created) {
        if (w.phase === 'creating')
          throw new Error(
            'An interrupted window creation has no marker. Review opened windows; cancel preserves them.',
          );
        w.phase = 'creating';
        await this.save(j);
        created = await this.native.createWindow(marker);
      }
      if (created.incognito || created.type !== 'normal')
        throw new Error('Restoration requires a regular window.');
      const sentinel = created.tabs.find((t) => (t.pendingUrl ?? t.url) === marker);
      if (!sentinel) throw new Error('The restoration window marker is missing.');
      w.native_id = created.id;
      w.sentinel_id = sentinel.id;
      w.phase = 'tabs';
      return;
    }
    if (w.phase === 'tabs') {
      const t = w.tabs.find((t) => t.phase !== 'loaded');
      if (!t) {
        w.phase = 'groups';
        return;
      }
      if (t.phase === 'pending' || t.phase === 'creating') {
        const marker = this.native.marker(j.id, `tab/${t.source.id}`),
          matches = (await this.native.getWindows())
            .flatMap((v) => v.tabs)
            .filter((v) => (v.pendingUrl ?? v.url) === marker);
        if (matches.length > 1)
          throw new Error('Multiple restoration tab markers found. Review them before resuming.');
        let created = matches[0];
        if (!created) {
          if (t.phase === 'creating')
            throw new Error(
              'An interrupted tab creation has no marker. Review opened tabs; cancel preserves them.',
            );
          await this.live(w);
          t.phase = 'creating';
          await this.save(j);
          created = await this.native.createTab(w.native_id!, marker);
        }
        if (created.windowId !== w.native_id || created.incognito)
          throw new Error('A restoration marker was moved to another window.');
        t.native_id = created.id;
        t.phase = 'created';
        return;
      }
      const tab = await this.knownTab(w, t),
        actual = tab.pendingUrl ?? tab.url,
        marker = this.native.marker(j.id, `tab/${t.source.id}`);
      if (t.phase === 'navigating' && actual === t.url && tab.pinned === t.source.pinned) {
        t.phase = 'loaded';
        return;
      }
      if (actual !== marker)
        throw new Error(
          'A tab navigated while restoration was interrupted. Its page was preserved; review or cancel this job.',
        );
      t.phase = 'navigating';
      await this.save(j);
      await this.native.navigateTab(t.native_id!, t.url, t.source.pinned);
      t.phase = 'loaded';
      return;
    }
    if (w.phase === 'groups') {
      const g = w.groups.find((g) => g.phase !== 'done');
      if (!g) {
        w.phase = 'order';
        return;
      }
      const members = w.tabs.filter((t) => t.source.group_id === g.source.id),
        live = await this.live(w),
        actual = members.map((t) => live.tabs.find((v) => v.id === t.native_id));
      if (actual.some((t) => !t || t.pinned))
        throw new Error('Restored group membership changed. Review opened tabs before resuming.');
      const ids = new Set(actual.map((t) => t!.groupId));
      if (ids.size !== 1)
        throw new Error(
          'Restored tabs were regrouped during restoration. Their groups were preserved.',
        );
      const id = actual[0]!.groupId;
      if (id >= 0) {
        if (
          g.phase === 'pending' ||
          (g.native_id !== undefined && g.native_id !== id) ||
          live.tabs.some((t) => t.groupId === id && !members.some((m) => m.native_id === t.id))
        )
          throw new Error(
            'A restored group was edited during restoration. Its contents were preserved.',
          );
        g.native_id = id;
      } else {
        if (g.native_id !== undefined)
          throw new Error('A restored group was removed. Its tabs were preserved.');
        g.phase = 'creating';
        await this.save(j);
        g.native_id = await this.native.groupTabs(
          w.native_id!,
          members.map((t) => t.native_id!),
        );
        await this.save(j);
      }
      await this.native.updateGroup(g.native_id!, g.source);
      g.phase = 'done';
      return;
    }
    if (w.phase === 'order') {
      if (j.selection.mode === 'tab' || w.order_index === w.tabs.length) {
        w.phase = 'activate';
        return;
      }
      const t = w.tabs[w.order_index]!,
        live = await this.knownTab(w, t);
      if (live.pinned !== t.source.pinned)
        throw new Error('A restored tab changed pinned state. Review before resuming.');
      await this.native.moveTab(t.native_id!, w.order_index);
      w.order_index++;
      return;
    }
    if (w.phase === 'activate') {
      const t = w.tabs.find((t) => t.source.active) ?? w.tabs[0]!;
      await this.knownTab(w, t);
      await this.native.activateTab(t.native_id!);
      w.phase = 'cleanup';
      return;
    }
    if (w.phase === 'cleanup') {
      const live = await this.live(w),
        sentinel = live.tabs.find((t) => t.id === w.sentinel_id);
      if (
        sentinel &&
        (sentinel.pendingUrl ?? sentinel.url) === this.native.marker(j.id, `window/${w.source.id}`)
      )
        await this.native.removeMarkerTab(sentinel.id);
      w.phase = 'done';
    }
  }
}
