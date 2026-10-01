import { canonicalUuid } from './revision';
import { base64, unbase64 } from './crypto';
import { validCounter } from './protocol';

export const SESSION_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
] as const;
export type SessionColor = (typeof SESSION_COLORS)[number];
export interface SessionTab {
  id: string;
  url: string;
  title: string;
  pinned: boolean;
  active: boolean;
  group_id?: string;
}
export interface SessionGroup {
  id: string;
  title: string;
  color: SessionColor;
  collapsed: boolean;
}
export interface SessionWindow {
  id: string;
  focused: boolean;
  state: 'normal' | 'minimized' | 'maximized' | 'fullscreen';
  tabs: SessionTab[];
  groups: SessionGroup[];
  /** Recently-closed APIs may omit group metadata. */
  groups_unavailable?: boolean;
}
export interface SessionSnapshot {
  id: string;
  source_id: string;
  source_revision: number;
  source_name: string;
  kind: 'current' | 'closed' | 'previous';
  captured_at: string;
  previous_of?: string;
  windows: SessionWindow[];
}
export type SessionContent = Pick<
  SessionSnapshot,
  'kind' | 'captured_at' | 'windows' | 'previous_of'
>;
export interface SessionPart {
  kind: 'session';
  schema_version: 1;
  operation_id: string;
  source_id: string;
  source_revision: number;
  snapshot_id: string;
  snapshot_kind: SessionSnapshot['kind'];
  source_name: string;
  captured_at: string;
  part: number;
  total: number;
  data: string;
}
export interface SessionProjection {
  snapshots: Record<string, SessionSnapshot>;
  current: Record<string, string>;
  previous: Record<string, string[]>;
  closed: Record<string, string[]>;
  incomplete: string[];
}
const PART_BYTES = 45_000,
  MAX_PARTS = 256;
function text(value: unknown, limit = 16_384): value is string {
  return typeof value === 'string' && value.length <= limit;
}
function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && Number.isFinite(Date.parse(value));
}
export function validateSessionSnapshot(s: SessionSnapshot): void {
  if (
    !s ||
    !canonicalUuid(s.id) ||
    !canonicalUuid(s.source_id) ||
    !validCounter(s.source_revision) ||
    !text(s.source_name, 100) ||
    !s.source_name ||
    !['current', 'closed', 'previous'].includes(s.kind) ||
    !timestamp(s.captured_at) ||
    !Array.isArray(s.windows) ||
    s.windows.length > 100 ||
    (s.previous_of !== undefined && !canonicalUuid(s.previous_of))
  )
    throw new Error('Invalid session snapshot.');
  const windows = new Set<string>(),
    tabs = new Set<string>(),
    groups = new Set<string>();
  let tabCount = 0;
  for (const w of s.windows) {
    if (
      !w ||
      !canonicalUuid(w.id) ||
      windows.has(w.id) ||
      typeof w.focused !== 'boolean' ||
      !['normal', 'minimized', 'maximized', 'fullscreen'].includes(w.state) ||
      !Array.isArray(w.tabs) ||
      !Array.isArray(w.groups) ||
      w.groups.length > 500 ||
      (w.groups_unavailable !== undefined && typeof w.groups_unavailable !== 'boolean') ||
      w.tabs.length > 10_000
    )
      throw new Error('Invalid session window.');
    windows.add(w.id);
    const groupIds = new Set<string>();
    for (const g of w.groups) {
      if (
        !g ||
        !canonicalUuid(g.id) ||
        groups.has(g.id) ||
        !text(g.title) ||
        !SESSION_COLORS.includes(g.color) ||
        typeof g.collapsed !== 'boolean'
      )
        throw new Error('Invalid session group.');
      groups.add(g.id);
      groupIds.add(g.id);
    }
    let unpinned = false,
      active = 0;
    const seenGroups = new Set<string>();
    let previousGroup: string | undefined;
    for (const t of w.tabs) {
      if (
        !t ||
        !canonicalUuid(t.id) ||
        tabs.has(t.id) ||
        !text(t.url) ||
        !text(t.title) ||
        typeof t.pinned !== 'boolean' ||
        typeof t.active !== 'boolean' ||
        (t.group_id !== undefined && !groupIds.has(t.group_id))
      )
        throw new Error('Invalid session tab.');
      if (t.pinned && (unpinned || t.group_id !== undefined))
        throw new Error('Pinned session tabs must precede unpinned tabs and cannot be grouped.');
      unpinned ||= !t.pinned;
      active += Number(t.active);
      tabs.add(t.id);
      tabCount++;
      if (t.group_id !== previousGroup) {
        if (t.group_id && seenGroups.has(t.group_id))
          throw new Error('Session groups must be contiguous.');
        if (t.group_id) seenGroups.add(t.group_id);
        previousGroup = t.group_id;
      }
    }
    if (active > 1 || tabCount > 10_000)
      throw new Error('Session capture exceeds supported tab/active limits.');
  }
  if (s.windows.filter((w) => w.focused).length > 1)
    throw new Error('Only one session window can be focused.');
}
export function splitSession(snapshot: SessionSnapshot): SessionPart[] {
  validateSessionSnapshot(snapshot);
  const data = new TextEncoder().encode(JSON.stringify(snapshot)),
    total = Math.max(1, Math.ceil(data.length / PART_BYTES));
  if (total > MAX_PARTS || !Number.isSafeInteger(snapshot.source_revision + total - 1))
    throw new Error('Session snapshot exceeds the supported transfer limit.');
  return Array.from({ length: total }, (_, part) => ({
    kind: 'session',
    schema_version: 1,
    operation_id: crypto.randomUUID(),
    source_id: snapshot.source_id,
    source_revision: snapshot.source_revision,
    snapshot_id: snapshot.id,
    snapshot_kind: snapshot.kind,
    source_name: snapshot.source_name,
    captured_at: snapshot.captured_at,
    part,
    total,
    data: base64(data.slice(part * PART_BYTES, (part + 1) * PART_BYTES)),
  }));
}
export function validateSessionPart(p: SessionPart): void {
  if (
    !p ||
    p.kind !== 'session' ||
    p.schema_version !== 1 ||
    !canonicalUuid(p.operation_id) ||
    !canonicalUuid(p.snapshot_id) ||
    !canonicalUuid(p.source_id) ||
    !validCounter(p.source_revision) ||
    !text(p.source_name, 100) ||
    !p.source_name ||
    !['current', 'closed', 'previous'].includes(p.snapshot_kind) ||
    !timestamp(p.captured_at) ||
    !Number.isSafeInteger(p.part) ||
    !Number.isSafeInteger(p.total) ||
    p.total < 1 ||
    p.total > MAX_PARTS ||
    p.part < 0 ||
    p.part >= p.total ||
    !text(p.data, (PART_BYTES * 4) / 3) ||
    !Number.isSafeInteger(p.source_revision + p.part)
  )
    throw new Error('Invalid session fragment.');
  const bytes = unbase64(p.data);
  if (!bytes.length || bytes.length > PART_BYTES || base64(bytes) !== p.data)
    throw new Error('Invalid session fragment bytes.');
}
const FIELDS = [
  'source_id',
  'source_revision',
  'snapshot_id',
  'snapshot_kind',
  'source_name',
  'captured_at',
  'total',
] as const;
/** Incomplete snapshots never replace the last complete snapshot. Source revision wins, not receipt time. */
export function projectSessions(input: readonly SessionPart[]): SessionProjection {
  const result: SessionProjection = {
    snapshots: {},
    current: {},
    previous: {},
    closed: {},
    incomplete: [],
  };
  const byId = new Map<string, SessionPart>(),
    bySnapshot = new Map<string, SessionPart[]>(),
    byRevision = new Map<string, string>(),
    counters = new Map<string, string>();
  for (const p of input) {
    validateSessionPart(p);
    const old = byId.get(p.operation_id);
    if (old && JSON.stringify(old) !== JSON.stringify(p))
      throw new Error('Session operation identity was reused.');
    if (old) continue;
    byId.set(p.operation_id, p);
    const key = `${p.source_id}/${p.source_revision}`,
      counter = `${p.source_id}/${p.source_revision + p.part}`;
    if ((byRevision.has(key) && byRevision.get(key) !== p.snapshot_id) || counters.has(counter))
      throw new Error('Session source revision/counter was reused.');
    byRevision.set(key, p.snapshot_id);
    counters.set(counter, p.operation_id);
    const list = bySnapshot.get(p.snapshot_id) ?? [];
    list.push(p);
    bySnapshot.set(p.snapshot_id, list);
  }
  for (const [id, list] of [...bySnapshot.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    list.sort((a, b) => a.part - b.part);
    const first = list[0]!;
    if (list.some((p) => FIELDS.some((field) => p[field] !== first[field])))
      throw new Error('Session fragments have inconsistent metadata.');
    if (list.length !== first.total) {
      result.incomplete.push(id);
      continue;
    }
    if (list.some((p, index) => p.part !== index))
      throw new Error('Session fragment indexes were reused.');
    const chunks = list.map((p) => unbase64(p.data)),
      bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const snapshot = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as SessionSnapshot;
    validateSessionSnapshot(snapshot);
    if (
      snapshot.id !== id ||
      snapshot.source_id !== first.source_id ||
      snapshot.source_revision !== first.source_revision ||
      snapshot.kind !== first.snapshot_kind ||
      snapshot.source_name !== first.source_name ||
      snapshot.captured_at !== first.captured_at
    )
      throw new Error('Session content does not match fragment metadata.');
    result.snapshots[id] = snapshot;
  }
  const complete = Object.values(result.snapshots).sort(
    (a, b) => b.source_revision - a.source_revision || a.id.localeCompare(b.id),
  );
  for (const s of complete) {
    if (s.kind === 'current' && !result.current[s.source_id]) result.current[s.source_id] = s.id;
    else if (s.kind === 'closed') (result.closed[s.source_id] ??= []).push(s.id);
    else (result.previous[s.source_id] ??= []).push(s.id);
  }
  return result;
}
export function restoreUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
