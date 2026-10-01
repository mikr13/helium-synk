import { afterEach, describe, expect, it, vi } from 'vitest';
import { SynkDatabase } from './database';
import { generateRecoveryKey } from './crypto';
import { SessionCapture } from './session-capture';
import type {
  SessionBrowser,
  NativeSessionWindow,
  NativeSessionGroup,
  NativeClosedWindow,
} from './session-native';

const dbs: SynkDatabase[] = [];
afterEach(async () => {
  for (const db of dbs.splice(0)) await db.delete();
});
function nativeWindow(id = 10): NativeSessionWindow {
  return {
    id,
    focused: true,
    incognito: false,
    type: 'normal',
    state: 'maximized',
    tabs: Array.from({ length: 3 }, (_, index) => ({
      id: id * 10 + index,
      windowId: id,
      index,
      url: `https://example.com/${index}`,
      title: `Tab ${index}`,
      pinned: index === 0,
      active: index === 1,
      groupId: index ? 5 : -1,
      incognito: false,
    })),
  };
}
class Native implements SessionBrowser {
  incarnation = 'browser-1';
  windows = [nativeWindow()];
  groups: NativeSessionGroup[] = [
    { id: 5, windowId: 10, title: 'Research', color: 'blue', collapsed: true },
  ];
  recent: NativeClosedWindow[] = [];
  async getIncarnation() {
    return this.incarnation;
  }
  async getWindows() {
    return structuredClone(this.windows);
  }
  async getWindow(id: number) {
    const w = this.windows.find((w) => w.id === id);
    if (!w) throw new Error('Window closed');
    return structuredClone(w);
  }
  async getGroups() {
    return structuredClone(this.groups);
  }
  async getRecentlyClosed() {
    return structuredClone(this.recent);
  }
}
async function fixture() {
  const db = new SynkDatabase(`capture-${crypto.randomUUID()}`);
  dbs.push(db);
  await db.enroll(
    {
      account_id: crypto.randomUUID(),
      device_id: crypto.randomUUID(),
      name: 'Laptop',
      token: 'a'.repeat(64),
      server_url: 'http://127.0.0.1:4318',
    },
    generateRecoveryKey(),
  );
  const native = new Native(),
    capture = new SessionCapture(db, native);
  await capture.enable();
  const source = (await db.state.get('local'))!.credentials.device_id;
  const current = async () => {
    const p = await db.sessionProjection();
    return p.snapshots[p.current[source]!]!;
  };
  return { db, native, capture, source, current };
}
describe('durable native session capture', () => {
  it('captures ordered tabs, pins, active selection and groups with stable internal IDs across worker/database reopening', async () => {
    const { db, native, current } = await fixture(),
      before = await current();
    expect(before.windows[0]!.tabs.map((t) => [t.pinned, t.active])).toEqual([
      [true, false],
      [false, true],
      [false, false],
    ]);
    expect(before.windows[0]!.groups[0]).toMatchObject({
      title: 'Research',
      color: 'blue',
      collapsed: true,
    });
    const pending = await db.pendingCount();
    db.close();
    const reopened = new SynkDatabase(db.name);
    dbs.push(reopened);
    await new SessionCapture(reopened, native).reconcile();
    expect(await reopened.pendingCount()).toBe(pending);
    const after = await reopened.sessionProjection();
    expect(after.snapshots[after.current[before.source_id]!]).toEqual(before);
    expect(JSON.stringify(before)).not.toContain('windowId');
  });
  it('persists an updated URL before closure and ignores closing-tab removals so a full closed window survives offline restart', async () => {
    const { db, native, capture, source } = await fixture();
    const changed = {
      ...native.windows[0]!.tabs[1]!,
      url: 'https://example.com/new',
      title: 'Latest',
    };
    await capture.observeTab(changed);
    for (const t of native.windows[0]!.tabs) await capture.removeTab(t.id, 10, true);
    native.windows = [];
    await capture.closeWindow(10);
    db.close();
    const reopened = new SynkDatabase(db.name);
    dbs.push(reopened);
    const p = await reopened.sessionProjection(),
      closed = p.snapshots[p.closed[source]![0]!]!;
    expect(closed.windows[0]!.tabs).toHaveLength(3);
    expect(closed.windows[0]!.tabs[1]).toMatchObject({ title: 'Latest', url: changed.url });
    expect(await reopened.pendingCount()).toBe(2);
    expect(await reopened.sessionWindows.count()).toBe(0);
  });
  it('recovers a missed window removal from the durable cache and matches recently-closed without duplicating richer group metadata', async () => {
    const { db, native, capture, source } = await fixture(),
      original = native.windows[0]!;
    native.windows = [];
    native.recent = [{ id: 'closed-1', closed_at: new Date().toISOString(), window: original }];
    await capture.reconcile();
    await capture.reconcile();
    const p = await db.sessionProjection();
    expect(p.closed[source]).toHaveLength(1);
    expect(p.snapshots[p.closed[source]![0]!]!.windows[0]!.groups[0]!.title).toBe('Research');
    expect(p.snapshots[p.current[source]!]!.windows).toHaveLength(0);
  });
  it('keeps two identical separately closed windows rather than collapsing them by content fingerprint', async () => {
    const { db, native, capture, source } = await fixture();
    const first = native.windows[0]!,
      second = nativeWindow(11);
    second.focused = false;
    native.windows.push(second);
    native.groups.push({ ...native.groups[0]!, id: 5, windowId: 11 });
    // Runtime group IDs are unique, so assign a separate group to the second window.
    native.groups[1]!.id = 6;
    second.tabs.filter((t) => !t.pinned).forEach((t) => (t.groupId = 6));
    await capture.reconcile();
    native.windows = [];
    native.recent = [
      { id: 'one', closed_at: new Date().toISOString(), window: first },
      { id: 'two', closed_at: new Date().toISOString(), window: second },
    ];
    await capture.reconcile();
    await capture.reconcile();
    expect((await db.sessionProjection()).closed[source]).toHaveLength(2);
  });
  it('archives the last good session across browser incarnation changes and ignores startup emptiness until windows appear', async () => {
    const { db, native, capture, current, source } = await fixture(),
      before = await current();
    native.incarnation = 'browser-2';
    native.windows = [];
    await capture.reconcile();
    expect((await current()).id).toBe(before.id);
    const p = await db.sessionProjection();
    expect(p.snapshots[p.previous[source]![0]!]!.previous_of).toBe(before.id);
    native.windows = [nativeWindow()];
    await capture.reconcile();
    expect((await current()).windows[0]!.id).not.toBe(before.windows[0]!.id);
    expect((await current()).windows[0]!.tabs[0]!.id).not.toBe(before.windows[0]!.tabs[0]!.id);
  });
  it('excludes private and non-normal windows and tabs from caches and snapshots', async () => {
    const { db, native, capture, current } = await fixture();
    const secret = nativeWindow(11);
    secret.incognito = true;
    secret.tabs.forEach((t) => (t.incognito = true));
    native.windows.push(secret, { ...nativeWindow(12), type: 'popup' });
    native.windows[0]!.tabs.push({
      ...nativeWindow(13).tabs[0]!,
      windowId: 10,
      incognito: true,
      url: 'https://private.invalid',
    });
    await capture.reconcile();
    await capture.observeTab(secret.tabs[0]!);
    await capture.observeWindow(secret);
    expect((await current()).windows).toHaveLength(1);
    expect((await current()).windows[0]!.tabs).toHaveLength(3);
    expect(JSON.stringify(await db.sessionProjection())).not.toContain('private.invalid');
    expect(await db.sessionWindows.count()).toBe(1);
  });
  it('pauses capture and does not retroactively archive windows closed during the pause', async () => {
    const { db, native, capture, current, source } = await fixture(),
      before = await current(),
      original = native.windows[0]!;
    await capture.pause();
    native.windows = [];
    native.recent = [{ id: 'paused', closed_at: new Date().toISOString(), window: original }];
    await capture.closeWindow(10);
    await capture.reconcile();
    expect((await current()).id).toBe(before.id);
    await capture.enable();
    expect((await db.sessionProjection()).closed[source] ?? []).toHaveLength(0);
    expect((await current()).windows).toHaveLength(0);
  });
  it('keeps cache and counter state intact when archiving fails, then retries without duplication', async () => {
    const { db, capture, source } = await fixture(),
      counter = (await db.state.get('local'))!.next_counter;
    const spy = vi.spyOn(db, 'stageSession').mockRejectedValueOnce(new Error('Storage exhausted'));
    await expect(capture.closeWindow(10)).rejects.toThrow('Storage exhausted');
    expect(await db.sessionWindows.count()).toBe(1);
    expect((await db.state.get('local'))!.next_counter).toBe(counter);
    spy.mockRestore();
    await capture.closeWindow(10);
    await capture.closeWindow(10);
    expect((await db.sessionProjection()).closed[source]).toHaveLength(1);
  });
  it('retains a valid cache through intermediate group events, then publishes reconciled native ordering', async () => {
    const { db, native, capture, current, source } = await fixture();
    const inserted = {
      ...native.windows[0]!.tabs[0]!,
      id: 999,
      pinned: false,
      index: 1.5,
      active: false,
      groupId: -1,
    };
    await capture.observeTab(inserted); // Temporarily divides the group; browser order will settle on reconciliation.
    expect((await db.sessionWindows.get(10))!.last_good!.tabs).toHaveLength(3);
    native.windows = [];
    await capture.closeWindow(10);
    expect(
      (await db.sessionProjection()).snapshots[(await db.sessionProjection()).closed[source]![0]!]!
        .windows[0]!.tabs,
    ).toHaveLength(3);
    expect((await current()).windows[0]!.tabs).toHaveLength(3);
  });
  it('bounds recently-closed imports and makes missing group metadata visible', async () => {
    const { db, native, capture, source } = await fixture();
    native.recent = Array.from({ length: 30 }, (_, i) => ({
      id: `closed-${i}`,
      closed_at: '2026-10-01T01:00:00Z',
      window: nativeWindow(i + 20),
    }));
    await capture.reconcile();
    await capture.reconcile();
    const p = await db.sessionProjection();
    expect(p.closed[source]).toHaveLength(25);
    expect(p.closed[source]!.every((id) => p.snapshots[id]!.windows[0]!.groups_unavailable)).toBe(
      true,
    );
  });
});
