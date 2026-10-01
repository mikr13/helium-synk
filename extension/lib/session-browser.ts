import { browser } from 'wxt/browser';
import type { Browser } from 'wxt/browser';
import type {
  NativeSessionTab,
  NativeSessionWindow,
  SessionBrowser,
  SessionRestoreBrowser,
} from '@helium-synk/core';
const MARKER = 'helium-synk-session-incarnation';
let incarnation: Promise<string> | undefined;
export function runtimeIncarnation(): Promise<string> {
  return (incarnation ??= (async () => {
    const old = (await browser.storage.session.get(MARKER))[MARKER];
    if (typeof old === 'string') return old;
    const id = crypto.randomUUID();
    await browser.storage.session.set({ [MARKER]: id });
    return id;
  })().catch((cause) => {
    incarnation = undefined;
    throw cause;
  }));
}
export function nativeTab(
  t: Browser.tabs.Tab,
  fallbackId = -1,
  fallbackWindow = -1,
): NativeSessionTab {
  const url = t.pendingUrl ?? t.url;
  return {
    id: t.id ?? fallbackId,
    windowId: t.windowId ?? fallbackWindow,
    index: t.index,
    url: t.url,
    pendingUrl: t.pendingUrl,
    title: t.title,
    pinned: t.pinned,
    active: t.active,
    groupId: t.groupId ?? -1,
    incognito: t.incognito,
    temporary: !!url?.startsWith(browser.runtime.getURL('/restore.html') + '#'),
  };
}
export function nativeWindow(w: Browser.windows.Window, fallbackId = -1): NativeSessionWindow {
  return {
    id: w.id ?? fallbackId,
    focused: w.focused,
    incognito: w.incognito,
    type: w.type ?? 'normal',
    state: w.state === 'locked-fullscreen' || !w.state ? 'normal' : w.state,
    tabs: (w.tabs ?? []).map((t, index) => nativeTab(t, -index - 1, w.id ?? fallbackId)),
  };
}
export const sessionBrowser: SessionBrowser = {
  getIncarnation: runtimeIncarnation,
  async getWindows() {
    return (await browser.windows.getAll({ populate: true, windowTypes: ['normal'] })).map((w) =>
      nativeWindow(w),
    );
  },
  async getWindow(id) {
    return nativeWindow(await browser.windows.get(id, { populate: true }));
  },
  async getGroups() {
    return (await browser.tabGroups.query({})).map((g) => ({
      id: g.id,
      windowId: g.windowId,
      title: g.title ?? '',
      color: g.color,
      collapsed: g.collapsed,
    }));
  },
  async getRecentlyClosed() {
    return (await browser.sessions.getRecentlyClosed({ maxResults: 25 })).flatMap((s, index) => {
      const w = s.window;
      if (!w?.sessionId) return [];
      return [
        {
          id: w.sessionId,
          closed_at: new Date(s.lastModified * 1000).toISOString(),
          window: nativeWindow(w, -index - 1),
        },
      ];
    });
  },
};
export const restoreBrowser: SessionRestoreBrowser = {
  ...sessionBrowser,
  marker: (job, item) => browser.runtime.getURL('/restore.html') + '#' + job + '/' + item,
  async createWindow(marker) {
    const w = await browser.windows.create({
      url: marker,
      focused: false,
      incognito: false,
      type: 'normal',
    });
    if (w?.id === undefined || w.id < 0)
      throw new Error('Browser did not return the created window.');
    return nativeWindow(await browser.windows.get(w.id, { populate: true }));
  },
  async createTab(windowId, marker) {
    const tab = await browser.tabs.create({ windowId, url: marker, active: false });
    if (tab.id === undefined || tab.id < 0)
      throw new Error('Browser did not return the created tab.');
    return nativeTab(tab);
  },
  async navigateTab(id, url, pinned) {
    await browser.tabs.update(id, { url, pinned, active: false });
  },
  async moveTab(id, index) {
    await browser.tabs.move(id, { index });
  },
  groupTabs: (windowId, tabIds) =>
    browser.tabs.group({ createProperties: { windowId }, tabIds: tabIds as [number, ...number[]] }),
  async updateGroup(id, group) {
    await browser.tabGroups.update(id, {
      title: group.title,
      color: group.color,
      collapsed: group.collapsed,
    });
  },
  async activateTab(id) {
    await browser.tabs.update(id, { active: true });
  },
  async focusWindow(id) {
    await browser.windows.update(id, { focused: true });
  },
  removeMarkerTab: (id) => browser.tabs.remove(id),
};
