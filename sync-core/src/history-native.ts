import type { VectorClock } from './revision';
import type { HistoryClear } from './history';
export interface NativeHistoryItem {
  id: string;
  url?: string;
  title?: string;
  lastVisitTime?: number;
}
export interface NativeHistoryVisit {
  visitId: string;
  visitTime?: number;
  isLocal?: boolean;
  transition?: string;
  referringVisitId?: string;
  incognito?: boolean;
}
export interface HistoryMarker {
  author: string;
  id: string;
}
export interface HistoryBrowser {
  search(start: number, end: number, limit: number): Promise<NativeHistoryItem[]>;
  getVisits(url: string): Promise<NativeHistoryVisit[]>;
  getMarker(): Promise<HistoryMarker | undefined>;
  setMarker(marker: HistoryMarker): Promise<void>;
}
export interface HistorySetup {
  id: 'history';
  enabled: boolean;
  phase: 'active' | 'baseline' | 'paused' | 'blocked';
  marker: string;
  incarnation: string;
  exclusions: string[];
  applied: string[];
  last_scan?: number;
  last_audit?: number;
  error?: string;
}
export interface HistoryInbox {
  id?: number;
  event:
    | { type: 'visited'; item: NativeHistoryItem }
    | { type: 'removed'; all: boolean; urls: string[] };
  context: VectorClock;
  barriers: HistoryClear[];
  incarnation: string;
  created_at: number;
  url_position?: number;
  removal_ids?: string[];
  attempts?: number;
  retry_at?: number;
  error?: string;
}
export interface HistorySeen {
  id: string;
  url_tag: string;
  native_id: string;
  visited_at: number;
  incarnation: string;
  suppressed: boolean;
}
export interface HistoryUrlEpoch {
  url_tag: string;
  incarnation: string;
  baseline_pending: boolean;
}
export interface HistoryScan {
  id: string;
  kind: 'import' | 'overlap' | 'baseline' | 'audit';
  start: number;
  end: number;
  ranges: { start: number; end: number }[];
  context: VectorClock;
  barriers: HistoryClear[];
  incarnation: string;
  url_tag?: string;
  created_at: number;
  discovery_done?: boolean;
  audit_cursor?: string;
  error?: string;
  retry_at?: number;
}
export interface HistoryScanUrl {
  id: string;
  job_id: string;
}
export interface HistoryLookup {
  id: string;
  job_id: string;
  item: NativeHistoryItem & { url: string };
  url_tag: string;
  kind: 'event' | 'import' | 'overlap' | 'baseline' | 'audit';
  start: number;
  end: number;
  context: VectorClock;
  barriers: HistoryClear[];
  incarnation: string;
  /** Local erased markers retain only identity and must never be recaptured. */
  records?: (NativeHistoryVisit & { erased?: true })[];
  checked_counter?: number;
  preserve_captured?: boolean;
  removal_ids?: string[];
  position: number;
  attempts: number;
  error?: string;
  retry_at?: number;
}
export function exclusionDomains(input: string[]): string[] {
  if (!Array.isArray(input) || input.length > 100)
    throw new Error('Use at most 100 excluded domains.');
  return [
    ...new Set(
      input.map((value) => {
        if (typeof value !== 'string' || !value.trim() || /[\s/@?#:]/.test(value.trim()))
          throw new Error('Use hostnames such as example.com for exclusions.');
        const url = new URL('https://' + value.trim());
        if (!url.hostname || url.pathname !== '/') throw new Error('Invalid excluded domain.');
        return url.hostname.toLowerCase().replace(/\.$/, '');
      }),
    ),
  ].sort();
}
export function excludedHistoryUrl(value: string, domains: string[]): boolean {
  try {
    const url = new URL(value),
      hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    return domains.some((d) => hostname === d || hostname.endsWith('.' + d));
  } catch {
    return true;
  }
}
