import { defineBackground } from 'wxt/utils/define-background';
import { browser, type Browser } from 'wxt/browser';
import {
  SynkDatabase,
  createPairingBundle,
  stagePairing,
  completePairing,
  discardPairing,
  pairingSummary,
  KeyManager,
  HttpTransport,
  exportRecovery,
  enrollRecovery,
  SyncCoordinator,
  BookmarkAdapter,
  SessionCapture,
  HistoryCapture,
  type HistoryInbox,
  SessionRestorer,
  restoreSummary,
  flattenBookmarks,
  type BookmarkEvent,
} from '@helium-synk/core';
import type { Reply, Request, Status } from '@/lib/messages';
import { bookmarkBrowser } from '@/lib/bookmark-browser';
import { historyBrowser } from '@/lib/history-browser';
import { sessionBrowser, restoreBrowser, nativeTab, nativeWindow } from '@/lib/session-browser';

export default defineBackground(() => {
  const db = new SynkDatabase();
  const coordinator = new SyncCoordinator(db);
  const bookmarks = new BookmarkAdapter(db, bookmarkBrowser);
  const sessions = new SessionCapture(db, sessionBrowser);
  const history = new HistoryCapture(db, historyBrowser);
  let historyError: string | undefined;
  let historyTimer: ReturnType<typeof setTimeout> | undefined;
  let historyWorkTimer: ReturnType<typeof setTimeout> | undefined;
  let firstHistoryEvent = 0;
  const restorer = new SessionRestorer(db, restoreBrowser);
  let sessionError: string | undefined;
  let sessionTimer: ReturnType<typeof setTimeout> | undefined;
  let firstSessionEvent = 0;
  let restoring = false;
  let restoreTimer: ReturnType<typeof setTimeout> | undefined;
  let bookmarkError: string | undefined;
  let bookmarkTimer: ReturnType<typeof setTimeout> | undefined;
  let firstBookmarkEvent = 0;
  let socket: WebSocket | undefined;
  let connection: Status['connection'] = 'not-connected';
  let error: string | undefined;
  let retryAt = 0;
  let failures = 0;

  async function sync(force = false): Promise<void> {
    if (!force && Date.now() < retryAt) return;
    if (!(await db.state.get('local'))) return;
    await reconcileBookmarks();
    await reconcileSessions();
    await reconcileHistory();
    connection = 'syncing';
    try {
      await coordinator.sync();
      await reconcileBookmarks();
      await reconcileHistory();
      connection = 'online';
      error = undefined;
      failures = 0;
      retryAt = 0;
    } catch (cause) {
      connection = 'waiting';
      error =
        cause instanceof Error ? cause.message : 'Unable to synchronize. Local work was retained.';
      failures = Math.min(failures + 1, 6);
      retryAt =
        Date.now() + Math.min(120_000, 1_000 * 2 ** failures) * (0.75 + Math.random() * 0.5);
    }
  }
  async function connect(): Promise<void> {
    if (socket && socket.readyState !== WebSocket.CLOSED) return;
    const local = await db.state.get('local');
    if (!local) return;
    const url = new URL('/v1/events', local.credentials.server_url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    let current: WebSocket;
    try {
      current = new WebSocket(url);
    } catch {
      connection = 'waiting';
      error = 'Unable to open notifications. Check the server host permission.';
      return;
    }
    socket = current;
    let authenticated = false;
    let lastMessage = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - lastMessage > 45_000) current.close();
      else if (authenticated && current.readyState === WebSocket.OPEN) current.send('ping');
    }, 20_000);
    current.onopen = () => current.send(JSON.stringify({ token: local.credentials.token }));
    current.onmessage = (event) => {
      lastMessage = Date.now();
      try {
        const message = JSON.parse(String(event.data)) as { type: string };
        if (message.type === 'ready') {
          authenticated = true;
          void sync(true);
        } else if (message.type === 'sync_available') void sync();
        else if (message.type === 'ping') current.send('pong');
      } catch {
        current.close();
      }
    };
    current.onerror = () => {
      connection = 'waiting';
    };
    current.onclose = () => {
      clearInterval(timer);
      if (socket === current) socket = undefined;
      if (connection === 'online') connection = 'waiting';
    };
  }
  async function status(): Promise<Status> {
    const historySetup = await db.historySetup.get('history');
    const setup = await db.bookmarkSetup.get('bookmark'),
      replica = await db.bookmarkProjection();
    const interrupted = await db.bookmarkEffects.where('status').equals('blocked').toArray();
    const local = await db.state.get('local'),
      sessionSetup = await db.sessionSetup.get('session'),
      sessionProjection = await db.sessionProjection();
    const activeJobs = await db.sessionRestores
      .where('status')
      .anyOf('running', 'blocked')
      .toArray();
    const recentJobs = await db.sessionRestores.orderBy('created_at').reverse().limit(5).toArray();
    const jobs = [...new Map([...activeJobs, ...recentJobs].map((j) => [j.id, j])).values()]
      .sort((a, b) => b.created_at.localeCompare(a.created_at))
      .map(restoreSummary);
    return {
      enrolled: !!local,
      key_epoch: local?.key_epoch ?? (local ? 1 : undefined),
      rotation_pending: await rotationSummary(),
      pairing_pending: pairingSummary(await db.pairingPending.get('pairing')),
      history: {
        enabled: !!historySetup?.enabled,
        phase: historySetup?.phase ?? 'off',
        visits: await db.historyVisits.count(),
        pending:
          (await db.historyInbox.count()) +
          (await db.historyLookups.count()) +
          (await db.historyScans.count()),
        exclusions: historySetup?.exclusions ?? [],
        error: historyError ?? historySetup?.error,
      },
      sessions: {
        enabled: !!sessionSetup?.enabled,
        snapshots: Object.keys(sessionProjection.snapshots).length,
        incomplete: sessionProjection.incomplete.length,
        error: sessionError,
        restores: jobs,
      },
      name: local?.credentials.name,
      endpoint: local?.credentials.server_url,
      connection,
      error,
      last_synced: local?.last_synced,
      pending: await db.pendingCount(),
      records: (await db.records.toArray())
        .sort((a, b) => b.payload.created_at.localeCompare(a.payload.created_at))
        .slice(0, 100),
      bookmarks: {
        phase: setup?.phase ?? 'off',
        nodes: Object.values(replica.nodes).filter((n) => !n.system).length,
        conflicts: replica.conflicts.length,
        captured: await db.bookmarkInbox.count(),
        error: bookmarkError,
        interrupted: interrupted.map((e) => ({
          id: e.id,
          message: e.error ?? 'Interrupted bookmark application needs review.',
        })),
      },
      browser_version: navigator.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1] ?? 'Unknown',
    };
  }
  async function rotationSummary(): Promise<Status['rotation_pending']> {
    const pending = await db.rotationPending.get('rotation');
    return pending
      ? {
          rotation_id: pending.request.rotation_id,
          key_epoch: pending.request.key_epoch,
          from_epoch: pending.request.from_epoch,
          revoke_ids: pending.request.revoke_ids,
        }
      : undefined;
  }
  async function keyManager(): Promise<KeyManager> {
    const local = await db.state.get('local');
    if (!local) throw new Error('Connect this device first.');
    return new KeyManager(db, new HttpTransport(local).keys);
  }
  async function handle(request: Request): Promise<Reply> {
    try {
      if (request.type === 'pairing-create')
        return { ok: true, pairing: await createPairingBundle(db) };
      if (request.type === 'pairing-discard') {
        await discardPairing(db);
        return { ok: true, status: await status() };
      }
      if (request.type === 'pairing-start' || request.type === 'pairing-retry') {
        if (request.type === 'pairing-start') await stagePairing(db, request.bundle, request.name);
        await completePairing(db);
        await connect();
        await sync(true);
        return { ok: true, status: await status() };
      }
      if (request.type === 'history-query') {
        return {
          ok: true,
          history_page: await db.queryHistory(request.query),
          history_sources: await db.historySources(),
        };
      }
      if (request.type === 'history-enable') {
        await history.enable(request.days, request.exclusions);
        await reconcileHistory();
        void sync(true);
        return { ok: true, status: await status() };
      }
      if (request.type === 'history-pause') {
        await history.pause();
        return { ok: true, status: await status() };
      }
      if (request.type === 'history-delete') {
        await db.stageHistory({ type: 'delete', visit_ids: request.ids });
        void sync(true);
        return { ok: true, status: await status() };
      }
      if (request.type === 'history-clear') {
        await db.stageHistory(
          request.source_id !== undefined
            ? { type: 'clear', scope: 'source', source_id: request.source_id }
            : { type: 'clear', scope: 'all' },
        );
        await reconcileHistory();
        void sync(true);
        return { ok: true, status: await status() };
      }
      if (request.type === 'session-list') {
        const offset = request.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0)
          throw new Error('Invalid session list page.');
        const projection = await db.sessionProjection();
        const values = Object.values(projection.snapshots).sort(
          (a, b) =>
            Number(projection.current[b.source_id] === b.id) -
              Number(projection.current[a.source_id] === a.id) ||
            b.captured_at.localeCompare(a.captured_at) ||
            b.source_revision - a.source_revision ||
            a.id.localeCompare(b.id),
        );
        return {
          ok: true,
          session_more: values.length > offset + 100,
          session_list: values.slice(offset, offset + 100).map((s) => ({
            id: s.id,
            source_id: s.source_id,
            source_name: s.source_name,
            source_revision: s.source_revision,
            kind: s.kind,
            captured_at: s.captured_at,
            previous_of: s.previous_of,
            windows: s.windows.length,
            tabs: s.windows.reduce((n, w) => n + w.tabs.length, 0),
            latest: projection.current[s.source_id] === s.id,
          })),
        };
      }
      if (request.type === 'session-detail') {
        const snapshot = (await db.sessionProjection()).snapshots[request.id];
        if (!snapshot) throw new Error('This session snapshot is unavailable.');
        return { ok: true, session_snapshot: snapshot };
      }
      if (request.type === 'session-enable') {
        await sessions.enable();
        sessionError = undefined;
        void sync(true);
        return { ok: true, status: await status() };
      }
      if (request.type === 'session-pause') {
        await sessions.pause();
        return { ok: true, status: await status() };
      }
      if (request.type === 'session-save') {
        await sessions.saveCurrent();
        void sync(true);
        return { ok: true, status: await status() };
      }
      if (request.type === 'session-restore') {
        const snapshot = (await db.sessionProjection()).snapshots[request.snapshot_id];
        if (!snapshot) throw new Error('This session snapshot is unavailable.');
        await restorer.begin(request.id, snapshot, request.selection);
        void resumeRestores();
        return { ok: true, status: await status() };
      }
      if (request.type === 'session-resume') {
        await restorer.resume(request.id);
        void resumeRestores();
        return { ok: true, status: await status() };
      }
      if (request.type === 'session-cancel') {
        await restorer.cancel(request.id);
        return { ok: true, status: await status() };
      }
      if (request.type === 'export') return { ok: true, replica: await db.exportReplica() };
      if (request.type === 'bookmark-roots') {
        const nodes = [...flattenBookmarks(await bookmarkBrowser.getTree()).values()];
        return {
          ok: true,
          bookmark_roots: nodes
            .filter(
              (n) =>
                !n.unmodifiable &&
                ['bookmarks-bar', 'other', 'mobile'].includes(n.folderType ?? ''),
            )
            .map((n) => ({
              id: n.id,
              title: n.title,
              role: n.folderType === 'bookmarks-bar' ? 'bar' : (n.folderType as 'other' | 'mobile'),
              syncing: n.syncing === true,
            })),
        };
      }
      if (request.type === 'bookmark-preview')
        return { ok: true, bookmark_preview: await bookmarks.preview(request.roots) };
      if (request.type === 'bookmark-confirm') {
        await bookmarks.confirm(request.id);
        void sync(true);
        return { ok: true, status: await status() };
      }
      if (request.type === 'bookmark-resolve') {
        await bookmarks.resolveCreate(request.id, request.native_id);
        bookmarkError = undefined;
        void sync(true);
        return { ok: true, status: await status() };
      }
      if (request.type === 'bookmark-review') {
        const effect = await db.bookmarkEffects.get(request.id);
        if (!effect || effect.status !== 'blocked')
          throw new Error('No interrupted bookmark to review.');
        const candidates = [...flattenBookmarks(await bookmarkBrowser.getTree()).values()].filter(
          (n) =>
            n.parentId === effect.desired.parentId &&
            n.title === effect.desired.title &&
            n.url === effect.desired.url &&
            !effect.before_children?.includes(n.id),
        );
        return { ok: true, bookmark_candidates: candidates };
      }
      if (request.type === 'keys-list') {
        const remote = await (await keyManager()).refresh();
        return {
          ok: true,
          status: await status(),
          keys: {
            key_epoch: remote.key_epoch,
            device_id: (await db.state.get('local'))!.credentials.device_id,
            devices: remote.devices.map((d) => ({
              device_id: d.device_id,
              name: d.name,
              revoked: d.revoked,
              ready: !!d.public_key,
            })),
          },
        };
      }
      if (request.type === 'keys-rotate' || request.type === 'keys-retry') {
        const manager = await keyManager();
        if (request.type === 'keys-rotate')
          await manager.stageRotation(request.revoke_ids, request.replace);
        await manager.completeRotation();
        void sync(true);
        return { ok: true, status: await status() };
      }
      if (request.type === 'enroll') {
        if (request.recovery_bundle)
          await enrollRecovery(db, request.credentials, request.recovery_bundle);
        else await db.enroll(request.credentials, request.recovery_key);
        await connect();
        await sync(true);
      } else if (request.type === 'queue') {
        await db.queueDiagnostic(request.note);
        void sync(true);
      } else if (request.type === 'sync') {
        await history.audit();
        await connect();
        await sync(true);
      } else if (request.type === 'recovery') {
        return {
          ok: true,
          recovery: await exportRecovery(db),
        };
      } else if (request.type !== 'status') throw new Error('Unknown request.');
      return { ok: true, status: await status() };
    } catch (cause) {
      return {
        ok: false,
        error: cause instanceof Error ? cause.message : 'Local storage operation failed.',
      };
    }
  }

  async function reconcileHistory(): Promise<void> {
    try {
      await history.reconcile();
      historyError = undefined;
      const setup = await db.historySetup.get('history');
      if (!setup?.enabled || setup.phase === 'blocked' || historyWorkTimer) return;
      const now = Date.now();
      const ready =
        (await db.historyInbox.filter((i) => (i.retry_at ?? 0) <= now).count()) > 0 ||
        (await db.historyLookups.filter((l) => (l.retry_at ?? 0) <= now).count()) > 0 ||
        (await db.historyScans.filter((s) => (s.retry_at ?? 0) <= now).count()) > 0;
      if (ready)
        historyWorkTimer = setTimeout(() => {
          historyWorkTimer = undefined;
          void sync(true);
        }, 500);
    } catch {
      historyError =
        'Unable to persist history progress. Saved records remain queued; check local storage.';
    }
  }
  function historyEvent(event: HistoryInbox['event']): void {
    void history
      .capture(event)
      .then((accepted) => {
        if (!accepted) {
          void reconcileHistory();
          return;
        }
        const now = Date.now();
        if (!firstHistoryEvent) firstHistoryEvent = now;
        if (historyTimer) clearTimeout(historyTimer);
        historyTimer = setTimeout(
          () => {
            historyTimer = undefined;
            firstHistoryEvent = 0;
            void sync(true);
          },
          Math.min(500, Math.max(0, firstHistoryEvent + 2000 - now)),
        );
      })
      .catch(() => {
        historyError =
          'A history event could not be saved. Check local storage; reconciliation will retry what the browser still retains.';
      });
  }
  // Registration is synchronous. Essential intent is in IndexedDB before debounce.
  browser.history.onVisited.addListener((item) => historyEvent({ type: 'visited', item }));
  browser.history.onVisitRemoved.addListener((event) =>
    historyEvent({ type: 'removed', all: event.allHistory, urls: event.urls ?? [] }),
  );

  async function reconcileSessions(): Promise<void> {
    try {
      await sessions.reconcile();
      sessionError = undefined;
    } catch (cause) {
      sessionError =
        cause instanceof Error
          ? cause.message
          : 'Unable to capture sessions. Last good snapshots were retained.';
    }
  }
  async function resumeRestores(): Promise<void> {
    if (restoring) return;
    restoring = true;
    try {
      const jobs = await db.sessionRestores.where('status').equals('running').sortBy('created_at');
      if (jobs[0]) await restorer.run(jobs[0].id);
      if (await db.sessionRestores.where('status').equals('running').count()) {
        if (restoreTimer) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
          restoreTimer = undefined;
          void resumeRestores();
        }, 150);
      }
    } catch {
      sessionError =
        'Unable to save restoration progress. Opened tabs were retained; check local storage.';
    } finally {
      restoring = false;
    }
  }
  function sessionEvent(work: Promise<unknown>): void {
    void work
      .then(async () => {
        if (!(await db.sessionSetup.get('session'))?.enabled) return;
        const now = Date.now();
        if (!firstSessionEvent) firstSessionEvent = now;
        if (sessionTimer) clearTimeout(sessionTimer);
        sessionTimer = setTimeout(
          () => {
            sessionTimer = undefined;
            firstSessionEvent = 0;
            void reconcileSessions().then(() => sync(true));
          },
          Math.min(2_000, Math.max(0, firstSessionEvent + 5_000 - now)),
        );
      })
      .catch(() => {
        sessionError =
          'Unable to persist a session event. Last good snapshots were retained; reconciliation will retry.';
      });
  }
  function refreshTab(id: number): void {
    sessionEvent(browser.tabs.get(id).then((tab) => sessions.observeTab(nativeTab(tab))));
  }
  // Native cache writes happen before the publication debounce and independently of transport.
  browser.tabs.onCreated.addListener((tab) => sessionEvent(sessions.observeTab(nativeTab(tab))));
  browser.tabs.onUpdated.addListener((_id, _changes, tab) =>
    sessionEvent(sessions.observeTab(nativeTab(tab))),
  );
  browser.tabs.onRemoved.addListener((id, info) =>
    sessionEvent(sessions.removeTab(id, info.windowId, info.isWindowClosing)),
  );
  browser.tabs.onMoved.addListener((id, info) =>
    sessionEvent(sessions.moveTab(id, info.windowId, info.toIndex)),
  );
  browser.tabs.onActivated.addListener((info) => refreshTab(info.tabId));
  browser.tabs.onDetached.addListener((id, info) =>
    sessionEvent(sessions.removeTab(id, info.oldWindowId, false)),
  );
  browser.tabs.onAttached.addListener((id) => refreshTab(id));
  browser.windows.onCreated.addListener((w) =>
    sessionEvent(sessions.observeWindow(nativeWindow(w))),
  );
  browser.windows.onRemoved.addListener((id) => sessionEvent(sessions.closeWindow(id)));
  browser.windows.onFocusChanged.addListener(() => sessionEvent(Promise.resolve()));
  browser.windows.onBoundsChanged.addListener((w) =>
    sessionEvent(sessions.observeWindow(nativeWindow(w))),
  );
  const groupEvent = (g: Browser.tabGroups.TabGroup) =>
    sessionEvent(
      sessions.observeGroup({
        id: g.id,
        windowId: g.windowId,
        title: g.title ?? '',
        color: g.color,
        collapsed: g.collapsed,
      }),
    );
  browser.tabGroups.onCreated.addListener(groupEvent);
  browser.tabGroups.onUpdated.addListener(groupEvent);
  browser.tabGroups.onMoved.addListener(groupEvent);
  browser.tabGroups.onRemoved.addListener(() => sessionEvent(Promise.resolve()));
  browser.sessions.onChanged.addListener(() => sessionEvent(Promise.resolve()));

  async function reconcileBookmarks(): Promise<void> {
    try {
      await bookmarks.reconcile();
      bookmarkError = undefined;
    } catch (cause) {
      bookmarkError =
        cause instanceof Error
          ? cause.message
          : 'Bookmark capture/application failed. Pending work was retained.';
    }
  }
  function captured(event: BookmarkEvent): void {
    void bookmarks
      .capture(event)
      .then((active) => {
        if (!active) return;
        const now = Date.now();
        if (!firstBookmarkEvent) firstBookmarkEvent = now;
        if (bookmarkTimer) clearTimeout(bookmarkTimer);
        bookmarkTimer = setTimeout(
          () => {
            bookmarkTimer = undefined;
            firstBookmarkEvent = 0;
            void reconcileBookmarks().then(() => sync(true));
          },
          Math.min(300, Math.max(0, firstBookmarkEvent + 2_000 - now)),
        );
      })
      .catch(() => {
        bookmarkError =
          'Unable to persist a bookmark event. Check local storage; tree reconciliation will retry.';
      });
  }
  // Event intent persists before debounced merging/network work. No global ignore-events flag.
  browser.bookmarks.onCreated.addListener((_id, node) => captured({ type: 'created', node }));
  browser.bookmarks.onChanged.addListener((id, changes) =>
    captured({ type: 'changed', id, title: changes.title, url: changes.url }),
  );
  browser.bookmarks.onMoved.addListener((id, move) =>
    captured({ type: 'moved', id, parentId: move.parentId, index: move.index }),
  );
  browser.bookmarks.onRemoved.addListener((id, removed) =>
    captured({ type: 'removed', id, node: removed.node }),
  );
  browser.bookmarks.onChildrenReordered.addListener((id, reordered) =>
    captured({ type: 'reordered', id, childIds: reordered.childIds }),
  );
  browser.bookmarks.onImportEnded.addListener(() => {
    void reconcileBookmarks().then(() => sync(true));
  });

  // Register synchronously, before any database/network initialization.
  browser.runtime.onMessage.addListener((request: Request, sender) => {
    if (sender.id !== browser.runtime.id) return undefined;
    return handle(request);
  });
  browser.action.onClicked.addListener(() => {
    void browser.runtime.openOptionsPage();
  });
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'reconcile') void start().catch(initializationError);
  });
  browser.runtime.onStartup.addListener(() => {
    void history
      .audit()
      .then(() => start())
      .catch(initializationError);
  });
  browser.runtime.onInstalled.addListener(() => {
    void start().catch(initializationError);
  });

  async function start(): Promise<void> {
    await browser.alarms.create('reconcile', { periodInMinutes: 0.5 });
    await reconcileBookmarks();
    await reconcileSessions();
    await reconcileHistory();
    void resumeRestores();
    await connect();
    await sync();
  }
  function initializationError(): void {
    connection = 'waiting';
    error = 'Unable to initialize local storage or the synchronization alarm.';
  }
  void start().catch(initializationError);
});
