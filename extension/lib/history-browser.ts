import { browser } from 'wxt/browser';
import type { HistoryBrowser, HistoryMarker } from '@helium-synk/core';
const MARKER = 'helium-synk-history-mapping';
/** This port only reads native history. Remote records stay in the extension timeline. */
export const historyBrowser: HistoryBrowser = {
  async search(startTime, endTime, maxResults) {
    try {
      return await browser.history.search({ text: '', startTime, endTime, maxResults });
    } catch {
      throw new Error('Native history search failed. Its saved range will retry.');
    }
  },
  async getVisits(url) {
    try {
      return await browser.history.getVisits({ url });
    } catch {
      throw new Error('Native history lookup failed. Saved intent will retry.');
    }
  },
  async getMarker() {
    const marker: unknown = (await browser.storage.local.get(MARKER))[MARKER];
    if (marker === undefined) return undefined;
    if (
      !marker ||
      typeof marker !== 'object' ||
      !('author' in marker) ||
      !('id' in marker) ||
      typeof marker.author !== 'string' ||
      typeof marker.id !== 'string'
    )
      throw new Error('History profile marker is invalid. Export surviving data before recovery.');
    return marker as HistoryMarker;
  },
  async setMarker(marker) {
    await browser.storage.local.set({ [MARKER]: marker });
  },
};
