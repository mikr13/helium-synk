import { browser } from 'wxt/browser';
import type { BookmarkBrowser } from '@helium-synk/core';
const MARKER = 'helium-synk-bookmark-incarnation';
export const bookmarkBrowser: BookmarkBrowser = {
  getTree: () => browser.bookmarks.getTree(),
  create: (details) => browser.bookmarks.create(details),
  update: (id, changes) => browser.bookmarks.update(id, changes),
  move: (id, destination) => browser.bookmarks.move(id, destination),
  remove: (id) => browser.bookmarks.remove(id),
  async getMarker() {
    const value = (await browser.storage.local.get(MARKER))[MARKER];
    return typeof value === 'string' ? value : undefined;
  },
  async setMarker(value) {
    await browser.storage.local.set({ [MARKER]: value });
  },
};
