import { describe, expect, it } from 'vitest';
import { sessionSnapshot, sessionWindow } from '../../tests/session-fixtures';
import { projectSessions, restoreUrl, splitSession, validateSessionSnapshot } from './sessions';
import { base64, unbase64 } from './crypto';

describe('source-owned session snapshots', () => {
  it('assembles multipart Unicode snapshots without exposing partial replacements', () => {
    const old = sessionSnapshot(),
      next = {
        ...sessionSnapshot(100, [sessionWindow(500, '漢字 🐇'.repeat(80))]),
        source_id: old.source_id,
      };
    const first = splitSession(old),
      parts = splitSession(next);
    expect(parts.length).toBeGreaterThan(1);
    const partial = projectSessions([...first, ...parts.slice(1)]);
    expect(partial.current[old.source_id]).toBe(old.id);
    expect(partial.incomplete).toEqual([next.id]);
    const complete = projectSessions([...parts.reverse(), ...first]);
    expect(complete.snapshots[next.id]).toEqual(next);
    expect(complete.current[old.source_id]).toBe(next.id);
    expect(complete.previous[old.source_id]).toContain(old.id);
    expect(parts.every((p) => new TextEncoder().encode(JSON.stringify(p)).byteLength < 65520)).toBe(
      true,
    );
  });
  it('chooses the latest source revision independently of clock skew and arrival order', () => {
    const newer = sessionSnapshot(10),
      older = {
        ...sessionSnapshot(1),
        source_id: newer.source_id,
        captured_at: '2099-01-01T00:00:00Z',
      };
    for (const parts of [
      [...splitSession(newer), ...splitSession(older)],
      [...splitSession(older), ...splitSession(newer)],
    ])
      expect(projectSessions(parts).current[newer.source_id]).toBe(newer.id);
  });
  it('keeps device-owned current, closed and selected previous records independent', () => {
    const a = sessionSnapshot(1),
      b = sessionSnapshot(10),
      closed = { ...sessionSnapshot(2), kind: 'closed' as const, source_id: a.source_id },
      saved = {
        ...sessionSnapshot(3),
        kind: 'previous' as const,
        source_id: a.source_id,
        previous_of: a.id,
      };
    const p = projectSessions([a, b, closed, saved].flatMap(splitSession));
    expect(p.current).toEqual({ [b.source_id]: b.id, [a.source_id]: a.id });
    expect(p.closed[a.source_id]).toEqual([closed.id]);
    expect(p.previous[a.source_id]).toEqual([saved.id]);
  });
  it('deduplicates unchanged parts but rejects identity, revision and fragment-index reuse', () => {
    const snapshot = sessionSnapshot(),
      parts = splitSession(snapshot);
    expect(projectSessions([...parts, ...parts]).snapshots[snapshot.id]).toEqual(snapshot);
    expect(() =>
      projectSessions([...parts, { ...parts[0]!, data: base64(new TextEncoder().encode('{}')) }]),
    ).toThrow('identity');
    expect(() =>
      projectSessions([...parts, ...splitSession({ ...snapshot, id: crypto.randomUUID() })]),
    ).toThrow('revision');
    expect(() =>
      projectSessions([...parts, { ...parts[0]!, operation_id: crypto.randomUUID() }]),
    ).toThrow('counter');
  });
  it('rejects inconsistent metadata and fully assembled invalid/unbound content', () => {
    const snapshot = sessionSnapshot(1, [sessionWindow(500, 'Long'.repeat(100))]),
      parts = splitSession(snapshot);
    expect(parts.length).toBeGreaterThan(1);
    expect(() =>
      projectSessions(parts.map((p, i) => (i ? { ...p, source_name: 'Changed' } : p))),
    ).toThrow('metadata');
    const one = splitSession(sessionSnapshot())[0]!,
      value = JSON.parse(new TextDecoder().decode(unbase64(one.data)));
    value.source_id = crypto.randomUUID();
    expect(() =>
      projectSessions([{ ...one, data: base64(new TextEncoder().encode(JSON.stringify(value))) }]),
    ).toThrow('content');
    expect(() =>
      projectSessions([{ ...one, data: base64(new TextEncoder().encode('{bad')) }]),
    ).toThrow();
  });
  it('rejects reused internal IDs and malformed pin/group/active structure', () => {
    const s = sessionSnapshot();
    s.windows[0]!.tabs[1]!.id = s.windows[0]!.tabs[0]!.id;
    expect(() => validateSessionSnapshot(s)).toThrow('tab');
    const pin = sessionSnapshot();
    pin.windows[0]!.tabs[2]!.pinned = true;
    expect(() => validateSessionSnapshot(pin)).toThrow('Pinned');
    const group = sessionSnapshot();
    group.windows[0]!.tabs[1]!.group_id = crypto.randomUUID();
    expect(() => validateSessionSnapshot(group)).toThrow('tab');
    const active = sessionSnapshot();
    active.windows[0]!.tabs[1]!.active = true;
    expect(() => validateSessionSnapshot(active)).toThrow('active');
  });
  it('opens only valid HTTP/HTTPS URLs and rejects internal, executable and credential-bearing URLs', () => {
    expect(restoreUrl('https://example.com/path')).toBe('https://example.com/path');
    for (const url of [
      'chrome://history',
      'file:///tmp/private',
      'javascript:alert(1)',
      'data:text/html,test',
      'about:blank',
      'https://user:password@example.com',
      'not a URL',
    ])
      expect(restoreUrl(url)).toBeUndefined();
  });
});
