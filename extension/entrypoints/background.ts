import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { SynkDatabase, SyncCoordinator } from '@helium-synk/core';
import type { Reply, Request, Status } from '../lib/messages';

export default defineBackground(() => {
  const db = new SynkDatabase();
  const coordinator = new SyncCoordinator(db);
  let socket: WebSocket | undefined;
  let connection: Status['connection'] = 'not-connected';
  let error: string | undefined;
  let retryAt = 0;
  let failures = 0;

  async function sync(force = false): Promise<void> {
    if (!force && Date.now() < retryAt) return;
    if (!(await db.state.get('local'))) return;
    connection = 'syncing';
    try {
      await coordinator.sync();
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
    const local = await db.state.get('local');
    return {
      enrolled: !!local,
      name: local?.credentials.name,
      endpoint: local?.credentials.server_url,
      connection,
      error,
      last_synced: local?.last_synced,
      pending: await db.outbox.count(),
      records: (await db.records.toArray())
        .sort((a, b) => b.payload.created_at.localeCompare(a.payload.created_at))
        .slice(0, 100),
      browser_version: navigator.userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/)?.[1] ?? 'Unknown',
    };
  }
  async function handle(request: Request): Promise<Reply> {
    try {
      if (request.type === 'enroll') {
        await db.enroll(request.credentials, request.recovery_key);
        await connect();
        await sync(true);
      } else if (request.type === 'queue') {
        await db.queueDiagnostic(request.note);
        void sync(true);
      } else if (request.type === 'sync') {
        await connect();
        await sync(true);
      } else if (request.type === 'recovery') {
        const local = await db.state.get('local');
        if (!local) throw new Error('Connect this device first.');
        return {
          ok: true,
          recovery: {
            account_id: local.credentials.account_id,
            recovery_key: local.recovery_key,
            server_url: local.credentials.server_url,
          },
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
    void start().catch(initializationError);
  });
  browser.runtime.onInstalled.addListener(() => {
    void start().catch(initializationError);
  });

  async function start(): Promise<void> {
    await browser.alarms.create('reconcile', { periodInMinutes: 0.5 });
    await connect();
    await sync();
  }
  function initializationError(): void {
    connection = 'waiting';
    error = 'Unable to initialize local storage or the synchronization alarm.';
  }
  void start().catch(initializationError);
});
