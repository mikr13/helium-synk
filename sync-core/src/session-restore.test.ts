import { afterEach, describe, expect, it } from 'vitest';
import { SynkDatabase } from './database';
import {
  SessionRestorer,
  type SessionRestoreBrowser,
  type SessionRestoreJob,
} from './session-restore';
import type { NativeSessionWindow, NativeSessionGroup } from './session-native';
import type { SessionGroup } from './sessions';
import { sessionSnapshot, sessionWindow } from '../../tests/session-fixtures';
const dbs: SynkDatabase[] = [];
afterEach(async () => {
  for (const d of dbs.splice(0)) await d.delete();
});
class Native implements SessionRestoreBrowser {
  incarnation = 'one';
  windows: NativeSessionWindow[] = [];
  groups: NativeSessionGroup[] = [];
  nextWindow = 1;
  nextTab = 1;
  nextGroup = 1;
  fail?: 'window' | 'tab' | 'navigate' | 'group';
  redirected = false;
  marker(j: string, item: string) {
    return `chrome-extension://test/restore.html#${j}/${item}`;
  }
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
    return [];
  }
  private lose(op: Native['fail']) {
    if (this.fail === op) {
      this.fail = undefined;
      throw new Error('Browser reply lost');
    }
  }
  private indices(w: NativeSessionWindow) {
    w.tabs.forEach((t, index) => (t.index = index));
  }
  async createWindow(marker: string) {
    const w: NativeSessionWindow = {
      id: this.nextWindow++,
      focused: false,
      incognito: false,
      type: 'normal',
      state: 'normal',
      tabs: [],
    };
    this.windows.push(w);
    await this.createTab(w.id, marker);
    this.lose('window');
    return structuredClone(w);
  }
  async createTab(windowId: number, marker: string) {
    const w = this.windows.find((w) => w.id === windowId)!;
    const t = {
      id: this.nextTab++,
      windowId,
      index: w.tabs.length,
      url: marker,
      title: 'Restoring',
      pinned: false,
      active: !w.tabs.length,
      groupId: -1,
      incognito: false,
    };
    w.tabs.push(t);
    this.lose('tab');
    return structuredClone(t);
  }
  private tab(id: number) {
    for (const w of this.windows) {
      const t = w.tabs.find((t) => t.id === id);
      if (t) return { w, t };
    }
    throw new Error('Tab closed');
  }
  async navigateTab(id: number, url: string, pinned: boolean) {
    const { w, t } = this.tab(id);
    t.url = this.redirected ? 'https://redirected.test/' : url;
    t.pinned = pinned;
    w.tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    this.indices(w);
    this.lose('navigate');
  }
  async moveTab(id: number, index: number) {
    const { w, t } = this.tab(id);
    w.tabs = w.tabs.filter((v) => v.id !== id);
    w.tabs.splice(index, 0, t);
    this.indices(w);
  }
  async groupTabs(windowId: number, ids: number[]) {
    const id = this.nextGroup++;
    for (const t of this.windows.find((w) => w.id === windowId)!.tabs)
      if (ids.includes(t.id)) t.groupId = id;
    this.groups.push({ id, windowId, title: '', color: 'grey', collapsed: false });
    this.lose('group');
    return id;
  }
  async updateGroup(id: number, group: SessionGroup) {
    const g = this.groups.find((g) => g.id === id)!;
    Object.assign(g, { title: group.title, color: group.color, collapsed: group.collapsed });
  }
  async activateTab(id: number) {
    const { w } = this.tab(id);
    w.tabs.forEach((t) => (t.active = t.id === id));
  }
  async focusWindow(id: number) {
    this.windows.forEach((w) => (w.focused = w.id === id));
  }
  async removeMarkerTab(id: number) {
    const { w } = this.tab(id);
    w.tabs = w.tabs.filter((t) => t.id !== id);
    this.indices(w);
  }
}
function fixture() {
  const db = new SynkDatabase(`restore-${crypto.randomUUID()}`);
  dbs.push(db);
  const native = new Native();
  return { db, native, restorer: new SessionRestorer(db, native) };
}
async function finish(r: SessionRestorer, id: string) {
  let j: SessionRestoreJob | undefined;
  for (let i = 0; i < 200; i++) {
    j = await r.run(id);
    if (j?.status !== 'running') return j!;
  }
  throw new Error('Restore did not finish');
}
describe('journaled native session restoration', () => {
  it('restores multiple windows with pins, order, groups and active tabs while leaving the source snapshot intact', async () => {
    const { native, restorer } = fixture(),
      w = sessionWindow(4),
      second = sessionWindow(2);
    second.focused = false;
    const snapshot = sessionSnapshot(1, [w, second]),
      original = structuredClone(snapshot),
      id = crypto.randomUUID();
    await restorer.begin(id, snapshot, { mode: 'all' });
    const done = await finish(restorer, id);
    expect(done.status).toBe('complete');
    expect(native.windows).toHaveLength(2);
    expect(native.windows[0]!.tabs.map((t) => [t.url, t.pinned, t.active])).toEqual(
      w.tabs.map((t) => [t.url, t.pinned, t.active]),
    );
    expect(native.groups[0]).toMatchObject({ title: 'Research', color: 'blue', collapsed: true });
    expect(native.windows[0]!.focused).toBe(true);
    expect(native.windows.every((w) => w.state === 'normal')).toBe(true);
    expect(snapshot).toEqual(original);
    expect(
      native.windows.flatMap((w) => w.tabs).every((t) => !t.url!.includes('restore.html')),
    ).toBe(true);
  });
  it('opens one tab in a regular existing window without changing its other tabs', async () => {
    const { native, restorer } = fixture();
    const existing = await native.createWindow('https://existing.test/');
    existing.focused = true;
    native.windows[0]!.focused = true;
    const s = sessionSnapshot(),
      w = s.windows[0]!,
      id = crypto.randomUUID();
    await restorer.begin(id, s, { mode: 'tab', window_id: w.id, tab_id: w.tabs[1]!.id });
    expect((await finish(restorer, id)).status).toBe('complete');
    expect(native.windows).toHaveLength(1);
    expect(native.windows[0]!.tabs.map((t) => t.url)).toEqual([
      'https://existing.test/',
      w.tabs[1]!.url,
    ]);
    expect(native.groups).toHaveLength(0);
  });
  it('skips internal/local/credential URLs and reports a fully unsupported selection without opening a window', async () => {
    const { native, restorer } = fixture(),
      s = sessionSnapshot(),
      w = s.windows[0]!;
    w.tabs[0]!.url = 'file:///private/test';
    w.tabs[1]!.url = 'chrome://history/';
    w.tabs[2]!.url = 'https://user:secret@example.com';
    const id = crypto.randomUUID(),
      j = await restorer.begin(id, s, { mode: 'all' });
    expect(j.status).toBe('complete');
    expect(j.skipped).toHaveLength(3);
    expect(native.windows).toHaveLength(0);
  });
  it('recovers a created window after a lost result and database reopen, and repeated request identities do not duplicate it', async () => {
    let { db, native, restorer } = fixture();
    const s = sessionSnapshot(),
      id = crypto.randomUUID();
    await restorer.begin(id, s, { mode: 'all' });
    native.fail = 'window';
    expect((await restorer.run(id))!.status).toBe('blocked');
    expect(native.windows).toHaveLength(1);
    db.close();
    const reopened = new SynkDatabase(db.name);
    dbs.push(reopened);
    restorer = new SessionRestorer(reopened, native);
    await restorer.resume(id);
    expect((await finish(restorer, id)).status).toBe('complete');
    await restorer.begin(id, s, { mode: 'all' });
    await finish(restorer, id);
    expect(native.windows).toHaveLength(1);
    expect(native.windows[0]!.tabs).toHaveLength(3);
    await expect(
      restorer.begin(id, s, { mode: 'window', window_id: s.windows[0]!.id }),
    ).rejects.toThrow('identity');
  });
  it('recovers tab creation and group creation after lost replies without duplicating tabs or groups', async () => {
    const { native, restorer } = fixture(),
      s = sessionSnapshot(),
      id = crypto.randomUUID();
    await restorer.begin(id, s, { mode: 'all' });
    await restorer.run(id, 1);
    native.fail = 'tab';
    expect((await restorer.run(id))!.status).toBe('blocked');
    expect(native.windows[0]!.tabs).toHaveLength(2);
    await restorer.resume(id);
    native.fail = 'group';
    expect((await finish(restorer, id)).status).toBe('blocked');
    expect(native.groups).toHaveLength(1);
    await restorer.resume(id);
    expect((await finish(restorer, id)).status).toBe('complete');
    expect(native.windows[0]!.tabs).toHaveLength(3);
    expect(native.groups).toHaveLength(1);
  });
  it('recognizes a navigation that completed before a lost reply while preserving a changed page on ambiguous recovery', async () => {
    const { native, restorer } = fixture(),
      s = sessionSnapshot(),
      id = crypto.randomUUID();
    await restorer.begin(id, s, { mode: 'all' });
    native.fail = 'navigate';
    expect((await finish(restorer, id)).status).toBe('blocked');
    await restorer.resume(id);
    expect((await finish(restorer, id)).status).toBe('complete');
    const id2 = crypto.randomUUID();
    await restorer.begin(id2, s, { mode: 'all' });
    native.redirected = true;
    native.fail = 'navigate';
    await finish(restorer, id2);
    await restorer.resume(id2);
    const blocked = await finish(restorer, id2);
    expect(blocked.status).toBe('blocked');
    expect(blocked.error).toContain('navigated');
    expect(native.windows[1]!.tabs.some((t) => t.url === 'https://redirected.test/')).toBe(true);
  });
  it('blocks missing markers and changed runtime incarnations without blindly recreating or reusing native IDs', async () => {
    const { native, restorer } = fixture(),
      s = sessionSnapshot(),
      id = crypto.randomUUID();
    await restorer.begin(id, s, { mode: 'all' });
    native.fail = 'window';
    await restorer.run(id);
    native.windows[0]!.tabs[0]!.url = 'https://edited.test/';
    await restorer.resume(id);
    const j = await restorer.run(id);
    expect(j!.error).toContain('no marker');
    expect(native.windows).toHaveLength(1);
    native.incarnation = 'two';
    await expect(restorer.resume(id)).rejects.toThrow('browser restarted');
    expect(native.windows[0]!.tabs[0]!.url).toBe('https://edited.test/');
  });
  it('bounds work per pass and cancellation preserves all already opened pages', async () => {
    const { native, restorer } = fixture(),
      s = sessionSnapshot(1, [sessionWindow(120)]),
      id = crypto.randomUUID();
    await restorer.begin(id, s, { mode: 'all' });
    const partial = await restorer.run(id, 10);
    expect(partial!.status).toBe('running');
    expect(native.windows[0]!.tabs.length).toBeLessThan(10);
    const before = structuredClone(native.windows);
    await restorer.cancel(id);
    await restorer.run(id);
    expect(native.windows).toEqual(before);
  });
});
