import Dexie from 'dexie';
import { SynkDatabase } from './database';
import { validateSessionSnapshot, type SessionWindow } from './sessions';
import {
  windowContentFingerprint,
  sessionFingerprintDigest,
  type SessionBrowser,
  type NativeSessionTab,
  type NativeSessionWindow,
  type NativeSessionGroup,
  type SessionSetup,
} from './session-native';

/** Native caches are independent of network availability. Browser runtime IDs never leave this adapter. */
export class SessionCapture {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private db: SynkDatabase,
    private native: SessionBrowser,
  ) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const p = this.tail.then(work);
    this.tail = p.catch(() => {});
    return p;
  }
  private tables() {
    return [
      ...this.db.captureBudgetTables(),
      this.db.state,
      this.db.operations,
      this.db.drafts,
      this.db.sessionReplicas,
      this.db.sessionRestores,
      this.db.sessionSetup,
      this.db.sessionIdentities,
      this.db.sessionWindows,
      this.db.sessionClosedSeen,
    ];
  }
  private async enabled(): Promise<boolean> {
    const enabled = !!(await this.db.sessionSetup.get('session'))?.enabled;
    if (enabled) await this.db.assertCaptureCapacity();
    return enabled;
  }
  enable(): Promise<void> {
    return this.serial(async () => {
      if (!(await this.db.state.get('local'))) throw new Error('Connect this device first.');
      const old = await this.db.sessionSetup.get('session'),
        incarnation = await this.native.getIncarnation();
      const recent = old && !old.enabled ? await this.native.getRecentlyClosed() : [];
      const source = (await this.db.state.get('local'))!.credentials.device_id;
      await this.db.transaction('rw', this.tables(), async () => {
        if (old && !old.enabled) await this.db.sessionWindows.clear();
        await this.db.sessionSetup.put(
          old
            ? {
                ...old,
                enabled: true,
                closed_baseline: recent.map((e) => `${source}/${e.id}/${e.closed_at}`),
              }
            : { id: 'session', enabled: true, incarnation, startup_wait: true },
        );
      });
      await this.capture();
    });
  }
  pause(): Promise<void> {
    return this.serial(async () => {
      const old = await this.db.sessionSetup.get('session');
      if (old) await this.db.sessionSetup.put({ ...old, enabled: false });
    });
  }
  reconcile(): Promise<void> {
    return this.serial(async () => {
      if (await this.enabled()) await this.capture();
    });
  }
  saveCurrent(): Promise<string> {
    return this.serial(async () => {
      const local = (await this.db.state.get('local'))!,
        replica = await this.db.sessionProjection(),
        current = replica.snapshots[replica.current[local.credentials.device_id] ?? ''];
      if (!current) throw new Error('No current session to save.');
      return this.db.stageSession({
        kind: 'previous',
        captured_at: current.captured_at,
        windows: current.windows,
        previous_of: current.id,
      });
    });
  }
  private async incarnation(): Promise<SessionSetup> {
    const marker = await this.native.getIncarnation();
    return this.db.transaction('rw', this.tables(), async () => {
      const old = (await this.db.sessionSetup.get('session'))!;
      if (old.incarnation === marker) return old;
      const replica = await this.db.sessionProjection(),
        current = old.last_snapshot ? replica.snapshots[old.last_snapshot] : undefined;
      if (current)
        await this.db.stageSession({
          kind: 'previous',
          captured_at: current.captured_at,
          windows: current.windows,
          previous_of: current.id,
        });
      await this.db.sessionWindows.clear();
      await this.db.sessionIdentities.clear();
      const next: SessionSetup = {
        id: 'session',
        enabled: old.enabled,
        incarnation: marker,
        last_snapshot: old.last_snapshot,
        startup_wait: true,
        closed_baseline: old.closed_baseline,
      };
      await this.db.sessionSetup.put(next);
      return next;
    });
  }
  private async logical(key: string): Promise<string> {
    const old = await this.db.sessionIdentities.get(key);
    if (old) return old.logical_id;
    const logical_id = crypto.randomUUID();
    await this.db.sessionIdentities.add({ key, logical_id });
    return logical_id;
  }
  private async convert(
    window: NativeSessionWindow,
    groups: NativeSessionGroup[],
    prefix: string,
  ): Promise<SessionWindow> {
    const groupMap = new Map(groups.filter((g) => g.windowId === window.id).map((g) => [g.id, g]));
    const ids = new Map<number, string>();
    for (const [id] of groupMap) ids.set(id, await this.logical(`${prefix}/group/${id}`));
    const tabs = [];
    for (const t of [...window.tabs]
      .filter((t) => !t.incognito && !t.temporary)
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.index - b.index)) {
      if (t.groupId >= 0 && !t.pinned && !ids.has(t.groupId))
        throw new Error('Tab group metadata is not captured yet.');
      tabs.push({
        id: await this.logical(`${prefix}/tab/${t.id}`),
        url: t.pendingUrl ?? t.url ?? '',
        title: t.title ?? '',
        pinned: t.pinned,
        active: t.active,
        ...(t.groupId >= 0 && !t.pinned ? { group_id: ids.get(t.groupId)! } : {}),
      });
    }
    return {
      id: await this.logical(`${prefix}/window/${window.id}`),
      focused: window.focused,
      state: window.state,
      tabs,
      groups: [...groupMap.values()].map((g) => ({
        id: ids.get(g.id)!,
        title: g.title,
        color: g.color,
        collapsed: g.collapsed,
      })),
    };
  }
  private async cache(
    window: NativeSessionWindow,
    groups: NativeSessionGroup[],
    setup: SessionSetup,
  ): Promise<void> {
    window = { ...window, tabs: window.tabs.filter((t) => !t.incognito && !t.temporary) };
    const old = await this.db.sessionWindows.get(window.id);
    let last_good = old?.last_good;
    try {
      const candidate = await this.convert(window, groups, setup.incarnation),
        local = (await this.db.state.get('local'))!;
      validateSessionSnapshot({
        id: crypto.randomUUID(),
        source_id: local.credentials.device_id,
        source_revision: local.next_counter,
        source_name: local.credentials.name,
        kind: 'current',
        captured_at: new Date().toISOString(),
        windows: [candidate],
      });
      last_good = candidate;
    } catch (cause) {
      // Group and pin events may expose a transient non-contiguous tab order. Retain the last valid cache.
      if (
        !(cause instanceof Error) ||
        ![
          'Tab group metadata is not captured yet.',
          'Session groups must be contiguous.',
          'Pinned session tabs must precede unpinned tabs and cannot be grouped.',
        ].includes(cause.message)
      )
        throw cause;
    }
    await this.db.sessionWindows.put({
      runtime_id: window.id,
      incarnation: setup.incarnation,
      native: window,
      groups,
      last_good,
    });
  }
  observeTab(tab: NativeSessionTab): Promise<void> {
    return this.serial(async () => {
      if (!(await this.enabled()) || tab.incognito || tab.temporary) return;
      const setup = await this.incarnation(),
        cached = await this.db.sessionWindows.get(tab.windowId);
      let window = cached?.native;
      if (!window) {
        try {
          window = await this.native.getWindow(tab.windowId);
        } catch {
          return;
        }
      } else {
        try {
          await this.native.getWindow(tab.windowId);
        } catch {
          // Teardown can unpin/reorder tabs before the window-removal event. Keep
          // the cached layout, while retaining captured navigation/title changes.
          const previous = window.tabs.find((t) => t.id === tab.id);
          if (previous)
            tab = {
              ...previous,
              url: tab.url ?? previous.url,
              pendingUrl: tab.pendingUrl,
              title: tab.title ?? previous.title,
            };
        }
      }
      if (window.incognito || window.type !== 'normal') return;
      const next = {
        ...window,
        tabs: [
          ...window.tabs
            .filter((t) => t.id !== tab.id)
            .map((t) => (tab.active ? { ...t, active: false } : t)),
          tab,
        ],
      };
      await this.db.transaction('rw', this.tables(), async () =>
        this.cache(next, cached?.groups ?? [], setup),
      );
    });
  }
  observeWindow(window: NativeSessionWindow): Promise<void> {
    return this.serial(async () => {
      if (!(await this.enabled()) || window.incognito || window.type !== 'normal') return;
      const setup = await this.incarnation();
      let populated = window;
      try {
        populated = await this.native.getWindow(window.id);
      } catch {
        /* A transient window may already have closed. Preserve event-provided tabs if present. */
      }
      const cached = await this.db.sessionWindows.get(window.id);
      await this.db.transaction('rw', this.tables(), async () =>
        this.cache(populated, cached?.groups ?? [], setup),
      );
    });
  }
  observeGroup(group: NativeSessionGroup): Promise<void> {
    return this.serial(async () => {
      if (!(await this.enabled())) return;
      const setup = await this.incarnation(),
        cached = await this.db.sessionWindows.get(group.windowId);
      if (!cached) return;
      await this.db.transaction('rw', this.tables(), async () =>
        this.cache(
          cached.native,
          [...cached.groups.filter((g) => g.id !== group.id), group],
          setup,
        ),
      );
    });
  }
  moveTab(id: number, windowId: number, index: number): Promise<void> {
    return this.serial(async () => {
      if (!(await this.enabled())) return;
      const setup = await this.incarnation(),
        cached = await this.db.sessionWindows.get(windowId);
      const tab = cached?.native.tabs.find((t) => t.id === id);
      if (!cached || !tab) return;
      const tabs = cached.native.tabs.filter((t) => t.id !== id).sort((a, b) => a.index - b.index);
      tabs.splice(Math.min(tabs.length, Math.max(0, index)), 0, tab);
      await this.db.transaction('rw', this.tables(), async () =>
        this.cache(
          { ...cached.native, tabs: tabs.map((t, index) => ({ ...t, index })) },
          cached.groups,
          setup,
        ),
      );
    });
  }
  removeTab(id: number, windowId: number, windowClosing: boolean): Promise<void> {
    return this.serial(async () => {
      if (!(await this.enabled()) || windowClosing) return;
      const setup = await this.incarnation(),
        cached = await this.db.sessionWindows.get(windowId);
      if (!cached) return;
      await this.db.transaction('rw', this.tables(), async () =>
        this.cache(
          { ...cached.native, tabs: cached.native.tabs.filter((t) => t.id !== id) },
          cached.groups,
          setup,
        ),
      );
    });
  }
  closeWindow(id: number): Promise<void> {
    return this.serial(async () => {
      if (!(await this.enabled())) return;
      const setup = await this.incarnation();
      await this.db.transaction('rw', this.tables(), async () => this.archive(id, setup));
    });
  }
  private async archive(id: number, setup: SessionSetup): Promise<void> {
    const cached = await this.db.sessionWindows.get(id);
    if (!cached || cached.incarnation !== setup.incarnation) return;
    if (cached.last_good && cached.last_good.tabs.length) {
      const captured_at = new Date().toISOString(),
        window = { ...cached.last_good, focused: false };
      const snapshot_id = await this.db.stageSession({
        kind: 'closed',
        captured_at,
        windows: [window],
      });
      await this.db.sessionClosedSeen.put({
        id: `live/${setup.incarnation}/${id}`,
        snapshot_id,
        fingerprint: await Dexie.waitFor(
          sessionFingerprintDigest(windowContentFingerprint(window)),
        ),
        captured_at,
      });
    }
    await this.db.sessionWindows.delete(id);
  }
  private async capture(): Promise<void> {
    const setup = await this.incarnation(),
      windows = (await this.native.getWindows()).filter(
        (w) =>
          !w.incognito && w.type === 'normal' && w.tabs.some((t) => !t.incognito && !t.temporary),
      ),
      groups = await this.native.getGroups();
    await this.db.transaction('rw', this.tables(), async () => {
      // A missed removal is recovered from the durable cache before replacing the current set.
      for (const cached of await this.db.sessionWindows.toArray())
        if (!windows.some((w) => w.id === cached.runtime_id))
          await this.archive(cached.runtime_id, setup);
      const values = [];
      for (const w of windows) {
        const relevant = groups.filter((g) => g.windowId === w.id);
        const value = await this.convert(w, relevant, setup.incarnation);
        values.push(value);
        await this.db.sessionWindows.put({
          runtime_id: w.id,
          incarnation: setup.incarnation,
          native: { ...w, tabs: w.tabs.filter((t) => !t.incognito && !t.temporary) },
          groups: relevant,
          last_good: value,
        });
      }
      if (setup.startup_wait && !values.length && setup.last_snapshot) return;
      const fingerprint = JSON.stringify(values);
      if (fingerprint !== setup.last_fingerprint) {
        const id = await this.db.stageSession({
          kind: 'current',
          captured_at: new Date().toISOString(),
          windows: values,
        });
        await this.db.sessionSetup.put({
          ...setup,
          last_fingerprint: fingerprint,
          last_snapshot: id,
          startup_wait: false,
        });
      }
    });
    await this.recentlyClosed();
  }
  private async recentlyClosed(): Promise<void> {
    const entries = await this.native.getRecentlyClosed(),
      local = (await this.db.state.get('local'))!,
      setup = (await this.db.sessionSetup.get('session'))!;
    for (const entry of entries.slice(0, 25)) {
      if (entry.window.incognito || entry.window.type !== 'normal') continue;
      const key = `${local.credentials.device_id}/${entry.id}/${entry.closed_at}`;
      if (setup.closed_baseline?.includes(key)) continue;
      await this.db.transaction('rw', this.tables(), async () => {
        if (await this.db.sessionClosedSeen.get(key)) return;
        // Closed APIs cannot resolve live group IDs. Keep richer live-cache records when a unique unmatched record agrees.
        const window = await this.convert(
            { ...entry.window, tabs: entry.window.tabs.map((t) => ({ ...t, groupId: -1 })) },
            [],
            `closed/${key}`,
          ),
          legacyFingerprint = windowContentFingerprint(window),
          fingerprint = await Dexie.waitFor(sessionFingerprintDigest(legacyFingerprint));
        const matches = (
          await this.db.sessionClosedSeen
            .where('fingerprint')
            .anyOf(fingerprint, legacyFingerprint)
            .toArray()
        )
          .filter(
            (m) =>
              !m.native_session &&
              Math.abs(Date.parse(m.captured_at) - Date.parse(entry.closed_at)) <= 60_000,
          )
          .sort(
            (a, b) =>
              Math.abs(Date.parse(a.captured_at) - Date.parse(entry.closed_at)) -
              Math.abs(Date.parse(b.captured_at) - Date.parse(entry.closed_at)),
          );
        const match = matches[0];
        if (match) {
          await this.db.sessionClosedSeen.put({ ...match, fingerprint, native_session: key });
          await this.db.sessionClosedSeen.put({
            ...match,
            fingerprint,
            id: key,
            native_session: key,
          });
          return;
        }
        const snapshot_id = await this.db.stageSession({
          kind: 'closed',
          captured_at: entry.closed_at,
          windows: [{ ...window, focused: false, groups_unavailable: true }],
        });
        await this.db.sessionClosedSeen.put({
          id: key,
          snapshot_id,
          fingerprint,
          captured_at: entry.closed_at,
          native_session: key,
        });
      });
    }
  }
}
