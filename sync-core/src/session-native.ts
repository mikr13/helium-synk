import type { SessionColor, SessionWindow } from './sessions';
export interface NativeSessionTab {
  id: number;
  windowId: number;
  index: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  pinned: boolean;
  active: boolean;
  groupId: number;
  incognito: boolean;
  temporary?: boolean;
}
export interface NativeSessionWindow {
  id: number;
  focused: boolean;
  incognito: boolean;
  type: string;
  state: SessionWindow['state'];
  tabs: NativeSessionTab[];
}
export interface NativeSessionGroup {
  id: number;
  windowId: number;
  title: string;
  color: SessionColor;
  collapsed: boolean;
}
export interface NativeClosedWindow {
  id: string;
  closed_at: string;
  window: NativeSessionWindow;
}
export interface SessionBrowser {
  getIncarnation(): Promise<string>;
  getWindows(): Promise<NativeSessionWindow[]>;
  getWindow(id: number): Promise<NativeSessionWindow>;
  getGroups(): Promise<NativeSessionGroup[]>;
  getRecentlyClosed(): Promise<NativeClosedWindow[]>;
}
export interface SessionSetup {
  id: 'session';
  enabled: boolean;
  incarnation: string;
  last_fingerprint?: string;
  last_snapshot?: string;
  startup_wait?: boolean;
  closed_baseline?: string[];
}
export interface SessionIdentity {
  key: string;
  logical_id: string;
}
export interface SessionWindowCache {
  runtime_id: number;
  incarnation: string;
  native: NativeSessionWindow;
  groups: NativeSessionGroup[];
  last_good?: SessionWindow;
}
export interface SessionClosedSeen {
  id: string;
  snapshot_id: string;
  fingerprint: string;
  captured_at: string;
  native_session?: string;
}
export function windowContentFingerprint(w: SessionWindow): string {
  return JSON.stringify(w.tabs.map((t) => [t.url, t.title, t.pinned]));
}

/** A duplicate-detection receipt must not retain closed URLs or titles. */
export async function sessionFingerprintDigest(fingerprint: string): Promise<string> {
  if (/^sha256:[a-f0-9]{64}$/.test(fingerprint)) return fingerprint;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fingerprint));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
